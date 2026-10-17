import { describe, expect, it, beforeEach, vi } from "vitest";
import { ref, shallowRef } from "vue";
import { createApiActions, makeProviderApiActions } from "./app-api-actions.js";
import { resolveViewerProfileId } from "./app.js";
import { azureVoteSchema } from "../../electron/backend/ipc-schemas.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makeCtx(payloadValue: AnyApi) {
  const ctx = {
    payload: shallowRef(payloadValue),
    activeViewId: ref<string | null>(null),
    activeSessionId: ref<string | null>(null),
    splitGroup: ref(null),
    remoteAccessMode: ref("lan"),
    selectedLanUrl: ref(""),
    getApi: () => ({ isRemote: false }),
    adoptPayload: (next: AnyApi) => {
      ctx.payload.value = next;
    },
    withSuppressedBroadcast: async (fn: () => Promise<void>) => fn(),
    confirmInApp: async () => true,
    resolveViewerProfileId,
    reviewGit: { run: vi.fn(async () => ({ status: "ok" })), isBusy: vi.fn(() => false) },
  } as AnyApi;
  return ctx;
}

describe("createApiActions.getRemoteShareUrl", () => {
  beforeEach(() => {
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-b" } };
  });

  it("includes this desktop window's profile context in generated remote URLs", () => {
    const ctx = makeCtx({
      remoteAccess: {
        urls: ["http://192.168.1.20:7333"],
        tunnel: { publicUrl: "" },
      },
      appState: {
        settings: {
          remoteAccess: {
            token: "remote-token",
            customPublicUrl: "",
          },
        },
        windowSlots: [
          { id: "win-a", profileId: "profile-a" },
          { id: "win-b", profileId: "profile-b" },
        ],
      },
    });
    const actions = createApiActions(ctx);

    expect(actions.getRemoteShareUrl()).toBe("http://192.168.1.20:7333/?token=remote-token&profileId=profile-b");
  });
});

describe("createApiActions review checkout Git", () => {
  it("every action starts the matching review Git operation for the workspace", async () => {
    const ctx = makeCtx({ appState: { workspaces: [] } });
    const actions = createApiActions(ctx);

    await actions.refreshReviewCheckout("ws1");
    await actions.rebaseReviewCheckout("ws1");
    await actions.pushReviewCheckout("ws1");
    await actions.pushReviewCheckout("ws1", { force: true });
    await actions.pushAndPublishReview("ws1");

    expect(ctx.reviewGit.run.mock.calls).toEqual([
      ["refresh", "ws1"],
      ["rebase", "ws1"],
      ["push", "ws1"],
      ["force-push", "ws1"],
      ["push-and-publish", "ws1"],
    ]);
  });

  it("returns the outcome the operation reported, and does nothing without a workspace", async () => {
    const ctx = makeCtx({ appState: { workspaces: [] } });
    ctx.reviewGit.run.mockResolvedValueOnce({ push: { status: "pushed" }, publish: { attempted: true } });
    const actions = createApiActions(ctx);

    expect(await actions.pushAndPublishReview("ws1")).toEqual({
      push: { status: "pushed" },
      publish: { attempted: true },
    });
    expect(await actions.pushAndPublishReview("")).toBeNull();
    expect(ctx.reviewGit.run).toHaveBeenCalledTimes(1);
  });

  it("busy state comes from the runtime-backed operation list", () => {
    const ctx = makeCtx({ appState: { workspaces: [] } });
    ctx.reviewGit.isBusy.mockReturnValueOnce(true);
    const actions = createApiActions(ctx);
    expect(actions.isReviewGitBusy("ws1", ["push"])).toBe(true);
    expect(ctx.reviewGit.isBusy).toHaveBeenCalledWith("ws1", ["push"]);
  });
});

describe("createApiActions.azureVote", () => {
  // The IPC handler validates with azureVoteSchema; a payload it refuses
  // never reaches Azure DevOps (see ReviewSummaryTab.test.ts).
  it("sends the vote as a number the IPC schema accepts", async () => {
    const ctx = makeCtx({ appState: { workspaces: [] } });
    const voteAzurePullRequest = vi.fn(async (_payload: unknown) => ({ appState: { workspaces: [] } }));
    ctx.getApi = () => ({ isRemote: false, voteAzurePullRequest });
    const actions = createApiActions(ctx);

    await actions.azureVote("pr-1", 10);

    expect(voteAzurePullRequest).toHaveBeenCalledWith({ prKey: "pr-1", vote: 10 });
    expect(azureVoteSchema.safeParse(voteAzurePullRequest.mock.calls[0][0]).success).toBe(true);
  });
});

// makeProviderApiActions is the factory behind refreshAzure/refreshGitHub,
// markAzurePrSeen/markGitHubPrSeen, openAzurePullRequest/openGitHubPullRequest,
// deleteAzureConnection/deleteGitHubConnection, and
// saveAzureConnection/saveGitHubConnection. These tests exercise the factory
// directly (not through createApiActions) to prove that selecting "azure" vs
// "github" wires every generated function to the correct provider-specific
// transport method, and never to the other provider's.
describe("makeProviderApiActions", () => {
  function makeMockApi() {
    return {
      refreshAzure: vi.fn(async () => ({ azure: "refreshed" })),
      markAzurePullRequestSeen: vi.fn(async (prKey: string) => ({ azure: "seen", prKey })),
      openAzurePullRequest: vi.fn(async (args: unknown) => ({ azure: "opened", args })),
      deleteAzureConnection: vi.fn(async (id: string) => ({ azure: "deleted", id })),
      saveAzureConnection: vi.fn(async (draft: unknown) => ({ payload: { azure: "saved", draft } })),

      refreshGitHub: vi.fn(async () => ({ github: "refreshed" })),
      markGitHubPullRequestSeen: vi.fn(async (prKey: string) => ({ github: "seen", prKey })),
      openGitHubPullRequest: vi.fn(async (args: unknown) => ({ github: "opened", args })),
      deleteGitHubConnection: vi.fn(async (id: string) => ({ github: "deleted", id })),
      saveGitHubConnection: vi.fn(async (draft: unknown) => ({ payload: { github: "saved", draft } })),
    };
  }

  function makeFactoryCtx(api: AnyApi, confirmed: boolean) {
    const setPayloadCalls: AnyApi[] = [];
    const confirmInApp = vi.fn(async () => confirmed);
    return {
      ctx: { getApi: () => api, confirmInApp },
      setPayload: (p: AnyApi) => setPayloadCalls.push(p),
      setPayloadCalls,
      confirmInApp,
    };
  }

  (["azure", "github"] as const).forEach((provider) => {
    it(`${provider}: every generated action calls the ${provider}-specific transport method (and never the other provider's)`, async () => {
      const api = makeMockApi();
      const { ctx, setPayload, setPayloadCalls } = makeFactoryCtx(api, true);
      const actions = makeProviderApiActions(ctx, setPayload, provider);

      await actions.refresh();
      await actions.markPrSeen("pr-1");
      await actions.openPullRequest("pr-1", "ws-1");
      await actions.saveConnection({ id: "conn-1" });

      const azureCalledWhenAzure = provider === "azure";
      expect(api.refreshAzure.mock.calls.length > 0).toBe(azureCalledWhenAzure);
      expect(api.refreshGitHub.mock.calls.length > 0).toBe(!azureCalledWhenAzure);

      const markPrSeenMethod = provider === "azure" ? api.markAzurePullRequestSeen : api.markGitHubPullRequestSeen;
      const openPrMethod = provider === "azure" ? api.openAzurePullRequest : api.openGitHubPullRequest;
      const saveMethod = provider === "azure" ? api.saveAzureConnection : api.saveGitHubConnection;
      const otherMarkPrSeenMethod = provider === "azure" ? api.markGitHubPullRequestSeen : api.markAzurePullRequestSeen;

      expect(markPrSeenMethod).toHaveBeenCalledWith("pr-1");
      expect(openPrMethod).toHaveBeenCalledWith({ prKey: "pr-1", workspaceId: "ws-1", forceReview: false });
      expect(saveMethod).toHaveBeenCalledWith({ id: "conn-1" });
      expect(otherMarkPrSeenMethod).not.toHaveBeenCalled();

      // saveConnection unwraps { payload } exactly like the pre-refactor code did.
      expect(setPayloadCalls.at(-1)).toEqual({ [provider]: "saved", draft: { id: "conn-1" } });
    });

    it(`${provider}: deleteConnection confirms with provider-specific copy, then calls the matching delete method`, async () => {
      const api = makeMockApi();
      const { ctx, setPayload, confirmInApp } = makeFactoryCtx(api, true);
      const actions = makeProviderApiActions(ctx, setPayload, provider);

      await actions.deleteConnection("conn-1");

      const expectedName = provider === "azure" ? "Azure DevOps connection" : "GitHub connection";
      expect(confirmInApp).toHaveBeenCalledWith(
        expect.objectContaining({
          title: `Delete ${expectedName}?`,
          message: `This ${expectedName} will be removed.`,
        }),
      );
      const deleteMethod = provider === "azure" ? api.deleteAzureConnection : api.deleteGitHubConnection;
      const otherDeleteMethod = provider === "azure" ? api.deleteGitHubConnection : api.deleteAzureConnection;
      expect(deleteMethod).toHaveBeenCalledWith("conn-1");
      expect(otherDeleteMethod).not.toHaveBeenCalled();
    });

    it(`${provider}: deleteConnection skips the transport call when the user cancels the confirm`, async () => {
      const api = makeMockApi();
      const { ctx, setPayload } = makeFactoryCtx(api, false);
      const actions = makeProviderApiActions(ctx, setPayload, provider);

      await actions.deleteConnection("conn-1");

      expect(api.deleteAzureConnection).not.toHaveBeenCalled();
      expect(api.deleteGitHubConnection).not.toHaveBeenCalled();
    });
  });
});
