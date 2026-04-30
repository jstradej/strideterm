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
    phase: "worker",
    lastSavedAt: Date.now(),
    worker: { providerId: "claude", model: "sonnet" },
    judge: { providerId: "claude", model: "opus" },
    artifacts: {
      cwd: "/tmp/auth",
      taskDir: "/tmp/auth/.strideterm/tasks/task-1",
      handoffPath: "/tmp/auth/.strideterm/tasks/task-1/HANDOFF.md",
      verdictPath: "/tmp/auth/.strideterm/tasks/task-1/verdict.json",
      workLockPath: "/tmp/auth/.strideterm/tasks/task-1/WORK_LOCK",
    },
    fsState: "neither",
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
      makeCandidate({ workspaceId: "ws-b", workspaceName: "Billing", currentRound: 1, maxRounds: 4, phase: "judge" }),
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

  test("shows fs-state label per candidate", () => {
    seedStore([
      makeCandidate({ workspaceId: "ws-a", fsState: "neither" }),
      makeCandidate({ workspaceId: "ws-b", fsState: "handoff-exists" }),
    ]);
    const wrapper = mount(TaskRecoveryDialog);
    expect(wrapper.text()).toContain("no output yet");
    expect(wrapper.text()).toContain("handoff written");
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
