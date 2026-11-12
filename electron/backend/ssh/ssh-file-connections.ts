import { createHash, randomUUID } from "node:crypto";
import type { Client, SFTPWrapper } from "ssh2";
import { getLogger } from "../logger.js";
import { parseRemoteViewerId } from "../viewer-id.js";
import { SshFileError } from "./ssh-file-error.js";
import { openSftpChannel } from "./sftp-promises.js";
import type { SshManager } from "./ssh-manager.js";

const log = getLogger("ssh-file");

export const SSH_FILE_SESSION_PREFIX = "ssh-file:";
/** Agent file tools share the private prefix of the other agent SSH operations (never forwarded to a UI). */
export const SSH_FILE_AGENT_SESSION_PREFIX = "ssh-mcp:";
export const SSH_FILE_IDLE_CLOSE_MS = 5 * 60 * 1000;
/** A prompt of a remote client's own connection that nobody answers this long ends the connect. */
export const SSH_FILE_REMOTE_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;

type HostRecord = NonNullable<ReturnType<SshManager["getHost"]>>;

/**
 * The owner as it may appear in strideterm.log. A remote client's owner key embeds its session cookie, a bearer
 * secret, so only a short digest of it is written.
 */
export function ownerForLog(ownerKey: string | undefined): string {
  if (!ownerKey) return "";
  const marker = "remote:";
  const index = ownerKey.indexOf(marker);
  if (index < 0) return ownerKey;
  const digest = createHash("sha256")
    .update(ownerKey.slice(index + marker.length))
    .digest("hex")
    .slice(0, 8);
  return `${ownerKey.slice(0, index + marker.length)}#${digest}`;
}

function promptTimeoutError(timeoutMs: number): SshFileError {
  const when = timeoutMs >= 60_000 ? `within ${Math.round(timeoutMs / 60_000)} minutes` : "in time";
  return new SshFileError(
    "auth-required",
    `Nobody answered the sign-in prompt ${when}, so the connection was cancelled. Try again.`,
  );
}

/** Where a file operation connects: the live session of an SSH tab, else (when permitted) a connection of its own. */
export interface SshFileTarget {
  hostId: string;
  hostLabel: string;
  /** Session id of the source tab; used only when that session is connected over Built-in SSH. */
  liveSessionId?: string;
  /** Own connection: a saved host (`hostId`) or the source tab's inline host definition. */
  own?: { poolKey: string; hostId?: string; inlineHost?: Record<string, unknown> };
}

export interface SshFileConnectOptions {
  /** False for agents: any password / passphrase / host-key prompt aborts the connect. */
  allowPrompts: boolean;
  /** Viewer (desktop window id or `remote:<sessionId>`) that answers prompts of an own connection. */
  ownerWindowId?: string;
  /** Pool owner: connections are shared per (owner, host), never across owners. */
  ownerKey: string;
  sessionPrefix?: string;
}

export interface SshFileLease {
  client: Client;
  /** One shared browse channel per connection; transfers open their own with `openChannel`. */
  browseChannel(): Promise<SFTPWrapper>;
  openChannel(): Promise<SFTPWrapper>;
  release(): void;
}

interface Entry {
  key: string;
  client: Client;
  leases: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  browse: Promise<SFTPWrapper> | null;
  /** Own connections only: ends the held `onAuthenticated` callback, which closes the connection. */
  closeOwn?: () => void;
  dead: boolean;
  hostId?: string;
  logOwner?: string;
}

export interface SshFileConnectionsOptions {
  sshManager: SshManager;
  getEffectiveLaunchMode: (host: HostRecord) => "ssh2" | "system-ssh" | "wsl";
  idleCloseMs?: number;
  remotePromptTimeoutMs?: number;
}

export function createSshFileConnections({
  sshManager,
  getEffectiveLaunchMode,
  idleCloseMs = SSH_FILE_IDLE_CLOSE_MS,
  remotePromptTimeoutMs = SSH_FILE_REMOTE_PROMPT_TIMEOUT_MS,
}: SshFileConnectionsOptions) {
  const entries = new Map<string, Entry>();
  const connecting = new Map<string, Promise<Entry>>();
  const owners = new Map<string, string>();
  const refuseOnPrompt = new Map<string, (error: SshFileError) => void>();
  const promptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const promptTimedOut = new Set<string>();

  const armPromptTimeout = (sessionId: string): void => {
    const owner = owners.get(sessionId);
    if (!owner || !parseRemoteViewerId(owner)) return;
    const previous = promptTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      promptTimers.delete(sessionId);
      promptTimedOut.add(sessionId);
      log.warn("ssh file prompt unanswered, connection cancelled", { owner: ownerForLog(owner) });
      void sshManager.stop(sessionId).catch(() => {});
    }, remotePromptTimeoutMs);
    timer.unref?.();
    promptTimers.set(sessionId, timer);
  };

  const onPrompt = (kind: "auth" | "host-key") => (event: { sessionId?: unknown }) => {
    const sessionId = typeof event?.sessionId === "string" ? event.sessionId : "";
    const refuse = refuseOnPrompt.get(sessionId);
    if (!refuse) {
      armPromptTimeout(sessionId);
      return;
    }
    refuse(
      new SshFileError(
        "auth-required",
        kind === "host-key"
          ? "The host key must be verified before files can be transferred. Connect the SSH tab or test the host in SSH Settings first."
          : "This SSH host needs a password or passphrase. Connect the SSH tab first, or save the credentials in SSH Settings.",
      ),
    );
    void sshManager.stop(sessionId).catch(() => {});
  };
  const onAuthPrompt = onPrompt("auth");
  const onHostKey = onPrompt("host-key");
  sshManager.on("ssh:auth-prompt", onAuthPrompt);
  sshManager.on("ssh:host-key-change", onHostKey);

  function drop(entry: Entry): void {
    if (entry.dead) return;
    entry.dead = true;
    if (entry.key.startsWith("own:")) {
      log.info("ssh file connection closed", { hostId: entry.hostId, owner: entry.logOwner });
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    // A live tab's connection outlives this entry: give back the channel opened on it.
    const browse = entry.browse;
    entry.browse = null;
    browse?.then(
      (sftp) => {
        try {
          sftp.end();
        } catch {
          // already closed
        }
      },
      () => {},
    );
    entry.closeOwn?.();
  }

  function scheduleIdleClose(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.leases === 0) drop(entry);
    }, idleCloseMs);
    entry.idleTimer.unref?.();
  }

  function makeLease(entry: Entry): SshFileLease {
    entry.leases += 1;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    let released = false;
    const openChannel = () => {
      if (entry.dead) return Promise.reject(new SshFileError("not-connected", "The SSH connection was closed."));
      return openSftpChannel(entry.client).catch((error) => {
        throw new SshFileError("not-connected", `Could not open an SFTP channel: ${(error as Error).message}`);
      });
    };
    return {
      client: entry.client,
      openChannel,
      browseChannel() {
        if (!entry.browse) {
          const channel = openChannel();
          entry.browse = channel;
          channel.then(
            (sftp) => {
              const forget = () => {
                if (entry.browse === channel) entry.browse = null;
              };
              sftp.once("close", forget);
              sftp.once("end", forget);
              sftp.once("error", forget);
            },
            () => {
              if (entry.browse === channel) entry.browse = null;
            },
          );
        }
        return entry.browse;
      },
      release() {
        if (released) return;
        released = true;
        entry.leases = Math.max(0, entry.leases - 1);
        if (entry.leases === 0 && !entry.dead) scheduleIdleClose(entry);
      },
    };
  }

  function liveEntry(target: SshFileTarget): Entry | null {
    const sessionId = target.liveSessionId;
    if (!sessionId) return null;
    const session = sshManager.activeSessions.get(sessionId);
    const client = session?.client;
    if (!session || !client || !session.ready || session.ended) return null;
    const key = `live:${sessionId}`;
    const existing = entries.get(key);
    if (existing && !existing.dead && existing.client === client) return existing;
    if (existing) drop(existing);
    const entry: Entry = { key, client, leases: 0, idleTimer: null, browse: null, dead: false };
    entries.set(key, entry);
    client.once("close", () => drop(entry));
    return entry;
  }

  async function connectOwn(target: SshFileTarget, key: string, options: SshFileConnectOptions): Promise<Entry> {
    const own = target.own!;
    const sessionId = `${options.sessionPrefix ?? SSH_FILE_SESSION_PREFIX}${randomUUID()}`;
    const logOwner = ownerForLog(options.ownerKey);
    if (options.ownerWindowId) owners.set(sessionId, options.ownerWindowId);
    let closeHold!: () => void;
    const hold = new Promise<void>((resolve) => (closeHold = resolve));
    let entry: Entry | undefined;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<Entry>((resolve, reject) => {
      rejectReady = reject;
      if (!options.allowPrompts) refuseOnPrompt.set(sessionId, reject);
      const session = sshManager.createSession({
        sessionId,
        ...(own.hostId ? { hostId: own.hostId } : { inlineHost: own.inlineHost }),
        cols: 80,
        rows: 24,
        authOnly: true,
        authenticatedActionTimeoutMs: 0,
        skipLastConnectedAt: true,
        onAuthenticated: async (client: Client) => {
          entry = {
            key,
            client,
            leases: 0,
            idleTimer: null,
            browse: null,
            closeOwn: closeHold,
            dead: false,
            hostId: target.hostId,
            logOwner,
          };
          entries.set(key, entry);
          resolve(entry);
          log.info("ssh file connection ready", { hostId: target.hostId, owner: logOwner });
          await hold;
        },
      });
      session.then(
        () => {
          if (entry) drop(entry);
          else
            rejectReady(
              promptTimedOut.has(sessionId)
                ? promptTimeoutError(remotePromptTimeoutMs)
                : new SshFileError("not-connected", "The SSH connection ended before sign-in completed."),
            );
          void sshManager.stop(sessionId).catch(() => {});
        },
        (error: unknown) => {
          if (entry) drop(entry);
          void sshManager.stop(sessionId).catch(() => {});
          const message = error instanceof Error ? error.message : String(error);
          log.warn("ssh file connection failed", { hostId: target.hostId, owner: logOwner, err: message });
          rejectReady(
            promptTimedOut.has(sessionId)
              ? promptTimeoutError(remotePromptTimeoutMs)
              : new SshFileError("not-connected", `SSH connection failed: ${message}`),
          );
        },
      );
    });
    try {
      return await ready;
    } finally {
      refuseOnPrompt.delete(sessionId);
      owners.delete(sessionId);
      const timer = promptTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      promptTimers.delete(sessionId);
      promptTimedOut.delete(sessionId);
    }
  }

  return {
    ownerOf(sessionId: unknown): string | undefined {
      return typeof sessionId === "string" ? owners.get(sessionId) : undefined;
    },
    /** True while this connection pool is the one connecting `sessionId` (used for prompt routing). */
    isOwnSessionId(sessionId: unknown): boolean {
      return typeof sessionId === "string" && owners.has(sessionId);
    },

    async acquire(target: SshFileTarget, options: SshFileConnectOptions): Promise<SshFileLease> {
      const live = liveEntry(target);
      if (live) return makeLease(live);
      if (!target.own) {
        throw new SshFileError("not-connected", "Connect the SSH tab first.");
      }
      const host =
        target.own.hostId !== undefined
          ? sshManager.getHost(target.own.hostId)
          : (target.own.inlineHost as HostRecord | undefined);
      if (!host) throw new SshFileError("unsupported-host", "The SSH host was not found.");
      if (getEffectiveLaunchMode(host) !== "ssh2") {
        throw new SshFileError(
          "unsupported-host",
          "File transfer supports Built-in SSH hosts only. This host uses System SSH or WSL.",
        );
      }
      const key = `own:${options.ownerKey}|${target.own.poolKey}`;
      const existing = entries.get(key);
      if (existing && !existing.dead) return makeLease(existing);
      let pending = connecting.get(key);
      if (!pending) {
        pending = connectOwn(target, key, options).finally(() => connecting.delete(key));
        connecting.set(key, pending);
        log.info("ssh file connection opening", { hostId: target.hostId, owner: ownerForLog(options.ownerKey) });
      }
      return makeLease(await pending);
    },

    /**
     * A viewer went away: cancel its connects (and their prompts) and close its idle own connections. One a
     * transfer still holds stays until that transfer ends — a started transfer never depends on its caller.
     */
    closeViewer(viewerId: string): void {
      for (const [sessionId, owner] of [...owners]) {
        if (owner === viewerId) void sshManager.stop(sessionId).catch(() => {});
      }
      const prefix = `own:viewer:${viewerId}|`;
      for (const entry of [...entries.values()]) {
        if (entry.key.startsWith(prefix) && entry.leases === 0) drop(entry);
      }
    },

    closeAll(): void {
      sshManager.off("ssh:auth-prompt", onAuthPrompt);
      sshManager.off("ssh:host-key-change", onHostKey);
      for (const entry of [...entries.values()]) drop(entry);
      for (const timer of promptTimers.values()) clearTimeout(timer);
      promptTimers.clear();
    },

    /** For tests: how many pooled connections exist. */
    size(): number {
      return entries.size;
    },
  };
}

export type SshFileConnections = ReturnType<typeof createSshFileConnections>;
