import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { SshSession } from "./ssh-session.js";
import { verifyHostKey, recordHostKey } from "./ssh-known-hosts.js";
import type { Store as KnownHostsStore } from "./ssh-known-hosts.js";
import { buildAuth } from "./ssh-auth.js";
import type { CredentialStore } from "../shared/credential-store.js";
import type { Logger } from "../logger.js";

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
    agent?: string;
  };
  advanced?: {
    command?: string;
    keepaliveIntervalMs?: number;
    keepaliveCountMax?: number;
    compression?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    algorithms?: any;
    launchVia?: string;
  };
  hostKeyPolicy?: string;
  createdAt?: string;
  updatedAt?: string;
  lastConnectedAt?: string | null;
  tags?: string[];
}

interface AppState {
  ssh?: {
    hosts?: HostRecord[];
    keys?: unknown[];
    certificates?: unknown[];
    knownHosts?: Record<string, unknown>;
    settings?: Record<string, unknown>;
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
  finishKeyboard: ((answers: string[]) => void) | null;
  acceptHostKeyCb: ((accept: boolean) => void) | null;
  hostKeyInfo: { fingerprint: string; keyType: string; previous: unknown } | null;
  resolvePreAuth: ((pw: string) => void) | null;
  rejectPreAuth: ((err: Error) => void) | null;
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

  constructor({ store, credentialStore, logger }: SshManagerOpts) {
    super();
    this.store = store;
    this.credentialStore = credentialStore;
    this.log = logger || console;
    this.activeSessions = new Map();
    // Per-session pending state: { finishKeyboard, pendingHostKey, acceptHostKeyCb }
    this.pendingPrompts = new Map();
  }

  // ---- host book CRUD ----

  listHosts(): HostRecord[] {
    return this.store.getState().ssh?.hosts || [];
  }

  getHost(id: string): HostRecord | undefined {
    return this.listHosts().find((h) => h.id === id);
  }

  async createHost(partial: Omit<HostRecord, "id" | "createdAt" | "updatedAt" | "lastConnectedAt">): Promise<HostRecord> {
    const id = "h_" + randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    const newHost: HostRecord = {
      ...partial,
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

  async updateHost(id: string, patch: Partial<HostRecord>): Promise<HostRecord | null> {
    let updated: HostRecord | null = null;
    await this.store.mutate((state) => {
      if (!state.ssh || !Array.isArray(state.ssh.hosts)) return;
      const idx = state.ssh.hosts.findIndex((h) => h.id === id);
      if (idx === -1) return;
      const next: HostRecord = { ...state.ssh.hosts[idx]!, ...patch, id, updatedAt: new Date().toISOString() };
      state.ssh.hosts[idx] = next;
      updated = next;
    });
    if (updated) this.emit("ssh:state");
    return updated;
  }

  async deleteHost(id: string): Promise<void> {
    await this.store.mutate((state) => {
      if (!state.ssh) return;
      state.ssh.hosts = (state.ssh.hosts || []).filter((h) => h.id !== id);
      // Also scrub references from other hosts' jump chains.
      state.ssh.hosts = state.ssh.hosts.map((h) => ({
        ...h,
        jump: Array.isArray(h.jump) ? h.jump.filter((j) => j !== id) : [],
      }));
    });
    this.emit("ssh:state");
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
  async createSession({ sessionId, hostId, inlineHost, cols, rows, onData, onExit }: CreateSessionOpts): Promise<SshSession> {
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

    const auth = await buildAuth(host, this.credentialStore);

    // Resolve jump chain: each hop needs its own auth built from its credential refs.
    const jumps: { host: HostRecord; auth: typeof auth; verify: (args: { key: Buffer }) => ReturnType<typeof verifyHostKey> }[] = [];
    for (const jId of host.jump || []) {
      const jHost = this.getHost(jId);
      if (!jHost) throw new Error(`Jump host not found: ${jId}`);
      const jAuth = await buildAuth(jHost, this.credentialStore);
      jumps.push({
        host: jHost,
        auth: jAuth,
        verify: ({ key }) => verifyHostKey(this.store as KnownHostsStore, jHost, { key }),
      });
    }

    const pending: PendingSession = {
      finishKeyboard: null,
      acceptHostKeyCb: null,
      hostKeyInfo: null,
      resolvePreAuth: null,
      rejectPreAuth: null,
    };
    this.pendingPrompts.set(sessionId, pending);

    // ANSI-colored status banner so the user always sees *something* in the
    // terminal, even while connecting / after a failure. ssh2's `connect()`
    // doesn't emit any data until "ready", so without this the pane is black.
    const banner = (text: string, color = "90") => onData?.(`\r\n\x1b[${color}m${text}\x1b[0m\r\n`);
    const hostLabel = `${host.username || "?"}@${host.host}${host.port && host.port !== 22 ? `:${host.port}` : ""}`;
    banner(`── Connecting to ${hostLabel} …`);

    const methods = host.auth?.methods || [];

    // Up-front password prompt: when the user picked "Password / MFA" (stored
    // as keyboard-interactive) but no other credential source is available,
    // ssh2 only sends kb-int. Some servers (OpenSSH with
    // `KbdInteractiveAuthentication no`) reject kb-int and only accept the
    // classic `password` method — which ssh2 cannot offer without a static
    // value. Asking up-front lets us feed both:
    //   - cfg.password = typed value (classic method, broadest server support)
    //   - cfg.tryKeyboard = true, and auto-respond to a single "Password:"
    //     prompt with the same value (works for kb-int too)
    let cachedPassword: string | null = null;
    const needsInteractivePassword =
      methods.includes("keyboard-interactive") && !auth.password && !auth.privateKey && !auth.agent;
    if (needsInteractivePassword) {
      try {
        cachedPassword = await new Promise<string>((resolve, reject) => {
          pending.resolvePreAuth = resolve;
          pending.rejectPreAuth = reject;
          this.emit("ssh:auth-prompt", {
            sessionId,
            prompt: {
              name: "SSH Authentication",
              instructions: `Enter password for ${hostLabel}`,
              prompts: [{ prompt: "Password:", echo: false }],
            },
          });
        });
        auth.password = cachedPassword;
        auth.tryKeyboard = true;
      } catch (err) {
        banner(`✗ Authentication cancelled`, "31");
        this.pendingPrompts.delete(sessionId);
        throw err;
      }
    }

    // If the user picked "agent" but no agent is reachable AND no other
    // credential source is set up, ssh2 will fail with a generic
    // "authentication methods failed" — surface the real reason up-front.
    const hasAnyAuthMaterial = Boolean(auth.password || auth.privateKey || auth.agent || auth.tryKeyboard);
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
        this.activeSessions.delete(sessionId);
        this.pendingPrompts.delete(sessionId);
        this.emit("ssh:connection-state", { sessionId, state: "disconnected" });
        banner(exit?.error ? `✗ Disconnected: ${exit.error}` : "── Disconnected", exit?.error ? "31" : "90");
        onExit?.(exit);
      },
      onAuthPrompt: ({ name, instructions, prompts, finish }) => {
        // If we already collected a password up-front and the server is
        // asking a single "Password:"-style prompt via keyboard-interactive,
        // answer transparently — no need to re-prompt the user.
        if (
          cachedPassword &&
          prompts.length === 1 &&
          !prompts[0]!.echo &&
          /pass(word|phrase)?/i.test(prompts[0]!.prompt || "")
        ) {
          finish([cachedPassword]);
          return;
        }
        pending.finishKeyboard = finish;
        this.emit("ssh:auth-prompt", {
          sessionId,
          prompt: { name, instructions, prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })) },
        });
      },
      onHostKeyDecision: ({ fingerprint, keyType, previous }, callback) => {
        pending.acceptHostKeyCb = callback;
        pending.hostKeyInfo = { fingerprint, keyType, previous };
        this.emit("ssh:host-key-change", {
          sessionId,
          host: { name: host.name, host: host.host, port: host.port || 22 },
          fingerprint,
          keyType,
          previous,
        });
      },
      onReady: () => {
        this.emit("ssh:connection-state", { sessionId, state: "ready" });
        // Persist fingerprint for first-time TOFU accept (mismatch acceptance
        // is persisted separately via acceptHostKey("permanent")).
        const activeSession = this.activeSessions.get(sessionId);
        if (activeSession?.verifiedHostKey?.first) {
          recordHostKey(this.store as KnownHostsStore, host, activeSession.verifiedHostKey).catch(() => {});
        }
        // Fire-and-forget lastConnectedAt bump.
        this.store
          .mutate((state) => {
            const idx = (state.ssh?.hosts || []).findIndex((h) => h.id === host.id);
            if (idx !== -1) state.ssh!.hosts![idx]!.lastConnectedAt = new Date().toISOString();
          })
          .catch(() => {});
      },
    });

    this.activeSessions.set(sessionId, session);
    this.emit("ssh:connection-state", { sessionId, state: "connecting" });

    try {
      await session.start();
      return session;
    } catch (err) {
      this.activeSessions.delete(sessionId);
      this.pendingPrompts.delete(sessionId);
      this.emit("ssh:connection-state", { sessionId, state: "disconnected", error: (err as Error).message });
      banner(`✗ Connection failed: ${(err as Error).message}`, "31");
      throw err;
    }
  }

  write(sessionId: string, data: string): void {
    this.activeSessions.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.activeSessions.get(sessionId)?.resize(cols, rows);
  }

  async stop(sessionId: string): Promise<void> {
    const s = this.activeSessions.get(sessionId);
    this.pendingPrompts.delete(sessionId);
    if (!s) return;
    await s.stop();
    this.activeSessions.delete(sessionId);
  }

  // ---- prompts: keyboard-interactive (MFA) ----

  answerAuthPrompt(sessionId: string, answers: string[]): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending) return;
    // Up-front password prompt (collected before session.start()) takes
    // priority over mid-connect keyboard-interactive prompts.
    if (pending.resolvePreAuth) {
      const pw = Array.isArray(answers) ? (answers[0] ?? "") : "";
      try {
        pending.resolvePreAuth(pw);
      } finally {
        pending.resolvePreAuth = null;
        pending.rejectPreAuth = null;
      }
      return;
    }
    if (!pending.finishKeyboard) {
      (this.log as Logger).warn?.("answerAuthPrompt called with no pending keyboard prompt", { sessionId });
      return;
    }
    try {
      pending.finishKeyboard(answers);
    } finally {
      pending.finishKeyboard = null;
    }
  }

  cancelAuthPrompt(sessionId: string): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending) return;
    if (pending.rejectPreAuth) {
      try {
        pending.rejectPreAuth(new Error("Authentication cancelled"));
      } finally {
        pending.resolvePreAuth = null;
        pending.rejectPreAuth = null;
      }
      return;
    }
    if (!pending.finishKeyboard) return;
    try {
      // Passing an empty array lets ssh2 fail auth cleanly.
      pending.finishKeyboard([]);
    } finally {
      pending.finishKeyboard = null;
    }
  }

  // ---- prompts: host key TOFU mismatch ----

  async acceptHostKey(sessionId: string, mode = "once"): Promise<void> {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending?.acceptHostKeyCb) {
      (this.log as Logger).warn?.("acceptHostKey called with no pending decision", { sessionId });
      return;
    }
    const cb = pending.acceptHostKeyCb;
    pending.acceptHostKeyCb = null;

    if (mode === "permanent" && pending.hostKeyInfo) {
      const activeSession = this.activeSessions.get(sessionId);
      if (activeSession?.host) {
        await recordHostKey(this.store as KnownHostsStore, activeSession.host, pending.hostKeyInfo as { fingerprint: string; keyType: string });
      }
    }
    cb(true);
  }

  rejectHostKey(sessionId: string): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending?.acceptHostKeyCb) return;
    const cb = pending.acceptHostKeyCb;
    pending.acceptHostKeyCb = null;
    cb(false);
  }
}
