import { preferredRemoteUrl, withRemoteToken } from "../app/helpers.js";
import type { Ref } from "vue";
import type { StatePayload } from "../../electron/shared/types/state.js";
import type { Transport } from "../transport.js";

/**
 * Mirror of the backend `PruneResult` shape (electron/backend/docker-manager).
 * Duplicated here to avoid pulling backend types into the renderer bundle.
 */
export interface DockerPruneResult {
  kind: "image" | "volume" | "network" | "builder";
  deletedNames: string[];
  reclaimed: string;
  raw: string;
}

interface ApiActionsCtx {
  payload: Ref<StatePayload | null>;
  activeViewId: Ref<string | null>;
  activeSessionId: Ref<string | null>;
  splitGroup: Ref<{ layout: string; viewIds: string[] } | null>;
  remoteAccessMode: Ref<string>;
  selectedLanUrl: Ref<string>;
  getApi: () => Transport;
  withSuppressedBroadcast: (fn: () => Promise<void>) => Promise<void>;
}

/**
 * Domain-specific API actions (azure, review bridge, agent, remote, docker, profile/settings).
 * These are thin wrappers that call the transport API and write the result to payload.
 */
export function createApiActions(ctx: ApiActionsCtx) {
  // ctx = { payload, activeViewId, activeSessionId, splitGroup,
  //         remoteAccessMode, selectedLanUrl,
  //         getApi, withSuppressedBroadcast }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyApi = any;

  // --- Azure -----------------------------------------------------------

  async function refreshAzure(): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).refreshAzure()) as StatePayload;
  }

  async function markAzurePrSeen(prKey: string): Promise<void> {
    if (!prKey) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).markAzurePullRequestSeen(prKey)) as StatePayload;
  }

  async function azureVote(prKey: string, vote: string): Promise<void> {
    if (!prKey) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).voteAzurePullRequest({ prKey, vote })) as StatePayload;
  }

  async function azureResolveThread(prKey: string, threadId: string): Promise<void> {
    if (!prKey || !threadId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).updateAzureThreadStatus({
      prKey,
      threadId,
      status: "fixed",
    })) as StatePayload;
  }

  async function azureReactivateThread(prKey: string, threadId: string): Promise<void> {
    if (!prKey || !threadId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).updateAzureThreadStatus({
      prKey,
      threadId,
      status: "active",
    })) as StatePayload;
  }

  async function azureComment(
    prKey: string,
    content: string,
    threadId: string | null = null,
    parentCommentId = 0,
  ): Promise<void> {
    if (!prKey) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).commentAzurePullRequest({
      prKey,
      content,
      threadId,
      parentCommentId,
    })) as StatePayload;
  }

  async function openAzurePullRequest(prKey: string, workspaceId: string): Promise<void> {
    if (!prKey) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).openAzurePullRequest({
      prKey,
      workspaceId: workspaceId || "",
    })) as StatePayload;
  }

  async function azureFetchReviewWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).fetchAzureReviewWorkspace(workspaceId)) as StatePayload;
  }

  async function azureRebaseReviewWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).rebaseAzureReviewWorkspace(workspaceId)) as StatePayload;
  }

  async function azurePushReviewWorkspace(workspaceId: string, { force = false } = {}): Promise<void> {
    if (!workspaceId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).pushAzureReviewWorkspace(workspaceId, {
      force,
    })) as StatePayload;
  }

  async function deleteAzureConnection(connectionId: string): Promise<void> {
    if (!connectionId) return;
    if (!window.confirm("Delete this Azure DevOps connection?")) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).deleteAzureConnection(connectionId)) as StatePayload;
  }

  async function saveAzureConnection(draft: unknown): Promise<void> {
    const result = (await (ctx.getApi() as AnyApi).saveAzureConnection(draft)) as AnyApi;
    ctx.payload.value = (result.payload || result) as StatePayload;
  }

  // --- Review bridge ---------------------------------------------------

  async function saveReviewBridgeDraft(params: unknown): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).saveReviewBridgeDraft(params)) as StatePayload;
  }

  async function deleteReviewBridgeDraft(prKey: string, draftId: string): Promise<void> {
    if (!prKey || !draftId) return;
    if (!window.confirm("Delete this draft? This cannot be undone.")) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).deleteReviewBridgeDraft({ prKey, draftId })) as StatePayload;
  }

  async function queueReviewBridgeDraft(prKey: string, draftId: string, commentKey: string): Promise<void> {
    if (!prKey || (!draftId && !commentKey)) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).queueReviewBridgeDraft({
      prKey,
      draftId,
      commentKey,
    })) as StatePayload;
  }

  async function deleteReviewBridgeComment(prKey: string, commentKey: string): Promise<void> {
    if (!prKey || !commentKey) return;
    if (!window.confirm("Delete this draft comment? This cannot be undone.")) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).deleteReviewBridgeComment({
      prKey,
      commentKey,
    })) as StatePayload;
  }

  async function createReviewBridgeDraftComment(params: unknown): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).createReviewBridgeDraftComment(params)) as StatePayload;
  }

  async function syncReviewBridgePullRequest(prKey: string): Promise<void> {
    if (!prKey) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).syncReviewBridgePullRequest({ prKey })) as StatePayload;
  }

  async function reviewBridgeDeleteAllDrafts(prKey: string): Promise<void> {
    if (!prKey) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (ctx.payload.value as any)?.reviewBridge?.pullRequests?.[prKey] || {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drafts = ((bridge.drafts || []) as any[]).filter((d: AnyApi) => d.status === "draft");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const draftComments = ((bridge.comments || []) as any[]).filter(
      (c: AnyApi) => c.commentKind === "draft" || c.commentKind === "local-comment",
    );
    const totalCount = drafts.length + draftComments.length;
    if (!totalCount) return;
    if (
      !window.confirm(
        `Delete ${drafts.length} draft${drafts.length !== 1 ? "s" : ""} and ${draftComments.length} draft comment${draftComments.length !== 1 ? "s" : ""}? This cannot be undone.`,
      )
    )
      return;
    const api = ctx.getApi() as AnyApi;
    for (const comment of draftComments) {
      ctx.payload.value = (await api.deleteReviewBridgeComment({
        prKey,
        commentKey: comment.commentKey,
      })) as StatePayload;
    }
    for (const draft of drafts) {
      if (!draftComments.some((c: AnyApi) => c.commentKey === draft.commentKey)) {
        ctx.payload.value = (await api.deleteReviewBridgeDraft({ prKey, draftId: draft.draftId })) as StatePayload;
      }
    }
  }

  async function reviewBridgeQueueAllDrafts(prKey: string): Promise<void> {
    if (!prKey) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drafts = (((ctx.payload.value as any)?.reviewBridge?.pullRequests?.[prKey]?.drafts || []) as any[]).filter(
      (d: AnyApi) => d.status === "draft",
    );
    if (!drafts.length) return;
    const api = ctx.getApi() as AnyApi;
    for (const draft of drafts) {
      ctx.payload.value = (await api.queueReviewBridgeDraft({ prKey, draftId: draft.draftId })) as StatePayload;
    }
  }

  async function pushAndPublishReview(workspaceId: string): Promise<unknown> {
    if (!workspaceId) return null;
    const result = (await (ctx.getApi() as AnyApi).pushAndPublishReview({ workspaceId })) as AnyApi;
    const summary = result?.pushAndPublishResult || null;
    ctx.payload.value = result as StatePayload;
    return summary;
  }

  // --- GitHub ------------------------------------------------------------

  async function refreshGitHub(): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).refreshGitHub()) as StatePayload;
  }

  async function markGitHubPrSeen(prKey: string): Promise<void> {
    if (!prKey) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).markGitHubPullRequestSeen(prKey)) as StatePayload;
  }

  async function openGitHubPullRequest(prKey: string, workspaceId: string): Promise<void> {
    if (!prKey) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).openGitHubPullRequest({
      prKey,
      workspaceId: workspaceId || "",
    })) as StatePayload;
  }

  async function githubComment(prKey: string, body: string): Promise<void> {
    if (!prKey) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).commentGitHubPullRequest({ prKey, body })) as StatePayload;
  }

  async function githubSubmitReview(prKey: string, event: string, body = ""): Promise<void> {
    if (!prKey) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).submitGitHubPullRequestReview({
      prKey,
      event,
      body,
    })) as StatePayload;
  }

  async function githubFetchReviewWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).fetchGitHubReviewWorkspace(workspaceId)) as StatePayload;
  }

  async function githubRebaseReviewWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).rebaseGitHubReviewWorkspace(workspaceId)) as StatePayload;
  }

  async function githubPushReviewWorkspace(workspaceId: string, { force = false } = {}): Promise<void> {
    if (!workspaceId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).pushGitHubReviewWorkspace(workspaceId, {
      force,
    })) as StatePayload;
  }

  async function deleteGitHubConnection(connectionId: string): Promise<void> {
    if (!connectionId) return;
    if (!window.confirm("Delete this GitHub connection?")) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).deleteGitHubConnection(connectionId)) as StatePayload;
  }

  async function saveGitHubConnection(draft: unknown): Promise<void> {
    const result = (await (ctx.getApi() as AnyApi).saveGitHubConnection(draft)) as AnyApi;
    ctx.payload.value = (result.payload || result) as StatePayload;
  }

  // --- Agent prompts ---------------------------------------------------

  async function saveAgentPrompt(params: unknown): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).saveAgentPrompt(params)) as StatePayload;
  }

  async function resetAgentPrompts(): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).resetAgentPrompts()) as StatePayload;
  }

  async function deleteAgentPrompt(promptId: string): Promise<void> {
    if (!promptId) return;
    if (!window.confirm("Delete this prompt?")) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).deleteAgentPrompt({ promptId })) as StatePayload;
  }

  // --- Remote access ---------------------------------------------------

  function setRemoteMode(mode: string): void {
    if (["lan", "cloudflare", "vps"].includes(mode)) {
      ctx.remoteAccessMode.value = mode;
    }
  }

  async function toggleRemoteAccess(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enabled = !(ctx.payload.value as any)?.appState?.settings?.remoteAccess?.enabled;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).updateSettings({
      remoteAccess: { enabled },
    })) as StatePayload;
  }

  async function regenerateRemoteToken(): Promise<void> {
    ctx.payload.value = (await ctx.getApi().regenerateRemoteToken()) as StatePayload;
  }

  async function saveCustomPublicUrl(url: string): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).updateSettings({
      remoteAccess: { customPublicUrl: url },
    })) as StatePayload;
  }

  async function clearCustomPublicUrl(): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).updateSettings({
      remoteAccess: { customPublicUrl: "" },
    })) as StatePayload;
  }

  async function createCloudflareTunnel(): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).createCloudflareTunnel()) as StatePayload;
  }

  async function stopCloudflareTunnel(): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).stopCloudflareTunnel()) as StatePayload;
  }

  async function refreshTunnel(): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).refreshTunnel()) as StatePayload;
  }

  function pickLanUrl(url: string): void {
    if (url) ctx.selectedLanUrl.value = url;
  }

  function getRemoteShareUrl(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = ctx.payload.value as any;
    const windowId = (window as AnyApi).strideterm?.startupFlags?.windowId || "";
    const slots = (p?.appState?.windowSlots || []) as Array<{ id: string; profileId?: string }>;
    const profileId = ctx.getApi().isRemote
      ? ""
      : (windowId && slots.find((slot) => slot.id === windowId)?.profileId) || slots[0]?.profileId || "";
    return withRemoteToken(
      preferredRemoteUrl({
        urls: p?.remoteAccess?.urls || [],
        tunnelUrl: p?.remoteAccess?.tunnel?.publicUrl || "",
        customPublicUrl: p?.appState?.settings?.remoteAccess?.customPublicUrl || "",
      }),
      p?.appState?.settings?.remoteAccess?.token || "",
      profileId,
    );
  }

  async function copyText(text: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard not available
    }
  }

  // --- Docker ----------------------------------------------------------

  async function refreshDocker(): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).refreshDocker()) as StatePayload;
  }

  async function dockerShell(
    workspaceId: string,
    containerId: string,
    backendId?: string,
    contextName?: string,
  ): Promise<void> {
    if (!workspaceId || !containerId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).openDockerSession({
      workspaceId,
      containerId,
      mode: "shell",
      backendId,
      contextName,
    })) as StatePayload;
    ctx.activeViewId.value = `${workspaceId}:shell-${containerId}`;
  }

  async function dockerLogs(workspaceId: string, containerId: string): Promise<void> {
    if (!workspaceId || !containerId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).openDockerSession({
      workspaceId,
      containerId,
      mode: "logs",
    })) as StatePayload;
    ctx.activeViewId.value = `${workspaceId}:logs-${containerId}`;
  }

  async function dockerAction(
    action: string,
    workspaceId: string,
    containerId: string,
    backendId?: string,
    contextName?: string,
  ): Promise<void> {
    if (!workspaceId || !containerId) return;
    const cleanAction = action.replace("docker-", "");
    ctx.payload.value = (await (ctx.getApi() as AnyApi).dockerAction({
      action: cleanAction,
      containerId,
      backendId,
      contextName,
    })) as StatePayload;
  }

  async function dockerLogsOpen(
    sessionId: string,
    containerId: string,
    backendId: string,
    contextName: string,
    options?: { timestamps?: boolean; tail?: number | "all" },
  ): Promise<void> {
    await (ctx.getApi() as AnyApi).dockerLogsOpen({
      sessionId,
      containerId,
      backendId,
      contextName,
      timestamps: options?.timestamps,
      tail: options?.tail,
    });
  }

  async function dockerLogsUpdate(
    sessionId: string,
    options: { timestamps?: boolean; tail?: number | "all" },
  ): Promise<boolean> {
    const r = (await (ctx.getApi() as AnyApi).dockerLogsUpdate({ sessionId, ...options })) as { ok: boolean };
    return !!r?.ok;
  }

  async function dockerLogsClose(sessionId: string): Promise<void> {
    await (ctx.getApi() as AnyApi).dockerLogsClose({ sessionId });
  }

  async function dockerComposeAction(
    action: string,
    backendId: string,
    contextName: string,
    projectName: string,
  ): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).dockerComposeAction({
      action,
      backendId,
      contextName,
      projectName,
    })) as StatePayload;
  }

  async function dockerInspect(containerId: string, backendId: string, contextName: string): Promise<string> {
    return (await (ctx.getApi() as AnyApi).dockerInspect({ containerId, backendId, contextName })) as string;
  }

  async function dockerTop(containerId: string, backendId: string, contextName: string): Promise<string> {
    return (await (ctx.getApi() as AnyApi).dockerTop({ containerId, backendId, contextName })) as string;
  }

  async function dockerStats(
    containerId: string,
    backendId: string,
    contextName: string,
  ): Promise<{
    cpuPerc: string;
    memUsage: string;
    memPerc: string;
    netIO: string;
    blockIO: string;
    pids: string;
  } | null> {
    return (await (ctx.getApi() as AnyApi).dockerStats({ containerId, backendId, contextName })) as {
      cpuPerc: string;
      memUsage: string;
      memPerc: string;
      netIO: string;
      blockIO: string;
      pids: string;
    } | null;
  }

  async function dockerImageInspect(imageId: string, backendId: string, contextName: string): Promise<string> {
    return (await (ctx.getApi() as AnyApi).dockerImageInspect({ resource: imageId, backendId, contextName })) as string;
  }

  async function dockerVolumeInspect(volumeName: string, backendId: string, contextName: string): Promise<string> {
    return (await (ctx.getApi() as AnyApi).dockerVolumeInspect({
      resource: volumeName,
      backendId,
      contextName,
    })) as string;
  }

  async function dockerNetworkInspect(networkId: string, backendId: string, contextName: string): Promise<string> {
    return (await (ctx.getApi() as AnyApi).dockerNetworkInspect({
      resource: networkId,
      backendId,
      contextName,
    })) as string;
  }

  async function dockerImageRemove(
    imageId: string,
    backendId: string,
    contextName: string,
    force = false,
  ): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).dockerImageRemove({
      resource: imageId,
      backendId,
      contextName,
      force,
    })) as StatePayload;
  }

  async function dockerVolumeRemove(
    volumeName: string,
    backendId: string,
    contextName: string,
    force = false,
  ): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).dockerVolumeRemove({
      resource: volumeName,
      backendId,
      contextName,
      force,
    })) as StatePayload;
  }

  async function dockerNetworkRemove(networkId: string, backendId: string, contextName: string): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).dockerNetworkRemove({
      resource: networkId,
      backendId,
      contextName,
    })) as StatePayload;
  }

  async function dockerImagePull(reference: string, backendId: string, contextName: string): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).dockerImagePull({
      resource: reference,
      backendId,
      contextName,
    })) as StatePayload;
  }

  // ---------------------------------------------------------------------------
  // Prune actions. Each returns the PruneResult so the caller can show a toast
  // / dialog with the reclaimed-size and deleted-names. Payload is refreshed
  // server-side; we replace ctx.payload here to avoid stale UI.
  // ---------------------------------------------------------------------------
  async function dockerImagePrune(backendId: string, contextName: string, all: boolean): Promise<DockerPruneResult> {
    const r = (await (ctx.getApi() as AnyApi).dockerImagePrune({ backendId, contextName, all })) as {
      payload: StatePayload;
      result: DockerPruneResult;
    };
    ctx.payload.value = r.payload;
    return r.result;
  }

  async function dockerVolumePrune(backendId: string, contextName: string): Promise<DockerPruneResult> {
    const r = (await (ctx.getApi() as AnyApi).dockerVolumePrune({ backendId, contextName })) as {
      payload: StatePayload;
      result: DockerPruneResult;
    };
    ctx.payload.value = r.payload;
    return r.result;
  }

  async function dockerNetworkPrune(backendId: string, contextName: string): Promise<DockerPruneResult> {
    const r = (await (ctx.getApi() as AnyApi).dockerNetworkPrune({ backendId, contextName })) as {
      payload: StatePayload;
      result: DockerPruneResult;
    };
    ctx.payload.value = r.payload;
    return r.result;
  }

  async function dockerBuilderPrune(backendId: string, contextName: string, all: boolean): Promise<DockerPruneResult> {
    const r = (await (ctx.getApi() as AnyApi).dockerBuilderPrune({ backendId, contextName, all })) as {
      payload: StatePayload;
      result: DockerPruneResult;
    };
    ctx.payload.value = r.payload;
    return r.result;
  }

  async function dockerSystemDf(backendId?: string, contextName?: string): Promise<string> {
    return (await (ctx.getApi() as AnyApi).dockerSystemDf({ backendId, contextName })) as string;
  }

  async function dockerVolumeList(
    volumeName: string,
    backendId: string,
    contextName: string,
    subPath: string,
  ): Promise<string> {
    return (await (ctx.getApi() as AnyApi).dockerVolumeList({
      volumeName,
      backendId,
      contextName,
      subPath,
    })) as string;
  }

  async function dockerVolumeRead(
    volumeName: string,
    backendId: string,
    contextName: string,
    subPath: string,
  ): Promise<string> {
    return (await (ctx.getApi() as AnyApi).dockerVolumeRead({
      volumeName,
      backendId,
      contextName,
      subPath,
    })) as string;
  }

  async function openLazydocker(workspaceId: string, backendId?: string): Promise<void> {
    if (!workspaceId) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).openLazydockerSession({
      workspaceId,
      backendId,
    })) as StatePayload;
    ctx.activeViewId.value = `${workspaceId}:lazydocker`;
  }

  // --- Profile / settings ----------------------------------------------

  async function saveProfile(profile: unknown): Promise<void> {
    ctx.payload.value = (await ctx
      .getApi()
      .saveProfile(profile as Parameters<Transport["saveProfile"]>[0])) as StatePayload;
  }

  async function deleteProfile(profileId: string): Promise<void> {
    ctx.payload.value = (await ctx.getApi().deleteProfile(profileId)) as StatePayload;
  }

  async function activateProfile(profileId: string): Promise<void> {
    await ctx.withSuppressedBroadcast(async () => {
      ctx.payload.value = (await ctx.getApi().activateProfile(profileId)) as StatePayload;
    });
    ctx.activeViewId.value = null;
    ctx.activeSessionId.value = null;
    ctx.splitGroup.value = null;
  }

  async function updateSettings(patch: unknown): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).updateSettings(patch)) as StatePayload;
  }

  return {
    // Azure
    refreshAzure,
    markAzurePrSeen,
    azureVote,
    azureResolveThread,
    azureReactivateThread,
    azureComment,
    openAzurePullRequest,
    azureFetchReviewWorkspace,
    azureRebaseReviewWorkspace,
    azurePushReviewWorkspace,
    deleteAzureConnection,
    saveAzureConnection,
    // GitHub
    refreshGitHub,
    markGitHubPrSeen,
    openGitHubPullRequest,
    githubComment,
    githubSubmitReview,
    githubFetchReviewWorkspace,
    githubRebaseReviewWorkspace,
    githubPushReviewWorkspace,
    deleteGitHubConnection,
    saveGitHubConnection,
    // Review bridge
    saveReviewBridgeDraft,
    deleteReviewBridgeDraft,
    queueReviewBridgeDraft,
    deleteReviewBridgeComment,
    createReviewBridgeDraftComment,
    syncReviewBridgePullRequest,
    reviewBridgeDeleteAllDrafts,
    reviewBridgeQueueAllDrafts,
    pushAndPublishReview,
    // Agent prompts
    saveAgentPrompt,
    deleteAgentPrompt,
    resetAgentPrompts,
    // Remote access
    setRemoteMode,
    toggleRemoteAccess,
    regenerateRemoteToken,
    saveCustomPublicUrl,
    clearCustomPublicUrl,
    createCloudflareTunnel,
    stopCloudflareTunnel,
    refreshTunnel,
    pickLanUrl,
    getRemoteShareUrl,
    copyText,
    // Docker
    refreshDocker,
    dockerShell,
    dockerLogs,
    dockerAction,
    dockerLogsOpen,
    dockerLogsUpdate,
    dockerLogsClose,
    dockerComposeAction,
    dockerInspect,
    dockerTop,
    dockerStats,
    dockerImageInspect,
    dockerVolumeInspect,
    dockerNetworkInspect,
    dockerImageRemove,
    dockerVolumeRemove,
    dockerNetworkRemove,
    dockerImagePull,
    dockerImagePrune,
    dockerVolumePrune,
    dockerNetworkPrune,
    dockerBuilderPrune,
    dockerSystemDf,
    dockerVolumeList,
    dockerVolumeRead,
    openLazydocker,
    // Profile / settings
    saveProfile,
    deleteProfile,
    activateProfile,
    updateSettings,
  };
}
