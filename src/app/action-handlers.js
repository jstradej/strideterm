import { cloneWorkspace } from "../workspace-state.js";
import { render as renderTemplate } from "lit";
import { renderTabPickerDropdown } from "./action-render.js";
import { preferredRemoteUrl, withRemoteToken } from "./helpers.js";

const FALLBACK_TAB_TEMPLATES = [
  { title: "Shell", command: "", icon: "\u{1F4BB}" },
  { title: "Claude Code", command: "claude", icon: "\u{1F916}" },
  { title: "Browser", command: "https://", icon: "\u{1F310}" },
];

function getUserVisibleErrorMessage(error, fallback = "Action failed.") {
  let message = error instanceof Error ? error.message : String(error || fallback);
  message = String(message || "").trim();
  message = message.replace(/^Error invoking remote method '[^']+':\s*/i, "");
  message = message.replace(/^Error:\s*/i, "");
  return message || fallback;
}

export function createActionHandlers(context) {
  const {
    state,
    api,
    appConfig,
    layouts,
    root,
    remoteAccess,
    openSidebar,
    closeSidebar,
    syncSidebarCollapsed,
    closeOverlay,
    hideContextMenu,
    showLayoutPicker,
    hideLayoutPicker,
    openWorkspaceDialog,
    openNewWorkspaceFlow,
    openSettingsDialog,
    openHelpDialog,
    openProfilesDialog,
    activateView,
    renameWorkspacePanel,
    exportTerminalTranscript,
    clearTerminalViewport,
    focusActiveTerminal,
    getWorkspace,
    getActiveWorkspace,
    getGitSnapshot,
    getWorkspaceTabs,
    render,
    renderRemoteAccess,
    readCustomPublicUrl,
    copyText,
    getRemoteShareUrl,
    isGitViewId,
    isDockerViewId,
    isAzureViewId,
    isReviewViewId,
    openAzureConnectionDialog,
    createTextAreaDialog,
    createTextInputDialog,
  } = context;

  function isBrowserPanel(panel = {}) {
    return /^https?:\/\//i.test(String(panel.command || "").trim());
  }

  function buildWorkspacePayloadSnapshot(workspaceId) {
    const appState = state.payload?.appState;
    if (!appState) {
      return null;
    }

    const workspace = (appState.workspaces || []).find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return null;
    }

    return {
      workspace,
      project: workspace,
      sessions: (workspace.panels || [])
        .filter((panel) => !isBrowserPanel(panel))
        .map((panel) => ({
          sessionId: `${workspace.id}:${panel.id}`,
          panelId: panel.id,
          title: panel.title,
          command: panel.command,
          launch: panel.launch,
          startup: panel.startup,
          status: "idle",
        })),
    };
  }

  function applyOptimisticWorkspaceActivation(workspaceId) {
    const appState = state.payload?.appState;
    if (!appState || !(appState.workspaces || []).some((workspace) => workspace.id === workspaceId)) {
      return false;
    }

    appState.activeWorkspaceId = workspaceId;
    appState.activeProjectId = workspaceId;
    state.pendingWorkspaceActivationId = workspaceId;
    state.payload = {
      ...state.payload,
      appState,
      workspace: buildWorkspacePayloadSnapshot(workspaceId),
    };
    return true;
  }

  function ensureGitUiState(workspaceId) {
    if (!workspaceId) {
      return {};
    }
    state.gitUiState[workspaceId] = state.gitUiState[workspaceId] || {};
    return state.gitUiState[workspaceId];
  }

  function clearGitBusy(workspaceId) {
    const gitUi = ensureGitUiState(workspaceId);
    gitUi.busyAction = "";
  }

  async function runGitAction(workspaceId, busyAction, runner) {
    const gitUi = ensureGitUiState(workspaceId);
    gitUi.busyAction = busyAction;
    render();

    try {
      const response = await runner();
      state.payload = response?.payload || state.payload;
      gitUi.lastResult = response?.result
        ? {
            ...response.result,
            at: new Date().toISOString(),
          }
        : null;

      if (gitUi.selectedDiff?.path) {
        const snapshot = getGitSnapshot(workspaceId);
        const preview = await api.gitDiffPreview({
          workspaceId,
          path: gitUi.selectedDiff.path,
          scope: gitUi.selectedDiff.scope,
          baseBranch: snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "",
        }).catch(() => null);
        if (preview) {
          gitUi.diffPreview = preview;
        }
      }
    } catch (error) {
      gitUi.lastResult = {
        ok: false,
        summary: error?.message || "Git action failed.",
        warnings: [],
        conflicts: [],
        rawOutput: "",
        operationState: null,
        at: new Date().toISOString(),
      };
    } finally {
      clearGitBusy(workspaceId);
      render();
    }
  }

  async function loadGitDiffPreview(workspaceId, path, scope) {
    const gitUi = ensureGitUiState(workspaceId);
    gitUi.selectedDiff = { path, scope };
    gitUi.diffPreview = {
      ok: true,
      path,
      scope,
      diff: "",
      summary: "Loading diff preview...",
    };
    render();

    const snapshot = getGitSnapshot(workspaceId);
    try {
      gitUi.diffPreview = await api.gitDiffPreview({
        workspaceId,
        path,
        scope,
        baseBranch: snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "",
      });
    } catch (error) {
      gitUi.diffPreview = {
        ok: false,
        path,
        scope,
        diff: "",
        summary: error?.message || "Diff preview failed to load.",
      };
    }
    render();
  }

  function buildConfirmMessage({ type, snapshot, baseBranch }) {
    const target = baseBranch || snapshot?.baseBranch || "base";
    const lines = [];

    if (type === "merge") {
      lines.push(`Merge ${target} into ${snapshot.branch}?`);
    } else if (type === "rebase") {
      lines.push(`Rebase ${snapshot.branch} onto ${target}? Your commits will be replayed on top of ${target} (commit hashes will change, content is preserved).`);
    } else if (type === "merge-into-base") {
      lines.push(`Merge ${snapshot?.branch || "current branch"} into ${target}?`);
      lines.push("This runs git merge in the base worktree.");
    } else if (type === "abort") {
      lines.push("Abort the current Git operation?");
    }

    if (snapshot?.dirty && type !== "abort") {
      lines.push("This workspace has uncommitted changes. Local changes will be stashed and restored afterwards.");
    }
    if (snapshot?.upstream && type !== "abort") {
      lines.push(`Upstream: ${snapshot.upstream}.`);
    }

    return lines.join("\n");
  }

  function setPendingGitAction(workspaceId, { type, baseBranch, snapshot }) {
    const gitUi = ensureGitUiState(workspaceId);
    gitUi.pendingAction = {
      type,
      baseBranch,
      stashDirty: snapshot?.dirty || false,
      message: buildConfirmMessage({ type, snapshot, baseBranch }),
    };
    render();
  }

  function clearPendingGitAction(workspaceId) {
    const gitUi = ensureGitUiState(workspaceId);
    gitUi.pendingAction = null;
    render();
  }

  async function handleRootAction(action, actionElement) {
    if (action === "toggle-sidebar") {
      if (root.querySelector(".sidebar")?.classList.contains("sidebar--open")) {
        closeSidebar();
      } else {
        openSidebar();
      }
      return true;
    }

    if (action === "toggle-sidebar-collapse") {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      syncSidebarCollapsed();
      return true;
    }

    if (action === "new-workspace") {
      await openNewWorkspaceFlow();
      return true;
    }
    if (action === "open-settings") {
      openSettingsDialog();
      return true;
    }
    if (action === "open-help") {
      openHelpDialog();
      return true;
    }
    if (action === "open-profiles") {
      openProfilesDialog();
      return true;
    }
    if (action === "open-repository-link") {
      const url = String(actionElement.dataset.url || "").trim();
      if (url) {
        api.openExternal?.(url);
      }
      return true;
    }
    if (action === "open-azure-connection-dialog") {
      openAzureConnectionDialog(actionElement.dataset.connectionId || "");
      return true;
    }
    if (action === "delete-azure-connection") {
      const connectionId = actionElement.dataset.connectionId;
      if (!connectionId) {
        return true;
      }
      if (!window.confirm("Delete this Azure DevOps connection?")) {
        return true;
      }
      state.payload = await api.deleteAzureConnection(connectionId);
      render();
      return true;
    }
    if (action === "azure-switch-tab") {
      const tab = actionElement.dataset.tab;
      if (!tab) return true;
      const inbox = actionElement.closest(".azure-inbox");
      if (!inbox) return true;
      inbox.querySelectorAll(".azure-tab").forEach((btn) => btn.classList.toggle("azure-tab--active", btn.dataset.tab === tab));
      inbox.querySelectorAll(".azure-section").forEach((sec) => sec.classList.toggle("azure-section--active", sec.dataset.azureSection === tab));
      return true;
    }
    if (action === "review-switch-tab") {
      const tab = actionElement.dataset.tab || "summary";
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }
      ensureGitUiState(workspaceId).activeReviewTab = tab;
      render();
      return true;
    }
    if (action === "review-comment-filter") {
      const filter = actionElement.dataset.filter || "all";
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) return true;
      ensureGitUiState(workspaceId).commentFilter = filter;
      render();
      return true;
    }
    if (action === "review-agent-subtab") {
      const subtab = actionElement.dataset.subtab || "prompts";
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) return true;
      ensureGitUiState(workspaceId).agentSubTab = subtab;
      render();
      return true;
    }
    if (action === "review-comment-sort") {
      const sort = actionElement.dataset.sort || "index";
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) return true;
      ensureGitUiState(workspaceId).commentSort = sort;
      render();
      return true;
    }
    if (action === "review-comment-search") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) return true;
      ensureGitUiState(workspaceId).commentSearch = actionElement.value || "";
      render();
      return true;
    }
    if (action === "review-comment-nav") {
      const direction = actionElement.dataset.direction || "next";
      const list = actionElement.closest(".review-panel")?.querySelector("[data-scroll-key='comments-list']");
      if (!list) return true;
      const cards = [...list.querySelectorAll(".review-comment-card")];
      if (!cards.length) return true;
      const listRect = list.getBoundingClientRect();
      // Find the first card whose top is below the list's top edge (current visible card)
      const currentIndex = cards.findIndex((card) => card.getBoundingClientRect().top >= listRect.top - 2);
      const targetIndex = direction === "prev"
        ? Math.max(0, (currentIndex <= 0 ? 0 : currentIndex - 1))
        : Math.min(cards.length - 1, (currentIndex < 0 ? 0 : currentIndex + 1));
      cards[targetIndex]?.scrollIntoView({ block: "start", behavior: "smooth" });
      return true;
    }
    if (action === "refresh-azure") {
      const btn = actionElement;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Refreshing\u2026";
      try {
        state.payload = await api.refreshAzure();
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
      render();
      return true;
    }
    if (action === "open-azure-browser") {
      const url = String(actionElement.dataset.url || "").trim();
      if (url) {
        api.openExternal?.(url);
      }
      return true;
    }
    if (action === "mark-azure-pr-seen") {
      const prKey = actionElement.dataset.prKey;
      if (!prKey) {
        return true;
      }
      state.payload = await api.markAzurePullRequestSeen(prKey);
      render();
      return true;
    }
    if (action === "open-azure-pull-request") {
      const prKey = actionElement.dataset.prKey;
      if (!prKey) {
        return true;
      }
      try {
        actionElement.disabled = true;
        actionElement.textContent = "Opening\u2026";
        state.payload = await api.openAzurePullRequest({
          prKey,
          workspaceId: actionElement.dataset.workspaceId || "",
        });
        render();
        focusActiveTerminal();
      } catch (error) {
        actionElement.disabled = false;
        actionElement.textContent = "Retry";
        window.alert(`Review workspace could not be opened.\n\n${getUserVisibleErrorMessage(error, "Unknown Azure DevOps error.")}`);
      }
      return true;
    }
    if (action === "azure-resolve-thread") {
      const prKey = actionElement.dataset.prKey;
      const threadId = Number.parseInt(actionElement.dataset.threadId || "", 10);
      if (!prKey || !threadId) {
        return true;
      }
      state.payload = await api.updateAzureThreadStatus({ prKey, threadId, status: "fixed" });
      render();
      return true;
    }
    if (action === "azure-reactivate-thread") {
      const prKey = actionElement.dataset.prKey;
      const threadId = Number.parseInt(actionElement.dataset.threadId || "", 10);
      if (!prKey || !threadId) {
        return true;
      }
      state.payload = await api.updateAzureThreadStatus({ prKey, threadId, status: "active" });
      render();
      return true;
    }
    if (action === "azure-comment" || action === "azure-reply-thread") {
      const prKey = actionElement.dataset.prKey;
      if (!prKey) {
        return true;
      }
      const isReply = action === "azure-reply-thread";
      const threadId = isReply
        ? Number.parseInt(actionElement.dataset.threadId || "", 10)
        : null;
      const parentCommentId = Number.parseInt(actionElement.dataset.parentCommentId || "0", 10) || 0;
      const dialog = createTextAreaDialog({
        eyebrow: "Azure DevOps",
        title: isReply ? "Reply to thread" : "New comment",
        label: "Comment",
        placeholder: "Write your review comment...",
        submitLabel: isReply ? "Reply" : "Post comment",
        secondarySubmitLabel: isReply ? "Reply & resolve" : "",
        onCancel: () => { closeOverlay(); focusActiveTerminal(); },
        onSubmit: async (content) => {
          closeOverlay();
          state.payload = await api.commentAzurePullRequest({
            prKey,
            content,
            threadId,
            parentCommentId,
          });
          render();
          focusActiveTerminal();
        },
        onSecondarySubmit: isReply ? async (content) => {
          closeOverlay();
          state.payload = await api.commentAzurePullRequest({
            prKey,
            content,
            threadId,
            parentCommentId,
          });
          if (threadId) {
            state.payload = await api.updateAzureThreadStatus({ prKey, threadId, status: "fixed" });
          }
          render();
          focusActiveTerminal();
        } : null,
      });
      closeOverlay();
      state.overlay = dialog;
      root.appendChild(dialog);
      dialog.querySelector("textarea")?.focus();
      return true;
    }
    if (action === "review-bridge-edit-draft") {
      const prKey = actionElement.dataset.prKey;
      const commentKey = actionElement.dataset.commentKey;
      if (!prKey || !commentKey) {
        return true;
      }
      const reviewBridge = state.payload?.reviewBridge?.pullRequests?.[prKey] || {};
      const draft = (reviewBridge.drafts || []).find((entry) => entry.commentKey === commentKey) || null;
      const dialog = createTextAreaDialog({
        eyebrow: "Review Bridge",
        title: draft ? "Edit local draft" : "Create local draft",
        label: "Draft reply",
        value: draft?.body || "",
        placeholder: "Write the local draft reply that can later be queued and published to Azure DevOps...",
        submitLabel: draft ? "Save draft" : "Create draft",
        onCancel: () => { closeOverlay(); focusActiveTerminal(); },
        onSubmit: async (content) => {
          closeOverlay();
          state.payload = await api.saveReviewBridgeDraft({
            prKey,
            commentKey,
            body: content,
            authorAgent: "human",
          });
          render();
          focusActiveTerminal();
        },
      });
      closeOverlay();
      state.overlay = dialog;
      root.appendChild(dialog);
      dialog.querySelector("textarea")?.focus();
      return true;
    }
    if (action === "review-bridge-create-local-comment") {
      const prKey = actionElement.dataset.prKey;
      if (!prKey) {
        return true;
      }
      const dialog = createTextAreaDialog({
        eyebrow: "Review Bridge",
        title: "New local comment",
        label: "Comment or follow-up",
        value: "",
        placeholder: "Describe the local review comment, follow-up, or note the agent should work on...",
        submitLabel: "Create comment",
        onCancel: () => { closeOverlay(); focusActiveTerminal(); },
        onSubmit: async (content) => {
          closeOverlay();
          state.payload = await api.createReviewBridgeLocalComment({
            prKey,
            body: content,
            authorAgent: "human",
          });
          render();
          focusActiveTerminal();
        },
      });
      closeOverlay();
      state.overlay = dialog;
      root.appendChild(dialog);
      dialog.querySelector("textarea")?.focus();
      return true;
    }
    if (action === "edit-agent-prompt") {
      const promptId = actionElement.dataset.promptId || "";
      const currentTitle = actionElement.dataset.promptTitle || "";
      const currentTemplate = actionElement.dataset.promptTemplate || "";
      const currentDescription = actionElement.dataset.promptDescription || "";
      const dialog = createTextAreaDialog({
        eyebrow: "Agent Prompt",
        title: `Edit: ${currentTitle}`,
        label: "Prompt template (use plain text — PR details are auto-inserted)",
        value: currentTemplate,
        placeholder: "Enter the prompt template...",
        submitLabel: "Save prompt",
        onCancel: () => { closeOverlay(); focusActiveTerminal(); },
        onSubmit: async (content) => {
          closeOverlay();
          state.payload = await api.saveAgentPrompt({
            promptId,
            title: currentTitle,
            description: currentDescription,
            template: content,
          });
          render();
          focusActiveTerminal();
        },
      });
      closeOverlay();
      state.overlay = dialog;
      root.appendChild(dialog);
      dialog.querySelector("textarea")?.focus();
      return true;
    }
    if (action === "delete-agent-prompt") {
      const promptId = actionElement.dataset.promptId || "";
      if (!promptId) return true;
      if (!window.confirm("Delete this prompt?")) return true;
      state.payload = await api.deleteAgentPrompt({ promptId });
      render();
      return true;
    }
    if (action === "review-bridge-delete-comment") {
      const prKey = actionElement.dataset.prKey;
      const commentKey = actionElement.dataset.commentKey;
      if (!prKey || !commentKey) {
        return true;
      }
      if (!window.confirm("Delete this local comment and its drafts? This cannot be undone.")) {
        return true;
      }
      state.payload = await api.deleteReviewBridgeComment({ prKey, commentKey });
      render();
      return true;
    }
    if (action === "review-bridge-delete-draft") {
      const prKey = actionElement.dataset.prKey;
      const draftId = actionElement.dataset.draftId;
      if (!prKey || !draftId) {
        return true;
      }
      if (!window.confirm("Delete this draft? This cannot be undone.")) {
        return true;
      }
      state.payload = await api.deleteReviewBridgeDraft({ prKey, draftId });
      render();
      return true;
    }
    if (action === "review-bridge-queue-draft") {
      const prKey = actionElement.dataset.prKey;
      const draftId = actionElement.dataset.draftId;
      if (!prKey || !draftId) {
        return true;
      }
      state.payload = await api.queueReviewBridgeDraft({ prKey, draftId });
      render();
      return true;
    }
    if (action === "review-bridge-delete-all-drafts") {
      const prKey = actionElement.dataset.prKey;
      if (!prKey) return true;
      const bridge = state.payload?.reviewBridge?.pullRequests?.[prKey] || {};
      const drafts = (bridge.drafts || []).filter((d) => d.status === "draft");
      const localComments = (bridge.comments || []).filter((c) => c.commentKind === "local-comment");
      const totalCount = drafts.length + localComments.length;
      if (!totalCount) return true;
      if (!window.confirm(`Delete ${drafts.length} draft${drafts.length !== 1 ? "s" : ""} and ${localComments.length} local comment${localComments.length !== 1 ? "s" : ""}? This cannot be undone.`)) return true;
      for (const comment of localComments) {
        state.payload = await api.deleteReviewBridgeComment({ prKey, commentKey: comment.commentKey });
      }
      for (const draft of drafts) {
        // Skip drafts whose comments were already deleted above
        if (!localComments.some((c) => c.commentKey === draft.commentKey)) {
          state.payload = await api.deleteReviewBridgeDraft({ prKey, draftId: draft.draftId });
        }
      }
      render();
      return true;
    }
    if (action === "review-bridge-queue-all-drafts") {
      const prKey = actionElement.dataset.prKey;
      if (!prKey) return true;
      const drafts = (state.payload?.reviewBridge?.pullRequests?.[prKey]?.drafts || []).filter((d) => d.status === "draft");
      if (!drafts.length) return true;
      for (const draft of drafts) {
        state.payload = await api.queueReviewBridgeDraft({ prKey, draftId: draft.draftId });
      }
      render();
      return true;
    }
    if (action === "review-bridge-sync") {
      const prKey = actionElement.dataset.prKey;
      if (!prKey) {
        return true;
      }
      state.payload = await api.syncReviewBridgePullRequest({ prKey });
      render();
      return true;
    }
    if (action === "copy-text") {
      const text = actionElement.dataset.text || "";
      if (text) {
        await copyText(text);
      }
      return true;
    }
    if (action === "review-select-file-diff") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      const filePath = (actionElement.dataset.path || "").replace(/^\/+/, "");
      const explicitBase = actionElement.dataset.baseBranch || "";
      if (!workspaceId || !filePath) {
        return true;
      }
      const gitUi = ensureGitUiState(workspaceId);
      gitUi.reviewSelectedFile = filePath;
      gitUi.reviewFileDiffPreview = {
        ok: true,
        path: filePath,
        diff: "",
        summary: "Loading diff preview...",
      };
      render();
      const snapshot = getGitSnapshot(workspaceId);
      const baseBranch = explicitBase || snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "";
      try {
        gitUi.reviewFileDiffPreview = await api.gitDiffPreview({
          workspaceId,
          path: filePath,
          scope: "branch",
          baseBranch: baseBranch ? `origin/${baseBranch}` : "",
        });
      } catch (error) {
        gitUi.reviewFileDiffPreview = {
          ok: false,
          path: filePath,
          diff: "",
          summary: error?.message || "Diff preview failed to load.",
        };
      }
      render();
      return true;
    }
    if (action === "azure-vote") {
      const prKey = actionElement.dataset.prKey;
      const vote = Number.parseInt(actionElement.dataset.vote || "0", 10);
      if (!prKey) {
        return true;
      }
      state.payload = await api.voteAzurePullRequest({ prKey, vote });
      render();
      return true;
    }
    if (action === "azure-fetch-review-workspace") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }
      state.payload = await api.fetchAzureReviewWorkspace(workspaceId);
      render();
      return true;
    }
    if (action === "azure-rebase-review-workspace") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }
      state.payload = await api.rebaseAzureReviewWorkspace(workspaceId);
      render();
      return true;
    }
    if (action === "azure-push-review-workspace") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }
      state.payload = await api.pushAzureReviewWorkspace(workspaceId);
      render();
      return true;
    }
    if (action === "activate-workspace") {
      const workspaceId = actionElement.dataset.workspaceId;
      if (!workspaceId) {
        return true;
      }
      applyOptimisticWorkspaceActivation(workspaceId);
      state.splitGroup = null;
      render();
      focusActiveTerminal();
      try {
        const nextPayload = await api.activateWorkspace(workspaceId);
        const isBootstrapPayload = Boolean(nextPayload?.meta?.bootstrap);
        if (!state.pendingWorkspaceActivationId || nextPayload?.appState?.activeWorkspaceId === state.pendingWorkspaceActivationId) {
          state.payload = nextPayload;
          if (!isBootstrapPayload) {
            state.pendingWorkspaceActivationId = "";
          }
          render();
          focusActiveTerminal();
        }
      } catch (error) {
        state.pendingWorkspaceActivationId = "";
        throw error;
      }
      return true;
    }
    if (action === "select-tab") {
      await activateView(actionElement.dataset.viewId);
      return true;
    }
    if (action === "rename-tab") {
      await renameWorkspacePanel(actionElement.dataset.viewId);
      hideContextMenu();
      return true;
    }
    if (action === "export-terminal-transcript") {
      const sessionId = actionElement.dataset.sessionId;
      if (sessionId) {
        exportTerminalTranscript(sessionId);
      }
      return true;
    }
    if (action === "clear-terminal") {
      const sessionId = actionElement.dataset.sessionId;
      if (sessionId) {
        clearTerminalViewport(sessionId);
        focusActiveTerminal();
      }
      return true;
    }
    if (action === "open-layout-picker") {
      showLayoutPicker(actionElement);
      return true;
    }
    if (action === "pick-layout") {
      const layout = actionElement.dataset.layout;
      const slots = layouts[layout]?.slots || 1;
      const tabs = getWorkspaceTabs(getWorkspace());
      const groupIds = [state.activeViewId];
      for (const tab of tabs) {
        if (groupIds.length >= slots) break;
        if (!groupIds.includes(tab.id)) {
          groupIds.push(tab.id);
        }
      }
      state.splitGroup = groupIds.length >= 2 ? { layout, viewIds: groupIds.slice(0, slots) } : null;
      hideLayoutPicker();
      render();
      focusActiveTerminal();
      return true;
    }
    if (action === "disband-split" || action === "ctx-disband-group") {
      state.splitGroup = null;
      hideContextMenu();
      render();
      focusActiveTerminal();
      return true;
    }
    if (action === "ctx-remove-from-group") {
      const viewId = actionElement.dataset.viewId;
      if (state.splitGroup) {
        state.splitGroup.viewIds = state.splitGroup.viewIds.filter((id) => id !== viewId);
        if (state.splitGroup.viewIds.length < 2) {
          state.splitGroup = null;
        }
      }
      hideContextMenu();
      render();
      focusActiveTerminal();
      return true;
    }
    if (action === "ctx-add-to-group") {
      const viewId = actionElement.dataset.viewId;
      if (state.splitGroup) {
        const slots = layouts[state.splitGroup.layout]?.slots || 2;
        if (state.splitGroup.viewIds.length < slots && !state.splitGroup.viewIds.includes(viewId)) {
          state.splitGroup.viewIds.push(viewId);
        }
      }
      hideContextMenu();
      render();
      focusActiveTerminal();
      return true;
    }
    if (action === "close-tab") {
      const viewId = actionElement.dataset.viewId;
      if (!viewId) {
        return true;
      }
      if (isAzureViewId(viewId) || isReviewViewId(viewId)) {
        return true;
      }
      if (state.splitGroup) {
        state.splitGroup.viewIds = state.splitGroup.viewIds.filter((id) => id !== viewId);
        if (state.splitGroup.viewIds.length < 2) {
          state.splitGroup = null;
        }
      }
      const workspace = getWorkspace();
      const sessionId = viewId;
      const panelId = sessionId.split(":").slice(1).join(":");
      const activeWorkspace = workspace?.workspace || workspace?.project;
      const isWorkspacePanel = activeWorkspace?.panels.some((panel) => panel.id === panelId);
      if (isGitViewId(viewId) || isDockerViewId(viewId) || !isWorkspacePanel) {
        state.hiddenViewIds.add(viewId);
        if (state.activeViewId === viewId) {
          const tabs = getWorkspaceTabs(getWorkspace());
          state.activeViewId = tabs.find((tab) => tab.id !== viewId)?.id || null;
        }
        render();
        focusActiveTerminal();
        if (!isGitViewId(viewId) && !isDockerViewId(viewId) && api.closeTerminal) {
          api.closeTerminal(viewId).then((payload) => { state.payload = payload; }).catch(() => {});
        }
        return true;
      }
      if (!workspace) {
        return true;
      }
      if (activeWorkspace.panels.length <= 1 && activeWorkspace.kind !== "docker") {
        return true;
      }
      const nextWorkspace = cloneWorkspace(activeWorkspace);
      nextWorkspace.panels = nextWorkspace.panels.filter((panel) => panel.id !== panelId);
      if (nextWorkspace.activePanelId === panelId) {
        nextWorkspace.activePanelId = nextWorkspace.panels[0]?.id || "";
      }
      if (state.activeViewId === viewId) {
        state.activeViewId = state.splitGroup?.viewIds[0] || getWorkspaceTabs(workspace)[0]?.id || null;
      }
      state.payload = await api.saveWorkspace(nextWorkspace);
      render();
      focusActiveTerminal();
      return true;
    }
    if (action === "toggle-tab-picker") {
      const existing = root.querySelector(".tab-picker-dropdown");
      if (existing) {
        existing.remove();
        return true;
      }
      const stateTemplates = state.payload?.appState?.tabTemplates;
      const quickTemplates = Array.isArray(stateTemplates) && stateTemplates.length ? stateTemplates : FALLBACK_TAB_TEMPLATES;
      const dropdown = document.createElement("div");
      dropdown.className = "tab-picker-dropdown";
      renderTemplate(renderTabPickerDropdown(quickTemplates), dropdown);
      const btn = actionElement;
      const rect = btn.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      dropdown.style.top = `${rect.bottom - rootRect.top + 4}px`;
      dropdown.style.right = `${rootRect.right - rect.right}px`;
      root.appendChild(dropdown);
      const close = (e) => { if (!dropdown.contains(e.target) && e.target !== btn) { dropdown.remove(); document.removeEventListener("click", close); } };
      setTimeout(() => document.addEventListener("click", close), 0);
      return true;
    }
    if (action === "quick-add-template-tab") {
      root.querySelector(".tab-picker-dropdown")?.remove();
      const workspace = getWorkspace();
      const activeWorkspace = workspace?.workspace || workspace?.project;
      if (!workspace || activeWorkspace.kind === "docker" || activeWorkspace.kind === "azure") return true;
      const nextWorkspace = cloneWorkspace(activeWorkspace);
      const panelId = `panel-${crypto.randomUUID()}`;
      const command = actionElement.dataset.command || "";
      const isBrowser = /^https?:\/\//i.test(command);
      nextWorkspace.panels.push({
        id: panelId,
        title: actionElement.dataset.title || "Shell",
        command,
        shell: true,
        startup: appConfig.ui.defaultPanelStartup,
      });
      nextWorkspace.activePanelId = panelId;
      state.activeViewId = isBrowser ? `browser:${panelId}` : `${nextWorkspace.id}:${panelId}`;
      state._suppressBroadcastRender = true;
      state.payload = await api.saveWorkspace(nextWorkspace);
      state._suppressBroadcastRender = false;
      render();
      focusActiveTerminal();
      return true;
    }
    if (action === "quick-add-tab") {
      root.querySelector(".tab-picker-dropdown")?.remove();
      const workspace = getWorkspace();
      const activeWorkspace = workspace?.workspace || workspace?.project;
      if (!workspace || activeWorkspace.kind === "docker" || activeWorkspace.kind === "azure") {
        return true;
      }

      const nextWorkspace = cloneWorkspace(activeWorkspace);
      const panelId = `panel-${crypto.randomUUID()}`;
      nextWorkspace.panels.push({
        id: panelId,
        title: `${appConfig.ui.numberedPanelTitlePrefix} ${nextWorkspace.panels.length + 1}`,
        command: "",
        shell: true,
        startup: appConfig.ui.defaultPanelStartup,
      });
      nextWorkspace.activePanelId = panelId;
      state.payload = await api.saveWorkspace(nextWorkspace);
      state.activeViewId = `${nextWorkspace.id}:${panelId}`;
      render();
      focusActiveTerminal();
      return true;
    }
    if (action === "create-worktree") {
      const workspaceId = actionElement.dataset.workspaceId;
      const dialog = context.createTextInputDialog({
        eyebrow: "Git",
        title: "New worktree",
        label: "Branch name",
        placeholder: "feature/my-branch",
        submitLabel: "Create",
        onCancel: () => { closeOverlay(); focusActiveTerminal(); },
        onSubmit: async (name) => {
          closeOverlay();
          state.payload = await api.createWorktree({ workspaceId, name });
          state.splitGroup = null;
          state.hiddenViewIds.clear();
          render();
          focusActiveTerminal();
        },
      });
      closeOverlay();
      state.overlay = dialog;
      root.appendChild(dialog);
      dialog.querySelector("input")?.focus();
      return true;
    }
    if (action === "add-plugin-workspace") {
      const pluginId = actionElement.dataset.pluginId;
      const plugin = (state.payload?.plugins || []).find((entry) => entry.id === pluginId);
      if (!plugin?.workspaceDefaults) return true;
      const tpl = plugin.workspaceDefaults;
      const draft = {
        id: `workspace-${crypto.randomUUID()}`,
        name: tpl.name || plugin.name,
        icon: tpl.icon || plugin.icon || "PL",
        color: tpl.color || plugin.color || "#ffa424",
        kind: tpl.kind || "terminal",
        source: "plugin",
        pluginId,
        profileId: state.payload?.appState?.activeProfileId || "default",
        cwd: "",
        notes: tpl.notes || "",
        activePanelId: tpl.panels?.[0]?.id || "",
        panels: (tpl.panels || []).map((panel) => ({ ...panel })),
      };
      openWorkspaceDialog(draft);
      return true;
    }
    if (action === "edit-workspace") {
      const workspace = getWorkspace();
      openWorkspaceDialog(workspace.workspace || workspace.project);
      return true;
    }
    if (action === "delete-workspace") {
      const workspace = getWorkspace();
      const activeWorkspace = workspace?.workspace || workspace?.project;
      if (!workspace || !activeWorkspace) return true;
      if (window.confirm(`Delete workspace "${activeWorkspace.name}"?`)) {
        state.payload = await api.deleteWorkspace(activeWorkspace.id);
        render();
      }
      return true;
    }
    if (action === "copy-remote-url") {
      const shareUrl = withRemoteToken(preferredRemoteUrl({
        urls: state.payload?.remoteAccess?.urls || [],
        tunnelUrl: state.payload?.remoteAccess?.tunnel?.publicUrl || "",
        customPublicUrl: state.payload?.appState?.settings?.remoteAccess?.customPublicUrl || "",
      }), state.payload?.appState?.settings?.remoteAccess?.token || "");
      await copyText(shareUrl);
      return true;
    }
    if (action === "copy-qr-url") {
      await copyText(getRemoteShareUrl());
      return true;
    }
    if (action === "pick-lan-url") {
      const url = actionElement?.dataset.url;
      if (url) {
        state.selectedLanUrl = url;
        await copyText(url);
        renderRemoteAccess();
      }
      return true;
    }
    if (action === "copy-lan-url") {
      const lanCopyUrl = state.selectedLanUrl || withRemoteToken(
        preferredRemoteUrl({ urls: state.payload?.remoteAccess?.urls || [] }),
        state.payload?.appState?.settings?.remoteAccess?.token || "",
      );
      await copyText(lanCopyUrl);
      return true;
    }
    if (action === "copy-tunnel-url") {
      await copyText(withRemoteToken(
        state.payload?.remoteAccess?.tunnel?.publicUrl || "",
        state.payload?.appState?.settings?.remoteAccess?.token || "",
      ));
      return true;
    }
    if (action === "copy-custom-public-url") {
      await copyText(withRemoteToken(
        readCustomPublicUrl() || state.payload?.appState?.settings?.remoteAccess?.customPublicUrl || "",
        state.payload?.appState?.settings?.remoteAccess?.token || "",
      ));
      return true;
    }
    if (action === "set-remote-mode") {
      const mode = actionElement?.dataset.mode;
      if (mode && ["lan", "cloudflare", "vps"].includes(mode)) {
        state.remoteAccessMode = mode;
        renderRemoteAccess();
      }
      return true;
    }
    if (action === "toggle-remote-panel") {
      state.remoteAccessExpanded = !state.remoteAccessExpanded;
      renderRemoteAccess();
      return true;
    }
    if (action === "toggle-remote-access") {
      const enabled = !(state.payload?.appState?.settings?.remoteAccess?.enabled);
      state.payload = await api.updateSettings({ remoteAccess: { enabled } });
      render();
      return true;
    }
    if (action === "regenerate-remote-token") {
      state.payload = await api.regenerateRemoteToken();
      render();
      return true;
    }
    if (action === "save-custom-public-url") {
      state.payload = await api.updateSettings({
        remoteAccess: {
          customPublicUrl: readCustomPublicUrl(),
        },
      });
      render();
      return true;
    }
    if (action === "clear-custom-public-url") {
      state.payload = await api.updateSettings({
        remoteAccess: {
          customPublicUrl: "",
        },
      });
      render();
      return true;
    }
    if (action === "browse-cloudflared") {
      if (!api.browseFile) return true;
      const selected = await api.browseFile({
        filters: [{ name: "Executables", extensions: ["exe"] }, { name: "All Files", extensions: ["*"] }],
      });
      if (selected) {
        const input = remoteAccess.querySelector('[data-role="cloudflared-path"]');
        if (input) input.value = selected;
        state.payload = await api.updateSettings({
          remoteAccess: { cloudflaredPath: selected },
        });
        render();
      }
      return true;
    }
    if (action === "cancel-cloudflare-tunnel") {
      state.payload = await api.stopCloudflareTunnel();
      render();
      return true;
    }
    if (action === "create-cloudflare-tunnel" || action === "refresh-cloudflare-tunnel" || action === "stop-cloudflare-tunnel") {
      const card = actionElement.closest(".remote-access");
      const btn = actionElement;
      card?.classList.add("remote-access--busy");
      btn.classList.add("button--busy");
      if (action === "create-cloudflare-tunnel") {
        btn.textContent = "Cancel";
        btn.dataset.action = "cancel-cloudflare-tunnel";
      } else {
        btn.disabled = true;
      }
      try {
        if (action === "create-cloudflare-tunnel") {
          state.payload = await api.createCloudflareTunnel();
        } else if (action === "refresh-cloudflare-tunnel") {
          state.payload = await api.refreshTunnel();
        } else {
          state.payload = await api.stopCloudflareTunnel();
        }
      } finally {
        card?.classList.remove("remote-access--busy");
        render();
      }
      return true;
    }
    if (action === "refresh-docker") {
      state.payload = await api.refreshDocker();
      render();
      return true;
    }
    if (action === "refresh-git") {
      state.payload = await api.refreshGit(actionElement.dataset.workspaceId);
      render();
      return true;
    }
    if (action === "git-fetch") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }
      await runGitAction(workspaceId, "fetch", () => api.gitFetch({ workspaceId }));
      return true;
    }
    if (action === "git-merge-base" || action === "git-rebase-base") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      const snapshot = getGitSnapshot(workspaceId);
      if (!workspaceId || !snapshot?.available) {
        return true;
      }

      const type = action === "git-merge-base" ? "merge" : "rebase";
      setPendingGitAction(workspaceId, {
        type,
        snapshot,
        baseBranch: actionElement.dataset.baseBranch || snapshot.baseBranch,
      });
      return true;
    }
    if (action === "git-confirm-action") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }
      const gitUi = ensureGitUiState(workspaceId);
      const pending = gitUi.pendingAction;
      if (!pending) {
        return true;
      }
      gitUi.pendingAction = null;

      if (pending.type === "abort") {
        await runGitAction(workspaceId, "abort", () => api.gitAbortOperation({ workspaceId }));
        return true;
      }

      if (pending.type === "merge-into-base") {
        await runGitAction(workspaceId, "merge-into-base", () => api.gitMergeCurrentIntoBase({
          workspaceId,
          baseBranch: pending.baseBranch,
        }));
        return true;
      }

      const payload = {
        workspaceId,
        baseBranch: pending.baseBranch,
        stashDirty: pending.stashDirty,
      };
      await runGitAction(
        workspaceId,
        pending.type,
        () => (pending.type === "merge" ? api.gitMergeIntoCurrent(payload) : api.gitRebaseOnto(payload)),
      );
      return true;
    }
    if (action === "git-cancel-action") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (workspaceId) {
        clearPendingGitAction(workspaceId);
      }
      return true;
    }
    if (action === "git-continue") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }
      await runGitAction(workspaceId, "continue", () => api.gitContinueOperation({ workspaceId }));
      return true;
    }
    if (action === "git-abort") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      const snapshot = getGitSnapshot(workspaceId);
      if (!workspaceId) {
        return true;
      }
      setPendingGitAction(workspaceId, { type: "abort", snapshot, baseBranch: "" });
      return true;
    }
    if (action === "git-merge-into-base") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      const snapshot = getGitSnapshot(workspaceId);
      if (!workspaceId || !snapshot?.available) {
        return true;
      }
      const baseBranch = actionElement.dataset.baseBranch || snapshot.baseBranch;
      setPendingGitAction(workspaceId, {
        type: "merge-into-base",
        snapshot,
        baseBranch,
      });
      return true;
    }
    if (action === "git-remove-worktree") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      const worktreePath = actionElement.dataset.worktreePath || "";
      const deleteBranch = actionElement.dataset.deleteBranch === "true";
      if (!workspaceId || !worktreePath) {
        return true;
      }
      await runGitAction(workspaceId, "remove-worktree", () => api.gitRemoveWorktree({ workspaceId, worktreePath, deleteBranch }));
      return true;
    }
    if (action === "git-commit-all") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }
      const message = actionElement.closest('.git-card')?.querySelector('input[name="commit-message"]')?.value;
      if (!message) {
        return true;
      }
      await runGitAction(workspaceId, "commit", () => api.gitCommitAll({ workspaceId, message }));
      return true;
    }
    if (action === "git-select-commit") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      const hash = actionElement.dataset.hash || "";
      if (!workspaceId || !hash) {
        return true;
      }
      const gitUi = ensureGitUiState(workspaceId);
      gitUi.selectedCommit = hash;
      gitUi.commitDiffPreview = { ok: true, hash, diff: "", summary: "Loading..." };
      render();
      try {
        const preview = await api.gitCommitDiff({ workspaceId, hash });
        gitUi.commitDiffPreview = preview;
      } catch (error) {
        gitUi.commitDiffPreview = { ok: false, hash, diff: "", summary: error?.message || "Failed to load commit diff." };
      }
      render();
      return true;
    }
    if (action === "git-switch-tab") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      const tab = actionElement.dataset.tab || "status";
      if (workspaceId) {
        ensureGitUiState(workspaceId).activeTab = tab;
        render();
      }
      return true;
    }
    if (action === "git-select-diff") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      const filePath = actionElement.dataset.path || "";
      const scope = actionElement.dataset.scope || "unstaged";
      if (!workspaceId || !filePath) {
        return true;
      }
      await loadGitDiffPreview(workspaceId, filePath, scope);
      return true;
    }
    if (action === "git-clear-result") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }
      ensureGitUiState(workspaceId).lastResult = null;
      render();
      return true;
    }
    if (action === "restart-session") {
      const sessionId = actionElement.dataset.sessionId;
      if (!sessionId) {
        return true;
      }
      state.payload = await api.restartTerminal(sessionId);
      state.activeViewId = sessionId;
      render();
      focusActiveTerminal();
      return true;
    }
    if (action === "open-lazygit") {
      const workspaceId = actionElement.dataset.workspaceId || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }

      state.payload = await api.openLazygitSession({ workspaceId });
      state.activeViewId = `${workspaceId}:lazygit`;
      render();
      focusActiveTerminal();
      return true;
    }
    if (action === "open-lazydocker") {
      const workspace = getWorkspace();
      const activeWorkspace = workspace?.workspace || workspace?.project;
      const workspaceId = activeWorkspace?.id || getActiveWorkspace()?.id;
      if (!workspaceId) {
        return true;
      }

      state.payload = await api.openLazydockerSession({ workspaceId });
      state.activeViewId = `${workspaceId}:lazydocker`;
      render();
      focusActiveTerminal();
      return true;
    }
    if (action.startsWith("docker-")) {
      const workspace = getWorkspace();
      const activeWorkspace = workspace?.workspace || workspace?.project;
      const workspaceId = activeWorkspace?.id || getActiveWorkspace()?.id;
      const containerId = actionElement.dataset.containerId;
      if (!workspaceId || !containerId) {
        return true;
      }

      if (action === "docker-shell") {
        state.payload = await api.openDockerSession({ workspaceId, containerId, mode: "shell" });
        state.activeViewId = `${workspaceId}:shell-${containerId}`;
        render();
        focusActiveTerminal();
        return true;
      }
      if (action === "docker-logs") {
        state.payload = await api.openDockerSession({ workspaceId, containerId, mode: "logs" });
        state.activeViewId = `${workspaceId}:logs-${containerId}`;
        render();
        focusActiveTerminal();
        return true;
      }
      if (action === "docker-remove" && !window.confirm("Remove this container permanently?")) {
        return true;
      }

      const dockerAction = action.replace("docker-", "");
      state.payload = await api.dockerAction(dockerAction, containerId);
      render();
      return true;
    }

    return false;
  }

  return {
    handleRootAction,
  };
}
