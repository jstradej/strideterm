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
  // Per-generation prompt token. A rapid Disconnect→reconnect (or Restart) reuses
  // the sessionId, so an answer/dismiss must be scoped to the generation that
  // raised the prompt — otherwise a stale dialog's answer could be delivered to a
  // newer connection (incl. accepting a DIFFERENT host key). Echoed in every
  // ssh:auth-prompt / ssh:host-key-change payload and required back on answers.
  promptId: string;
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

  async createHost(
    partial: Omit<HostRecord, "id" | "createdAt" | "updatedAt" | "lastConnectedAt">,
  ): Promise<HostRecord> {
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
  async createSession({
    sessionId,
    hostId,
    inlineHost,
    cols,
    rows,
    onData,
    onExit,
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
      finishKeyboard: null,
      acceptHostKeyCb: null,
      hostKeyInfo: null,
      resolvePreAuth: null,
      rejectPreAuth: null,
    };
    this.pendingPrompts.set(sessionId, pending);

    let auth: Awaited<ReturnType<typeof buildAuth>>;
    // Resolve jump chain: each hop needs its own auth built from its credential refs.
    const jumps: {
      host: HostRecord;
      auth: typeof auth;
      verify: (args: { key: Buffer }) => ReturnType<typeof verifyHostKey>;
    }[] = [];
    try {
      auth = await buildAuth(host, this.credentialStore);
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
            promptId: pending.promptId,
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
        // Identity-guard the delete: an immediate reconnect may already have
        // registered a NEW generation's pending record under this id. Deleting it
        // unconditionally would erase the reconnect's record and make it fail its
        // own abort check. Only drop the entry if it is still ours.
        if (this.pendingPrompts.get(sessionId) === pending) this.pendingPrompts.delete(sessionId);
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
        // Generation guard: a late stream/client close from a SUPERSEDED
        // generation (a rapid Restart or Disconnect→Reconnect reuses this
        // sessionId) must not tear down the CURRENT generation. If a newer
        // generation now owns the id, drop this exit — otherwise it would
        // delete the live session/prompt and (via terminal:exit) clear the new
        // generation's replay.
        if (this.isSupersededGeneration(sessionId, pending)) return;
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
          promptId: pending.promptId,
          prompt: { name, instructions, prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })) },
        });
      },
      onHostKeyDecision: ({ fingerprint, keyType, previous }, callback) => {
        pending.acceptHostKeyCb = callback;
        pending.hostKeyInfo = { fingerprint, keyType, previous };
        this.emit("ssh:host-key-change", {
          sessionId,
          promptId: pending.promptId,
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
      if (this.activeSessions.get(sessionId) === session && !this.isSupersededGeneration(sessionId, pending)) {
        this.activeSessions.delete(sessionId);
        this.pendingPrompts.delete(sessionId);
        this.emit("ssh:connection-state", { sessionId, state: "disconnected", error: (err as Error).message });
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

  /**
   * Reject / dismiss every outstanding user-decision on a pending connect so a
   * teardown mid-prompt can't leave the connect hanging. Rejecting the pre-auth
   * promise makes the awaiting createSession reject; answering a keyboard prompt
   * with `[]` or rejecting the host key makes ssh2 close the pre-ready
   * connection, which rejects start(). Safe on a session with no open prompt.
   */
  private cancelPendingDecision(pending: PendingSession): void {
    if (pending.rejectPreAuth) {
      try {
        pending.rejectPreAuth(new Error("SSH connection cancelled"));
      } catch {
        // already settled
      }
      pending.resolvePreAuth = null;
      pending.rejectPreAuth = null;
    }
    if (pending.finishKeyboard) {
      try {
        pending.finishKeyboard([]);
      } catch {
        // already settled
      }
      pending.finishKeyboard = null;
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
   * showing for this generation. Scoped by promptId so a teardown of one
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
      this.emitPromptDismiss(sessionId, pending.promptId);
    }
    if (s) await s.stop();
  }

  // ---- prompts: keyboard-interactive (MFA) ----

  answerAuthPrompt(sessionId: string, answers: string[], promptId?: string): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending) return;
    // Reject an answer that doesn't match the CURRENT generation's token: a
    // Disconnect→reconnect reuses the sessionId, so a stale dialog left open on
    // another client must not feed its answer into the new connection. promptId
    // is mandatory (sshAuthAnswerSchema) and the guard is unconditional — an
    // omitted or superseded token is ignored (undefined never equals a live id),
    // closing the bypass where a client could hit the current prompt with only a
    // sessionId.
    if (pending.promptId !== promptId) return;
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
      this.emitPromptDismiss(sessionId, pending.promptId);
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
    this.emitPromptDismiss(sessionId, pending.promptId);
  }

  cancelAuthPrompt(sessionId: string, promptId?: string): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending) return;
    // Never cancel a superseded generation — a stale dialog could otherwise
    // dismiss the CURRENT prompt of a newer connection that reused the id.
    // promptId is mandatory (sshAuthCancelSchema) and the guard is unconditional:
    // an omitted or superseded token is ignored (see answerAuthPrompt).
    if (pending.promptId !== promptId) return;
    if (pending.rejectPreAuth) {
      try {
        pending.rejectPreAuth(new Error("Authentication cancelled"));
      } finally {
        pending.resolvePreAuth = null;
        pending.rejectPreAuth = null;
      }
      this.emitPromptDismiss(sessionId, pending.promptId);
      return;
    }
    if (!pending.finishKeyboard) return;
    try {
      // Passing an empty array lets ssh2 fail auth cleanly.
      pending.finishKeyboard([]);
    } finally {
      pending.finishKeyboard = null;
    }
    this.emitPromptDismiss(sessionId, pending.promptId);
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
    if (pending.promptId !== promptId) return;
    const cb = pending.acceptHostKeyCb;
    pending.acceptHostKeyCb = null;

    if (mode === "permanent" && pending.hostKeyInfo) {
      const activeSession = this.activeSessions.get(sessionId);
      if (activeSession?.host) {
        await recordHostKey(
          this.store as KnownHostsStore,
          activeSession.host,
          pending.hostKeyInfo as { fingerprint: string; keyType: string },
        );
      }
    }
    cb(true);
    this.emitPromptDismiss(sessionId, pending.promptId);
  }

  rejectHostKey(sessionId: string, promptId?: string): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending?.acceptHostKeyCb) return;
    // Never reject a superseded generation — a stale dialog could otherwise
    // abort a newer connection's host-key decision. promptId is mandatory
    // (sshRejectHostKeySchema) and the guard is unconditional (see acceptHostKey).
    if (pending.promptId !== promptId) return;
    const cb = pending.acceptHostKeyCb;
    pending.acceptHostKeyCb = null;
    cb(false);
    this.emitPromptDismiss(sessionId, pending.promptId);
  }
}
