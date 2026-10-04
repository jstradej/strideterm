import ssh2 from "ssh2";
import type { Client as Ssh2Client, ClientChannel, ClientErrorExtensions, ConnectConfig, Prompt } from "ssh2";
import type { AnyAuthMethod, AuthenticationType } from "ssh2";
import type { AuthConfig } from "./ssh-auth.js";
import type { HostKeyVerdict } from "./ssh-known-hosts.js";

const { Client } = ssh2;

const KEEPALIVE_INTERVAL = 30000;
const KEEPALIVE_MAX = 3;
const READY_TIMEOUT = 20000;

interface ReadyDeadline {
  pause(): void;
  resume(): void;
  restart(): void;
  clear(): void;
}

interface HostAdvanced {
  command?: string;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  compression?: boolean;
  agentForward?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  algorithms?: any;
}

interface HostLike {
  host: string;
  port?: number;
  username?: string;
  advanced?: HostAdvanced;
  hostKeyPolicy?: string;
  name?: string;
}

export interface HostKeyInfo {
  fingerprint: string;
  keyType: string;
  first?: boolean;
}

interface HostKeyMismatchInfo {
  fingerprint: string;
  keyType: string;
  previous: { fingerprint: string; keyType: string; addedAt: string } | null;
}

interface JumpEntry {
  host: HostLike;
  auth: AuthConfig;
  verify?: (args: { key: Buffer }) => HostKeyVerdict;
  onAccepted?: (info: HostKeyInfo) => void;
  onAuthPrompt?: (info: AuthPromptInfo) => void;
  onPasswordPrompt?: (finish: (password: string | null) => void) => void;
  onHostKeyDecision?: (info: HostKeyMismatchInfo, callback: (accept: boolean) => void) => void;
}

interface ExitInfo {
  exitCode: number;
  signal: string | null;
  error?: string;
}

interface AuthPromptInfo {
  name: string;
  instructions: string;
  prompts: Prompt[];
  finish: (responses: string[]) => void;
}

interface SshSessionOpts {
  host: HostLike;
  auth?: AuthConfig;
  jumps?: JumpEntry[];
  dimensions?: { cols: number; rows: number };
  verify?: (args: { key: Buffer }) => HostKeyVerdict;
  onData?: (data: string) => void;
  onExit?: (exit: ExitInfo) => void;
  onAuthPrompt?: (info: AuthPromptInfo) => void;
  onPasswordPrompt?: (finish: (password: string | null) => void) => void;
  onHostKeyDecision?: (info: HostKeyMismatchInfo, callback: (accept: boolean) => void) => void;
  onReady?: () => void;
  onAuthenticated?: (client: Ssh2Client) => Promise<void> | void;
  authOnly?: boolean;
  readyTimeoutMs?: number;
  authenticatedActionTimeoutMs?: number;
}

interface AuthFailureDiagnostic {
  host: HostLike;
  auth: AuthConfig;
  failedMethods: Set<AuthenticationType>;
  skippedMethods: Set<AuthenticationType>;
  serverMethods: AuthenticationType[];
  unknownServerMethods: boolean;
  partialSuccess: boolean | null;
  cancelled: boolean;
}

const AUTH_METHOD_NAMES = new Set<AuthenticationType>([
  "none",
  "password",
  "publickey",
  "agent",
  "keyboard-interactive",
  "hostbased",
]);

const AUTH_METHOD_LABELS: Partial<Record<AuthenticationType, string>> = {
  password: "password",
  publickey: "saved key",
  agent: "SSH agent",
  "keyboard-interactive": "password or verification code",
  hostbased: "host-based authentication",
};

const SERVER_AUTH_METHOD_LABELS: Partial<Record<AuthenticationType, string>> = {
  password: "password",
  publickey: "public-key authentication",
  agent: "public-key authentication",
  "keyboard-interactive": "keyboard-interactive (password or verification code)",
  hostbased: "host-based authentication",
};

function sanitizeDiagnosticText(value: string): string {
  return (
    value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "?"
  );
}

export class SshSession {
  host: HostLike;
  auth: AuthConfig;
  jumps: JumpEntry[];
  dimensions: { cols: number; rows: number };
  verify?: (args: { key: Buffer }) => HostKeyVerdict;
  onData?: (data: string) => void;
  onExit?: (exit: ExitInfo) => void;
  onAuthPrompt?: (info: AuthPromptInfo) => void;
  onPasswordPrompt?: (finish: (password: string | null) => void) => void;
  onHostKeyDecision?: (info: HostKeyMismatchInfo, callback: (accept: boolean) => void) => void;
  onReady?: () => void;
  onAuthenticated?: (client: Ssh2Client) => Promise<void> | void;
  authOnly: boolean;
  readyTimeoutMs: number;
  authenticatedActionTimeoutMs: number;
  client: Ssh2Client | null;
  stream: ClientChannel | null;
  jumpClients: Ssh2Client[];
  ready: boolean;
  ended: boolean;
  verifiedHostKey: HostKeyInfo | null;
  private authFailureDiagnostic: AuthFailureDiagnostic | null;
  private readyDeadlines: Set<ReadyDeadline>;
  private cancelAuthenticatedAction?: () => void;

  constructor(opts: SshSessionOpts) {
    this.host = opts.host;
    this.auth = opts.auth || {};
    this.jumps = opts.jumps || [];
    this.dimensions = opts.dimensions || { cols: 80, rows: 24 };
    this.verify = opts.verify;
    this.onData = opts.onData;
    this.onExit = opts.onExit;
    this.onAuthPrompt = opts.onAuthPrompt;
    this.onPasswordPrompt = opts.onPasswordPrompt;
    this.onHostKeyDecision = opts.onHostKeyDecision;
    this.onReady = opts.onReady;
    this.onAuthenticated = opts.onAuthenticated;
    this.authOnly = opts.authOnly === true;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT;
    this.authenticatedActionTimeoutMs = opts.authenticatedActionTimeoutMs ?? 30000;
    this.client = null;
    this.stream = null;
    this.jumpClients = [];
    this.ready = false;
    this.ended = false;
    // Populated by the primary host verifier; the manager persists this on
    // successful connect for first-time hosts under accept-new/warn policy.
    this.verifiedHostKey = null;
    this.authFailureDiagnostic = null;
    this.readyDeadlines = new Set();
  }

  async start(): Promise<void> {
    let sock: ClientChannel | null;
    try {
      sock = await this._connectChain();
    } catch (error) {
      throw this.withAuthDiagnostics(error);
    }

    return new Promise<void>((resolve, reject) => {
      const client = new Client();
      this.client = client;
      let clearReadyDeadline = () => {};

      let settled = false;
      let rejectAuthenticatedAction: ((error: Error) => void) | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finish = (fn: (arg?: any) => void, arg?: unknown) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };

      client
        .on("ready", () => {
          clearReadyDeadline();
          this.ready = true;
          if (this.authOnly) {
            if (!this.onAuthenticated) {
              try {
                this.onReady?.();
              } catch {
                // Reporting readiness must not keep an authenticated client alive.
              }
              finish(resolve);
              void this.stop();
              return;
            }
            let actionSettled = false;
            const actionTimer = setTimeout(() => {
              rejectAuthenticatedAction?.(new Error("SSH post-authentication operation timed out."));
              client.destroy();
            }, this.authenticatedActionTimeoutMs);
            rejectAuthenticatedAction = (error) => {
              if (actionSettled) return;
              actionSettled = true;
              clearTimeout(actionTimer);
              rejectAuthenticatedAction = undefined;
              this.cancelAuthenticatedAction = undefined;
              finish(reject, this.withAuthDiagnostics(error));
            };
            this.cancelAuthenticatedAction = () => {
              rejectAuthenticatedAction?.(new Error("SSH post-authentication operation was stopped."));
              client.destroy();
            };
            void (async () => {
              try {
                this.onReady?.();
                await this.onAuthenticated?.(client);
                if (actionSettled) return;
                actionSettled = true;
                clearTimeout(actionTimer);
                rejectAuthenticatedAction = undefined;
                this.cancelAuthenticatedAction = undefined;
                finish(resolve);
              } catch (error) {
                rejectAuthenticatedAction?.(error instanceof Error ? error : new Error(String(error)));
              } finally {
                await this.stop();
              }
            })();
            return;
          }
          client.shell(
            {
              term: "xterm-256color",
              cols: this.dimensions.cols || 80,
              rows: this.dimensions.rows || 24,
            },
            (err, stream) => {
              if (err) {
                finish(reject, this.withAuthDiagnostics(err));
                return;
              }
              this.stream = stream;
              stream.on("data", (buf: Buffer) => this.onData?.(buf.toString("utf-8")));
              stream.stderr.on("data", (buf: Buffer) => this.onData?.(buf.toString("utf-8")));
              stream.on("close", (code: number | null, signal: string | null) => {
                if (this.ended) return;
                this.ended = true;
                this.onExit?.({ exitCode: typeof code === "number" ? code : 0, signal: signal || null });
              });
              try {
                this.onReady?.();
              } catch {
                // reporting failure should never break the shell
              }
              if (this.host.advanced?.command) {
                stream.write(this.host.advanced.command + "\r");
              }
              finish(resolve);
            },
          );
        })
        .on(
          "keyboard-interactive",
          (
            name: string,
            instructions: string,
            _lang: string,
            prompts: Prompt[],
            finishPrompt: (responses: string[]) => void,
          ) => {
            if (!this.onAuthPrompt) {
              finishPrompt([]);
              return;
            }
            readyDeadline.pause();
            let completed = false;
            try {
              this.onAuthPrompt({
                name,
                instructions,
                prompts,
                finish: (responses) => {
                  if (completed) return;
                  completed = true;
                  if (responses.length === 0) this.authFailureDiagnostic!.cancelled = true;
                  try {
                    finishPrompt(responses);
                  } finally {
                    readyDeadline.resume();
                  }
                },
              });
            } catch {
              readyDeadline.resume();
              finishPrompt([]);
            }
          },
        )
        .on("banner", (msg: string) => this.onData?.(msg))
        .on("error", (err: Error) => {
          readyDeadline.clear();
          if (this.ready) {
            rejectAuthenticatedAction?.(err);
            // Post-ready errors: treat as exit with nonzero code, not as start() reject.
            if (this.ended) return;
            this.ended = true;
            this.onExit?.({ exitCode: 1, signal: null, error: err.message });
            return;
          }
          finish(reject, this.withAuthDiagnostics(err));
        })
        .on("close", () => {
          readyDeadline.clear();
          rejectAuthenticatedAction?.(new Error("SSH connection closed during the post-authentication operation."));
          if (!this.ready) {
            finish(reject, new Error("Connection closed before ready"));
            return;
          }
          if (this.ended) return;
          this.ended = true;
          this.onExit?.({ exitCode: 0, signal: null });
        });

      const readyDeadline = this.createReadyDeadline(client);
      clearReadyDeadline = () => readyDeadline.clear();
      client.on("handshake", () => readyDeadline.restart());
      try {
        client.connect(this._buildConnectConfig(sock, readyDeadline));
      } catch (error) {
        readyDeadline.clear();
        finish(reject, error);
      }
    });
  }

  async _connectChain(): Promise<ClientChannel | null> {
    if (this.jumps.length === 0) return null;

    let currentSock: ClientChannel | null = null;
    this.jumpClients = [];

    for (let i = 0; i < this.jumps.length; i += 1) {
      const jump = this.jumps[i]!;
      const diagnostic = this.createAuthDiagnostic(jump.host, jump.auth);
      this.authFailureDiagnostic = diagnostic;
      const jumpClient = new Client();
      this.jumpClients.push(jumpClient);
      const readyDeadline = this.createReadyDeadline(jumpClient);

      await new Promise<void>((resolveConnect, rejectConnect) => {
        let settled = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const settle = (fn: (arg?: any) => void, arg?: unknown) => {
          if (settled) return;
          settled = true;
          fn(arg);
        };
        try {
          jumpClient.on("handshake", () => readyDeadline.restart());
          jumpClient.on("ready", () => {
            readyDeadline.clear();
            settle(resolveConnect);
          });
          jumpClient.on("error", (err: Error) => {
            readyDeadline.clear();
            settle(rejectConnect, err);
          });
          jumpClient.on("close", () => {
            readyDeadline.clear();
            if (!settled) settle(rejectConnect, new Error("Jump connection closed"));
          });

          const { promptPassword, ...jumpAuth } = jump.auth;
          const cfg: ConnectConfig = {
            host: jump.host.host,
            port: jump.host.port || 22,
            username: jump.host.username,
            ...jumpAuth,
            readyTimeout: 0,
            hostVerifier: this._makeHostVerifier(
              jump.host,
              jump.verify,
              jump.onAccepted,
              jump.onHostKeyDecision
                ? (info, callback) => {
                    readyDeadline.pause();
                    try {
                      jump.onHostKeyDecision!(info, (accept) => {
                        try {
                          callback(accept);
                        } finally {
                          readyDeadline.resume();
                        }
                      });
                    } catch {
                      readyDeadline.resume();
                      callback(false);
                    }
                  }
                : undefined,
            ),
            debug: (message) => this.captureAuthDiagnostic(diagnostic, message),
          };
          this.applyAuthHandler(
            cfg,
            jump.host.username || "",
            jump.auth,
            promptPassword,
            jump.onPasswordPrompt,
            diagnostic,
            readyDeadline,
          );
          jumpClient.on("keyboard-interactive", (name, instructions, _lang, prompts, finish) => {
            if (!jump.onAuthPrompt) {
              finish([]);
              return;
            }
            readyDeadline.pause();
            let completed = false;
            try {
              jump.onAuthPrompt({
                name,
                instructions,
                prompts,
                finish: (responses) => {
                  if (completed) return;
                  completed = true;
                  if (responses.length === 0) diagnostic.cancelled = true;
                  try {
                    finish(responses);
                  } finally {
                    readyDeadline.resume();
                  }
                },
              });
            } catch {
              readyDeadline.resume();
              finish([]);
            }
          });
          if (currentSock) cfg.sock = currentSock;
          jumpClient.connect(cfg);
        } catch (error) {
          readyDeadline.clear();
          settle(rejectConnect, error);
        }
      });

      const nextHost = i + 1 < this.jumps.length ? this.jumps[i + 1]!.host : this.host;
      const nextPort = nextHost.port || 22;

      currentSock = await new Promise<ClientChannel>((resolveForward, rejectForward) => {
        jumpClient.forwardOut("127.0.0.1", 0, nextHost.host, nextPort, (err, stream) => {
          if (err) rejectForward(err);
          else resolveForward(stream);
        });
      });
    }

    return currentSock;
  }

  _buildConnectConfig(sock: ClientChannel | null, readyDeadline?: ReadyDeadline): ConnectConfig {
    // `compress` is a legacy top-level ConnectConfig option that is not present
    // in the @types/ssh2 typings (it belongs in algorithms.compress) but ssh2
    // at runtime accepts it directly. Cast through unknown to keep the logic.

    const { promptPassword, ...auth } = this.auth;
    const diagnostic = this.createAuthDiagnostic(this.host, this.auth);
    this.authFailureDiagnostic = diagnostic;
    const cfg = {
      host: this.host.host,
      port: this.host.port || 22,
      username: this.host.username,
      ...auth,
      readyTimeout: 0,
      keepaliveInterval: this.host.advanced?.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL,
      keepaliveCountMax: this.host.advanced?.keepaliveCountMax ?? KEEPALIVE_MAX,
      compress: this.host.advanced?.compression !== false,
      agentForward: this.host.advanced?.agentForward === true,
      algorithms: this.host.advanced?.algorithms || undefined,
      hostVerifier: this._makeHostVerifier(
        this.host,
        this.verify,
        (info) => {
          this.verifiedHostKey = info;
        },
        this.onHostKeyDecision && readyDeadline
          ? (info, callback) => {
              readyDeadline.pause();
              try {
                this.onHostKeyDecision!(info, (accept) => {
                  try {
                    callback(accept);
                  } finally {
                    readyDeadline.resume();
                  }
                });
              } catch {
                readyDeadline.resume();
                callback(false);
              }
            }
          : undefined,
      ),
      debug: (message: string) => this.captureAuthDiagnostic(diagnostic, message),
    } as ConnectConfig;
    this.applyAuthHandler(
      cfg,
      this.host.username || "",
      this.auth,
      promptPassword,
      this.onPasswordPrompt,
      diagnostic,
      readyDeadline,
    );
    if (sock) cfg.sock = sock;
    return cfg;
  }

  private applyAuthHandler(
    cfg: ConnectConfig,
    username: string,
    auth: AuthConfig,
    promptPassword: boolean | undefined,
    onPasswordPrompt: ((finish: (password: string | null) => void) => void) | undefined,
    diagnostic: AuthFailureDiagnostic,
    readyDeadline?: ReadyDeadline,
  ): void {
    if (promptPassword) {
      // ssh2 only considers the classic password method available when a
      // password value exists. An empty placeholder enables it, while this
      // handler waits until the server actually offers password auth before
      // asking the user. It also permits key/agent rejection fallback.
      cfg.password = "";
      const configuredMethods = auth.methodOrder || [
        ...(auth.privateKey ? ["publickey" as const] : []),
        ...(auth.agent ? ["agent" as const] : []),
        ...(auth.password !== undefined || promptPassword ? ["password" as const] : []),
        ...(auth.tryKeyboard ? ["keyboard-interactive" as const] : []),
      ];
      const methods: AuthenticationType[] = configuredMethods.filter((method) => {
        if (method === "publickey") return Boolean(auth.privateKey);
        if (method === "agent") return Boolean(auth.agent);
        if (method === "password") return auth.password !== undefined || promptPassword === true;
        if (method === "keyboard-interactive") return auth.tryKeyboard === true;
        return false;
      });
      let methodIndex = 0;
      cfg.authHandler = (available, partialSuccess, next) => {
        // ssh2 accepts false as an abort at runtime; @types/ssh2 omits this
        // documented-by-implementation sentinel from NextAuthHandler.
        const reject = next as unknown as (selection: AuthenticationType | AnyAuthMethod | false) => void;
        if (!available) {
          next("none");
          return;
        }
        diagnostic.partialSuccess = partialSuccess;
        const method = methods.slice(methodIndex).find((candidate) => {
          const serverMethod = candidate === "agent" ? "publickey" : candidate;
          return available.includes(serverMethod);
        });
        if (!method) {
          reject(false);
          return;
        }
        methodIndex = methods.indexOf(method) + 1;
        if (method !== "password" || auth.password !== undefined) {
          next(method);
          return;
        }
        if (!onPasswordPrompt) {
          reject(false);
          return;
        }
        readyDeadline?.pause();
        let completed = false;
        try {
          onPasswordPrompt((password) => {
            if (completed) return;
            completed = true;
            try {
              if (password === null) {
                diagnostic.cancelled = true;
                reject(false);
              } else next({ type: "password", username, password } as AnyAuthMethod);
            } finally {
              readyDeadline?.resume();
            }
          });
        } catch {
          readyDeadline?.resume();
          reject(false);
        }
      };
    }
  }

  private createAuthDiagnostic(host: HostLike, auth: AuthConfig): AuthFailureDiagnostic {
    return {
      host,
      auth,
      failedMethods: new Set(),
      skippedMethods: new Set(),
      serverMethods: [],
      unknownServerMethods: false,
      partialSuccess: null,
      cancelled: false,
    };
  }

  private captureAuthDiagnostic(diagnostic: AuthFailureDiagnostic, message: string): void {
    const serverMethods = /^Inbound: Received USERAUTH_FAILURE \(([^)]*)\)$/.exec(message);
    if (serverMethods) {
      const advertised = serverMethods[1]!
        .split(",")
        .map((method) => method.trim())
        .filter(Boolean);
      diagnostic.unknownServerMethods = advertised.some(
        (method) => !AUTH_METHOD_NAMES.has(method as AuthenticationType),
      );
      diagnostic.serverMethods = advertised.filter((method): method is AuthenticationType =>
        AUTH_METHOD_NAMES.has(method as AuthenticationType),
      );
      return;
    }

    const failedMethod = /^Client: (password|publickey|agent|keyboard-interactive|hostbased) auth failed$/.exec(
      message,
    );
    if (failedMethod) {
      diagnostic.failedMethods.add(failedMethod[1] as AuthenticationType);
      return;
    }

    if (
      message === "Skipping invalid key auth attempt" ||
      message === "Skipping key authentication (no mutual hash algorithm)"
    ) {
      diagnostic.skippedMethods.add("publickey");
    } else if (message === "Skipping invalid password auth attempt") {
      diagnostic.skippedMethods.add("password");
    } else if (message === "Skipping invalid keyboard-interactive auth attempt") {
      diagnostic.skippedMethods.add("keyboard-interactive");
    }
  }

  private withAuthDiagnostics(error: unknown): unknown {
    if (!(error instanceof Error) || !this.authFailureDiagnostic) return error;
    const extension = error as Error & ClientErrorExtensions;
    if (extension.level !== "client-authentication" || error.message !== "All configured authentication methods failed")
      return error;

    const diagnostic = this.authFailureDiagnostic;
    if (diagnostic.cancelled) return error;
    const configured = diagnostic.auth.configuredMethods || diagnostic.auth.methodOrder || [];
    const labels = (methods: AuthenticationType[]) =>
      [...new Set(methods)].map((method) => AUTH_METHOD_LABELS[method] || method).join(", ");
    const host = sanitizeDiagnosticText(diagnostic.host.host);
    const username = sanitizeDiagnosticText(diagnostic.host.username || "");
    const endpoint = `${username ? `${username}@` : ""}${host}${diagnostic.host.port ? `:${diagnostic.host.port}` : ""}`;
    const attempted = [...diagnostic.failedMethods];
    const serverMethods = diagnostic.serverMethods.filter((method) => method !== "none");
    const configuredProtocols = new Set<string>(
      (diagnostic.auth.methodOrder || configured).map((method) => (method === "agent" ? "publickey" : method)),
    );
    const hasOverlap = serverMethods.some((method) => configuredProtocols.has(method));
    const lines = [`SSH authentication failed for ${endpoint}.`];

    if (configured.length) lines.push(`Configured methods: ${labels(configured)}.`);
    const rejected = attempted.filter((method) => method !== "agent");
    if (rejected.length) lines.push(`Methods rejected by the server: ${labels(rejected)}.`);
    if (attempted.includes("agent")) lines.push("SSH agent authentication did not complete successfully.");
    if (diagnostic.skippedMethods.size) {
      lines.push(`The client could not use: ${labels([...diagnostic.skippedMethods])}.`);
    }
    if (serverMethods.length) {
      const offeredLabels = [...new Set(serverMethods)].map((method) => SERVER_AUTH_METHOD_LABELS[method] || method);
      lines.push(`Server-advertised methods: ${offeredLabels.join(", ")}.`);
    }
    if (diagnostic.unknownServerMethods) {
      lines.push("The server also advertised authentication methods this client does not recognize.");
    }

    const unavailable = diagnostic.auth.unavailableMethods || [];
    if (unavailable.includes("agent")) {
      lines.push("The selected SSH agent is unavailable. Start/configure an agent or choose another method.");
    }
    if (unavailable.includes("publickey")) {
      lines.push("No saved private key was resolved for public-key authentication. Select or import a key.");
    }
    if (unavailable.includes("password")) {
      lines.push("No saved password was resolved. Update the saved credential or choose interactive sign-in.");
    }

    if (diagnostic.partialSuccess === true) {
      lines.push("The server accepted an authentication factor and requires another.");
    } else if (configured.length && (serverMethods.length > 0 || diagnostic.unknownServerMethods) && !hasOverlap) {
      lines.push("The server currently offers none of the configured authentication methods.");
    } else if (rejected.length || attempted.includes("agent")) {
      lines.push("The server did not explain whether the rejected credentials or account policy caused the failure.");
    } else if (!unavailable.length) {
      lines.push("Authentication ended before a configured method received a conclusive response.");
    }

    lines.push("Check that this account is allowed to use the selected methods, then try again.");
    return Object.assign(new Error(lines.join(" ")), { level: extension.level });
  }

  // `hostVerifier` in ssh2 receives the raw host key Buffer (plus a callback
  // for async verdict). We compute the fingerprint ourselves, check the store,
  // and escalate to the user on mismatch via onHostKeyDecision.
  _makeHostVerifier(
    host: HostLike,
    verify?: (args: { key: Buffer }) => HostKeyVerdict,
    onAccepted?: (info: HostKeyInfo) => void,
    onDecision?: (info: HostKeyMismatchInfo, callback: (accept: boolean) => void) => void,
  ): (keyOrHash: Buffer, callback: (valid: boolean) => void) => boolean | undefined {
    return (keyOrHash: Buffer, callback: (valid: boolean) => void): boolean | undefined => {
      try {
        const result: HostKeyVerdict | { ok: true } = verify ? verify({ key: keyOrHash }) : { ok: true };
        if (result && typeof result === "object") {
          if (result.ok === true) {
            // Capture fingerprint so the caller can persist it on successful
            // connect (handles first-time TOFU acceptance).
            const r = result as { ok: true; first?: boolean; fingerprint?: string; keyType?: string };
            if (r.first && r.fingerprint && typeof onAccepted === "function") {
              onAccepted({ fingerprint: r.fingerprint, keyType: r.keyType || "", first: true });
            }
            if (typeof callback === "function") callback(true);
            return true;
          }
          const mismatch = result as {
            ok: false;
            mismatch?: boolean;
            fingerprint?: string;
            keyType?: string;
            previous?: { fingerprint: string; keyType: string; addedAt: string } | null;
          };
          const decision = onDecision || this.onHostKeyDecision;
          if (mismatch.mismatch && decision) {
            decision(
              {
                fingerprint: mismatch.fingerprint || "",
                keyType: mismatch.keyType || "",
                previous: mismatch.previous || null,
              },
              (accept) => {
                if (accept && typeof onAccepted === "function") {
                  onAccepted({
                    fingerprint: mismatch.fingerprint || "",
                    keyType: mismatch.keyType || "",
                    first: false,
                  });
                }
                if (typeof callback === "function") callback(!!accept);
              },
            );
            return; // decision pending
          }
          // strict new-host rejection
          if (typeof callback === "function") callback(false);
          return false;
        }
        // Backward-compat: legacy verify that returned a plain boolean.
        if (typeof callback === "function") callback(!!result);
        return !!result;
      } catch {
        if (typeof callback === "function") callback(false);
        return false;
      }
    };
  }

  write(data: string): void {
    if (this.stream) this.stream.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.stream) this.stream.setWindow(rows, cols, 0, 0);
  }

  async stop(): Promise<void> {
    this.cancelAuthenticatedAction?.();
    this.cancelAuthenticatedAction = undefined;
    for (const deadline of this.readyDeadlines) deadline.clear();
    this.readyDeadlines.clear();
    try {
      if (this.stream) this.stream.end();
    } catch {
      // already closed
    }
    try {
      if (this.client) this.client.end();
    } catch {
      // already closed
    }
    for (const jc of this.jumpClients) {
      try {
        jc.end();
      } catch {
        // already closed
      }
    }
    if (!this.authOnly) this.ready = false;
  }

  private createReadyDeadline(client: Ssh2Client): ReadyDeadline {
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    let paused = false;
    let removeFromSet = () => {};
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const startTimer = () => {
      if (closed || paused || this.readyTimeoutMs <= 0) return;
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        closed = true;
        removeFromSet();
        const error = Object.assign(new Error("Timed out while waiting for handshake"), { level: "client-timeout" });
        client.emit("error", error);
        client.destroy();
      }, this.readyTimeoutMs);
    };
    const deadline: ReadyDeadline = {
      pause: () => {
        if (closed) return;
        paused = true;
        clearTimer();
      },
      resume: () => {
        if (closed) return;
        paused = false;
        startTimer();
      },
      restart: () => startTimer(),
      clear: () => {
        if (closed) return;
        closed = true;
        clearTimer();
        removeFromSet();
      },
    };
    this.readyDeadlines.add(deadline);
    removeFromSet = () => this.readyDeadlines.delete(deadline);
    startTimer();
    return deadline;
  }
}
