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
import { useAppStore } from "../../stores/app.js";
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
});
