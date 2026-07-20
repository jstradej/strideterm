/**
 * Component-level tests for PrePrWorkspaceView — the "New Branch" pre-PR
 * wizard extracted out of AzureReviewPane.vue (review-code-quality finding
 * 5.4). Mounted directly (not through the parent pane) so its own
 * interactions — branch loading, title auto-fill, PR creation — are
 * verified in isolation.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PrePrWorkspaceView from "./PrePrWorkspaceView.vue";
import { apiKey } from "../../../types/keys.js";
import CustomSelect from "../../common/CustomSelect.vue";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import type { StatePayload } from "../../../../electron/shared/types/state.js";

function buildPayload(opts: {
  provider?: "azure-devops" | "github";
  aheadCount?: number;
  dirty?: boolean;
  log?: Array<Record<string, unknown>>;
  baseBranch?: string;
}): StatePayload {
  const provider = opts.provider || "azure-devops";
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
          review: { provider },
          quickfix: { baseBranch: opts.baseBranch || "" },
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
        review: { provider },
        quickfix: { baseBranch: opts.baseBranch || "" },
      },
      project: null,
      sessions: [],
    },
    azureDevops: { pullRequests: {} },
    github: { pullRequests: {} },
    reviewBridge: { pullRequests: {}, agentPrompts: [], syncQueue: [] },
    git: {
      workspaces: {
        "ws-review": {
          branch: "feature/x",
          aheadCount: opts.aheadCount ?? 0,
          dirty: opts.dirty ?? false,
          dirtyCount: 0,
          log: opts.log || [],
        },
      },
    },
  } as unknown as StatePayload;
}

function mountWizard(payloadOpts: Parameters<typeof buildPayload>[0], api: Record<string, unknown> = {}) {
  const appStore = useAppStore();
  appStore.payload = buildPayload(payloadOpts);
  const defaultApi = {
    azureListRemoteBranches: () => Promise.resolve({ branches: [] }),
    githubListRemoteBranches: () => Promise.resolve({ branches: [] }),
    azureCreatePullRequest: () => Promise.resolve({ result: { pullRequestId: 1, url: "" } }),
    githubCreatePullRequest: () => Promise.resolve({ result: { pullRequestNumber: 1, url: "" } }),
    ...api,
  };
  return mount(PrePrWorkspaceView, {
    props: { workspaceId: "ws-review" },
    global: {
      stubs: { GitCommitLog: true },
      provide: { [apiKey]: defaultApi },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("PrePrWorkspaceView — workflow steps reflect git state", () => {
  test("clean working tree: step 1 is active, steps 2/3 are not done", () => {
    const wrapper = mountWizard({ aheadCount: 0, dirty: false });
    const steps = wrapper.findAll(".nb-step");
    expect(steps[0].classes()).toContain("nb-step--active");
    expect(steps[0].classes()).not.toContain("nb-step--done");
    expect(steps[1].classes()).not.toContain("nb-step--done");
    expect(wrapper.text()).toContain("Working tree is clean");
  });

  test("dirty working tree with no commits yet: step 1 done, step 2 active", () => {
    const wrapper = mountWizard({ aheadCount: 0, dirty: true });
    const steps = wrapper.findAll(".nb-step");
    expect(steps[0].classes()).toContain("nb-step--done");
    expect(steps[1].classes()).toContain("nb-step--active");
    expect(wrapper.text()).toContain("uncommitted file(s)");
  });

  test("commits ahead: steps 1 and 2 done, step 3 active, commit log renders", () => {
    const wrapper = mountWizard({
      aheadCount: 2,
      dirty: false,
      log: [{ subject: "Fix bug", shortHash: "abc123" }],
    });
    const steps = wrapper.findAll(".nb-step");
    expect(steps[0].classes()).toContain("nb-step--done");
    expect(steps[1].classes()).toContain("nb-step--done");
    expect(steps[2].classes()).toContain("nb-step--active");
    expect(wrapper.text()).toContain("2 commit(s) ready to push");
    expect(wrapper.findComponent({ name: "GitCommitLog" }).exists()).toBe(true);
  });
});

describe("PrePrWorkspaceView — branch loading", () => {
  test("loads remote branches on mount via the Azure API when provider is azure-devops", async () => {
    const azureListRemoteBranches = vi.fn(() => Promise.resolve({ branches: ["develop", "main"] }));
    mountWizard({ provider: "azure-devops" }, { azureListRemoteBranches });
    await flushPromises();

    expect(azureListRemoteBranches).toHaveBeenCalledWith({ workspaceId: "ws-review" });
  });

  test("loads remote branches via the GitHub API when provider is github", async () => {
    const githubListRemoteBranches = vi.fn(() => Promise.resolve({ branches: ["main"] }));
    mountWizard({ provider: "github" }, { githubListRemoteBranches });
    await flushPromises();

    expect(githubListRemoteBranches).toHaveBeenCalledWith({ workspaceId: "ws-review" });
  });

  test("auto-selects 'develop' as the target branch when present and no base branch is configured", async () => {
    const wrapper = mountWizard(
      { provider: "azure-devops" },
      { azureListRemoteBranches: () => Promise.resolve({ branches: ["release", "develop", "main"] }) },
    );
    await flushPromises();

    expect((wrapper.findComponent(CustomSelect).props() as Record<string, unknown>).modelValue).toBe("develop");
  });

  test("prefers the workspace's configured base branch over 'develop'/'main'", async () => {
    const wrapper = mountWizard(
      { provider: "azure-devops", baseBranch: "release/1.0" },
      { azureListRemoteBranches: () => Promise.resolve({ branches: ["release/1.0", "develop", "main"] }) },
    );
    await flushPromises();

    expect((wrapper.findComponent(CustomSelect).props() as Record<string, unknown>).modelValue).toBe("release/1.0");
  });

  test("a rejected branch load surfaces a visible error instead of silently emptying the list", async () => {
    const wrapper = mountWizard(
      { provider: "azure-devops" },
      { azureListRemoteBranches: () => Promise.reject(new Error("network down")) },
    );
    await flushPromises();

    expect(wrapper.text()).toContain("network down");
  });
});

describe("PrePrWorkspaceView — PR title/description auto-fill", () => {
  test("a single ahead commit auto-fills the title from its subject", async () => {
    const wrapper = mountWizard({
      aheadCount: 1,
      log: [{ subject: "Fix the thing", shortHash: "abc123" }],
    });
    await flushPromises();

    const titleInput = wrapper.find('input[placeholder="Pull request title"]');
    expect((titleInput.element as HTMLInputElement).value).toBe("Fix the thing");
  });

  test("multiple ahead commits use the branch name as title and list commits in the description", async () => {
    const wrapper = mountWizard({
      aheadCount: 2,
      log: [
        { subject: "First commit", shortHash: "aaa" },
        { subject: "Second commit", shortHash: "bbb" },
      ],
    });
    await flushPromises();

    const titleInput = wrapper.find('input[placeholder="Pull request title"]');
    // branch is "feature/x" -> suffix "x"
    expect((titleInput.element as HTMLInputElement).value).toBe("x");
    const descriptionArea = wrapper.find("textarea");
    expect((descriptionArea.element as HTMLTextAreaElement).value).toBe("- First commit\n- Second commit");
  });
});

describe("PrePrWorkspaceView — creating a pull request", () => {
  test("with unpushed commits: confirming the push proceeds to push then create the PR", async () => {
    const appStore = useAppStore();
    const confirmSpy = vi.spyOn(appStore, "confirmInApp").mockResolvedValue(true);
    const pushSpy = vi.spyOn(appStore, "azurePushReviewWorkspace").mockResolvedValue(undefined as never);
    const azureCreatePullRequest = vi.fn(() =>
      Promise.resolve({ result: { pullRequestId: 42, url: "https://example.test/pr/42" } }),
    );
    const wrapper = mountWizard(
      { aheadCount: 1, log: [{ subject: "Fix the thing", shortHash: "abc123" }] },
      { azureListRemoteBranches: () => Promise.resolve({ branches: ["main"] }), azureCreatePullRequest },
    );
    await flushPromises();

    await wrapper.find("button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(confirmSpy).toHaveBeenCalled();
    expect(pushSpy).toHaveBeenCalledWith("ws-review");
    expect(azureCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-review", targetBranch: "main", title: "Fix the thing" }),
    );
    expect(wrapper.text()).toContain("PR #42 created.");
  });

  test("declining the push confirmation does not create the PR", async () => {
    const appStore = useAppStore();
    vi.spyOn(appStore, "confirmInApp").mockResolvedValue(false);
    const azureCreatePullRequest = vi.fn(() => Promise.resolve({ result: { pullRequestId: 1, url: "" } }));
    const wrapper = mountWizard(
      { aheadCount: 1, log: [{ subject: "Fix the thing", shortHash: "abc123" }] },
      { azureListRemoteBranches: () => Promise.resolve({ branches: ["main"] }), azureCreatePullRequest },
    );
    await flushPromises();

    await wrapper.find("button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(azureCreatePullRequest).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Push your commits to remote first");
  });

  test("a failed PR creation surfaces the error message instead of throwing", async () => {
    const azureCreatePullRequest = vi.fn(() => Promise.reject(new Error("PR creation failed")));
    const wrapper = mountWizard(
      { aheadCount: 0, log: [] },
      { azureListRemoteBranches: () => Promise.resolve({ branches: ["main"] }), azureCreatePullRequest },
    );
    await flushPromises();
    // No commits ahead, so title needs to be filled manually to enable submit.
    await wrapper.find('input[placeholder="Pull request title"]').setValue("Manual title");

    await wrapper.find("button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("PR creation failed");
  });
});

describe("PrePrWorkspaceView — refresh", () => {
  test("clicking refresh calls refreshAzure and surfaces a failure as a toast", async () => {
    const appStore = useAppStore();
    vi.spyOn(appStore, "refreshAzure").mockRejectedValue(new Error("offline"));
    const wrapper = mountWizard({});
    await flushPromises();

    await wrapper.find("button.button--ghost.button--small").trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Refresh failed");
  });
});
