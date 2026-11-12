import path from "node:path";
import type { SshFileListing, SshFileTransferStarted, SshFileTransfersState } from "../../shared/ssh-file-events.js";
import type { AppState, PanelState, WorkspaceState } from "../../shared/types/state.js";
import { parseRemoteViewerId } from "../viewer-id.js";
import {
  sshFileDeleteSchema,
  sshFileDownloadSchema,
  sshFileListSchema,
  sshFileMkdirSchema,
  sshFileRealpathSchema,
  sshFileRenameSchema,
  sshFileTransferCancelSchema,
  sshFileUploadSchema,
  validateIpc,
} from "../ipc-schemas.js";
import { SshFileError } from "./ssh-file-error.js";
import type { SshFileConnectOptions, SshFileTarget } from "./ssh-file-connections.js";
import { createRootsLocalPolicy, desktopLocalPolicy } from "./ssh-file-local-policy.js";
import { createSshFileAgentTools } from "./ssh-file-agent.js";
import { createSshFileService } from "./ssh-file-service.js";
import type { SshFileLocalPolicy } from "./ssh-file-transfers.js";
import type { SshManager } from "./ssh-manager.js";
import { normalizeRemoteCwd } from "../../shared/ssh-remote-cwd.js";

type HostRecord = NonNullable<ReturnType<SshManager["getHost"]>>;

export interface SshFileCaller {
  /** A remote / mobile browser client rather than a desktop window. */
  remote: boolean;
  /** A session minted from a paired phone: a subset of remote (never downloads to the desktop disk). */
  mobile: boolean;
  profileId: string;
  /** Desktop window id, or `remote:<sessionId>` for a remote client. */
  viewerId: string;
}

export interface SshFileHandlersCtx {
  sshManager: SshManager;
  getState: () => AppState;
  emit: (channel: string, payload: unknown) => void;
  /** Profile of a desktop window or `remote:` viewer; null when it no longer exists. */
  getWindowProfileId: (windowId: string | undefined) => string | null;
  getEffectiveLaunchMode: (host: HostRecord) => "ssh2" | "system-ssh" | "wsl";
  createSessionId: (workspaceId: string, panelId: string) => string;
  /** Workspace roots of a profile (the file manager's allow-list). */
  rootsForProfile: (profileId: string) => string[];
}

interface Resolved {
  target: SshFileTarget;
  connect: SshFileConnectOptions;
  local: SshFileLocalPolicy;
  workspace: WorkspaceState;
  /** Directory the browser starts in when it names no path. */
  startDir?: string;
}

export function createSshFileHandlers(ctx: SshFileHandlersCtx) {
  const service = createSshFileService({
    sshManager: ctx.sshManager,
    getEffectiveLaunchMode: ctx.getEffectiveLaunchMode,
    emit: ctx.emit,
  });

  interface CallOptions {
    /** The caller is a session minted from a paired phone. */
    mobile?: boolean;
    /** Told which host a request resolved to (for the mobile audit trail); not called when it fails earlier. */
    onResolved?: (info: { hostLabel: string }) => void;
  }

  function prepare(
    input: { workspaceId: string; panelId: string },
    viewerId: string | undefined,
    options: CallOptions,
  ) {
    const caller = callerOf(viewerId, options.mobile === true);
    const resolved = resolve(input, caller);
    options.onResolved?.({ hostLabel: resolved.target.hostLabel });
    return { caller, resolved };
  }

  function callerOf(viewerId: string | undefined, mobile: boolean): SshFileCaller {
    if (!viewerId) throw new SshFileError("permission-denied", "SSH file access needs an authenticated client.");
    const profileId = ctx.getWindowProfileId(viewerId);
    if (!profileId) throw new SshFileError("permission-denied", "The calling profile is no longer available.");
    const remote = Boolean(parseRemoteViewerId(viewerId));
    return { remote, mobile: remote && mobile, profileId, viewerId };
  }

  /**
   * The access policy, in one place.
   *  - Desktop window: the live ssh2 session of the source SSH tab when it is connected, else its own connection
   *    to that tab's host (prompts go to this window); any absolute local path.
   *  - Remote client: ONLY the live session of an SSH tab of its own profile — never an own connection, which
   *    would let a phone reach every saved host; local paths only inside its profile's workspace roots.
   */
  function resolve(payload: { workspaceId: string; panelId: string }, caller: SshFileCaller): Resolved {
    const state = ctx.getState();
    const workspace = state.workspaces.find((item) => item.id === payload.workspaceId);
    if (!workspace) throw new SshFileError("not-found", "Workspace not found.");
    if (String(workspace.profileId || "default") !== caller.profileId) {
      throw new SshFileError("permission-denied", "This workspace belongs to another profile.");
    }
    const panel = (workspace.panels || []).find((item) => item.id === payload.panelId);
    if (!panel) throw new SshFileError("not-found", "Tab not found.");

    let tab: PanelState | undefined = panel.launch?.kind === "ssh" ? panel : undefined;
    let saved: { sshHostId?: string; sshInline?: Record<string, unknown> } | undefined = tab?.launch ?? undefined;
    if (!tab && panel.command === "__sftp__") {
      const source = panel.sftp?.sourcePanelId
        ? (workspace.panels || []).find((item) => item.id === panel.sftp?.sourcePanelId)
        : undefined;
      if (source?.launch?.kind === "ssh") {
        tab = source;
        saved = source.launch;
      } else if (panel.sftp?.sshHostId || panel.sftp?.sshInline) {
        saved = { sshHostId: panel.sftp.sshHostId, sshInline: panel.sftp.sshInline };
      }
    }
    if (!saved) throw new SshFileError("io", "This tab is not an SSH tab.");

    const owner = tab ?? panel;
    const inline = Boolean(saved.sshInline);
    const hostRecord = inline
      ? ({ id: `inline:${workspace.id}:${owner.id}`, jump: [], ...saved.sshInline } as unknown as HostRecord)
      : saved.sshHostId
        ? ctx.sshManager.getHost(saved.sshHostId)
        : undefined;
    if (!hostRecord) throw new SshFileError("not-found", "The SSH host of this tab was not found.");
    if (ctx.getEffectiveLaunchMode(hostRecord) !== "ssh2") {
      throw new SshFileError(
        "unsupported-host",
        "File transfer supports Built-in SSH hosts only. This host uses System SSH or WSL.",
      );
    }

    const label = hostRecord.name || `${hostRecord.username ? `${hostRecord.username}@` : ""}${hostRecord.host}`;
    const target: SshFileTarget = {
      hostId: hostRecord.id,
      hostLabel: label,
      ...(tab ? { liveSessionId: ctx.createSessionId(workspace.id, tab.id) } : {}),
      ...(caller.remote
        ? {}
        : {
            own: {
              poolKey: hostRecord.id,
              ...(inline ? { inlineHost: saved.sshInline } : { hostId: hostRecord.id }),
            },
          }),
    };
    const connect: SshFileConnectOptions = caller.remote
      ? { allowPrompts: false, ownerKey: `remote:${caller.profileId}` }
      : { allowPrompts: true, ownerWindowId: caller.viewerId, ownerKey: `window:${caller.viewerId}` };
    const local = caller.remote
      ? createRootsLocalPolicy({ roots: () => ctx.rootsForProfile(caller.profileId) })
      : desktopLocalPolicy;
    return {
      target,
      connect,
      local,
      workspace,
      startDir: normalizeRemoteCwd(tab?.launch?.remoteCwd) || panel.sftp?.path || undefined,
    };
  }

  const agent = createSshFileAgentTools({
    sshManager: ctx.sshManager,
    getState: ctx.getState,
    getEffectiveLaunchMode: ctx.getEffectiveLaunchMode,
    service,
  });

  return {
    service,
    /** The file tools of the SSH MCP grant (list, upload, download, status). */
    sshFileAgent: agent,

    /** Which window answers the prompts of an own file connection (undefined once it is connected). */
    sshFileSessionOwner(sessionId: unknown): string | undefined {
      return service.connections.ownerOf(sessionId);
    },
    isSshFileSessionId(sessionId: unknown): sessionId is string {
      return typeof sessionId === "string" && sessionId.startsWith("ssh-file:");
    },

    async sshFileRealpath(payload: unknown, viewerId?: string, options: CallOptions = {}) {
      const input = validateIpc(sshFileRealpathSchema, payload, "ssh-file:realpath");
      const { resolved } = prepare(input, viewerId, options);
      if (input.path !== undefined) return service.realpath(resolved.target, resolved.connect, input.path);
      const home = await service.realpath(resolved.target, resolved.connect);
      const start = resolved.startDir;
      // The tab's remote directory may be "~" or "~/x"; a directory that is gone falls back to home.
      const tilde = start === "~" || start?.startsWith("~/");
      const candidate = tilde
        ? path.posix.join(home.path, String(start).slice(1))
        : start?.startsWith("/")
          ? start
          : "";
      if (!candidate || candidate === home.path) return home;
      return service.realpath(resolved.target, resolved.connect, candidate).catch((error: unknown) => {
        const code = (error as SshFileError).code;
        if (code === "not-found" || code === "io" || code === "permission-denied") return home;
        throw error;
      });
    },

    async sshFileList(payload: unknown, viewerId?: string, options: CallOptions = {}): Promise<SshFileListing> {
      const input = validateIpc(sshFileListSchema, payload, "ssh-file:list");
      const { resolved } = prepare(input, viewerId, options);
      return service.list(resolved.target, resolved.connect, input.path);
    },

    async sshFileMkdir(payload: unknown, viewerId?: string, options: CallOptions = {}) {
      const input = validateIpc(sshFileMkdirSchema, payload, "ssh-file:mkdir");
      const { resolved } = prepare(input, viewerId, options);
      await service.mkdir(resolved.target, resolved.connect, input.path);
      return { ok: true as const };
    },

    async sshFileRename(payload: unknown, viewerId?: string, options: CallOptions = {}) {
      const input = validateIpc(sshFileRenameSchema, payload, "ssh-file:rename");
      const { resolved } = prepare(input, viewerId, options);
      await service.rename(resolved.target, resolved.connect, input.from, input.to);
      return { ok: true as const };
    },

    async sshFileDelete(payload: unknown, viewerId?: string, options: CallOptions = {}) {
      const input = validateIpc(sshFileDeleteSchema, payload, "ssh-file:delete");
      const { resolved } = prepare(input, viewerId, options);
      return service.remove(resolved.target, resolved.connect, input.paths, { recursive: input.recursive === true });
    },

    /** Starts an upload and answers at once; the outcome arrives as `ssh-file:transfer-finished`. */
    async sshFileUpload(
      payload: unknown,
      viewerId?: string,
      options: CallOptions = {},
    ): Promise<SshFileTransferStarted> {
      const input = validateIpc(sshFileUploadSchema, payload, "ssh-file:upload");
      const { caller, resolved } = prepare(input, viewerId, options);
      const { transferId } = await service.startTransfer({
        direction: "upload",
        sources: input.localPaths,
        destinationDir: input.remoteDir,
        conflict: input.conflict,
        profileId: caller.profileId,
        workspaceId: resolved.workspace.id,
        source: "ui",
        ownerKey: `window:${caller.viewerId}`,
        local: resolved.local,
        target: resolved.target,
        connect: resolved.connect,
      });
      return { started: true, transferId };
    },

    /** Starts a download to the desktop's disk. A mobile session may never write there. */
    async sshFileDownload(
      payload: unknown,
      viewerId?: string,
      options: CallOptions = {},
    ): Promise<SshFileTransferStarted> {
      const input = validateIpc(sshFileDownloadSchema, payload, "ssh-file:download");
      const caller = callerOf(viewerId, options.mobile === true);
      if (caller.mobile) {
        throw new SshFileError("denied-for-mobile", "A phone cannot download files to the desktop.");
      }
      const resolved = resolve(input, caller);
      options.onResolved?.({ hostLabel: resolved.target.hostLabel });
      const { transferId } = await service.startTransfer({
        direction: "download",
        sources: input.remotePaths,
        destinationDir: input.localDir,
        conflict: input.conflict,
        profileId: caller.profileId,
        workspaceId: resolved.workspace.id,
        source: "ui",
        ownerKey: `window:${caller.viewerId}`,
        local: resolved.local,
        target: resolved.target,
        connect: resolved.connect,
      });
      return { started: true, transferId };
    },

    async sshFileTransferCancel(payload: unknown, viewerId?: string, options: CallOptions = {}) {
      const input = validateIpc(sshFileTransferCancelSchema, payload, "ssh-file:transfer-cancel");
      const caller = callerOf(viewerId, options.mobile === true);
      if (!service.transfers.cancel(input.transferId, { profileId: caller.profileId })) {
        throw new SshFileError("not-found", "That transfer is not running.");
      }
      return { ok: true as const };
    },

    sshFileTransfersPayload(profileId: string): SshFileTransfersState {
      return service.transfers.getPayload(profileId);
    },

    close(): void {
      service.close();
    },
  };
}

export type SshFileHandlers = ReturnType<typeof createSshFileHandlers>;
