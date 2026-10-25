import { beforeEach, describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import GitOperationCard from "./GitOperationCard.vue";

beforeEach(() => setActivePinia(createPinia()));

describe("GitOperationCard push diagnostics", () => {
  test("labels classified long-operation results", () => {
    const wrapper = mount(GitOperationCard, {
      props: {
        workspaceId: "ws-1",
        snapshot: {},
        gitUi: {
          lastResult: {
            ok: false,
            summary: "Fetch completed, but rebase was blocked.",
            classification: "partial",
          },
        },
      },
    });

    expect(wrapper.get('[data-testid="operation-classification"]').text()).toBe("Partially completed");
  });

  test("shows live pre-push output and retains hook failure diagnostics after completion", async () => {
    const wrapper = mount(GitOperationCard, {
      props: {
        workspaceId: "ws-push-hook",
        snapshot: { operationState: { inProgress: false, conflicts: [] } },
        gitUi: {
          busyAction: "push",
          busyPhase: "Pushing…",
          pushProgress: "Running pre-push hook…\nchecking types…\n",
        },
      },
    });

    expect(wrapper.get('[data-testid="push-progress"]').text()).toContain("Running pre-push hook…");
    expect(wrapper.get('[data-testid="push-progress"]').text()).toContain("checking types…");

    await wrapper.setProps({
      gitUi: {
        busyAction: "",
        busyPhase: "",
        pushProgress: "",
        lastResult: {
          ok: false,
          summary: "Push failed.",
          warnings: ["The pre-push hook rejected the update."],
          rawOutput: "pre-push hook: typecheck failed",
        },
      },
    } as never);

    expect(wrapper.find('[data-testid="push-progress"]').exists()).toBe(false);
    expect(wrapper.get(".git-operation-banner--error").text()).toContain("The pre-push hook rejected the update.");
    expect(wrapper.get(".git-operation-banner--error pre").text()).toContain("pre-push hook: typecheck failed");
  });
});
