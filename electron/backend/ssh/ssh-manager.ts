import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import ssh2 from "ssh2";
import { SshSession } from "./ssh-session.js";
import { verifyHostKey, recordHostKey } from "./ssh-known-hosts.js";
import type { Store as KnownHostsStore } from "./ssh-known-hosts.js";
import { buildAuth } from "./ssh-auth.js";
import type { SshHostUpdate } from "../ipc-schemas.js";

const { utils } = ssh2;
import type { CredentialStore } from "../shared/credential-store.js";
import type { Logger } from "../logger.js";
import type { SshConnectionSettings } from "../../shared/ssh-connection.js";
import type { SshKey } from "../../shared/types/ssh.js";
import type { SshSettings } from "../../shared/types/state.js";
import type { Client as Ssh2Client } from "ssh2";
import type { AuthConfig } from "./ssh-auth.js";

interface HostRecord {
  id: string;
  host: string;
  port?: number;
  username?: string;
  name?: string;
  jump?: string[];
  auth?: {
    methods?: string[];
    passwordRef?: string;
    keyRef?: string;
    passphraseRef?: string;
    certRef?: string;
    agent?: string | null;
  };
  advanced?: {
    command?: string;
    keepaliveIntervalMs?: number;
    keepaliveCountMax?: number;
    compression?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    algorithms?: any;
    launchVia?: string;
    sshPath?: string;
    portOverride?: boolean;
    env?: Record<string, string> | null;
    wsl?: { distro?: string | null; user?: string | null; exec?: string };
  };
  hostKeyPolicy?: string;
  createdAt?: string;
  updatedAt?: string;
  lastConnectedAt?: string | null;
  tags?: string[];
}

interface AppState {
  settings?: { ssh?: Partial<SshConnectionSettings> };
  workspaces?: Array<{
    id: string;
    name: string;
    panels?: Array<{ id: string; title: string; launch?: { sshHostId?: string } | null }>;
  }>;
  ssh?: {
    hosts?: HostRecord[];
    keys?: SshKey[];
    certificates?: unknown[];
    knownHosts?: Record<string, unknown>;
    settings?: Partial<SshSettings>;
  };
}

// Store is compatible with KnownHostsStore — the manager's AppState uses
// HostRecord[] for hosts (more specific) but Record<string, unknown> for
// knownHosts (less specific). Cast to KnownHostsStore when passing to
// ssh-known-hosts functions.
type Store = {
  getState(): AppState;
  mutate(mutator: (state: AppState) => void): Promise<unknown>;
};

interface PendingSession {
  // Per-generation prompt token. A rapid Disconnect→reconnect (or Restart) reuses
  // the sessionId, so an answer/dismiss must be scoped to the generation that
  // raised the prompt — otherwise a stale dialog's answer could be delivered to a
  // newer connection (incl. accepting a DIFFERENT host key). Echoed in every
  // ssh:auth-prompt / ssh:host-key-change payload and required back on answers.
  promptId: string;
  activePromptId: string;
  finishKeyboard: ((answers: string[]) => void) | null;
  finishPassword: ((password: string | null) => void) | null;
  resolvePreAuth: ((value: string) => void) | null;
  rejectPreAuth: ((error: Error) => void) | null;
  acceptHostKeyCb: ((accept: boolean) => void) | null;
  hostKeyInfo: { host: HostRecord; fingerprint: string; keyType: string; previous: unknown } | null;
  hostKeyDecisionInProgress?: boolean;
}

interface CreateSessionOpts {
  sessionId: string;
  hostId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inlineHost?: any;
  cols: number;
  rows: number;
  onData?: (data: string) => void;
  onExit?: (exit: { exitCode: number; signal: string | null; error?: string }) => void;
  authOnly?: boolean;
  authOverride?: HostRecord["auth"];
  forceOneTimePasswordForJumps?: boolean;
  jumpHostOverrides?: Record<string, HostRecord>;
  onAuthenticated?: (client: Ssh2Client, auth: AuthConfig) => Promise<void> | void;
  skipLastConnectedAt?: boolean;
  validatePrivateKeyBeforeConnect?: boolean;
  authenticatedActionTimeoutMs?: number;
}

interface SshManagerOpts {
  store: Store;
  credentialStore: CredentialStore;
  logger?: Logger | Console;
}

export class SshManager extends EventEmitter {
  store: Store;
  credentialStore: CredentialStore;
  log: Logger | Console;
  activeSessions: Map<string, SshSession>;
  pendingPrompts: Map<string, PendingSession>;
  // Monotonic source of per-generation prompt tokens (see PendingSession.promptId).
  promptSeq: number;

  constructor({ store, credentialStore, logger }: SshManagerOpts) {
    super();
    this.store = store;
    this.credentialStore = credentialStore;
    this.log = logger || console;
    this.activeSessions = new Map();
    // Per-session pending state: { finishKeyboard, pendingHostKey, acceptHostKeyCb }
    this.pendingPrompts = new Map();
    this.promptSeq = 0;
  }

  // ---- host book CRUD ----

  listHosts(): HostRecord[] {
    return this.store.getState().ssh?.hosts || [];
  }

  getHost(id: string): HostRecord | undefined {
    return this.listHosts().find((h) => h.id === id);
  }

  async renameKey({ id, label }: { id: string; label: string }): Promise<SshKey | null> {
    const trimmedLabel = label.trim();
    if (!trimmedLabel || trimmedLabel.length > 60) {
      throw new Error("SSH key label must be between 1 and 60 characters.");
    }

    let renamed: SshKey | null = null;
    await this.store.mutate((state) => {
      if (!state.ssh || !Array.isArray(state.ssh.keys)) return;
      const index = state.ssh.keys.findIndex((key) => key.id === id);
      if (index === -1) return;
      renamed = { ...state.ssh.keys[index]!, label: trimmedLabel };
      state.ssh.keys[index] = renamed;
    });
    if (renamed) this.emit("ssh:state");
    return renamed;
  }

  async createHost(
    partial: Omit<HostRecord, "id" | "createdAt" | "updatedAt" | "lastConnectedAt">,
  ): Promise<HostRecord> {
    const id = "h_" + randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    const newHost: HostRecord = {
      ...partial,
      auth: partial.auth || { methods: ["publickey"] },
      jump: partial.jump || [],
      advanced: partial.advanced || { launchVia: "default" },
      id,
      createdAt: now,
      updatedAt: now,
      lastConnectedAt: null,
    };

    await this.store.mutate((state) => {
      if (!state.ssh) state.ssh = { hosts: [], keys: [], certificates: [], knownHosts: {}, settings: {} };
      if (!Array.isArray(state.ssh.hosts)) state.ssh.hosts = [];
      state.ssh.hosts.push(newHost);
    });
    this.emit("ssh:state");
    return newHost;
  }

  async updateHost(id: string, patch: SshHostUpdate["patch"]): Promise<HostRecord | null> {
    let updated: HostRecord | null = null;
    await this.store.mutate((state) => {
      if (!state.ssh || !Array.isArray(state.ssh.hosts)) return;
      const idx = state.ssh.hosts.findIndex((h) => h.id === id);
      if (idx === -1) return;
      const current = state.ssh.hosts[idx]!;
      const advancedPatch =
        patch.advanced && patch.advanced !== null
          ? ({ ...patch.advanced } as unknown as NonNullable<HostRecord["advanced"]>)
          : undefined;
      if (advancedPatch && patch.advanced && patch.advanced !== null) {
        if (patch.advanced.command === null) advancedPatch.command = undefined;
        if (patch.advanced.keepaliveIntervalMs === null) advancedPatch.keepaliveIntervalMs = undefined;
        if (patch.advanced.keepaliveCountMax === null) advancedPatch.keepaliveCountMax = undefined;
        if (patch.advanced.compression === null) advancedPatch.compression = undefined;
        if (patch.advanced.env === null) advancedPatch.env = undefined;
        if (patch.advanced.sshPath === null) advancedPatch.sshPath = undefined;
      }
      const hostPatch = {
        ...(patch as unknown as Partial<HostRecord>),
        ...(patch.port === null ? { port: undefined } : {}),
        ...(patch.username === null ? { username: undefined } : {}),
        ...(patch.hostKeyPolicy === null ? { hostKeyPolicy: undefined } : {}),
        ...(patch.advanced === null ? { advanced: undefined } : advancedPatch ? { advanced: advancedPatch } : {}),
      };
      const next: HostRecord = {
        ...current,
        ...hostPatch,
        ...(patch.auth ? { auth: { ...current.auth, ...patch.auth } } : {}),
        ...(advancedPatch
          ? {
              advanced: {
                ...current.advanced,
                ...advancedPatch,
                ...(advancedPatch.wsl && typeof advancedPatch.wsl === "object"
                  ? { wsl: { ...current.advanced?.wsl, ...advancedPatch.wsl } }
                  : {}),
              },
            }
          : {}),
        ...(patch.advanced?.wsl === null
          ? { advanced: { ...current.advanced, ...advancedPatch, wsl: undefined } }
          : {}),
        ...(patch.advanced === null ? { advanced: undefined } : {}),
        id,
        updatedAt: new Date().toISOString(),
      };
      state.ssh.hosts[idx] = next;
      updated = next;
    });
    if (updated) this.emit("ssh:state");
    return updated;
  }

  async deleteHost(id: string): Promise<
    | { ok: true }
    | {
        ok: false;
        error: "in-use";
        hosts: Array<{ id: string; name: string }>;
        workspaces: Array<{ workspaceId: string; workspaceName: string; panelId: string; panelTitle: string }>;
      }
  > {
    let result:
      | { ok: true }
      | {
          ok: false;
          error: "in-use";
          hosts: Array<{ id: string; name: string }>;
          workspaces: Array<{ workspaceId: string; workspaceName: string; panelId: string; panelTitle: string }>;
        } = { ok: true };
    await this.store.mutate((state) => {
      if (!state.ssh) return;
      const current = state.ssh.hosts || [];
      if (!current.some((host) => host.id === id)) return;
      const hosts = current
        .filter((host) => host.jump?.includes(id))
        .map((host) => ({ id: host.id, name: host.name || host.host }));
      const workspaces = (state.workspaces || []).flatMap((workspace) =>
        (workspace.panels || [])
          .filter((panel) => panel.launch?.sshHostId === id)
          .map((panel) => ({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            panelId: panel.id,
            panelTitle: panel.title,
          })),
      );
      if (hosts.length || workspaces.length) {
        result = { ok: false, error: "in-use", hosts, workspaces };
        return;
      }
      state.ssh.hosts = current.filter((host) => host.id !== id);
    });
    if (result.ok) this.emit("ssh:state");
    return result;
  }

  // ---- session lifecycle ----

  /**
   * Start a new session against either a saved host (by id) or an inline
   * ad-hoc host definition. Caller provides exactly one:
   *   - { hostId: "h_abc" }                 → look up in host book
   *   - { inlineHost: { host, user, … } }   → transient, not persisted
   *
   * Inline hosts get a synthetic id like `inline:<sessionId>` so logs and
   * jump-chain resolution don't have to special-case them.
   */
  async createSession({
    sessionId,
    hostId,
    inlineHost,
    cols,
    rows,
    onData,
    onExit,
    authOnly,
    authOverride,
    forceOneTimePasswordForJumps,
    jumpHostOverrides,
    onAuthenticated,
    skipLastConnectedAt,
    validatePrivateKeyBeforeConnect,
    authenticatedActionTimeoutMs,
  }: CreateSessionOpts): Promise<SshSession> {
    let host: HostRecord;
    if (inlineHost) {
      host = {
        id: `inline:${sessionId}`,
        jump: [],
        ...inlineHost,
      } as HostRecord;
    } else {
      const found = this.getHost(hostId!);
      if (!found) throw new Error(`SSH host not found: ${hostId}`);
      host = found;
    }
    if (authOverride) host = { ...host, auth: authOverride };

    // Register the pending record BEFORE the first await. ssh2 auth and
    // jump-host credential resolution below are async, and a teardown (stop() /
    // Disconnect / workspace prune) can land in that window. Without an entry in
    // the map here, stop() would find neither an active session nor a pending
    // record and no-op — the connect would then sail past the teardown and park
    // on a prompt/handshake nothing can reach. The abort check after the awaits
    // detects a teardown that removed this record and rejects the connect. The
    // record identity also drives the generation guard (isSupersededGeneration).
    const pending: PendingSession = {
      promptId: `${sessionId}#${++this.promptSeq}`,
      activePromptId: "",
      finishKeyboard: null,
      finishPassword: null,
      resolvePreAuth: null,
      rejectPreAuth: null,
      acceptHostKeyCb: null,
      hostKeyInfo: null,
    };
    this.pendingPrompts.set(sessionId, pending);

    let auth: Awaited<ReturnType<typeof buildAuth>>;
    // Resolve jump chain: each hop needs its own auth built from its credential refs.
    const jumps: {
      host: HostRecord;
      auth: typeof auth;
      verify: (args: { key: Buffer }) => ReturnType<typeof verifyHostKey>;
      onAccepted: (info: { fingerprint: string; keyType: string; first?: boolean }) => void;
      onAuthPrompt: (info: {
        name: string;
        instructions: string;
        prompts: import("ssh2").Prompt[];
        finish: (answers: string[]) => void;
      }) => void;
      onPasswordPrompt: (finish: (password: string | null) => void) => void;
      onHostKeyDecision: (
        info: { fingerprint: string; keyType: string; previous: unknown },
        callback: (accept: boolean) => void,
      ) => void;
    }[] = [];
    try {
      auth = await this.resolveAuth(host, sessionId, pending);
      if (validatePrivateKeyBeforeConnect) {
        if (!auth.privateKey) throw new Error("The selected managed private key is unavailable.");
        const parsedKey = utils.parseKey(auth.privateKey, auth.passphrase);
        if (parsedKey instanceof Error || Array.isArray(parsedKey) || !parsedKey.isPrivateKey()) {
          throw new Error("The selected managed private key is invalid or its passphrase is incorrect.");
        }
      }
      for (const jId of host.jump || []) {
        const storedJump = jumpHostOverrides?.[jId] || this.getHost(jId);
        if (!storedJump) throw new Error(`Jump host not found: ${jId}`);
        const jHost = forceOneTimePasswordForJumps
          ? {
              ...storedJump,
              auth: {
                ...storedJump.auth,
                passwordRef: undefined,
                methods: [...new Set([...(storedJump.auth?.methods || []), "password", "keyboard-interactive"])],
              },
            }
          : storedJump;
        const jAuth = await this.resolveAuth(jHost, sessionId, pending);
        jumps.push({
          host: jHost,
          auth: jAuth,
          verify: ({ key }) => verifyHostKey(this.store as KnownHostsStore, jHost, { key }),
          onAccepted: (info) => {
            if (!info.first || this.pendingPrompts.get(sessionId) !== pending) return;
            recordHostKey(
              this.store as KnownHostsStore,
              jHost,
              info,
              () => this.pendingPrompts.get(sessionId) === pending,
            ).catch((err) => (this.log as Logger).warn?.("failed to persist jump host key", { hostId: jHost.id, err }));
          },
          onAuthPrompt: (info) => this.showKeyboardPrompt(sessionId, pending, jHost, info),
          onPasswordPrompt: (finish) => this.showPasswordPrompt(sessionId, pending, jHost, finish),
          onHostKeyDecision: (info, callback) => this.showHostKeyPrompt(sessionId, pending, jHost, info, callback),
        });
      }
    } catch (err) {
      // Auth/jump resolution failed → drop the up-front pending record so it
      // doesn't leak, then rethrow to the caller. Guard the delete: a concurrent
      // teardown may already have removed or replaced it.
      if (this.pendingPrompts.get(sessionId) === pending) this.pendingPrompts.delete(sessionId);
      throw err;
    }

    // A teardown that landed while buildAuth/jump-auth was resolving removed our
    // record from the map (or a newer generation replaced it). Abort now instead
    // of connecting into a session the caller already tore down.
    if (this.pendingPrompts.get(sessionId) !== pending) {
      throw new Error("SSH connect cancelled");
    }

    // ANSI-colored status banner so the user always sees *something* in the
    // terminal, even while connecting / after a failure. ssh2's `connect()`
    // doesn't emit any data until "ready", so without this the pane is black.
    const banner = (text: string, color = "90") => onData?.(`\r\n\x1b[${color}m${text}\x1b[0m\r\n`);
    const hostLabel = `${host.username || "?"}@${host.host}${host.port && host.port !== 22 ? `:${host.port}` : ""}`;
    banner(`── Connecting to ${hostLabel} …`);

    const methods = host.auth?.methods || [];

    // If the user picked "agent" but no agent is reachable AND no other
    // credential source is set up, ssh2 will fail with a generic
    // "authentication methods failed" — surface the real reason up-front.
    const hasAnyAuthMaterial = Boolean(
      auth.password || auth.privateKey || auth.agent || auth.tryKeyboard || auth.promptPassword,
    );
    if (!hasAnyAuthMaterial) {
      banner(
        `⚠ No authentication material resolved for method(s): ${methods.join(", ") || "(none)"}. ` +
          `Check that your SSH agent is running, or import a key / enable password auth.`,
        "33",
      );
    }

    const session = new SshSession({
      host,
      auth,
      jumps,
      dimensions: { cols, rows },
      verify: ({ key }) => verifyHostKey(this.store as KnownHostsStore, host, { key }),
      onData,
      onExit: (exit) => {
        // Generation guard: a late stream/client close from a SUPERSEDED
        // generation (a rapid Restart or Disconnect→Reconnect reuses this
        // sessionId) must not tear down the CURRENT generation. If a newer
        // generation now owns the id, drop this exit — otherwise it would
        // delete the live session/prompt and (via terminal:exit) clear the new
        // generation's replay.
        if (this.pendingPrompts.get(sessionId) !== pending) return;
        if (pending.activePromptId) this.emitPromptDismiss(sessionId, pending.activePromptId);
        this.activeSessions.delete(sessionId);
        this.pendingPrompts.delete(sessionId);
        this.emit("ssh:connection-state", {
          sessionId,
          hostId: host.id,
          status: exit?.error ? "error" : "disconnected",
          connected: false,
          ...(exit?.error ? { error: exit.error } : {}),
        });
        banner(exit?.error ? `✗ Disconnected: ${exit.error}` : "── Disconnected", exit?.error ? "31" : "90");
        onExit?.(exit);
      },
      onAuthPrompt: (info) => this.showKeyboardPrompt(sessionId, pending, host, info),
      onPasswordPrompt: (finish) => this.showPasswordPrompt(sessionId, pending, host, finish),
      onHostKeyDecision: ({ fingerprint, keyType, previous }, callback) => {
        this.showHostKeyPrompt(sessionId, pending, host, { fingerprint, keyType, previous }, callback);
      },
      onReady: () => {
        if (this.pendingPrompts.get(sessionId) !== pending) return;
        this.emit("ssh:connection-state", { sessionId, hostId: host.id, status: "connected", connected: true });
        // Persist fingerprint for first-time TOFU accept (mismatch acceptance
        // is persisted separately via acceptHostKey("permanent")).
        const activeSession = this.activeSessions.get(sessionId);
        if (activeSession?.verifiedHostKey?.first) {
          recordHostKey(
            this.store as KnownHostsStore,
            host,
            activeSession.verifiedHostKey,
            () =>
              this.pendingPrompts.get(sessionId) === pending && this.activeSessions.get(sessionId) === activeSession,
          ).catch((err) => (this.log as Logger).warn?.("failed to persist host key", { hostId: host.id, err }));
        }
        // Fire-and-forget lastConnectedAt bump.
        if (!skipLastConnectedAt && !host.id.startsWith("inline:")) {
          this.store
            .mutate((state) => {
              if (
                this.pendingPrompts.get(sessionId) !== pending ||
                this.activeSessions.get(sessionId) !== activeSession
              )
                return;
              const idx = (state.ssh?.hosts || []).findIndex((h) => h.id === host.id);
              if (idx !== -1) state.ssh!.hosts![idx]!.lastConnectedAt = new Date().toISOString();
            })
            .catch(() => {});
        }
      },
      onAuthenticated: onAuthenticated ? (client) => onAuthenticated(client, auth) : undefined,
      authOnly,
      authenticatedActionTimeoutMs,
    });

    this.activeSessions.set(sessionId, session);
    this.emit("ssh:connection-state", { sessionId, hostId: host.id, status: "connecting", connected: false });

    try {
      await session.start();
      // Ownership guard: a teardown (stop) removed us from activeSessions while
      // start() was completing, or a newer generation replaced us. Returning this
      // now-orphaned connection would leave a live-but-untracked ssh2 client
      // emitting under the shared id (racing the current owner). Tear it down
      // quietly instead — the current owner drives the UI.
      if (this.activeSessions.get(sessionId) !== session) {
        await session.stop().catch(() => {});
        throw new Error("SSH connect superseded");
      }
      return session;
    } catch (err) {
      // Skip the failure cleanup/UI when we no longer own this id (a rapid Restart
      // or Disconnect→Reconnect installed a newer generation, including the
      // superseded case above) — otherwise we'd clobber the successor's state or
      // emit a spurious "Connection failed" banner for a superseded connect.
      if (this.activeSessions.get(sessionId) === session && this.pendingPrompts.get(sessionId) === pending) {
        if (pending.activePromptId) this.emitPromptDismiss(sessionId, pending.activePromptId);
        await session.stop().catch(() => {});
        this.activeSessions.delete(sessionId);
        this.pendingPrompts.delete(sessionId);
        this.emit("ssh:connection-state", {
          sessionId,
          hostId: host.id,
          status: "error",
          connected: false,
          error: (err as Error).message,
        });
        banner(`✗ Connection failed: ${(err as Error).message}`, "31");
      }
      throw err;
    }
  }

  /**
   * True when a NEWER generation has taken over this sessionId (a rapid Restart
   * or Disconnect→Reconnect reuses the id). Every generation installs its own
   * `pending` record before it creates its SshSession, so a pending entry that
   * is no longer *this* generation's proves a successor now owns the id — and a
   * late callback from the old generation must leave the current one alone.
   */
  private isSupersededGeneration(sessionId: string, pending: PendingSession): boolean {
    const current = this.pendingPrompts.get(sessionId);
    return !!current && current !== pending;
  }

  private async resolveAuth(host: HostRecord, sessionId: string, pending: PendingSession) {
    const settings = (this.store.getState().settings?.ssh || {}) as Partial<SshConnectionSettings>;
    const auth = await buildAuth(host, this.credentialStore, settings);
    if (auth.privateKey && !auth.passphrase) {
      const parsedKey = utils.parseKey(auth.privateKey);
      if (parsedKey instanceof Error && /passphrase/i.test(parsedKey.message)) {
        const promptId = this.activatePrompt(pending);
        auth.passphrase = await new Promise<string>((resolve, reject) => {
          pending.resolvePreAuth = resolve;
          pending.rejectPreAuth = reject;
          this.emit("ssh:auth-prompt", {
            sessionId,
            promptId,
            prompt: {
              name: "SSH Key Passphrase",
              instructions: `Unlock the private key for ${host.name || host.host}. This is not the remote account password.`,
              prompts: [{ prompt: "Private key passphrase:", echo: false }],
            },
          });
        });
      }
    }
    return auth;
  }

  private showKeyboardPrompt(
    sessionId: string,
    pending: PendingSession,
    host: HostRecord,
    info: {
      name: string;
      instructions: string;
      prompts: Array<{ prompt: string; echo?: boolean }>;
      finish: (answers: string[]) => void;
    },
  ): void {
    if (this.pendingPrompts.get(sessionId) !== pending) return;
    const promptId = this.activatePrompt(pending);
    pending.finishKeyboard = info.finish;
    this.emit("ssh:auth-prompt", {
      sessionId,
      promptId,
      prompt: {
        name: info.name,
        instructions: info.instructions || `Sign in to ${host.name || host.host}`,
        prompts: info.prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
      },
    });
  }

  private showPasswordPrompt(
    sessionId: string,
    pending: PendingSession,
    host: HostRecord,
    finish: (password: string | null) => void,
  ): void {
    if (this.pendingPrompts.get(sessionId) !== pending) {
      finish(null);
      return;
    }
    const promptId = this.activatePrompt(pending);
    pending.finishPassword = finish;
    this.emit("ssh:auth-prompt", {
      sessionId,
      promptId,
      prompt: {
        name: "SSH Authentication",
        instructions: `Enter password for ${host.username || "user"}@${host.name || host.host}`,
        prompts: [{ prompt: "Password:", echo: false }],
      },
    });
  }

  private showHostKeyPrompt(
    sessionId: string,
    pending: PendingSession,
    host: HostRecord,
    info: { fingerprint: string; keyType: string; previous: unknown },
    callback: (accept: boolean) => void,
  ): void {
    if (this.pendingPrompts.get(sessionId) !== pending) {
      callback(false);
      return;
    }
    const promptId = this.activatePrompt(pending);
    pending.acceptHostKeyCb = callback;
    pending.hostKeyInfo = { host, ...info };
    this.emit("ssh:host-key-change", {
      sessionId,
      promptId,
      host: { name: host.name, host: host.host, port: host.port || 22 },
      fingerprint: info.fingerprint,
      keyType: info.keyType,
      previous: info.previous,
    });
  }

  private activatePrompt(pending: PendingSession): string {
    pending.activePromptId = `${pending.promptId}:${++this.promptSeq}`;
    return pending.activePromptId;
  }

  /**
   * Reject / dismiss every outstanding user-decision on a pending connect so a
   * teardown mid-prompt can't leave the connect hanging. Rejecting the pre-auth
   * promise makes the awaiting createSession reject; answering a keyboard prompt
   * with `[]` or rejecting the host key makes ssh2 close the pre-ready
   * connection, which rejects start(). Safe on a session with no open prompt.
   */
  private cancelPendingDecision(pending: PendingSession): void {
    if (pending.finishKeyboard) {
      try {
        pending.finishKeyboard([]);
      } catch {
        // already settled
      }
      pending.finishKeyboard = null;
    }
    if (pending.rejectPreAuth) {
      pending.rejectPreAuth(new Error("SSH connection cancelled"));
      pending.resolvePreAuth = null;
      pending.rejectPreAuth = null;
    }
    if (pending.finishPassword) {
      pending.finishPassword(null);
      pending.finishPassword = null;
    }
    if (pending.acceptHostKeyCb) {
      try {
        pending.acceptHostKeyCb(false);
      } catch {
        // already settled
      }
      pending.acceptHostKeyCb = null;
    }
  }

  write(sessionId: string, data: string): void {
    this.activeSessions.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.activeSessions.get(sessionId)?.resize(cols, rows);
  }

  /**
   * Tell every connected client to dismiss any auth / host-key dialog it is
   * showing for this decision. Scoped by promptId so a teardown of one
   * generation never closes a newer generation's prompt (Disconnect→reconnect
   * reuses the sessionId).
   */
  private emitPromptDismiss(sessionId: string, promptId: string): void {
    this.emit("ssh:auth-prompt-cancel", { sessionId, promptId });
  }

  async stop(sessionId: string): Promise<void> {
    const s = this.activeSessions.get(sessionId);
    const pending = this.pendingPrompts.get(sessionId);
    this.activeSessions.delete(sessionId);
    this.pendingPrompts.delete(sessionId);
    // Unblock any connect still waiting on user input BEFORE tearing the session
    // down. Without this a teardown that lands while the up-front password prompt
    // (or a mid-connect keyboard-interactive / host-key decision) is open leaves
    // the awaiting createSession promise — and its prompt — hanging forever.
    if (pending) {
      this.cancelPendingDecision(pending);
      // A user-driven teardown (disconnect / workspace removal / backend cancel)
      // all funnel through stop(); tell clients to close the now-dead dialog so a
      // stale password/host-key prompt can't linger on another client.
      this.emitPromptDismiss(sessionId, pending.activePromptId || pending.promptId);
    }
    if (s) await s.stop();
  }

  // ---- prompts: keyboard-interactive (MFA) ----

  answerAuthPrompt(sessionId: string, answers: string[], promptId?: string): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending) return;
    if (typeof promptId !== "string" || !promptId || !pending.activePromptId || pending.activePromptId !== promptId)
      return;
    const decisionId = pending.activePromptId;
    const resolvePreAuth = pending.resolvePreAuth;
    const finishPassword = pending.finishPassword;
    const finishKeyboard = pending.finishKeyboard;
    pending.resolvePreAuth = null;
    pending.rejectPreAuth = null;
    pending.finishPassword = null;
    pending.finishKeyboard = null;
    if (resolvePreAuth) {
      resolvePreAuth(Array.isArray(answers) ? (answers[0] ?? "") : "");
      this.emitPromptDismiss(sessionId, decisionId);
      return;
    }
    if (finishPassword) {
      finishPassword(Array.isArray(answers) ? (answers[0] ?? "") : "");
      this.emitPromptDismiss(sessionId, decisionId);
      return;
    }
    if (!finishKeyboard) {
      (this.log as Logger).warn?.("answerAuthPrompt called with no pending keyboard prompt", { sessionId });
      return;
    }
    try {
      finishKeyboard(answers);
    } finally {
      this.emitPromptDismiss(sessionId, decisionId);
    }
  }

  cancelAuthPrompt(sessionId: string, promptId?: string): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending) return;
    // Never cancel a superseded generation — a stale dialog could otherwise
    // dismiss the CURRENT prompt of a newer connection that reused the id.
    // promptId is mandatory (sshAuthCancelSchema) and the guard is unconditional:
    // an omitted or superseded token is ignored (see answerAuthPrompt).
    if (typeof promptId !== "string" || !promptId || !pending.activePromptId || pending.activePromptId !== promptId)
      return;
    const decisionId = pending.activePromptId;
    const rejectPreAuth = pending.rejectPreAuth;
    const finishPassword = pending.finishPassword;
    const finishKeyboard = pending.finishKeyboard;
    pending.resolvePreAuth = null;
    pending.rejectPreAuth = null;
    pending.finishPassword = null;
    pending.finishKeyboard = null;
    if (rejectPreAuth) {
      rejectPreAuth(new Error("Authentication cancelled"));
      this.emitPromptDismiss(sessionId, decisionId);
      return;
    }
    if (finishPassword) {
      finishPassword(null);
      this.emitPromptDismiss(sessionId, decisionId);
      return;
    }
    if (!finishKeyboard) return;
    try {
      // Passing an empty array lets ssh2 fail auth cleanly.
      finishKeyboard([]);
    } finally {
      this.emitPromptDismiss(sessionId, decisionId);
    }
  }

  // ---- prompts: host key TOFU mismatch ----

  async acceptHostKey(sessionId: string, mode = "once", promptId?: string): Promise<void> {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending?.acceptHostKeyCb) {
      (this.log as Logger).warn?.("acceptHostKey called with no pending decision", { sessionId });
      return;
    }
    // Never accept a host key for a superseded generation — a stale dialog could
    // otherwise persist a DIFFERENT server's key against the new connection.
    // promptId is mandatory (sshAcceptHostKeySchema) and the guard is
    // unconditional: an omitted or superseded token is ignored.
    if (typeof promptId !== "string" || !promptId || !pending.activePromptId || pending.activePromptId !== promptId)
      return;
    const decisionId = pending.activePromptId;
    if (this.pendingPrompts.get(sessionId) !== pending || pending.activePromptId !== decisionId) return;
    if (pending.hostKeyDecisionInProgress) return;
    pending.hostKeyDecisionInProgress = true;

    try {
      if (mode === "permanent" && pending.hostKeyInfo) {
        const host = pending.hostKeyInfo.host;
        if (host) {
          await recordHostKey(
            this.store as KnownHostsStore,
            host,
            pending.hostKeyInfo as { fingerprint: string; keyType: string },
            () => this.pendingPrompts.get(sessionId) === pending && pending.activePromptId === decisionId,
          );
        }
      }
    } catch (err) {
      pending.hostKeyDecisionInProgress = false;
      throw err;
    }
    pending.hostKeyDecisionInProgress = false;
    const cb = pending.acceptHostKeyCb;
    pending.acceptHostKeyCb = null;
    if (this.pendingPrompts.get(sessionId) !== pending || pending.activePromptId !== decisionId) {
      cb?.(false);
      return;
    }
    cb?.(true);
    this.emitPromptDismiss(sessionId, decisionId);
  }

  rejectHostKey(sessionId: string, promptId?: string): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending?.acceptHostKeyCb) return;
    // Never reject a superseded generation — a stale dialog could otherwise
    // abort a newer connection's host-key decision. promptId is mandatory
    // (sshRejectHostKeySchema) and the guard is unconditional (see acceptHostKey).
    if (typeof promptId !== "string" || !promptId || !pending.activePromptId || pending.activePromptId !== promptId)
      return;
    const decisionId = pending.activePromptId;
    const cb = pending.acceptHostKeyCb;
    pending.acceptHostKeyCb = null;
    cb(false);
    this.emitPromptDismiss(sessionId, decisionId);
  }
}
