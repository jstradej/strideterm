import { cloneWorkspace } from "../workspace-state.js";
import type { Ref, ShallowRef } from "vue";
import type { StatePayload } from "../../electron/shared/types/state.js";
import type { Transport } from "../transport.js";
import { rlog } from "../lib/renderer-log.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

interface DialogActionsCtx {
  overlay: Ref<string | null>;
  overlayProps: Ref<Record<string, unknown>>;
  contextMenu: Ref<{ x: number; y: number; viewId: string } | null>;
  layoutPickerAnchor: Ref<DOMRect | null>;
  layoutPickerMode: Ref<"grid" | "split" | "auto">;
  payload: ShallowRef<StatePayload | null>;
  activeViewId: Ref<string | null>;
  activeSessionId: Ref<string | null>;
  splitGroup: Ref<{ layout: string; viewIds: string[] } | null>;
  suppressBroadcast: Ref<boolean>;
  hiddenViewIds: Ref<Set<string>>;
  getApi: () => Transport;
  withSuppressedBroadcast: (fn: () => Promise<void>) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPanelByViewId: (viewId: string, workspace?: any) => any;
  createWorktree: (workspaceId: string, name: string, rootPath?: string) => Promise<void>;
  quickAddTemplateTab: (
    command: string,
    title: string,
    cwdOverride?: string,
    options?: Record<string, unknown>,
  ) => Promise<void>;
  /** Single source of truth for "which profile does the current viewer belong
   *  to" — see resolveViewerProfileId in stores/app.ts. */
  resolveViewerProfileId: (sourcePayload: unknown, opts: { isRemote: boolean; windowId: string }) => string | null;
}

// Build an initial CLI command string for a provider — used to pre-populate
// the worker/judge panel command field when we don't have a Vue-level
// buildProviderCommand in scope. Must stay aligned with the backend provider
// classes (electron/backend/providers/*) and the WorkspaceDialog copy.
function buildProviderCommandString({
  providerId,
  model,
  skipPermissions,
}: { providerId?: string; model?: string; skipPermissions?: boolean } = {}): string {
  if (providerId === "claude") {
    const parts = ["claude"];
    if (skipPermissions !== false) parts.push("--dangerously-skip-permissions");
    if (model) parts.push("--model", model);
    return parts.join(" ");
  }
  if (providerId === "codex") {
    const parts = ["codex"];
    if (skipPermissions !== false) parts.push("--dangerously-bypass-approvals-and-sandbox", "-s", "danger-full-access");
    if (model) parts.push("--model", model);
    return parts.join(" ");
  }
  if (providerId === "gemini") {
    const parts = ["gemini"];
    if (skipPermissions === true) parts.push("--yolo");
    if (model) parts.push("-m", model);
    return parts.join(" ");
  }
  if (providerId === "copilot") {
    const parts = ["copilot"];
    if (skipPermissions !== false) parts.push("--allow-all-tools");
    if (model) parts.push("--model", model);
    return parts.join(" ");
  }
  if (providerId === "opencode") {
    const parts = ["opencode"];
    if (skipPermissions !== false) parts.push("--yolo");
    if (model && model !== "default") parts.push("--model", model);
    return parts.join(" ");
  }
  return "claude --dangerously-skip-permissions --model sonnet";
}

// Hook API selectors per provider id. Returns null for providers that don't
// currently have a hook-config story (none today).
function hookApiForProvider(
  api: AnyApi,
  providerId: string,
): {
  status: (() => Promise<AnyApi>) | undefined;
  configure: (() => Promise<void>) | undefined;
  displayName: string;
} | null {
  if (!api) return null;
  if (providerId === "codex")
    return { status: api.getCodexHookStatus, configure: api.configureCodexHook, displayName: "Codex CLI" };
  if (providerId === "gemini")
    return { status: api.getGeminiHookStatus, configure: api.configureGeminiHook, displayName: "Gemini CLI" };
  if (providerId === "copilot")
    return {
      status: api.getCopilotHookStatus,
      configure: api.configureCopilotHook,
      displayName: "GitHub Copilot",
    };
  if (providerId === "opencode")
    return {
      status: api.getOpencodeHookStatus,
      configure: api.configureOpencodeHook,
      displayName: "OpenCode",
    };
  // Default to Claude for legacy workspaces and explicit claude selection.
  return { status: api.getClaudeHookStatus, configure: api.configureClaudeHook, displayName: "Claude Code" };
}

/**
 * Factory for dialog / overlay / context-menu / layout-picker actions.
 *
 * @param ctx  Shared refs and helpers injected by the app store.
 *   overlay, overlayProps, contextMenu, layoutPickerAnchor,
 *   payload, activeViewId, activeSessionId, splitGroup, suppressBroadcast,
 *   hiddenViewIds, getApi, withSuppressedBroadcast, getPanelByViewId,
 *   createWorktree
 */
export function createDialogActions(ctx: DialogActionsCtx) {
  // --- Dialog / overlay --------------------------------------------------

  function currentProfileId(): string {
    const windowId = (window as AnyApi).strideterm?.startupFlags?.windowId || "";
    return (
      ctx.resolveViewerProfileId(ctx.payload.value, { isRemote: ctx.getApi().isRemote, windowId }) || "default"
    );
  }

  function openDialog(name: string, props: Record<string, unknown> = {}): void {
    ctx.contextMenu.value = null;
    ctx.layoutPickerAnchor.value = null;
    ctx.overlay.value = name;
    ctx.overlayProps.value = props;
  }

  function closeDialog(): void {
    ctx.overlay.value = null;
    ctx.overlayProps.value = {};
  }

  // --- Context menu ------------------------------------------------------

  function showContextMenu(x: number, y: number, viewId: string): void {
    ctx.contextMenu.value = { x, y, viewId };
  }

  function hideContextMenu(): void {
    ctx.contextMenu.value = null;
  }

  // --- Layout picker -----------------------------------------------------

  function showLayoutPicker(anchorRect: DOMRect, mode: "grid" | "split" | "auto" = "auto"): void {
    ctx.layoutPickerAnchor.value = anchorRect;
    ctx.layoutPickerMode.value = mode;
  }

  function hideLayoutPicker(): void {
    ctx.layoutPickerAnchor.value = null;
    ctx.layoutPickerMode.value = "auto";
  }

  // --- Tab edit dialog ---------------------------------------------------

  function editTabWithDialog(viewId: string): void {
    const target = ctx.getPanelByViewId(viewId);
    if (!target) return;
    // For SSH tabs pointing at a saved host, jump straight to the full host
    // editor — tab-level edit (title/command only) is a poor fit when the
    // user wants to tweak hostname, auth, etc.
    const launch = target.panel.launch;
    if (launch?.kind === "ssh" && launch.sshHostId) {
      const appState = ctx.payload.value?.appState;
      const host = appState?.ssh?.hosts?.find((h: AnyApi) => h.id === launch.sshHostId);
      if (host && openSshHostEditor) {
        openSshHostEditor(host);
        return;
      }
    }
    // Snapshot whether the tab has a live PTY *before* opening the dialog —
    // saveWorkspace could in theory mutate the session list, so we capture the
    // pre-save state. Used after Save to decide if the reload prompt makes
    // sense (no point asking when nothing is running).
    const workspaceData = (ctx.payload.value as AnyApi)?.workspace;
    const hasLiveSession = !!((workspaceData?.sessions as AnyApi[] | undefined) || []).find(
      (s: AnyApi) => s.sessionId === viewId,
    );
    openDialog("EditTabDialog", {
      eyebrow: "Workspace",
      mode: "edit",
      title: target.panel.title || "",
      command: target.panel.command || "",
      onCancel: closeDialog,
      onSubmit: async ({ title, command }: { title: string; command: string }) => {
        const nextTitle = (title || "").trim();
        const nextCommand = (command || "").trim();
        const sameTitle = nextTitle === (target.panel.title || "").trim();
        const sameCommand = nextCommand === (target.panel.command || "").trim();
        if (!nextTitle || (sameTitle && sameCommand)) {
          closeDialog();
          return;
        }
        const nextWorkspace = cloneWorkspace(target.workspace);
        nextWorkspace.panels = nextWorkspace.panels.map((p: AnyApi) =>
          p.id === target.panel.id ? { ...p, title: nextTitle, command: nextCommand } : p,
        );
        ctx.payload.value = (await (ctx.getApi() as AnyApi).saveWorkspace(nextWorkspace)) as StatePayload;
        // If the command changed and a live PTY is running, ask whether to
        // reload now. The saved command otherwise only takes effect the next
        // time the tab is launched, which is surprising when you just clicked
        // Save and watched the tab keep running the previous command.
        if (!sameCommand && hasLiveSession) {
          openDialog("ConfirmDialog", {
            eyebrow: "Tab",
            title: "Reload tab now?",
            message:
              "The command changed. Reload now to apply it, or keep the running tab as-is — the new command will be used the next time this tab is launched.",
            confirmLabel: "Reload now",
            cancelLabel: "Apply on next launch",
            onCancel: closeDialog,
            onConfirm: async () => {
              closeDialog();
              try {
                ctx.payload.value = (await (ctx.getApi() as AnyApi).restartTerminal(viewId)) as StatePayload;
                ctx.activeViewId.value = viewId;
              } catch (err) {
                console.error("[edit-tab] reload after save failed:", err);
              }
            },
          });
          return;
        }
        closeDialog();
      },
    });
  }

  function openNewTabDialog(
    cwdOverride = "",
    presetTitle = "",
    presetCommand = "",
    options: { tabType?: string; sshMode?: string; sshHostId?: string } = {},
  ): void {
    const presetTabType = options.tabType === "ssh" ? "ssh" : "local";
    const defaultTitle = presetTabType === "ssh" ? "" : "\u{1F4BB} Shell";
    const presetSshMode = options.sshMode === "quick" ? "quick" : "saved";
    const presetSshHostId = options.sshHostId || "";
    openDialog("EditTabDialog", {
      eyebrow: "Workspace",
      mode: "new",
      title: presetTitle || defaultTitle,
      command: presetCommand || "",
      presetTabType,
      presetSshMode,
      presetSshHostId,
      onEditSshHost: (host: AnyApi, currentState: AnyApi) => {
        // Swap the new-tab dialog for the full host editor. When the editor
        // closes (Save / Cancel / Close / backdrop) we re-open the new-tab
        // dialog with the user's typed state preserved — otherwise they'd
        // have to click "+ Tab" again just to pick a host.
        openDialog("SshHostEditor", {
          host,
          onCancel: () => {
            openNewTabDialog(cwdOverride, currentState.title, currentState.command, {
              tabType: "ssh",
              sshMode: currentState.sshMode,
              sshHostId: currentState.sshHostId,
            });
          },
        });
      },
      onCancel: closeDialog,
      onSubmit: async (payload: AnyApi) => {
        const { title, command, kind, sshHostId, sshInline } = payload;
        const nextTitle = (title || "").trim();
        if (!nextTitle) {
          closeDialog();
          return;
        }
        closeDialog();
        await ctx.quickAddTemplateTab(command || "", nextTitle, cwdOverride, { kind, sshHostId, sshInline });
      },
    });
  }

  // --- Workspace dialog --------------------------------------------------

  function isBrowserPanel(panel: AnyApi = {}): boolean {
    return /^https?:\/\//i.test(String(panel.command || "").trim());
  }

  function openWorkspaceDialog(workspace: AnyApi = null): void {
    const tabTemplates = ctx.payload.value?.appState?.tabTemplates || [];
    openDialog("WorkspaceDialog", {
      workspace,
      tabTemplates,
      onCancel: closeDialog,
      onSubmit: async (draft: AnyApi) => {
        const isNew = !workspace;
        // Always pin profileId to the currently active profile when missing.
        // `isNew` was inferred from the parent calling openWorkspaceDialog(null)
        // — but the New Workspace picker prefills a draft and calls
        // openWorkspaceDialog(draft), which makes `isNew` false even though
        // the draft has no profileId yet. Without this fallback, the draft
        // arrives at saveWorkspace with profileId=undefined and the backend
        // normalizes it to "default" — landing the workspace on the wrong
        // profile silently.
        if (!draft.profileId) {
          draft.profileId = currentProfileId();
        }
        // Guard: preserve task workspace identity on edit (kind + task object must survive)
        if (!isNew && workspace.kind === "task" && workspace.task) {
          draft.kind = "task";
          draft.task = { ...workspace.task, description: draft.task?.description ?? workspace.task.description };
        }
        const firstPanel = draft.panels?.[0];
        if (draft.kind === "azure") {
          ctx.activeViewId.value = `azure:${draft.id}`;
        } else if (draft.kind === "github") {
          ctx.activeViewId.value = `github:${draft.id}`;
        } else if (firstPanel) {
          ctx.activeViewId.value = isBrowserPanel(firstPanel)
            ? `browser:${firstPanel.id}`
            : `${draft.id}:${firstPanel.id}`;
        }
        // Strip reactive proxies — IPC structuredClone cannot handle Vue Proxy objects
        const plain = JSON.parse(JSON.stringify(draft)) as AnyApi;
        // Let backend errors propagate so WorkspaceDialog can render them in
        // the dialog footer instead of swallowing them into devtools console
        // and silently closing the dialog.
        await ctx.withSuppressedBroadcast(async () => {
          ctx.payload.value = (await (ctx.getApi() as AnyApi).saveWorkspace(plain)) as StatePayload;
          if (isNew) {
            ctx.payload.value = (await (ctx.getApi() as AnyApi).activateWorkspace(plain.id)) as StatePayload;
          }
        });
        closeDialog();
      },
    });
  }

  function openNewWorkspaceFlow(): void {
    const plugins = (ctx.payload.value as AnyApi)?.plugins || [];
    // Always show picker — it includes the Task Runner option alongside plugins and empty workspace
    openDialog("NewWorkspacePicker", {
      plugins,
      onCancel: closeDialog,
      onPickEmpty: () => {
        closeDialog();
        openWorkspaceDialog();
      },
      onPickTask: () => {
        closeDialog();
        openTaskWorkspaceDialog();
      },
      onPickPlugin: (pluginId: string) => {
        closeDialog();
        const plugin = plugins.find((p: AnyApi) => p.id === pluginId);
        if (!plugin?.workspaceDefaults) {
          openWorkspaceDialog();
          return;
        }
        const tpl = plugin.workspaceDefaults;
        const draft: AnyApi = {
          id: `workspace-${crypto.randomUUID()}`,
          name: tpl.name || plugin.name,
          icon: tpl.icon || plugin.icon || "PL",
          color: tpl.color || plugin.color || "#ffa424",
          kind: tpl.kind || "terminal",
          source: "plugin",
          pluginId,
          cwd: "",
          notes: tpl.notes || "",
          activePanelId: tpl.panels?.[0]?.id || "",
          panels: (tpl.panels || []).map((panel: AnyApi) => ({ ...panel })),
        };
        openWorkspaceDialog(draft);
      },
    });
  }

  // --- Settings / help / profiles / azure connection dialogs -------------

  function openSettingsDialog(opts: { initialTab?: string } = {}): void {
    openDialog("SettingsDialog", {
      settings: ctx.payload.value?.appState?.settings || {},
      tabTemplates: ctx.payload.value?.appState?.tabTemplates || [],
      profiles: ctx.payload.value?.appState?.profiles || [],
      appVersion: (ctx.payload.value as AnyApi)?.meta?.appVersion || "",
      repositoryUrl: (ctx.payload.value as AnyApi)?.meta?.repositoryUrl || "",
      versionCheck: (ctx.payload.value as AnyApi)?.meta?.versionCheck || null,
      initialTab: opts.initialTab || "general",
      onCancel: closeDialog,
      onSave: async (patch: AnyApi) => {
        try {
          const plain = JSON.parse(JSON.stringify(patch)) as AnyApi;
          ctx.payload.value = (await (ctx.getApi() as AnyApi).updateSettings(plain)) as StatePayload;
          closeDialog();
        } catch (err) {
          ctx.overlayProps.value = {
            ...ctx.overlayProps.value,
            saveError: (err as Error).message || "Failed to save settings",
          };
        }
      },
    });
  }

  function openHelpDialog(): void {
    openDialog("HelpDialog", { onClose: closeDialog });
  }

  function openRemoteAccessDialog(): void {
    openDialog("RemoteAccessDialog", { onClose: closeDialog });
  }

  function openProfilesDialog(): void {
    const appState = ctx.payload.value?.appState || ({} as AnyApi);
    const api = ctx.getApi();
    const isRemote = api.isRemote;
    const profiles = ((appState as AnyApi).profiles || []) as AnyApi[];

    // Determine the current profile for THIS viewer (window slot in Electron,
    // remoteClient context in remote mode) via the shared resolveViewerProfileId
    // — see currentProfileId() elsewhere in this file for the same resolution.
    const myWindowId = (window as AnyApi).strideterm?.startupFlags?.windowId || "";
    const slots = ((appState as AnyApi).windowSlots || []) as Array<{ id: string; profileId: string }>;
    const myCurrentProfileId = ctx.resolveViewerProfileId(ctx.payload.value, { isRemote, windowId: myWindowId });

    // Build desktopOccupancy map: profileId → number of desktop windows
    // currently showing it. Info-only badge ("Open on desktop: N windows").
    const desktopOccupancy = new Map<string, number>();
    slots.forEach((slot) => {
      desktopOccupancy.set(slot.profileId, (desktopOccupancy.get(slot.profileId) || 0) + 1);
    });

    // Every profile is selectable from remote — a remote viewer may open a
    // profile that is not shown in any desktop window.
    const visibleProfiles = profiles;

    openDialog("ProfilesDialog", {
      profiles: JSON.parse(JSON.stringify(visibleProfiles)) as unknown[],
      activeProfileId: myCurrentProfileId ?? undefined,
      workspaces: (appState as AnyApi).workspaces || [],
      // Remote slim-core scopes `workspaces` to the viewer's one profile, so the
      // per-profile counts ride along separately; absent on desktop (which has
      // the full workspaces array to count directly).
      profileWorkspaceCounts: (appState as AnyApi).profileWorkspaceCounts,
      windowSlots: isRemote ? [] : (appState as AnyApi).windowSlots || [],
      isRemote,
      desktopOccupancy,
      onCancel: closeDialog,
      onSave: async (profile: AnyApi) => {
        ctx.payload.value = (await (api as AnyApi).saveProfile(profile)) as StatePayload;
      },
      onActivate: async (profileId: string) => {
        ctx.suppressBroadcast.value = true;
        const previousPayload = ctx.payload.value;
        if (isRemote && previousPayload) {
          const firstWorkspace = ((previousPayload.appState?.workspaces || []) as AnyApi[]).find(
            (ws: AnyApi) => (ws.profileId || "default") === profileId,
          );
          ctx.payload.value = {
            ...(previousPayload as AnyApi),
            remoteClient: {
              ...((previousPayload as AnyApi).remoteClient || {}),
              profileId,
              activeWorkspaceId: firstWorkspace?.id || "",
              activeSessionId: "",
            },
          } as StatePayload;
        }
        try {
          ctx.payload.value = (await (api as AnyApi).activateProfile(profileId)) as StatePayload;
        } catch (err) {
          if (previousPayload) ctx.payload.value = previousPayload;
          ctx.suppressBroadcast.value = false;
          throw err;
        }
        // The backend chooses the restore target for this window/profile. Adopt
        // its active session here so opening Profiles behaves like normal
        // profile switching.
        const nextPayload = ctx.payload.value as AnyApi;
        const restoredSession = isRemote
          ? nextPayload?.remoteClient?.activeSessionId || ""
          : (() => {
              const slots = nextPayload?.appState?.windowSlots as AnyApi[] | undefined;
              const slot = myWindowId && slots ? slots.find((s: AnyApi) => s.id === myWindowId) : null;
              return slot?.activeSessionId || "";
            })();
        if (restoredSession) {
          ctx.activeSessionId.value = restoredSession;
          ctx.activeViewId.value = restoredSession;
        } else {
          ctx.activeViewId.value = null;
          ctx.activeSessionId.value = null;
        }
        ctx.splitGroup.value = null;
        closeDialog();
        setTimeout(() => {
          ctx.suppressBroadcast.value = false;
        }, 200);
      },
      onDelete: async (profileId: string, options?: { taskAction?: "pause" | "stop" }) => {
        try {
          ctx.payload.value = (await (api as AnyApi).deleteProfile(profileId, options)) as StatePayload;
        } catch (err) {
          const msg = ((err as Error)?.message || String(err || ""))
            .replace(/^Error invoking remote method '[^']+':\s*/, "")
            .replace(/^Error:\s*/, "");
          // Re-throw with clean message so ProfilesDialog shows it inline.
          // The backend deliberately refuses: "Profile is open in Window N. Close that window first."
          throw new Error(msg, { cause: err });
        }
      },
      onOpenWindow: async (profileId: string) => {
        // Desktop only — the dialog hides the button on remote. createWindow
        // always makes a fresh window slot; the same profile may be open in
        // any number of windows (including the current one).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (await (window as any).strideterm?.createWindow?.(profileId)) as { error?: string } | undefined;
        if (result?.error) throw new Error(result.error);
        closeDialog();
      },
    });
  }

  function openAzureConnectionDialog(connectionId = ""): void {
    const azureSettings = (ctx.payload.value?.appState?.settings as AnyApi)?.integrations?.azureDevops || {};
    const connection = ((azureSettings as AnyApi).connections || []).find((c: AnyApi) => c.id === connectionId) || null;
    openDialog("AzureConnectionDialog", {
      connection,
      defaultReviewRoot: (azureSettings as AnyApi).reviewRoot || "",
      onCancel: closeDialog,
      onSave: async (draft: AnyApi) => {
        draft.profileId = currentProfileId();
        const result = (await (ctx.getApi() as AnyApi).saveAzureConnection(draft)) as AnyApi;
        ctx.payload.value = (result.payload || result) as StatePayload;
        closeDialog();
      },
    });
  }

  function openGitHubConnectionDialog(connectionId = ""): void {
    const ghSettings = (ctx.payload.value?.appState?.settings as AnyApi)?.integrations?.github || {};
    const connection = ((ghSettings as AnyApi).connections || []).find((c: AnyApi) => c.id === connectionId) || null;
    openDialog("GitHubConnectionDialog", {
      connection,
      defaultReviewRoot: (ghSettings as AnyApi).reviewRoot || "",
      onCancel: closeDialog,
      onSave: async (draft: AnyApi) => {
        draft.profileId = currentProfileId();
        const result = (await (ctx.getApi() as AnyApi).saveGitHubConnection(draft)) as AnyApi;
        ctx.payload.value = (result.payload || result) as StatePayload;
        closeDialog();
      },
    });
  }

  function openGitHubQuickFixWizard(): void {
    const ghSettings = (ctx.payload.value?.appState?.settings as AnyApi)?.integrations?.github || {};
    // Scope to this window's profile — the raw settings list aggregates
    // connections across every profile, and the wizard's QuickFix create
    // path is profile-bound (the workspace lands on the connection's
    // profile). Without scoping, the user could pick a cross-profile
    // connection and have the resulting workspace appear in a different
    // window's sidebar.
    const myProfileId = currentProfileId();
    const connections = ((ghSettings as AnyApi).connections || [])
      .filter((c: AnyApi) => c.enabled !== false)
      .filter((c: AnyApi) => (c.profileId || "default") === myProfileId);
    if (!connections.length) {
      openGitHubConnectionDialog("");
      return;
    }
    openDialog("QuickFixWizardDialog", {
      provider: "github",
      connections,
      onCancel: closeDialog,
      onCreate: (result: AnyApi) => {
        closeDialog();
        if (result) {
          ctx.payload.value = result as StatePayload;
          ctx.activeViewId.value = null;
          ctx.splitGroup.value = null;
        }
      },
    });
  }

  // --- Quick Fix wizard ---------------------------------------------------

  function openQuickFixWizard(): void {
    const azureSettings = (ctx.payload.value?.appState?.settings as AnyApi)?.integrations?.azureDevops || {};
    // See openGitHubQuickFixWizard for the per-profile scoping rationale.
    const myProfileId = currentProfileId();
    const connections = ((azureSettings as AnyApi).connections || [])
      .filter((c: AnyApi) => c.enabled !== false)
      .filter((c: AnyApi) => (c.profileId || "default") === myProfileId);
    if (!connections.length) {
      openAzureConnectionDialog("");
      return;
    }
    openDialog("QuickFixWizardDialog", {
      connections,
      onCancel: closeDialog,
      onCreate: (result: AnyApi) => {
        closeDialog();
        if (result) {
          ctx.payload.value = result as StatePayload;
          ctx.activeViewId.value = null;
          ctx.splitGroup.value = null;
        }
      },
    });
  }

  // --- Worktree dialog ---------------------------------------------------

  function createWorktreeWithDialog(
    workspaceId: string,
    { preselectedRootPath = "" }: { preselectedRootPath?: string } = {},
  ): void {
    const workspaces = ctx.payload.value?.appState?.workspaces || [];
    const target = workspaces.find((w: AnyApi) => w.id === workspaceId);
    const gitRoots = Array.isArray((target as AnyApi)?.gitRoots)
      ? ((target as AnyApi).gitRoots as string[]).filter(Boolean)
      : [];
    const isMultiRepo = gitRoots.length >= 2;

    if (isMultiRepo) {
      const repoChoices = gitRoots.map((root) => ({
        value: root,
        label: formatRootBasename(root, gitRoots),
      }));
      openDialog("WorktreeDialog", {
        repoChoices,
        preselectedRootPath: preselectedRootPath || gitRoots[0],
        onCancel: closeDialog,
        onSubmit: async ({ name, rootPath }: { name: string; rootPath: string }) => {
          closeDialog();
          await ctx.createWorktree(workspaceId, name, rootPath);
        },
      });
      return;
    }

    openDialog("TextInputDialog", {
      eyebrow: "Git",
      title: "New worktree",
      label: "Branch name",
      value: "",
      placeholder: "feature/my-branch",
      submitLabel: "Create",
      onCancel: closeDialog,
      onSubmit: async (name: string) => {
        closeDialog();
        await ctx.createWorktree(workspaceId, name, preselectedRootPath || "");
      },
    });
  }

  function formatRootBasename(rootPath: string, allRoots: string[]): string {
    const basename = rootPath.split(/[\\/]/).filter(Boolean).at(-1) || rootPath;
    const collisions = allRoots.filter((r) => {
      const rb = r.split(/[\\/]/).filter(Boolean).at(-1) || r;
      return rb === basename && r !== rootPath;
    });
    if (!collisions.length) return basename;
    const segments = rootPath.split(/[\\/]/).filter(Boolean);
    return segments.slice(-2).join("/") || basename;
  }

  function openTaskWorkspaceDialog(workspaceId?: string): void {
    // When invoked from a workspace's kebab menu, seed the cwd from the
    // right-clicked workspace rather than whichever workspace happens to be
    // active — the parent is auto-detected from cwd downstream, so seeding the
    // wrong cwd would attach the task to the active workspace instead.
    // The toolbar / picker entry points pass no id and keep using the active
    // workspace.
    let initialCwd: string;
    if (workspaceId) {
      const target = (ctx.payload.value?.appState?.workspaces || []).find((w: AnyApi) => w.id === workspaceId);
      initialCwd = (target as AnyApi)?.cwd || "";
    } else {
      const ws = (ctx.payload.value as AnyApi)?.workspace;
      const activeWorkspace = ws?.workspace || ws?.project || null;
      initialCwd = (activeWorkspace as AnyApi)?.cwd || "";
    }

    // Re-check Claude CLI availability in the background so the dialog
    // shows up-to-date status (user may have installed claude mid-session)
    (ctx.getApi() as AnyApi)
      .recheckClaude?.()
      .then((result: AnyApi) => {
        if (result?.payload) ctx.payload.value = result.payload as StatePayload;
      })
      .catch((err: unknown) => {
        rlog("warn", "task dialog: recheckClaude failed, provider availability may be stale", {
          err: (err as Error)?.message || String(err),
        });
      });

    // Use per-user taskDefaults from settings for the initial provider selection
    const taskDefaults = (ctx.payload.value?.appState?.settings as AnyApi)?.taskDefaults || {};
    const defaultWorkerProvider = (taskDefaults as AnyApi).workerProvider || { providerId: "claude", model: "sonnet" };
    const defaultJudgeProvider = (taskDefaults as AnyApi).judgeProvider || { providerId: "claude", model: "opus" };

    // The panel command needs to reflect the active provider default, otherwise
    // a user with defaultWorkerProvider !== "claude" briefly sees a stale
    // "claude --dangerously-skip-permissions ..." string before WorkspaceDialog's
    // watcher rewrites it. Worse — if the user clicks Create without touching
    // the provider picker, we'd submit a claude command for a Copilot task.
    const initialWorkerCommand = buildProviderCommandString(defaultWorkerProvider as AnyApi);
    const initialJudgeCommand = buildProviderCommandString(defaultJudgeProvider as AnyApi);

    // Build a task workspace draft with panel stubs so the full dialog
    // can bind to workerPanel/judgePanel commands.
    const workerPanelId = `panel-${crypto.randomUUID()}`;
    const judgePanelId = `panel-${crypto.randomUUID()}`;
    const dashboardPanelId = `panel-${crypto.randomUUID()}`;
    const taskDraft: AnyApi = {
      id: `workspace-${crypto.randomUUID()}`,
      name: "",
      icon: "\u{1F916}",
      color: "#7C4DFF",
      kind: "task",
      source: "manual",
      pluginId: "",
      cwd: initialCwd,
      notes: "",
      activePanelId: dashboardPanelId,
      panels: [
        { id: dashboardPanelId, title: "Dashboard", command: "__task-dashboard__", shell: false, startup: "none" },
        {
          id: workerPanelId,
          title: "Worker",
          command: initialWorkerCommand,
          shell: true,
          startup: "default",
        },
        {
          id: judgePanelId,
          title: "Judge",
          command: initialJudgeCommand,
          shell: true,
          startup: "default",
        },
      ],
      task: {
        description: "",
        workerPanelId,
        judgePanelId,
        maxRounds: 10,
      },
      // Provider selection (new)
      workerProvider: { ...defaultWorkerProvider },
      judgeProvider: { ...defaultJudgeProvider },
      workerCommandOverride: false,
      judgeCommandOverride: false,
      // Extra fields consumed by the creation flow only
      useWorktree: false,
      worktreeBranch: "",
    };

    openDialog("WorkspaceDialog", {
      workspace: taskDraft,
      creating: true,
      tabTemplates: [],
      onCancel: closeDialog,
      onSubmit: async (draft: AnyApi) => {
        try {
          const config: AnyApi = {
            cwd: draft.cwd,
            description: draft.task?.description || "",
            maxRounds: draft.task?.maxRounds || 10,
            name: draft.name || "",
            icon: draft.icon || "",
            color: draft.color || "",
            notes: draft.notes || "",
          };

          // Extract worker/judge config: provider dropdown or raw command override
          const wp = draft.panels?.find((p: AnyApi) => p.id === workerPanelId);
          const jp = draft.panels?.find((p: AnyApi) => p.id === judgePanelId);
          if (draft.workerCommandOverride) {
            if (wp?.command) config.workerCommand = wp.command;
          } else if (draft.workerProvider) {
            config.workerProvider = draft.workerProvider;
          } else if (wp?.command) {
            config.workerCommand = wp.command;
          }
          if (draft.judgeCommandOverride) {
            if (jp?.command) config.judgeCommand = jp.command;
          } else if (draft.judgeProvider) {
            config.judgeProvider = draft.judgeProvider;
          } else if (jp?.command) {
            config.judgeCommand = jp.command;
          }

          // Worktree config
          if (draft.useWorktree) {
            config.useWorktree = true;
            config.worktreeBranch = draft.worktreeBranch || "";
          }

          // gitRoots inheritance — non-worktree task inside a multi-repo parent
          if (Array.isArray(draft.gitRoots) && draft.gitRoots.length >= 2) {
            config.gitRoots = draft.gitRoots;
          }

          // Use parent workspace ID passed by the dialog when available; otherwise auto-detect.
          if (draft.parentWorkspaceId) {
            config.parentWorkspaceId = draft.parentWorkspaceId;
          } else {
            const normCwd = (draft.cwd || "")
              .replace(/[\\/]+$/, "")
              .replace(/\\/g, "/")
              .toLowerCase();
            const activeProfileId = currentProfileId();
            const workspaces = ctx.payload.value?.appState?.workspaces || [];
            const parent = workspaces.find(
              (ws: AnyApi) =>
                ws.kind !== "task" &&
                (ws.profileId || "default") === activeProfileId &&
                (ws.cwd || "")
                  .replace(/[\\/]+$/, "")
                  .replace(/\\/g, "/")
                  .toLowerCase() === normCwd,
            );
            if (parent) config.parentWorkspaceId = (parent as AnyApi).id;
          }

          // Strip Vue reactive proxies before IPC — structuredClone can't serialize them
          const plainConfig = JSON.parse(JSON.stringify(config)) as AnyApi;
          const result = (await (ctx.getApi() as AnyApi).createTaskWorkspace(plainConfig)) as AnyApi;
          if (result?.payload) {
            ctx.payload.value = result.payload as StatePayload;
          }
          closeDialog();
          // Show warning if another task workspace uses the same directory
          if (result?.cwdWarning) {
            console.warn("[task-workspace] cwd conflict:", result.cwdWarning);
            const notifStore = (await import("./notifications.js")).useNotificationStore();
            notifStore.add({
              title: "Task workspace warning",
              body: result.cwdWarning,
              kind: "warning",
              workspaceId: result.workspaceId || "",
              workspaceName: config.description || "Task workspace",
              tabName: "",
              viewId: "",
            });
          }
        } catch (err) {
          console.error("[task-workspace] create failed:", err);
          // Re-throw so the dialog's inline error banner can render the
          // message. Do NOT close the dialog here — the user needs to see
          // what went wrong and correct the cwd (e.g. the directory isn't
          // a git repo) without retyping the whole task description.
          throw err;
        }
      },
    });
  }

  async function doStartTask(workspaceId: string): Promise<void> {
    const api = ctx.getApi() as AnyApi;
    try {
      const result = (await api.startTask({ workspaceId })) as AnyApi;
      if (result?.payload) ctx.payload.value = result.payload as StatePayload;
    } catch (err) {
      console.error("[task] start failed:", err);
    }
  }

  async function startTaskWithHookCheck(workspaceId: string): Promise<void> {
    const api = ctx.getApi() as AnyApi;
    // Check if agent hook setting is enabled
    const settings = (ctx.payload.value?.appState?.settings as AnyApi)?.notifications;
    const hookSettingEnabled = (settings as AnyApi)?.agentHook !== false;

    // Resolve the worker's provider so the check targets the right hook file.
    // Falls back to claude for legacy workspaces missing workerProvider.
    const workspaces = ctx.payload.value?.appState?.workspaces || [];
    const ws = (workspaces as AnyApi[]).find((w: AnyApi) => w.id === workspaceId) || null;
    const workerProviderId =
      (ws as AnyApi)?.task?.workerProviderConfig?.providerId || (ws as AnyApi)?.workerProvider?.providerId || "claude";
    const hookApi = hookApiForProvider(api, workerProviderId);
    const providerDisplayName = hookApi?.displayName || "the agent";

    // If setting is off, hooks can't work — show dialog immediately
    if (!hookSettingEnabled) {
      openDialog("TaskHookCheckDialog", {
        needsSettingEnable: true,
        providerDisplayName,
        onCancel: closeDialog,
        onSkip: () => {
          closeDialog();
          void doStartTask(workspaceId);
        },
        onConfigure: async () => {
          closeDialog();
          try {
            // Enable the setting first
            const settingsResult = (await api.updateSettings({
              notifications: { ...(settings as AnyApi), agentHook: true },
            })) as AnyApi;
            if (settingsResult?.payload) ctx.payload.value = settingsResult.payload as StatePayload;
            // Then configure the hook for the worker provider
            if (hookApi?.configure) await hookApi.configure();
          } catch (err) {
            console.error("[task] hook configure failed:", err);
          }
          await doStartTask(workspaceId);
        },
      });
      return;
    }

    // Setting is on — check if the worker provider's hook is actually configured
    try {
      const hookResult = hookApi?.status ? ((await hookApi.status()) as AnyApi) : null;
      if ((hookResult as AnyApi)?.status === "configured") {
        // All good — start immediately
        await doStartTask(workspaceId);
        return;
      }
    } catch {
      // Can't check — start anyway, don't block
      await doStartTask(workspaceId);
      return;
    }

    // Hook not configured — show dialog
    openDialog("TaskHookCheckDialog", {
      needsSettingEnable: false,
      providerDisplayName,
      onCancel: closeDialog,
      onSkip: () => {
        closeDialog();
        void doStartTask(workspaceId);
      },
      onConfigure: async () => {
        closeDialog();
        try {
          if (hookApi?.configure) await hookApi.configure();
        } catch (err) {
          console.error("[task] hook configure failed:", err);
        }
        await doStartTask(workspaceId);
      },
    });
  }

  // --- SSH dialogs -------------------------------------------------------

  function openSshHostsDialog(): void {
    openDialog("SshHostsDialog", { onCancel: closeDialog });
  }

  function openSshHostEditor(host: AnyApi = null): void {
    openDialog("SshHostEditor", {
      host,
      onCancel: closeDialog,
    });
  }

  function openSshKeyManager(): void {
    openDialog("SshKeyManager", { onCancel: closeDialog });
  }

  function openSshKeyGenerateDialog(): void {
    openDialog("SshKeyGenerateDialog", { onCancel: closeDialog });
  }

  function openSshKeyImportDialog(): void {
    openDialog("SshKeyImportDialog", { onCancel: closeDialog });
  }

  function openSshCertImportDialog(keyId: string): void {
    openDialog("SshCertImportDialog", { keyId, onCancel: closeDialog });
  }

  function openNewWindowModal(): void {
    const appState = ctx.payload.value?.appState || ({} as AnyApi);
    // Window context for "Duplicate current window" — desktop only; remote
    // clients have no desktop window of their own.
    const currentWindowId = ctx.getApi().isRemote
      ? ""
      : ((window as AnyApi).strideterm?.startupFlags?.windowId as string) || "";
    const slots = ((appState as AnyApi).windowSlots || []) as Array<{ id: string; profileId?: string }>;
    const currentWindowProfileId = currentWindowId
      ? slots.find((slot) => slot.id === currentWindowId)?.profileId || ""
      : "";
    openDialog("NewWindowModal", {
      profiles: JSON.parse(JSON.stringify((appState as AnyApi).profiles || [])) as unknown[],
      windowSlots: JSON.parse(JSON.stringify((appState as AnyApi).windowSlots || [])) as unknown[],
      workspaces: JSON.parse(JSON.stringify((appState as AnyApi).workspaces || [])) as unknown[],
      currentWindowId,
      currentProfileId: currentWindowProfileId,
      onCancel: closeDialog,
      "onCreate-and-open": async (profile: { id: string; name: string; color: string }) => {
        // Save the new profile, then open a window for it. saveProfile drives
        // the runtime state update; createWindow attaches a BrowserWindow to
        // the profile via main.ts:window:create.
        await (ctx.getApi() as AnyApi).saveProfile(profile);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (window as any).strideterm?.createWindow?.(profile.id);
        closeDialog();
      },
    });
  }

  return {
    openDialog,
    closeDialog,
    showContextMenu,
    hideContextMenu,
    showLayoutPicker,
    hideLayoutPicker,
    editTabWithDialog,
    openNewTabDialog,
    openWorkspaceDialog,
    openNewWorkspaceFlow,
    openSettingsDialog,
    openHelpDialog,
    openRemoteAccessDialog,
    openProfilesDialog,
    openNewWindowModal,
    openAzureConnectionDialog,
    openGitHubConnectionDialog,
    openGitHubQuickFixWizard,
    openQuickFixWizard,
    createWorktreeWithDialog,
    openTaskWorkspaceDialog,
    startTaskWithHookCheck,
    openSshHostsDialog,
    openSshHostEditor,
    openSshKeyManager,
    openSshKeyGenerateDialog,
    openSshKeyImportDialog,
    openSshCertImportDialog,
  };
}
