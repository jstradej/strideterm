/**
 * Component-level tests for AzureReviewPane mobile/responsive behaviour.
 *
 * AzureReviewPane is provider-aware (it handles both Azure and GitHub
 * reviews via review.provider on the workspace). These tests verify that
 * the same .review-shell popover triggers we wired up for the inbox
 * panes also fire correctly on the review pane in mobile mode, no dev
 * server required.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AzureReviewPane from "./AzureReviewPane.vue";
import ReviewPipelinesTab from "./shared/ReviewPipelinesTab.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

declare const setMatchMediaResult: (query: string, matches: boolean) => void;

function buildPayload(provider: "azure-devops" | "github" = "azure-devops"): StatePayload {
  const prKey = provider === "github" ? "github:42" : "ado:1";
  const detail = {
    pullRequest: {
      id: provider === "github" ? 42 : 1,
      number: provider === "github" ? 42 : undefined,
      title: "Sample review PR",
      isDraft: false,
      sourceRefName: provider === "github" ? "feature/x" : "refs/heads/feature/x",
      targetRefName: provider === "github" ? "main" : "refs/heads/main",
      url: "",
      webUrl: "",
      mergeStatus: "succeeded",
    },
    project: { name: "MockProject" },
    repository: provider === "github" ? { fullName: "mock-org/repo" } : { name: "platform-api" },
    role: "reviewer",
    hasAttention: false,
    attentionReason: "",
    reviewerSummary: { reviewers: [] },
    checks: { failedCount: 0, pendingCount: 0, passedCount: 1, checks: [] },
    changedFiles: [],
    threads: [],
    issueComments: [],
  };
  return {
    appState: {
      activeWorkspaceId: "ws-review",
      activeViewId: "review:ws-review",
      activeProfileId: "default",
      workspaces: [
        {
          id: "ws-review",
          name: "Review WS",
          kind: "terminal",
          activeViewId: "review:ws-review",
          panels: [],
          review: { provider, prKey },
        },
      ],
      profiles: [{ id: "default", name: "Default", color: "", workspaceIds: ["ws-review"] }],
    },
    workspace: {
      workspace: {
        id: "ws-review",
        name: "Review WS",
        kind: "terminal",
        panels: [],
        review: { provider, prKey },
      },
      project: null,
      sessions: [],
    },
    azureDevops: provider === "azure-devops" ? { pullRequests: { [prKey]: detail } } : { pullRequests: {} },
    github: provider === "github" ? { pullRequests: { [prKey]: detail } } : { pullRequests: {} },
    reviewBridge: { pullRequests: {}, agentPrompts: [], syncQueue: [] },
    git: { workspaces: {} },
  } as unknown as StatePayload;
}

function mountPane(provider: "azure-devops" | "github" = "azure-devops") {
  const appStore = useAppStore();
  appStore.payload = buildPayload(provider);
  // Stub the network-bound store actions the component fires from
  // mounted/watch hooks so they don't blow up against the null _api.
  const noop = () => Promise.resolve();
  for (const fn of [
    "refreshAzure",
    "refreshGitHub",
    "markAzurePrSeen",
    "markGitHubPrSeen",
    "markAzurePullRequestSeen",
    "openExternal",
  ]) {
    if (typeof (appStore as unknown as Record<string, unknown>)[fn] === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.spyOn(appStore as any, fn as any) as any).mockImplementation(noop);
    }
  }
  return mount(AzureReviewPane, {
    props: { workspaceId: "ws-review" },
    global: {
      stubs: {
        PaneShell: true,
        DiffViewer: true,
        GitCommitLog: true,
        MonacoDiffPanel: true,
        ReviewSummaryTab: true,
        ReviewCommentsTab: true,
        ReviewAgentTab: true,
        ReviewPipelinesTab: true,
        CustomSelect: true,
      },
      provide: {
        api: {
          azureListRemoteBranches: () => Promise.resolve({ branches: [] }),
          githubListRemoteBranches: () => Promise.resolve({ branches: [] }),
        },
      },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("AzureReviewPane responsive chrome", () => {
  test("on desktop the inline review chrome renders without popover triggers", async () => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.find(".review-shell__menu-trigger").exists()).toBe(false);
    expect(wrapper.find(".review-shell__tabs-trigger").exists()).toBe(false);
    // Inline subtab list is in the DOM regardless — CSS hides it on mobile.
    expect(wrapper.find(".review-subtabs").exists()).toBe(true);
    expect(wrapper.find(".git-view__toolbar").exists()).toBe(true);
  });

  test("on mobile the popover triggers render in the review shell", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.find(".review-shell__menu-trigger").exists()).toBe(true);
    expect(wrapper.find(".review-shell__tabs-trigger").exists()).toBe(true);
  });

  test("toggling the actions trigger flips the --menu-open modifier", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    await wrapper.find(".review-shell__menu-trigger").trigger("click");
    expect(wrapper.find(".review-shell--menu-open").exists()).toBe(true);
    await wrapper.find(".review-shell__menu-backdrop").trigger("click");
    expect(wrapper.find(".review-shell--menu-open").exists()).toBe(false);
  });

  test("toggling the tabs trigger flips the --tabs-menu-open modifier", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    await wrapper.find(".review-shell__tabs-trigger").trigger("click");
    expect(wrapper.find(".review-shell--tabs-menu-open").exists()).toBe(true);
    await wrapper.find(".review-shell__menu-backdrop").trigger("click");
    expect(wrapper.find(".review-shell--tabs-menu-open").exists()).toBe(false);
  });

  test("provider-aware: GitHub PR data also renders the same mobile chrome", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane("github");
    await flushPromises();

    expect(wrapper.find(".review-shell__menu-trigger").exists()).toBe(true);
    expect(wrapper.find(".review-shell__tabs-trigger").exists()).toBe(true);
  });

  test("a failing auto-refresh is swallowed and never reaches the error handler", async () => {
    // Regression: the immediate auto-refresh watch awaited refreshAzure without
    // catching. A failed poll (5xx through the tunnel, server restarting) then
    // rejected out of the watch → Vue's error handler → ErrorBoundary → the pane
    // remounted → the watch re-fired → a crash-loop that churned the visible-tab
    // set (terminal mounting/unmounting every cycle). It must be swallowed.
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);

    const appStore = useAppStore();
    appStore.payload = buildPayload("azure-devops");
    const reviewStore = appStore as unknown as {
      activeViewId: string;
      refreshAzure: () => Promise<void>;
      markAzurePrSeen: (prKey: string) => Promise<void>;
    };
    // The immediate watch only refreshes when the review view is active.
    reviewStore.activeViewId = "review:ws-review";
    const refreshSpy = vi
      .spyOn(reviewStore, "refreshAzure")
      .mockRejectedValue(new Error("Remote workspace is temporarily unavailable"));
    vi.spyOn(reviewStore, "markAzurePrSeen").mockImplementation(() => Promise.resolve());

    const handledErrors: unknown[] = [];
    const wrapper = mount(AzureReviewPane, {
      props: { workspaceId: "ws-review" },
      global: {
        // Vue routes async watcher-callback rejections here. Without the catch
        // in the watch, the refresh rejection lands in this handler.
        config: { errorHandler: (err: unknown) => handledErrors.push(err) },
        stubs: {
          PaneShell: true,
          DiffViewer: true,
          GitCommitLog: true,
          MonacoDiffPanel: true,
          ReviewSummaryTab: true,
          ReviewCommentsTab: true,
          ReviewAgentTab: true,
          ReviewPipelinesTab: true,
          CustomSelect: true,
        },
        provide: {
          api: {
            azureListRemoteBranches: () => Promise.resolve({ branches: [] }),
            githubListRemoteBranches: () => Promise.resolve({ branches: [] }),
          },
        },
      },
    });
    await flushPromises();

    expect(refreshSpy).toHaveBeenCalled(); // the watch actually fired the refresh
    expect(handledErrors).toHaveLength(0); // ...and the rejection was swallowed
    expect(wrapper.exists()).toBe(true); // pane still mounted, no crash
  });
});

/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.3: the
 * toolbar Refresh and Pipelines-tab refresh handlers were try/finally with
 * no catch, so a failed refresh silently reset the busy flag with zero
 * user-visible feedback. Both now go through notifications.runWithToast.
 */
describe("AzureReviewPane — toolbar and pipelines refresh surface failures instead of silently succeeding", () => {
  test("toolbar Refresh: rejection is caught and surfaced as a toast, busy resets", async () => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
    // mountPane() itself installs no-op spies for refreshAzure/markAzurePrSeen —
    // override them AFTER mounting, otherwise mountPane's noop clobbers ours.
    const wrapper = mountPane();
    await flushPromises();
    const appStore = useAppStore();
    vi.spyOn(appStore, "refreshAzure").mockRejectedValue(new Error("network down"));

    const refreshBtn = wrapper
      .findAll("button")
      .find((b) => b.attributes("title")?.includes("Fetch the latest PR data"))!;
    await refreshBtn.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Refresh failed");
    // busy resets — button label back to "Refresh" (not "Refreshing…")
    expect(refreshBtn.text()).toContain("Refresh");
    expect(refreshBtn.text()).not.toContain("Refreshing");
  });

  test("Pipelines tab refresh: rejection is caught and surfaced as a toast, busy resets", async () => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
    // mountPane() itself installs no-op spies for refreshAzure/markAzurePrSeen —
    // override them AFTER mounting, otherwise mountPane's noop clobbers ours.
    const wrapper = mountPane();
    await flushPromises();
    const appStore = useAppStore();
    vi.spyOn(appStore, "refreshAzure").mockRejectedValue(new Error("pipeline refresh failed"));

    const pipelinesTabBtn = wrapper.findAll(".azure-tab").find((b) => b.text().startsWith("Pipelines"))!;
    await pipelinesTabBtn.trigger("click");

    const pipelinesTab = wrapper.findComponent(ReviewPipelinesTab);
    expect(pipelinesTab.exists()).toBe(true);
    await pipelinesTab.vm.$emit("refresh");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Refresh checks failed");
    // busy resets — refreshing prop passed to the child goes back to false
    expect((wrapper.findComponent(ReviewPipelinesTab).props() as Record<string, unknown>).refreshing).toBe(false);
  });
});

/**
 * Category A (code-review batch, 2026-07): loadPrBranches swallowed a
 * failed azureListRemoteBranches/githubListRemoteBranches call into an
 * empty list, indistinguishable from "this repo genuinely has no remote
 * branches." It must now surface a distinct error.
 */
describe("AzureReviewPane — loadPrBranches surfaces a load failure", () => {
  function buildPrePrPayload(): StatePayload {
    return {
      appState: {
        activeWorkspaceId: "ws-review",
        activeViewId: "review:ws-review",
        activeProfileId: "default",
        workspaces: [
          {
            id: "ws-review",
            name: "Review WS",
            kind: "terminal",
            activeViewId: "review:ws-review",
            panels: [],
            review: { provider: "azure-devops" },
          },
        ],
        profiles: [{ id: "default", name: "Default", color: "", workspaceIds: ["ws-review"] }],
      },
      workspace: {
        workspace: {
          id: "ws-review",
          name: "Review WS",
          kind: "terminal",
          panels: [],
          review: { provider: "azure-devops" },
        },
        project: null,
        sessions: [],
      },
      azureDevops: { pullRequests: {} },
      github: { pullRequests: {} },
      reviewBridge: { pullRequests: {}, agentPrompts: [], syncQueue: [] },
      git: { workspaces: {} },
    } as unknown as StatePayload;
  }

  test("a rejected azureListRemoteBranches sets a visible error instead of an empty list", async () => {
    const appStore = useAppStore();
    appStore.payload = buildPrePrPayload();

    const wrapper = mount(AzureReviewPane, {
      props: { workspaceId: "ws-review" },
      global: {
        stubs: {
          PaneShell: true,
          DiffViewer: true,
          GitCommitLog: true,
          MonacoDiffPanel: true,
          ReviewSummaryTab: true,
          ReviewCommentsTab: true,
          ReviewAgentTab: true,
          ReviewPipelinesTab: true,
          CustomSelect: true,
        },
        provide: {
          api: {
            azureListRemoteBranches: () => Promise.reject(new Error("network down")),
            githubListRemoteBranches: () => Promise.reject(new Error("network down")),
          },
        },
      },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("network down");
  });
});

/**
 * Regression coverage for review-code-quality-2026-07.md §3.5: AzureReviewPane
 * used to carry its own inline copy of the Monaco diff seq-guard/error-envelope
 * logic instead of the shared useMonacoDiffLoader composable that
 * GitBranchesTab/GitChangesTab already used. This proves the shared composable
 * is wired correctly here — the right fetch is issued when a file is selected,
 * and a rejection produces the same error-envelope shape MonacoDiffPanel expects.
 */
describe("AzureReviewPane — Monaco diff loading via the shared useMonacoDiffLoader", () => {
  function buildFileDiffPayload(): StatePayload {
    const prKey = "ado:1";
    const detail = {
      pullRequest: {
        id: 1,
        title: "Sample review PR",
        isDraft: false,
        sourceRefName: "refs/heads/feature/x",
        targetRefName: "refs/heads/main",
        url: "",
        webUrl: "",
        mergeStatus: "succeeded",
      },
      project: { name: "MockProject" },
      repository: { name: "platform-api" },
      role: "reviewer",
      hasAttention: false,
      attentionReason: "",
      reviewerSummary: { reviewers: [] },
      checks: { failedCount: 0, pendingCount: 0, passedCount: 1, checks: [] },
      changedFiles: [{ path: "src/foo.ts", changeType: "modified" }],
      threads: [],
      issueComments: [],
    };
    return {
      appState: {
        activeWorkspaceId: "ws-review",
        activeViewId: "review:ws-review",
        activeProfileId: "default",
        workspaces: [
          {
            id: "ws-review",
            name: "Review WS",
            kind: "terminal",
            cwd: "/repo",
            activeViewId: "review:ws-review",
            panels: [],
            review: { provider: "azure-devops", prKey },
          },
        ],
        profiles: [{ id: "default", name: "Default", color: "", workspaceIds: ["ws-review"] }],
      },
      workspace: {
        workspace: {
          id: "ws-review",
          name: "Review WS",
          kind: "terminal",
          cwd: "/repo",
          panels: [],
          review: { provider: "azure-devops", prKey },
        },
        project: null,
        sessions: [],
      },
      azureDevops: { pullRequests: { [prKey]: detail } },
      github: { pullRequests: {} },
      reviewBridge: { pullRequests: {}, agentPrompts: [], syncQueue: [] },
      git: { workspaces: {} },
    } as unknown as StatePayload;
  }

  function mountWithFileDiff() {
    const appStore = useAppStore();
    appStore.payload = buildFileDiffPayload();
    for (const fn of ["refreshAzure", "markAzurePrSeen", "markAzurePullRequestSeen"]) {
      if (typeof (appStore as unknown as Record<string, unknown>)[fn] === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vi.spyOn(appStore as any, fn as any) as any).mockImplementation(() => Promise.resolve());
      }
    }
    return mount(AzureReviewPane, {
      props: { workspaceId: "ws-review" },
      global: {
        stubs: {
          PaneShell: true,
          DiffViewer: true,
          GitCommitLog: true,
          ReviewSummaryTab: true,
          ReviewCommentsTab: true,
          ReviewAgentTab: true,
          ReviewPipelinesTab: true,
          CustomSelect: true,
          // MonacoDiffPanel is intentionally NOT stubbed away here — we need to
          // read its monaco-payload prop to confirm the loader actually wired.
        },
        provide: {
          api: {
            azureListRemoteBranches: () => Promise.resolve({ branches: [] }),
            githubListRemoteBranches: () => Promise.resolve({ branches: [] }),
          },
        },
      },
    });
  }

  test("selecting a file fetches the branch diff against origin/<target> and feeds MonacoDiffPanel", async () => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
    const wrapper = mountWithFileDiff();
    await flushPromises();

    const appStore = useAppStore();
    const fileGitDiff = vi.fn().mockResolvedValue({ ok: true, leftContent: "old", rightContent: "new" });
    vi.spyOn(appStore, "getApi").mockReturnValue({ fileGitDiff } as unknown as ReturnType<typeof appStore.getApi>);

    const filesTabBtn = wrapper.findAll(".azure-tab").find((b) => b.text().startsWith("Files"))!;
    await filesTabBtn.trigger("click");
    await flushPromises();

    const fileBtn = wrapper.find(".review-tree-file");
    expect(fileBtn.exists()).toBe(true);
    await fileBtn.trigger("click");
    await flushPromises();

    expect(fileGitDiff).toHaveBeenCalledWith({
      rootPath: "/repo",
      relativePath: "src/foo.ts",
      source: "branch",
      revisionRef: "origin/main",
    });

    // MonacoDiffPanel is auto-stubbed as a defineAsyncComponent in this test
    // environment, so assert via the (real, unstubbed) ReviewFileDiffPreview
    // wrapper's own monacoPayload prop instead of reaching across the stub.
    const preview = wrapper.findComponent({ name: "ReviewFileDiffPreview" });
    expect(preview.exists()).toBe(true);
    expect(preview.props("monacoPayload")).toEqual({ ok: true, leftContent: "old", rightContent: "new" });
  });

  test("a rejected fetch produces the shared error-envelope shape instead of throwing", async () => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
    const wrapper = mountWithFileDiff();
    await flushPromises();

    const appStore = useAppStore();
    const fileGitDiff = vi.fn().mockRejectedValue(new Error("git show failed"));
    vi.spyOn(appStore, "getApi").mockReturnValue({ fileGitDiff } as unknown as ReturnType<typeof appStore.getApi>);

    const filesTabBtn = wrapper.findAll(".azure-tab").find((b) => b.text().startsWith("Files"))!;
    await filesTabBtn.trigger("click");
    await flushPromises();

    await wrapper.find(".review-tree-file").trigger("click");
    await flushPromises();

    const preview = wrapper.findComponent({ name: "ReviewFileDiffPreview" });
    expect(preview.props("monacoPayload")).toEqual(
      expect.objectContaining({ ok: false, leftError: "git show failed", leftMissing: true, rightMissing: true }),
    );
  });
});
