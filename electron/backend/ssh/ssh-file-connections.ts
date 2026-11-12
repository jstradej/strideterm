import { randomUUID } from "node:crypto";
import type { Client, SFTPWrapper } from "ssh2";
import { getLogger } from "../logger.js";
import { SshFileError } from "./ssh-file-error.js";
import { openSftpChannel } from "./sftp-promises.js";
import type { SshManager } from "./ssh-manager.js";

const log = getLogger("ssh-file");

export const SSH_FILE_SESSION_PREFIX = "ssh-file:";
/** Agent file tools share the private prefix of the other agent SSH operations (never forwarded to a UI). */
export const SSH_FILE_AGENT_SESSION_PREFIX = "ssh-mcp:";
export const SSH_FILE_IDLE_CLOSE_MS = 5 * 60 * 1000;

type HostRecord = NonNullable<ReturnType<SshManager["getHost"]>>;

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
  /** False for remote clients and agents: any password / passphrase / host-key prompt aborts the connect. */
  allowPrompts: boolean;
  /** Window that answers prompts of an own connection (routing like the SSH connection test). */
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
}

export interface SshFileConnectionsOptions {
  sshManager: SshManager;
  getEffectiveLaunchMode: (host: HostRecord) => "ssh2" | "system-ssh" | "wsl";
  idleCloseMs?: number;
}

export function createSshFileConnections({
  sshManager,
  getEffectiveLaunchMode,
  idleCloseMs = SSH_FILE_IDLE_CLOSE_MS,
}: SshFileConnectionsOptions) {
  const entries = new Map<string, Entry>();
  const connecting = new Map<string, Promise<Entry>>();
  const owners = new Map<string, string>();
  const refuseOnPrompt = new Map<string, (error: SshFileError) => void>();

  const onPrompt = (kind: "auth" | "host-key") => (event: { sessionId?: unknown }) => {
    const sessionId = typeof event?.sessionId === "string" ? event.sessionId : "";
    const refuse = refuseOnPrompt.get(sessionId);
    if (!refuse) return;
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
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
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
          entry = { key, client, leases: 0, idleTimer: null, browse: null, closeOwn: closeHold, dead: false };
          entries.set(key, entry);
          resolve(entry);
          await hold;
        },
      });
      session.then(
        () => {
          if (entry) drop(entry);
          void sshManager.stop(sessionId).catch(() => {});
        },
        (error: unknown) => {
          if (entry) drop(entry);
          void sshManager.stop(sessionId).catch(() => {});
          const message = error instanceof Error ? error.message : String(error);
          rejectReady(new SshFileError("not-connected", `SSH connection failed: ${message}`));
        },
      );
    });
    try {
      return await ready;
    } finally {
      refuseOnPrompt.delete(sessionId);
      owners.delete(sessionId);
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
        log.info("ssh file connection opening", { hostId: target.hostId, owner: options.ownerKey });
      }
      return makeLease(await pending);
    },

    closeAll(): void {
      sshManager.off("ssh:auth-prompt", onAuthPrompt);
      sshManager.off("ssh:host-key-change", onHostKey);
      for (const entry of [...entries.values()]) drop(entry);
    },

    /** For tests: how many pooled connections exist. */
    size(): number {
      return entries.size;
    },
  };
}

export type SshFileConnections = ReturnType<typeof createSshFileConnections>;
