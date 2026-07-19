import { describe, expect, test, vi } from "vitest";
import { reactive } from "vue";
import { mount, flushPromises } from "@vue/test-utils";

const azureCreatePullRequest = vi.fn();

vi.mock("../../../stores/git-ui.js", () => ({
  useGitUiStore: () => ({
    azureCreatePullRequest,
    remoteBranches: [],
    remoteBranchesLoading: false,
    azureListRemoteBranches: vi.fn(),
  }),
}));

import GitPullRequestTab from "./GitPullRequestTab.vue";

function mountTab(gitUi: Record<string, unknown>) {
  return mount(GitPullRequestTab, {
    props: {
      workspaceId: "ws1",
      snapshot: { branch: "feature/x", aheadCount: 1, upstream: "origin/feature/x", dirty: false, branchNames: [] },
      gitUi,
      baseBranch: "main",
      hasAzureConnection: true,
      activeConnectionId: "conn-1",
      activeConnectionLabel: "Azure — org/project",
    },
  });
}

async function fillAndSubmit(wrapper: ReturnType<typeof mountTab>) {
  const inputs = wrapper.findAll("input.git-pr-form__input");
  await inputs[1].setValue("My PR title");
  await wrapper.find(".git-operation-actions button").trigger("click");
  await flushPromises();
}

describe("GitPullRequestTab — create PR submission", () => {
  test("reports success via the shared submitPullRequest result", async () => {
    const gitUi = reactive<Record<string, unknown>>({ lastResult: null });
    azureCreatePullRequest.mockImplementation(async () => {
      gitUi.lastResult = { ok: true, pullRequestId: 42, url: "https://dev.azure.com/pr/42" };
    });

    const wrapper = mountTab(gitUi);
    await fillAndSubmit(wrapper);

    expect(azureCreatePullRequest).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ title: "My PR title", sourceBranch: "feature/x", connectionId: "conn-1" }),
    );
    const hint = wrapper.find(".git-pr-form .git-card__hint");
    expect(hint.text()).toContain("PR #42 created.");
    expect(hint.find("a").attributes("href")).toBe("https://dev.azure.com/pr/42");
  });

  test("reports failure via the shared submitPullRequest result", async () => {
    const gitUi = reactive<Record<string, unknown>>({ lastResult: null });
    azureCreatePullRequest.mockImplementation(async () => {
      gitUi.lastResult = { ok: false, summary: "A pull request already exists for this branch." };
    });

    const wrapper = mountTab(gitUi);
    await fillAndSubmit(wrapper);

    const hint = wrapper.find(".git-pr-form .git-card__hint--warning");
    expect(hint.text()).toContain("A pull request already exists for this branch.");
  });
});
