import { preferredRemoteUrl, withRemoteToken } from "../app/helpers.js";

/**
 * Domain-specific API actions (azure, review bridge, agent, remote, docker, profile/settings).
 * These are thin wrappers that call the transport API and write the result to payload.
 */
export function createApiActions(ctx) {
  // ctx = { payload, activeViewId, activeSessionId, splitGroup,
  //         remoteAccessExpanded, remoteAccessMode, selectedLanUrl,
  //         getApi, withSuppressedBroadcast }

  // --- Azure -----------------------------------------------------------

  async function refreshAzure() {
    ctx.payload.value = await ctx.getApi().refreshAzure();
  }

  async function markAzurePrSeen(prKey) {
    if (!prKey) return;
    ctx.payload.value = await ctx.getApi().markAzurePullRequestSeen(prKey);
  }

  async function azureVote(prKey, vote) {
    if (!prKey) return;
    ctx.payload.value = await ctx.getApi().voteAzurePullRequest({ prKey, vote });
  }

  async function azureResolveThread(prKey, threadId) {
    if (!prKey || !threadId) return;
    ctx.payload.value = await ctx.getApi().updateAzureThreadStatus({ prKey, threadId, status: "fixed" });
  }

  async function azureReactivateThread(prKey, threadId) {
    if (!prKey || !threadId) return;
    ctx.payload.value = await ctx.getApi().updateAzureThreadStatus({ prKey, threadId, status: "active" });
  }

  async function azureComment(prKey, content, threadId = null, parentCommentId = 0) {
    if (!prKey) return;
    ctx.payload.value = await ctx.getApi().commentAzurePullRequest({ prKey, content, threadId, parentCommentId });
  }

  async function openAzurePullRequest(prKey, workspaceId) {
    if (!prKey) return;
    ctx.payload.value = await ctx.getApi().openAzurePullRequest({ prKey, workspaceId: workspaceId || "" });
  }

  async function azureFetchReviewWorkspace(workspaceId) {
    if (!workspaceId) return;
    ctx.payload.value = await ctx.getApi().fetchAzureReviewWorkspace(workspaceId);
  }

  async function azureRebaseReviewWorkspace(workspaceId) {
    if (!workspaceId) return;
    ctx.payload.value = await ctx.getApi().rebaseAzureReviewWorkspace(workspaceId);
  }

  async function azurePushReviewWorkspace(workspaceId, { force = false } = {}) {
    if (!workspaceId) return;
    ctx.payload.value = await ctx.getApi().pushAzureReviewWorkspace(workspaceId, { force });
  }

  async function deleteAzureConnection(connectionId) {
    if (!connectionId) return;
    if (!window.confirm("Delete this Azure DevOps connection?")) return;
    ctx.payload.value = await ctx.getApi().deleteAzureConnection(connectionId);
  }

  async function saveAzureConnection(draft) {
    const result = await ctx.getApi().saveAzureConnection(draft);
    ctx.payload.value = result.payload || result;
  }

  // --- Review bridge ---------------------------------------------------

  async function saveReviewBridgeDraft(params) {
    ctx.payload.value = await ctx.getApi().saveReviewBridgeDraft(params);
  }

  async function deleteReviewBridgeDraft(prKey, draftId) {
    if (!prKey || !draftId) return;
    if (!window.confirm("Delete this draft? This cannot be undone.")) return;
    ctx.payload.value = await ctx.getApi().deleteReviewBridgeDraft({ prKey, draftId });
  }

  async function queueReviewBridgeDraft(prKey, draftId, commentKey) {
    if (!prKey || (!draftId && !commentKey)) return;
    ctx.payload.value = await ctx.getApi().queueReviewBridgeDraft({ prKey, draftId, commentKey });
  }

  async function deleteReviewBridgeComment(prKey, commentKey) {
    if (!prKey || !commentKey) return;
    if (!window.confirm("Delete this draft comment? This cannot be undone.")) return;
    ctx.payload.value = await ctx.getApi().deleteReviewBridgeComment({ prKey, commentKey });
  }

  async function createReviewBridgeDraftComment(params) {
    ctx.payload.value = await ctx.getApi().createReviewBridgeDraftComment(params);
  }

  async function syncReviewBridgePullRequest(prKey) {
    if (!prKey) return;
    ctx.payload.value = await ctx.getApi().syncReviewBridgePullRequest({ prKey });
  }

  async function reviewBridgeDeleteAllDrafts(prKey) {
    if (!prKey) return;
    const bridge = ctx.payload.value?.reviewBridge?.pullRequests?.[prKey] || {};
    const drafts = (bridge.drafts || []).filter((d) => d.status === "draft");
    const draftComments = (bridge.comments || []).filter((c) => c.commentKind === "draft" || c.commentKind === "local-comment");
    const totalCount = drafts.length + draftComments.length;
    if (!totalCount) return;
    if (!window.confirm(`Delete ${drafts.length} draft${drafts.length !== 1 ? "s" : ""} and ${draftComments.length} draft comment${draftComments.length !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    const api = ctx.getApi();
    for (const comment of draftComments) {
      ctx.payload.value = await api.deleteReviewBridgeComment({ prKey, commentKey: comment.commentKey });
    }
    for (const draft of drafts) {
      if (!draftComments.some((c) => c.commentKey === draft.commentKey)) {
        ctx.payload.value = await api.deleteReviewBridgeDraft({ prKey, draftId: draft.draftId });
      }
    }
  }

  async function reviewBridgeQueueAllDrafts(prKey) {
    if (!prKey) return;
    const drafts = (ctx.payload.value?.reviewBridge?.pullRequests?.[prKey]?.drafts || []).filter((d) => d.status === "draft");
    if (!drafts.length) return;
    const api = ctx.getApi();
    for (const draft of drafts) {
      ctx.payload.value = await api.queueReviewBridgeDraft({ prKey, draftId: draft.draftId });
    }
  }

  async function pushAndPublishReview(workspaceId) {
    if (!workspaceId) return null;
    const result = await ctx.getApi().pushAndPublishReview({ workspaceId });
    const summary = result?.pushAndPublishResult || null;
    ctx.payload.value = result;
    return summary;
  }

  // --- Agent prompts ---------------------------------------------------

  async function saveAgentPrompt(params) {
    ctx.payload.value = await ctx.getApi().saveAgentPrompt(params);
  }

  async function resetAgentPrompts() {
    ctx.payload.value = await ctx.getApi().resetAgentPrompts();
  }

  async function deleteAgentPrompt(promptId) {
    if (!promptId) return;
    if (!window.confirm("Delete this prompt?")) return;
    ctx.payload.value = await ctx.getApi().deleteAgentPrompt({ promptId });
  }

  // --- Remote access ---------------------------------------------------

  function setRemoteMode(mode) {
    if (["lan", "cloudflare", "vps"].includes(mode)) {
      ctx.remoteAccessMode.value = mode;
    }
  }

  function toggleRemotePanel() {
    ctx.remoteAccessExpanded.value = !ctx.remoteAccessExpanded.value;
  }

  async function toggleRemoteAccess() {
    const enabled = !(ctx.payload.value?.appState?.settings?.remoteAccess?.enabled);
    ctx.payload.value = await ctx.getApi().updateSettings({ remoteAccess: { enabled } });
  }

  async function regenerateRemoteToken() {
    ctx.payload.value = await ctx.getApi().regenerateRemoteToken();
  }

  async function saveCustomPublicUrl(url) {
    ctx.payload.value = await ctx.getApi().updateSettings({ remoteAccess: { customPublicUrl: url } });
  }

  async function clearCustomPublicUrl() {
    ctx.payload.value = await ctx.getApi().updateSettings({ remoteAccess: { customPublicUrl: "" } });
  }

  async function createCloudflareTunnel() {
    ctx.payload.value = await ctx.getApi().createCloudflareTunnel();
  }

  async function stopCloudflareTunnel() {
    ctx.payload.value = await ctx.getApi().stopCloudflareTunnel();
  }

  async function refreshTunnel() {
    ctx.payload.value = await ctx.getApi().refreshTunnel();
  }

  function pickLanUrl(url) {
    if (url) ctx.selectedLanUrl.value = url;
  }

  function getRemoteShareUrl() {
    return withRemoteToken(
      preferredRemoteUrl({
        urls: ctx.payload.value?.remoteAccess?.urls || [],
        tunnelUrl: ctx.payload.value?.remoteAccess?.tunnel?.publicUrl || "",
        customPublicUrl: ctx.payload.value?.appState?.settings?.remoteAccess?.customPublicUrl || "",
      }),
      ctx.payload.value?.appState?.settings?.remoteAccess?.token || "",
    );
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard not available
    }
  }

  // --- Docker ----------------------------------------------------------

  async function refreshDocker() {
    ctx.payload.value = await ctx.getApi().refreshDocker();
  }

  async function dockerShell(workspaceId, containerId) {
    if (!workspaceId || !containerId) return;
    ctx.payload.value = await ctx.getApi().openDockerSession({ workspaceId, containerId, mode: "shell" });
    ctx.activeViewId.value = `${workspaceId}:shell-${containerId}`;
  }

  async function dockerLogs(workspaceId, containerId) {
    if (!workspaceId || !containerId) return;
    ctx.payload.value = await ctx.getApi().openDockerSession({ workspaceId, containerId, mode: "logs" });
    ctx.activeViewId.value = `${workspaceId}:logs-${containerId}`;
  }

  async function dockerAction(action, workspaceId, containerId) {
    if (!workspaceId || !containerId) return;
    if (action === "docker-remove" && !window.confirm("Remove this container permanently?")) return;
    ctx.payload.value = await ctx.getApi().dockerAction(action.replace("docker-", ""), containerId);
  }

  async function openLazydocker(workspaceId) {
    if (!workspaceId) return;
    ctx.payload.value = await ctx.getApi().openLazydockerSession({ workspaceId });
    ctx.activeViewId.value = `${workspaceId}:lazydocker`;
  }

  // --- Profile / settings ----------------------------------------------

  async function saveProfile(profile) {
    ctx.payload.value = await ctx.getApi().saveProfile(profile);
  }

  async function deleteProfile(profileId) {
    ctx.payload.value = await ctx.getApi().deleteProfile(profileId);
  }

  async function activateProfile(profileId) {
    await ctx.withSuppressedBroadcast(async () => {
      ctx.payload.value = await ctx.getApi().activateProfile(profileId);
    });
    ctx.activeViewId.value = null;
    ctx.activeSessionId.value = null;
    ctx.splitGroup.value = null;
  }

  async function updateSettings(patch) {
    ctx.payload.value = await ctx.getApi().updateSettings(patch);
  }

  return {
    // Azure
    refreshAzure, markAzurePrSeen, azureVote,
    azureResolveThread, azureReactivateThread, azureComment,
    openAzurePullRequest, azureFetchReviewWorkspace, azureRebaseReviewWorkspace, azurePushReviewWorkspace,
    deleteAzureConnection, saveAzureConnection,
    // Review bridge
    saveReviewBridgeDraft, deleteReviewBridgeDraft, queueReviewBridgeDraft,
    deleteReviewBridgeComment, createReviewBridgeDraftComment, syncReviewBridgePullRequest,
    reviewBridgeDeleteAllDrafts, reviewBridgeQueueAllDrafts, pushAndPublishReview,
    // Agent prompts
    saveAgentPrompt, deleteAgentPrompt, resetAgentPrompts,
    // Remote access
    setRemoteMode, toggleRemotePanel, toggleRemoteAccess,
    regenerateRemoteToken, saveCustomPublicUrl, clearCustomPublicUrl,
    createCloudflareTunnel, stopCloudflareTunnel, refreshTunnel,
    pickLanUrl, getRemoteShareUrl, copyText,
    // Docker
    refreshDocker, dockerShell, dockerLogs, dockerAction, openLazydocker,
    // Profile / settings
    saveProfile, deleteProfile, activateProfile, updateSettings,
  };
}
