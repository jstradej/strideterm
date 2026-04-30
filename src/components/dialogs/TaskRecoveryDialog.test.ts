import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TaskRecoveryDialog from "./TaskRecoveryDialog.vue";
import { useAppStore } from "../../stores/app.js";
import type { RecoveryCandidate } from "../../../electron/shared/types/state.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

function makeCandidate(overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    taskId: "task-1",
    workspaceId: "ws-1",
    workspaceName: "Auth Refactor",
    profileId: "default",
    currentRound: 3,
    maxRounds: 8,
    previousState: "running",
    ...overrides,
  };
}

function seedStore(
  candidates: RecoveryCandidate[],
  profiles: Array<{ id: string; name: string; color?: string }> = [],
) {
  const store = useAppStore();
  store.recoveryCandidates = candidates;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).payload = { appState: { profiles } };
  store.resolveTaskRecovery = vi.fn().mockResolvedValue(undefined);
  return store;
}

describe("TaskRecoveryDialog", () => {
  test("renders one row per candidate with name and round metadata", () => {
    seedStore([
      makeCandidate({ workspaceId: "ws-a", workspaceName: "Auth", currentRound: 3, maxRounds: 8 }),
      makeCandidate({
        workspaceId: "ws-b",
        workspaceName: "Billing",
        currentRound: 1,
        maxRounds: 4,
        previousState: "judge-evaluating",
      }),
    ]);
    const wrapper = mount(TaskRecoveryDialog);
    expect(wrapper.text()).toContain("Auth");
    expect(wrapper.text()).toContain("Billing");
    expect(wrapper.text()).toContain("3/8");
    expect(wrapper.text()).toContain("1/4");
    expect(wrapper.text()).toContain("Worker running");
    expect(wrapper.text()).toContain("Judge evaluating");
  });

  test("defaults all decisions to 'continue'", () => {
    seedStore([makeCandidate({ workspaceId: "ws-a" }), makeCandidate({ workspaceId: "ws-b" })]);
    const wrapper = mount(TaskRecoveryDialog);
    const inputs = wrapper.findAll<HTMLInputElement>("input[type='radio']:checked");
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect((input.element as HTMLInputElement).value).toBe("continue");
    }
  });

  test("shows previousState label per candidate", () => {
    seedStore([
      makeCandidate({ workspaceId: "ws-a", previousState: "running" }),
      makeCandidate({ workspaceId: "ws-b", previousState: "judge-evaluating" }),
    ]);
    const wrapper = mount(TaskRecoveryDialog);
    expect(wrapper.text()).toContain("Worker running");
    expect(wrapper.text()).toContain("Judge evaluating");
  });

  test("shows profile badge for non-default profile when profile exists in store", () => {
    seedStore(
      [makeCandidate({ workspaceId: "ws-a", profileId: "work" })],
      [
        { id: "default", name: "Default", color: "#4a9eff" },
        { id: "work", name: "Work", color: "#ffa424" },
      ],
    );
    const wrapper = mount(TaskRecoveryDialog);
    expect(wrapper.find(".recovery-item__profile").text()).toBe("Work");
  });

  test("Confirm dispatches resolveTaskRecovery with collected decisions", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a" }), makeCandidate({ workspaceId: "ws-b" })]);
    const onClose = vi.fn();
    const wrapper = mount(TaskRecoveryDialog, { props: { onClose } });

    // Switch ws-b to "skip"
    const skipRadios = wrapper.findAll<HTMLInputElement>("input[value='skip']");
    await skipRadios[1].setValue();

    await wrapper.find(".dialog__footer .button:not(.button--ghost)").trigger("click");
    await wrapper.vm.$nextTick();

    expect(store.resolveTaskRecovery).toHaveBeenCalledWith({ "ws-a": "continue", "ws-b": "skip" });
    // onClose runs after resolveTaskRecovery resolves
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).toHaveBeenCalled();
  });

  test("Resume all dispatches continue for every candidate, even ones the user toggled off", async () => {
    const store = seedStore([
      makeCandidate({ workspaceId: "ws-a" }),
      makeCandidate({ workspaceId: "ws-b" }),
      makeCandidate({ workspaceId: "ws-c" }),
    ]);
    const wrapper = mount(TaskRecoveryDialog);

    // User toggled ws-b to "skip" — Resume all must override that
    const skipRadios = wrapper.findAll<HTMLInputElement>("input[value='skip']");
    await skipRadios[1].setValue();

    const resumeAllBtn = wrapper.findAll("button").find((b) => b.text() === "Resume all");
    expect(resumeAllBtn, "Resume all button must exist").toBeTruthy();
    await resumeAllBtn!.trigger("click");
    // Resume all uses the same callback as Confirm so the wait is identical
    await new Promise((r) => setTimeout(r, 0));

    expect(store.resolveTaskRecovery).toHaveBeenCalledWith({
      "ws-a": "continue",
      "ws-b": "continue",
      "ws-c": "continue",
    });
  });

  test("Skip all dispatches skip for every candidate", async () => {
    const store = seedStore([
      makeCandidate({ workspaceId: "ws-a" }),
      makeCandidate({ workspaceId: "ws-b" }),
      makeCandidate({ workspaceId: "ws-c" }),
    ]);
    const wrapper = mount(TaskRecoveryDialog);

    await wrapper.find(".dialog__footer .button--ghost").trigger("click");
    await wrapper.vm.$nextTick();

    expect(store.resolveTaskRecovery).toHaveBeenCalledWith({
      "ws-a": "skip",
      "ws-b": "skip",
      "ws-c": "skip",
    });
  });
});
