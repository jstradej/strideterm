import { preferredRemoteUrl, withRemoteToken } from "../app/helpers.js";
import type { Ref } from "vue";
import type { StatePayload } from "../../electron/shared/types/state.js";
import type { Transport } from "../transport.js";
import { useRemoteDetailsStore } from "./remote-details.js";

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
  adoptPayload?: (payload: StatePayload) => void;
  withSuppressedBroadcast: (fn: () => Promise<void>) => Promise<void>;
  /** In-app ConfirmDialog helper — replaces native window.confirm so the
   *  prompt is themed, non-blocking, and works in remote/mobile clients
   *  where browser dialogs don't apply. Provided by createWorkspaceActions. */
  confirmInApp: (opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  /** Single source of truth for "which profile does the current viewer belong
   *  to" — see resolveViewerProfileId in stores/app.ts. */
  resolveViewerProfileId: (sourcePayload: unknown, opts: { isRemote: boolean; windowId: string }) => string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

/**
 * Azure DevOps / GitHub review-workspace + connection actions are structurally
 * identical between the two providers — only the transport method names and
 * the connection-type display copy differ. `makeProviderApiActions` generates
 * the shared bodies once; `createApiActions` below assigns the results onto
 * the provider-specific exported names (refreshAzure/refreshGitHub, etc.) so
 * every existing call site keeps working unchanged.
 *
 * NOT covered here (real behavior differs, not just naming — see callers in
 * createApiActions): azureComment (threaded: threadId/parentCommentId) vs
 * githubComment (flat body); azureVote/azureResolveThread/azureReactivateThread
 * (Azure-only thread & vote model) vs githubSubmitReview (GitHub's review
 * event/body model).
 */
type ProviderKind = "azure" | "github";

interface ProviderApiMethods {
  /** Human copy for the delete-connection confirm dialog, e.g. "Azure DevOps connection". */
  displayName: string;
  refresh: (api: AnyApi) => Promise<AnyApi>;
  markPrSeen: (api: AnyApi, prKey: string) => Promise<AnyApi>;
  openPullRequest: (api: AnyApi, args: { prKey: string; workspaceId: string }) => Promise<AnyApi>;
  fetchReviewWorkspace: (api: AnyApi, workspaceId: string) => Promise<AnyApi>;
  rebaseReviewWorkspace: (api: AnyApi, workspaceId: string) => Promise<AnyApi>;
  pushReviewWorkspace: (api: AnyApi, workspaceId: string, opts: { force: boolean }) => Promise<AnyApi>;
  deleteConnection: (api: AnyApi, connectionId: string) => Promise<AnyApi>;
  saveConnection: (api: AnyApi, draft: unknown) => Promise<AnyApi>;
}

const PROVIDER_API_METHODS: Record<ProviderKind, ProviderApiMethods> = {
  azure: {
    displayName: "Azure DevOps connection",
    refresh: (api) => api.refreshAzure(),
    markPrSeen: (api, prKey) => api.markAzurePullRequestSeen(prKey),
    openPullRequest: (api, args) => api.openAzurePullRequest(args),
    fetchReviewWorkspace: (api, workspaceId) => api.fetchAzureReviewWorkspace(workspaceId),
    rebaseReviewWorkspace: (api, workspaceId) => api.rebaseAzureReviewWorkspace(workspaceId),
    pushReviewWorkspace: (api, workspaceId, opts) => api.pushAzureReviewWorkspace(workspaceId, opts),
    deleteConnection: (api, connectionId) => api.deleteAzureConnection(connectionId),
    saveConnection: (api, draft) => api.saveAzureConnection(draft),
  },
  github: {
    displayName: "GitHub connection",
    refresh: (api) => api.refreshGitHub(),
    markPrSeen: (api, prKey) => api.markGitHubPullRequestSeen(prKey),
    openPullRequest: (api, args) => api.openGitHubPullRequest(args),
    fetchReviewWorkspace: (api, workspaceId) => api.fetchGitHubReviewWorkspace(workspaceId),
    rebaseReviewWorkspace: (api, workspaceId) => api.rebaseGitHubReviewWorkspace(workspaceId),
    pushReviewWorkspace: (api, workspaceId, opts) => api.pushGitHubReviewWorkspace(workspaceId, opts),
    deleteConnection: (api, connectionId) => api.deleteGitHubConnection(connectionId),
    saveConnection: (api, draft) => api.saveGitHubConnection(draft),
  },
};

export function makeProviderApiActions(
  ctx: Pick<ApiActionsCtx, "getApi" | "confirmInApp">,
  setPayload: (p: StatePayload) => void,
  provider: ProviderKind,
) {
  // eslint-disable-next-line security/detect-object-injection -- provider is the narrow "azure" | "github" union, not user input
  const m = PROVIDER_API_METHODS[provider];

  async function refresh(): Promise<void> {
    setPayload((await m.refresh(ctx.getApi() as AnyApi)) as StatePayload);
  }

  async function markPrSeen(prKey: string): Promise<void> {
    if (!prKey) return;
    setPayload((await m.markPrSeen(ctx.getApi() as AnyApi, prKey)) as StatePayload);
  }

  async function openPullRequest(prKey: string, workspaceId: string): Promise<void> {
    if (!prKey) return;
    setPayload(
      (await m.openPullRequest(ctx.getApi() as AnyApi, { prKey, workspaceId: workspaceId || "" })) as StatePayload,
    );
  }

  async function fetchReviewWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    setPayload((await m.fetchReviewWorkspace(ctx.getApi() as AnyApi, workspaceId)) as StatePayload);
  }

  async function rebaseReviewWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    setPayload((await m.rebaseReviewWorkspace(ctx.getApi() as AnyApi, workspaceId)) as StatePayload);
  }

  async function pushReviewWorkspace(workspaceId: string, { force = false } = {}): Promise<void> {
    if (!workspaceId) return;
    setPayload((await m.pushReviewWorkspace(ctx.getApi() as AnyApi, workspaceId, { force })) as StatePayload);
  }

  async function deleteConnection(connectionId: string): Promise<void> {
    if (!connectionId) return;
    const confirmed = await ctx.confirmInApp({
      title: `Delete ${m.displayName}?`,
      message: `This ${m.displayName} will be removed.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    setPayload((await m.deleteConnection(ctx.getApi() as AnyApi, connectionId)) as StatePayload);
  }

  async function saveConnection(draft: unknown): Promise<void> {
    const result = (await m.saveConnection(ctx.getApi() as AnyApi, draft)) as AnyApi;
    setPayload((result.payload || result) as StatePayload);
  }

  return {
    refresh,
    markPrSeen,
    openPullRequest,
    fetchReviewWorkspace,
    rebaseReviewWorkspace,
    pushReviewWorkspace,
    deleteConnection,
    saveConnection,
  };
}

/**
 * Domain-specific API actions (azure, review bridge, agent, remote, docker, profile/settings).
 * These are thin wrappers that call the transport API and write the result to payload.
 */
export function createApiActions(ctx: ApiActionsCtx) {
  // ctx = { payload, activeViewId, activeSessionId, splitGroup,
  //         remoteAccessMode, selectedLanUrl,
  //         getApi, withSuppressedBroadcast }

  /**
   * Adopt a mutation/refresh response into the reactive state.
   *
   * On the REMOTE slim core this is a deliberate no-op: these callers are the
   * frequent refresh buttons + provider/review-bridge domain mutations, whose
   * response the client must not swap into its whole state "after every button
   * click". The server answers those with a small targeted ack
   * (`{ ok, changedResources, revision }`, not a core) and then broadcasts the
   * authoritative new core (state:updated, newer coreRevision) plus the relevant
   * per-resource invalidations, which the app store applies — so the renderer
   * waits for the targeted update. As a latency optimization the ack also names
   * the resources it changed; we proactively refetch the interested ones here so
   * a visible pane repaints on the mutation's own response instead of waiting for
   * the WS invalidation round-trip. (Navigation mutations that the renderer DOES
   * adopt synchronously — save/activate/reorder/settings — go through their own
   * `payload.value =` assignment and receive the slim core, not this no-op.)
   * Desktop keeps adopting its full IPC payload for immediacy.
   */
  function setPayload(nextPayload: StatePayload): void {
    if (ctx.getApi().isRemote) {
      const changed = (nextPayload as unknown as { changedResources?: unknown })?.changedResources;
      if (Array.isArray(changed) && changed.length) {
        useRemoteDetailsStore().invalidateResources(changed.filter((r): r is string => typeof r === "string"));
      }
      return;
    }
    if (ctx.adoptPayload) {
      ctx.adoptPayload(nextPayload);
      return;
    }
    ctx.payload.value = nextPayload;
  }

  // --- Azure -----------------------------------------------------------

  const azureApi = makeProviderApiActions(ctx, setPayload, "azure");

  async function azureVote(prKey: string, vote: string): Promise<void> {
    if (!prKey) return;
    setPayload((await (ctx.getApi() as AnyApi).voteAzurePullRequest({ prKey, vote })) as StatePayload);
  }

  async function azureResolveThread(prKey: string, threadId: string): Promise<void> {
    if (!prKey || !threadId) return;
    setPayload(
      (await (ctx.getApi() as AnyApi).updateAzureThreadStatus({
        prKey,
        threadId,
        status: "fixed",
      })) as StatePayload,
    );
  }

  async function azureReactivateThread(prKey: string, threadId: string): Promise<void> {
    if (!prKey || !threadId) return;
    setPayload(
      (await (ctx.getApi() as AnyApi).updateAzureThreadStatus({
        prKey,
        threadId,
        status: "active",
      })) as StatePayload,
    );
  }

  async function azureComment(
    prKey: string,
    content: string,
    threadId: string | null = null,
    parentCommentId = 0,
  ): Promise<void> {
    if (!prKey) return;
    setPayload(
      (await (ctx.getApi() as AnyApi).commentAzurePullRequest({
        prKey,
        content,
        threadId,
        parentCommentId,
      })) as StatePayload,
    );
  }

  // --- Review bridge ---------------------------------------------------

  async function saveReviewBridgeDraft(params: unknown): Promise<void> {
    setPayload((await (ctx.getApi() as AnyApi).saveReviewBridgeDraft(params)) as StatePayload);
  }

  async function deleteReviewBridgeDraft(prKey: string, draftId: string): Promise<void> {
    if (!prKey || !draftId) return;
    const confirmed = await ctx.confirmInApp({
      title: "Delete draft?",
      message: "This draft will be removed. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    setPayload((await (ctx.getApi() as AnyApi).deleteReviewBridgeDraft({ prKey, draftId })) as StatePayload);
  }

  async function queueReviewBridgeDraft(prKey: string, draftId: string, commentKey: string): Promise<void> {
    if (!prKey || (!draftId && !commentKey)) return;
    setPayload(
      (await (ctx.getApi() as AnyApi).queueReviewBridgeDraft({
        prKey,
        draftId,
        commentKey,
      })) as StatePayload,
    );
  }

  async function deleteReviewBridgeComment(prKey: string, commentKey: string): Promise<void> {
    if (!prKey || !commentKey) return;
    const confirmed = await ctx.confirmInApp({
      title: "Delete draft comment?",
      message: "This draft comment will be removed. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    setPayload(
      (await (ctx.getApi() as AnyApi).deleteReviewBridgeComment({
        prKey,
        commentKey,
      })) as StatePayload,
    );
  }

  async function createReviewBridgeDraftComment(params: unknown): Promise<void> {
    setPayload((await (ctx.getApi() as AnyApi).createReviewBridgeDraftComment(params)) as StatePayload);
  }

  async function syncReviewBridgePullRequest(prKey: string): Promise<void> {
    if (!prKey) return;
    setPayload((await (ctx.getApi() as AnyApi).syncReviewBridgePullRequest({ prKey })) as StatePayload);
  }

  // The per-PR review-bridge context lives in `payload.reviewBridge` on desktop
  // but in the on-demand detail cache on the remote slim core (the core drops
  // it). Read whichever is populated so the draft actions work on both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function readReviewBridge(prKey: string): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fromPayload = (ctx.payload.value as any)?.reviewBridge?.pullRequests?.[prKey];
    if (fromPayload) return fromPayload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (useRemoteDetailsStore().get(`review-bridge:${prKey}`) as any) || {};
  }

  async function reviewBridgeDeleteAllDrafts(prKey: string): Promise<void> {
    if (!prKey) return;
    const bridge = readReviewBridge(prKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drafts = ((bridge.drafts || []) as any[]).filter((d: AnyApi) => d.status === "draft");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const draftComments = ((bridge.comments || []) as any[]).filter(
      (c: AnyApi) => c.commentKind === "draft" || c.commentKind === "local-comment",
    );
    const totalCount = drafts.length + draftComments.length;
    if (!totalCount) return;
    const confirmed = await ctx.confirmInApp({
      title: "Delete all drafts?",
      message: `Delete ${drafts.length} draft${drafts.length !== 1 ? "s" : ""} and ${draftComments.length} draft comment${draftComments.length !== 1 ? "s" : ""}? This cannot be undone.`,
      confirmLabel: "Delete all",
      danger: true,
    });
    if (!confirmed) return;
    const api = ctx.getApi() as AnyApi;
    for (const comment of draftComments) {
      setPayload(
        (await api.deleteReviewBridgeComment({
          prKey,
          commentKey: comment.commentKey,
        })) as StatePayload,
      );
    }
    for (const draft of drafts) {
      if (!draftComments.some((c: AnyApi) => c.commentKey === draft.commentKey)) {
        setPayload((await api.deleteReviewBridgeDraft({ prKey, draftId: draft.draftId })) as StatePayload);
      }
    }
  }

  async function reviewBridgeQueueAllDrafts(prKey: string): Promise<void> {
    if (!prKey) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drafts = ((readReviewBridge(prKey).drafts || []) as any[]).filter((d: AnyApi) => d.status === "draft");
    if (!drafts.length) return;
    const api = ctx.getApi() as AnyApi;
    for (const draft of drafts) {
      setPayload((await api.queueReviewBridgeDraft({ prKey, draftId: draft.draftId })) as StatePayload);
    }
  }

  async function pushAndPublishReview(workspaceId: string): Promise<unknown> {
    if (!workspaceId) return null;
    const result = (await (ctx.getApi() as AnyApi).pushAndPublishReview({ workspaceId })) as AnyApi;
    const summary = result?.pushAndPublishResult || null;
    setPayload(result as StatePayload);
    return summary;
  }

  // --- GitHub ------------------------------------------------------------

  const githubApi = makeProviderApiActions(ctx, setPayload, "github");

  async function githubComment(prKey: string, body: string): Promise<void> {
    if (!prKey) return;
    setPayload((await (ctx.getApi() as AnyApi).commentGitHubPullRequest({ prKey, body })) as StatePayload);
  }

  async function githubSubmitReview(prKey: string, event: string, body = ""): Promise<void> {
    if (!prKey) return;
    setPayload(
      (await (ctx.getApi() as AnyApi).submitGitHubPullRequestReview({
        prKey,
        event,
        body,
      })) as StatePayload,
    );
  }

  // --- Agent prompts ---------------------------------------------------

  async function saveAgentPrompt(params: unknown): Promise<void> {
    setPayload((await (ctx.getApi() as AnyApi).saveAgentPrompt(params)) as StatePayload);
  }

  async function resetAgentPrompts(): Promise<void> {
    setPayload((await (ctx.getApi() as AnyApi).resetAgentPrompts()) as StatePayload);
  }

  async function deleteAgentPrompt(promptId: string): Promise<void> {
    if (!promptId) return;
    const confirmed = await ctx.confirmInApp({
      title: "Delete prompt?",
      message: "This prompt will be removed.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    setPayload((await (ctx.getApi() as AnyApi).deleteAgentPrompt({ promptId })) as StatePayload);
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
    setPayload(
      (await (ctx.getApi() as AnyApi).updateSettings({
        remoteAccess: { enabled },
      })) as StatePayload,
    );
  }

  async function regenerateRemoteToken(): Promise<void> {
    setPayload((await ctx.getApi().regenerateRemoteToken()) as StatePayload);
  }

  async function saveCustomPublicUrl(url: string): Promise<void> {
    setPayload(
      (await (ctx.getApi() as AnyApi).updateSettings({
        remoteAccess: { customPublicUrl: url },
      })) as StatePayload,
    );
  }

  async function clearCustomPublicUrl(): Promise<void> {
    setPayload(
      (await (ctx.getApi() as AnyApi).updateSettings({
        remoteAccess: { customPublicUrl: "" },
      })) as StatePayload,
    );
  }

  async function createCloudflareTunnel(): Promise<void> {
    setPayload((await (ctx.getApi() as AnyApi).createCloudflareTunnel()) as StatePayload);
  }

  async function stopCloudflareTunnel(): Promise<void> {
    setPayload((await (ctx.getApi() as AnyApi).stopCloudflareTunnel()) as StatePayload);
  }

  async function refreshTunnel(): Promise<void> {
    setPayload((await (ctx.getApi() as AnyApi).refreshTunnel()) as StatePayload);
  }

  function pickLanUrl(url: string): void {
    if (url) ctx.selectedLanUrl.value = url;
  }

  function getRemoteShareUrl(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = ctx.payload.value as any;
    const isRemote = ctx.getApi().isRemote;
    // A remote client never shares a remote-access URL of its own — this UI
    // is desktop-only, so no profile scoping is attempted when already remote.
    const windowId = (window as AnyApi).strideterm?.startupFlags?.windowId || "";
    const profileId = isRemote ? "" : ctx.resolveViewerProfileId(p, { isRemote: false, windowId }) || "";
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
    setPayload((await (ctx.getApi() as AnyApi).refreshDocker()) as StatePayload);
  }

  async function dockerShell(
    workspaceId: string,
    containerId: string,
    backendId?: string,
    contextName?: string,
  ): Promise<void> {
    if (!workspaceId || !containerId) return;
    setPayload(
      (await (ctx.getApi() as AnyApi).openDockerSession({
        workspaceId,
        containerId,
        mode: "shell",
        backendId,
        contextName,
      })) as StatePayload,
    );
    ctx.activeViewId.value = `${workspaceId}:shell-${containerId}`;
  }

  async function dockerLogs(workspaceId: string, containerId: string): Promise<void> {
    if (!workspaceId || !containerId) return;
    setPayload(
      (await (ctx.getApi() as AnyApi).openDockerSession({
        workspaceId,
        containerId,
        mode: "logs",
      })) as StatePayload,
    );
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
    setPayload(
      (await (ctx.getApi() as AnyApi).dockerAction({
        action: cleanAction,
        containerId,
        backendId,
        contextName,
      })) as StatePayload,
    );
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
    setPayload(
      (await (ctx.getApi() as AnyApi).dockerComposeAction({
        action,
        backendId,
        contextName,
        projectName,
      })) as StatePayload,
    );
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
    setPayload(
      (await (ctx.getApi() as AnyApi).dockerImageRemove({
        resource: imageId,
        backendId,
        contextName,
        force,
      })) as StatePayload,
    );
  }

  async function dockerVolumeRemove(
    volumeName: string,
    backendId: string,
    contextName: string,
    force = false,
  ): Promise<void> {
    setPayload(
      (await (ctx.getApi() as AnyApi).dockerVolumeRemove({
        resource: volumeName,
        backendId,
        contextName,
        force,
      })) as StatePayload,
    );
  }

  async function dockerNetworkRemove(networkId: string, backendId: string, contextName: string): Promise<void> {
    setPayload(
      (await (ctx.getApi() as AnyApi).dockerNetworkRemove({
        resource: networkId,
        backendId,
        contextName,
      })) as StatePayload,
    );
  }

  async function dockerImagePull(reference: string, backendId: string, contextName: string): Promise<void> {
    setPayload(
      (await (ctx.getApi() as AnyApi).dockerImagePull({
        resource: reference,
        backendId,
        contextName,
      })) as StatePayload,
    );
  }

  // ---------------------------------------------------------------------------
  // Prune actions. Each returns the PruneResult so the caller can show a toast
  // / dialog with the reclaimed-size and deleted-names. Payload is refreshed
  // server-side; we adopt it via setPayload (desktop only — on the remote slim
  // core the docker resource invalidation refetches the pane's detail instead).
  // ---------------------------------------------------------------------------
  async function dockerImagePrune(backendId: string, contextName: string, all: boolean): Promise<DockerPruneResult> {
    const r = (await (ctx.getApi() as AnyApi).dockerImagePrune({ backendId, contextName, all })) as {
      payload: StatePayload;
      result: DockerPruneResult;
    };
    setPayload(r.payload);
    return r.result;
  }

  async function dockerVolumePrune(backendId: string, contextName: string): Promise<DockerPruneResult> {
    const r = (await (ctx.getApi() as AnyApi).dockerVolumePrune({ backendId, contextName })) as {
      payload: StatePayload;
      result: DockerPruneResult;
    };
    setPayload(r.payload);
    return r.result;
  }

  async function dockerNetworkPrune(backendId: string, contextName: string): Promise<DockerPruneResult> {
    const r = (await (ctx.getApi() as AnyApi).dockerNetworkPrune({ backendId, contextName })) as {
      payload: StatePayload;
      result: DockerPruneResult;
    };
    setPayload(r.payload);
    return r.result;
  }

  async function dockerBuilderPrune(backendId: string, contextName: string, all: boolean): Promise<DockerPruneResult> {
    const r = (await (ctx.getApi() as AnyApi).dockerBuilderPrune({ backendId, contextName, all })) as {
      payload: StatePayload;
      result: DockerPruneResult;
    };
    setPayload(r.payload);
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
    setPayload(
      (await (ctx.getApi() as AnyApi).openLazydockerSession({
        workspaceId,
        backendId,
      })) as StatePayload,
    );
    ctx.activeViewId.value = `${workspaceId}:lazydocker`;
  }

  // --- Profile / settings ----------------------------------------------

  async function saveProfile(profile: unknown): Promise<void> {
    setPayload((await ctx.getApi().saveProfile(profile as Parameters<Transport["saveProfile"]>[0])) as StatePayload);
  }

  async function deleteProfile(profileId: string): Promise<void> {
    setPayload((await ctx.getApi().deleteProfile(profileId)) as StatePayload);
  }

  async function activateProfile(profileId: string): Promise<void> {
    await ctx.withSuppressedBroadcast(async () => {
      ctx.payload.value = (await ctx.getApi().activateProfile(profileId)) as StatePayload;
    });
    // Use restored session/view from the backend payload rather than blindly
    // clearing. The backend now saves and restores lastActiveWorkspaceId/SessionId
    // into the slot, so the payload reflects the correct selection after switching.
    const newPayload = ctx.payload.value as AnyApi;
    const windowId = typeof window !== "undefined" ? (window as AnyApi).strideterm?.startupFlags?.windowId : undefined;
    const slots = newPayload?.appState?.windowSlots as AnyApi[] | undefined;
    const mySlot = windowId && slots ? slots.find((s: AnyApi) => s.id === windowId) : null;
    const restoredSession = mySlot?.activeSessionId || "";
    if (restoredSession) {
      ctx.activeSessionId.value = restoredSession;
      ctx.activeViewId.value = restoredSession;
    } else {
      ctx.activeViewId.value = null;
      ctx.activeSessionId.value = null;
    }
    ctx.splitGroup.value = null;
  }

  async function updateSettings(patch: unknown): Promise<void> {
    setPayload((await (ctx.getApi() as AnyApi).updateSettings(patch)) as StatePayload);
  }

  return {
    // Azure
    refreshAzure: azureApi.refresh,
    markAzurePrSeen: azureApi.markPrSeen,
    azureVote,
    azureResolveThread,
    azureReactivateThread,
    azureComment,
    openAzurePullRequest: azureApi.openPullRequest,
    azureFetchReviewWorkspace: azureApi.fetchReviewWorkspace,
    azureRebaseReviewWorkspace: azureApi.rebaseReviewWorkspace,
    azurePushReviewWorkspace: azureApi.pushReviewWorkspace,
    deleteAzureConnection: azureApi.deleteConnection,
    saveAzureConnection: azureApi.saveConnection,
    // GitHub
    refreshGitHub: githubApi.refresh,
    markGitHubPrSeen: githubApi.markPrSeen,
    openGitHubPullRequest: githubApi.openPullRequest,
    githubComment,
    githubSubmitReview,
    githubFetchReviewWorkspace: githubApi.fetchReviewWorkspace,
    githubRebaseReviewWorkspace: githubApi.rebaseReviewWorkspace,
    githubPushReviewWorkspace: githubApi.pushReviewWorkspace,
    deleteGitHubConnection: githubApi.deleteConnection,
    saveGitHubConnection: githubApi.saveConnection,
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
