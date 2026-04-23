import { cloneWorkspace } from "../workspace-state.js";

// Build an initial CLI command string for a provider — used to pre-populate
// the worker/judge panel command field when we don't have a Vue-level
// buildProviderCommand in scope. Must stay aligned with the backend provider
// classes (electron/backend/providers/*) and the WorkspaceDialog copy.
function buildProviderCommandString({ providerId, model, skipPermissions } = {}) {
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
  return "claude --dangerously-skip-permissions --model sonnet";
}

// Hook API selectors per provider id. Returns null for providers that don't
// currently have a hook-config story (none today).
function hookApiForProvider(api, providerId) {
  if (!api) return null;
  if (providerId === "codex")
    return { status: api.getCodexHookStatus, configure: api.configureCodexHook, displayName: "Codex CLI" };
  if (providerId === "gemini")
    return { status: api.getGeminiHookStatus, configure: api.configureGeminiHook, displayName: "Gemini CLI" };
  if (providerId === "copilot")
    return { status: api.getCopilotHookStatus, configure: api.configureCopilotHook, displayName: "GitHub Copilot" };
  // Default to Claude for legacy workspaces and explicit claude selection.
  return { status: api.getClaudeHookStatus, configure: api.configureClaudeHook, displayName: "Claude Code" };
}

/**
 * Factory for dialog / overlay / context-menu / layout-picker actions.
 *
 * @param {object} ctx  Shared refs and helpers injected by the app store.
 *   overlay, overlayProps, contextMenu, layoutPickerAnchor,
 *   payload, activeViewId, activeSessionId, splitGroup, suppressBroadcast,
 *   hiddenViewIds, getApi, withSuppressedBroadcast, getPanelByViewId,
 *   createWorktree
 */
export function createDialogActions(ctx) {
  // --- Dialog / overlay --------------------------------------------------

  function openDialog(name, props = {}) {
    ctx.overlay.value = name;
    ctx.overlayProps.value = props;
  }

  function closeDialog() {
    ctx.overlay.value = null;
    ctx.overlayProps.value = {};
  }

  // --- Context menu ------------------------------------------------------

  function showContextMenu(x, y, viewId) {
    ctx.contextMenu.value = { x, y, viewId };
  }

  function hideContextMenu() {
    ctx.contextMenu.value = null;
  }

  // --- Layout picker -----------------------------------------------------

  function showLayoutPicker(anchorRect) {
    ctx.layoutPickerAnchor.value = anchorRect;
  }

  function hideLayoutPicker() {
    ctx.layoutPickerAnchor.value = null;
  }

  // --- Tab edit dialog ---------------------------------------------------

  function editTabWithDialog(viewId) {
    const target = ctx.getPanelByViewId(viewId);
    if (!target) return;
    // For SSH tabs pointing at a saved host, jump straight to the full host
    // editor — tab-level edit (title/command only) is a poor fit when the
    // user wants to tweak hostname, auth, etc.
    const launch = target.panel.launch;
    if (launch?.kind === "ssh" && launch.sshHostId) {
      const appState = ctx.payload.value?.appState;
      const host = appState?.ssh?.hosts?.find((h) => h.id === launch.sshHostId);
      if (host && openSshHostEditor) {
        openSshHostEditor(host);
        return;
      }
    }
    openDialog("EditTabDialog", {
      eyebrow: "Workspace",
      mode: "edit",
      title: target.panel.title || "",
      command: target.panel.command || "",
      onCancel: closeDialog,
      onSubmit: async ({ title, command }) => {
        const nextTitle = (title || "").trim();
        const nextCommand = (command || "").trim();
        const sameTitle = nextTitle === (target.panel.title || "").trim();
        const sameCommand = nextCommand === (target.panel.command || "").trim();
        if (!nextTitle || (sameTitle && sameCommand)) {
          closeDialog();
          return;
        }
        const nextWorkspace = cloneWorkspace(target.workspace);
        nextWorkspace.panels = nextWorkspace.panels.map((p) =>
          p.id === target.panel.id ? { ...p, title: nextTitle, command: nextCommand } : p,
        );
        ctx.payload.value = await ctx.getApi().saveWorkspace(nextWorkspace);
        closeDialog();
      },
    });
  }

  function openNewTabDialog(cwdOverride = "", presetTitle = "", presetCommand = "", options = {}) {
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
      onEditSshHost: (host, currentState) => {
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
      onSubmit: async (payload) => {
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

  function isBrowserPanel(panel = {}) {
    return /^https?:\/\//i.test(String(panel.command || "").trim());
  }

  function openWorkspaceDialog(workspace = null) {
    const tabTemplates = ctx.payload.value?.appState?.tabTemplates || [];
    openDialog("WorkspaceDialog", {
      workspace,
      tabTemplates,
      onCancel: closeDialog,
      onSubmit: async (draft) => {
        try {
          const isNew = !workspace;
          if (isNew) draft.profileId = ctx.payload.value?.appState?.activeProfileId || "default";
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
          const plain = JSON.parse(JSON.stringify(draft));
          await ctx.withSuppressedBroadcast(async () => {
            ctx.payload.value = await ctx.getApi().saveWorkspace(plain);
            if (isNew) {
              ctx.payload.value = await ctx.getApi().activateWorkspace(plain.id);
            }
          });
        } catch (err) {
          console.error("[workspace-dialog] save failed:", err);
        } finally {
          closeDialog();
        }
      },
    });
  }

  function openNewWorkspaceFlow() {
    const plugins = ctx.payload.value?.plugins || [];
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
      onPickPlugin: (pluginId) => {
        closeDialog();
        const plugin = plugins.find((p) => p.id === pluginId);
        if (!plugin?.workspaceDefaults) {
          openWorkspaceDialog();
          return;
        }
        const tpl = plugin.workspaceDefaults;
        const draft = {
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
          panels: (tpl.panels || []).map((panel) => ({ ...panel })),
        };
        openWorkspaceDialog(draft);
      },
    });
  }

  // --- Settings / help / profiles / azure connection dialogs -------------

  function openSettingsDialog() {
    openDialog("SettingsDialog", {
      settings: ctx.payload.value?.appState?.settings || {},
      tabTemplates: ctx.payload.value?.appState?.tabTemplates || [],
      appVersion: ctx.payload.value?.meta?.appVersion || "",
      repositoryUrl: ctx.payload.value?.meta?.repositoryUrl || "",
      versionCheck: ctx.payload.value?.meta?.versionCheck || null,
      onCancel: closeDialog,
      onSave: async (patch) => {
        try {
          const plain = JSON.parse(JSON.stringify(patch));
          ctx.payload.value = await ctx.getApi().updateSettings(plain);
          closeDialog();
        } catch (err) {
          ctx.overlayProps.value = {
            ...ctx.overlayProps.value,
            saveError: err.message || "Failed to save settings",
          };
        }
      },
    });
  }

  function openHelpDialog() {
    openDialog("HelpDialog", { onClose: closeDialog });
  }

  function openProfilesDialog() {
    const appState = ctx.payload.value?.appState || {};
    openDialog("ProfilesDialog", {
      profiles: JSON.parse(JSON.stringify(appState.profiles || [])),
      activeProfileId: appState.activeProfileId || "default",
      workspaces: appState.workspaces || [],
      onCancel: closeDialog,
      onSave: async (profile) => {
        ctx.payload.value = await ctx.getApi().saveProfile(profile);
      },
      onActivate: async (profileId) => {
        ctx.suppressBroadcast.value = true;
        try {
          ctx.payload.value = await ctx.getApi().activateProfile(profileId);
        } catch (err) {
          ctx.suppressBroadcast.value = false;
          throw err;
        }
        ctx.activeViewId.value = null;
        ctx.activeSessionId.value = null;
        ctx.splitGroup.value = null;
        closeDialog();
        setTimeout(() => {
          ctx.suppressBroadcast.value = false;
        }, 200);
      },
      onDelete: async (profileId) => {
        ctx.payload.value = await ctx.getApi().deleteProfile(profileId);
      },
    });
  }

  function openAzureConnectionDialog(connectionId = "") {
    const azureSettings = ctx.payload.value?.appState?.settings?.integrations?.azureDevops || {};
    const connection = (azureSettings.connections || []).find((c) => c.id === connectionId) || null;
    openDialog("AzureConnectionDialog", {
      connection,
      defaultReviewRoot: azureSettings.reviewRoot || "",
      onCancel: closeDialog,
      onSave: async (draft) => {
        draft.profileId = ctx.payload.value?.appState?.activeProfileId || "default";
        const result = await ctx.getApi().saveAzureConnection(draft);
        ctx.payload.value = result.payload || result;
        closeDialog();
      },
    });
  }

  function openGitHubConnectionDialog(connectionId = "") {
    const ghSettings = ctx.payload.value?.appState?.settings?.integrations?.github || {};
    const connection = (ghSettings.connections || []).find((c) => c.id === connectionId) || null;
    openDialog("GitHubConnectionDialog", {
      connection,
      defaultReviewRoot: ghSettings.reviewRoot || "",
      onCancel: closeDialog,
      onSave: async (draft) => {
        draft.profileId = ctx.payload.value?.appState?.activeProfileId || "default";
        const result = await ctx.getApi().saveGitHubConnection(draft);
        ctx.payload.value = result.payload || result;
        closeDialog();
      },
    });
  }

  function openGitHubQuickFixWizard() {
    const ghSettings = ctx.payload.value?.appState?.settings?.integrations?.github || {};
    const connections = (ghSettings.connections || []).filter((c) => c.enabled !== false);
    if (!connections.length) {
      openGitHubConnectionDialog("");
      return;
    }
    openDialog("QuickFixWizardDialog", {
      provider: "github",
      connections,
      onCancel: closeDialog,
      onCreate: (result) => {
        closeDialog();
        if (result) {
          ctx.payload.value = result;
          ctx.activeViewId.value = null;
          ctx.splitGroup.value = null;
        }
      },
    });
  }

  // --- Quick Fix wizard ---------------------------------------------------

  function openQuickFixWizard() {
    const azureSettings = ctx.payload.value?.appState?.settings?.integrations?.azureDevops || {};
    const connections = (azureSettings.connections || []).filter((c) => c.enabled !== false);
    if (!connections.length) {
      openAzureConnectionDialog("");
      return;
    }
    openDialog("QuickFixWizardDialog", {
      connections,
      onCancel: closeDialog,
      onCreate: (result) => {
        closeDialog();
        if (result) {
          ctx.payload.value = result;
          ctx.activeViewId.value = null;
          ctx.splitGroup.value = null;
        }
      },
    });
  }

  // --- Worktree dialog ---------------------------------------------------

  function createWorktreeWithDialog(workspaceId, { preselectedRootPath = "" } = {}) {
    const workspaces = ctx.payload.value?.appState?.workspaces || [];
    const target = workspaces.find((w) => w.id === workspaceId);
    const gitRoots = Array.isArray(target?.gitRoots) ? target.gitRoots.filter(Boolean) : [];
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
        onSubmit: async ({ name, rootPath }) => {
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
      onSubmit: async (name) => {
        closeDialog();
        await ctx.createWorktree(workspaceId, name, preselectedRootPath || "");
      },
    });
  }

  function formatRootBasename(rootPath, allRoots) {
    const basename = rootPath.split(/[\\/]/).filter(Boolean).at(-1) || rootPath;
    const collisions = allRoots.filter((r) => {
      const rb = r.split(/[\\/]/).filter(Boolean).at(-1) || r;
      return rb === basename && r !== rootPath;
    });
    if (!collisions.length) return basename;
    const segments = rootPath.split(/[\\/]/).filter(Boolean);
    return segments.slice(-2).join("/") || basename;
  }

  function openTaskWorkspaceDialog() {
    const ws = ctx.payload.value?.workspace;
    const activeWorkspace = ws?.workspace || ws?.project || null;
    const initialCwd = activeWorkspace?.cwd || "";

    // Re-check Claude CLI availability in the background so the dialog
    // shows up-to-date status (user may have installed claude mid-session)
    ctx
      .getApi()
      .recheckClaude?.()
      .then((result) => {
        if (result?.payload) ctx.payload.value = result.payload;
      })
      .catch(() => {});

    // Check all provider availabilities in the background — result is passed
    // to the dialog via the providerAvailability prop after resolution.
    const providerAvailabilityRef = { value: {} };
    ctx
      .getApi()
      .checkProviders?.()
      .then((result) => {
        providerAvailabilityRef.value = result || {};
      })
      .catch(() => {});

    // Use per-user taskDefaults from settings for the initial provider selection
    const taskDefaults = ctx.payload.value?.appState?.settings?.taskDefaults || {};
    const defaultWorkerProvider = taskDefaults.workerProvider || { providerId: "claude", model: "sonnet" };
    const defaultJudgeProvider = taskDefaults.judgeProvider || { providerId: "claude", model: "opus" };

    // The panel command needs to reflect the active provider default, otherwise
    // a user with defaultWorkerProvider !== "claude" briefly sees a stale
    // "claude --dangerously-skip-permissions ..." string before WorkspaceDialog's
    // watcher rewrites it. Worse — if the user clicks Create without touching
    // the provider picker, we'd submit a claude command for a Copilot task.
    const initialWorkerCommand = buildProviderCommandString(defaultWorkerProvider);
    const initialJudgeCommand = buildProviderCommandString(defaultJudgeProvider);

    // Build a task workspace draft with panel stubs so the full dialog
    // can bind to workerPanel/judgePanel commands.
    const workerPanelId = `panel-${crypto.randomUUID()}`;
    const judgePanelId = `panel-${crypto.randomUUID()}`;
    const dashboardPanelId = `panel-${crypto.randomUUID()}`;
    const taskDraft = {
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
      providerAvailabilityRef,
      onCancel: closeDialog,
      onSubmit: async (draft) => {
        try {
          const config = {
            cwd: draft.cwd,
            description: draft.task?.description || "",
            maxRounds: draft.task?.maxRounds || 10,
            name: draft.name || "",
            icon: draft.icon || "",
            color: draft.color || "",
            notes: draft.notes || "",
          };

          // Extract worker/judge config: provider dropdown or raw command override
          const wp = draft.panels?.find((p) => p.id === workerPanelId);
          const jp = draft.panels?.find((p) => p.id === judgePanelId);
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
            const activeProfileId = ctx.payload.value?.appState?.activeProfileId || "default";
            const workspaces = ctx.payload.value?.appState?.workspaces || [];
            const parent = workspaces.find(
              (ws) =>
                ws.kind !== "task" &&
                (ws.profileId || "default") === activeProfileId &&
                (ws.cwd || "")
                  .replace(/[\\/]+$/, "")
                  .replace(/\\/g, "/")
                  .toLowerCase() === normCwd,
            );
            if (parent) config.parentWorkspaceId = parent.id;
          }

          // Strip Vue reactive proxies before IPC — structuredClone can't serialize them
          const plainConfig = JSON.parse(JSON.stringify(config));
          const result = await ctx.getApi().createTaskWorkspace(plainConfig);
          if (result?.payload) {
            ctx.payload.value = result.payload;
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

  async function doStartTask(workspaceId) {
    const api = ctx.getApi();
    try {
      const result = await api.startTask({ workspaceId });
      if (result?.payload) ctx.payload.value = result.payload;
    } catch (err) {
      console.error("[task] start failed:", err);
    }
  }

  async function startTaskWithHookCheck(workspaceId) {
    const api = ctx.getApi();
    // Check if agent hook setting is enabled
    const settings = ctx.payload.value?.appState?.settings?.notifications;
    const hookSettingEnabled = settings?.agentHook !== false;

    // Resolve the worker's provider so the check targets the right hook file.
    // Falls back to claude for legacy workspaces missing workerProvider.
    const workspaces = ctx.payload.value?.appState?.workspaces || [];
    const ws = workspaces.find((w) => w.id === workspaceId) || null;
    const workerProviderId = ws?.task?.workerProviderConfig?.providerId || ws?.workerProvider?.providerId || "claude";
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
          doStartTask(workspaceId);
        },
        onConfigure: async () => {
          closeDialog();
          try {
            // Enable the setting first
            const settingsResult = await api.updateSettings({
              notifications: { ...settings, agentHook: true },
            });
            if (settingsResult?.payload) ctx.payload.value = settingsResult.payload;
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
      const hookResult = hookApi?.status ? await hookApi.status() : null;
      if (hookResult?.status === "configured") {
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
        doStartTask(workspaceId);
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

  function openSshHostsDialog() {
    openDialog("SshHostsDialog", { onCancel: closeDialog });
  }

  function openSshHostEditor(host = null) {
    openDialog("SshHostEditor", {
      host,
      onCancel: closeDialog,
      onSave: closeDialog,
    });
  }

  function openSshKeyManager() {
    openDialog("SshKeyManager", { onCancel: closeDialog });
  }

  function openSshKeyGenerateDialog() {
    openDialog("SshKeyGenerateDialog", { onCancel: closeDialog });
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
    openProfilesDialog,
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
  };
}
