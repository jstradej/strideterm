import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig, Prompt } from "ssh2";
import type { AuthConfig } from "./ssh-auth.js";
import type { HostKeyVerdict } from "./ssh-known-hosts.js";

const KEEPALIVE_INTERVAL = 30000;
const KEEPALIVE_MAX = 3;
const READY_TIMEOUT = 20000;

interface HostAdvanced {
  command?: string;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  compression?: boolean;
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
  onHostKeyDecision?: (info: HostKeyMismatchInfo, callback: (accept: boolean) => void) => void;
  onReady?: () => void;
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
  onHostKeyDecision?: (info: HostKeyMismatchInfo, callback: (accept: boolean) => void) => void;
  onReady?: () => void;
  client: Client | null;
  stream: ClientChannel | null;
  jumpClients: Client[];
  ready: boolean;
  ended: boolean;
  verifiedHostKey: HostKeyInfo | null;

  constructor(opts: SshSessionOpts) {
    this.host = opts.host;
    this.auth = opts.auth || {};
    this.jumps = opts.jumps || [];
    this.dimensions = opts.dimensions || { cols: 80, rows: 24 };
    this.verify = opts.verify;
    this.onData = opts.onData;
    this.onExit = opts.onExit;
    this.onAuthPrompt = opts.onAuthPrompt;
    this.onHostKeyDecision = opts.onHostKeyDecision;
    this.onReady = opts.onReady;
    this.client = null;
    this.stream = null;
    this.jumpClients = [];
    this.ready = false;
    this.ended = false;
    // Populated by the primary host verifier; the manager persists this on
    // successful connect for first-time hosts under accept-new/warn policy.
    this.verifiedHostKey = null;
  }

  async start(): Promise<void> {
    const sock = await this._connectChain();

    return new Promise<void>((resolve, reject) => {
      const client = new Client();
      this.client = client;

      let settled = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finish = (fn: (arg?: any) => void, arg?: unknown) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };

      client
        .on("ready", () => {
          this.ready = true;
          client.shell(
            {
              term: "xterm-256color",
              cols: this.dimensions.cols || 80,
              rows: this.dimensions.rows || 24,
            },
            (err, stream) => {
              if (err) {
                finish(reject, err);
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
        .on("keyboard-interactive", (name: string, instructions: string, _lang: string, prompts: Prompt[], finishPrompt: (responses: string[]) => void) => {
          this.onAuthPrompt?.({ name, instructions, prompts, finish: finishPrompt });
        })
        .on("banner", (msg: string) => this.onData?.(msg))
        .on("error", (err: Error) => {
          if (this.ready) {
            // Post-ready errors: treat as exit with nonzero code, not as start() reject.
            if (this.ended) return;
            this.ended = true;
            this.onExit?.({ exitCode: 1, signal: null, error: err.message });
            return;
          }
          finish(reject, err);
        })
        .on("close", () => {
          if (!this.ready) {
            finish(reject, new Error("Connection closed before ready"));
            return;
          }
          if (this.ended) return;
          this.ended = true;
          this.onExit?.({ exitCode: 0, signal: null });
        });

      client.connect(this._buildConnectConfig(sock));
    });
  }

  async _connectChain(): Promise<ClientChannel | null> {
    if (this.jumps.length === 0) return null;

    let currentSock: ClientChannel | null = null;
    this.jumpClients = [];

    for (let i = 0; i < this.jumps.length; i += 1) {
      const jump = this.jumps[i]!;
      const jumpClient = new Client();
      this.jumpClients.push(jumpClient);

      await new Promise<void>((resolveConnect, rejectConnect) => {
        let settled = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const settle = (fn: (arg?: any) => void, arg?: unknown) => {
          if (settled) return;
          settled = true;
          fn(arg);
        };
        jumpClient.on("ready", () => settle(resolveConnect));
        jumpClient.on("error", (err: Error) => settle(rejectConnect, err));
        jumpClient.on("close", () => {
          if (!settled) settle(rejectConnect, new Error("Jump connection closed"));
        });

        const cfg: ConnectConfig = {
          host: jump.host.host,
          port: jump.host.port || 22,
          username: jump.host.username,
          ...jump.auth,
          readyTimeout: READY_TIMEOUT,
          hostVerifier: this._makeHostVerifier(jump.host, jump.verify),
        };
        if (currentSock) cfg.sock = currentSock;
        jumpClient.connect(cfg);
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

  _buildConnectConfig(sock: ClientChannel | null): ConnectConfig {
    // `compress` is a legacy top-level ConnectConfig option that is not present
    // in the @types/ssh2 typings (it belongs in algorithms.compress) but ssh2
    // at runtime accepts it directly. Cast through unknown to keep the logic.
     
    const cfg = {
      host: this.host.host,
      port: this.host.port || 22,
      username: this.host.username,
      ...this.auth,
      readyTimeout: READY_TIMEOUT,
      keepaliveInterval: this.host.advanced?.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL,
      keepaliveCountMax: this.host.advanced?.keepaliveCountMax ?? KEEPALIVE_MAX,
      compress: this.host.advanced?.compression !== false,
      algorithms: this.host.advanced?.algorithms || undefined,
      hostVerifier: this._makeHostVerifier(this.host, this.verify, (info) => {
        this.verifiedHostKey = info;
      }),
    } as ConnectConfig;
    if (sock) cfg.sock = sock;
    return cfg;
  }

  // `hostVerifier` in ssh2 receives the raw host key Buffer (plus a callback
  // for async verdict). We compute the fingerprint ourselves, check the store,
  // and escalate to the user on mismatch via onHostKeyDecision.
  _makeHostVerifier(
    host: HostLike,
    verify?: (args: { key: Buffer }) => HostKeyVerdict,
    onAccepted?: (info: HostKeyInfo) => void,
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
          const mismatch = result as { ok: false; mismatch?: boolean; fingerprint?: string; keyType?: string; previous?: { fingerprint: string; keyType: string; addedAt: string } | null };
          if (mismatch.mismatch && this.onHostKeyDecision) {
            this.onHostKeyDecision(
              { fingerprint: mismatch.fingerprint || "", keyType: mismatch.keyType || "", previous: mismatch.previous || null },
              (accept) => {
                if (accept && typeof onAccepted === "function") {
                  onAccepted({ fingerprint: mismatch.fingerprint || "", keyType: mismatch.keyType || "", first: false });
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
    this.ready = false;
  }
}
