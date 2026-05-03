import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
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
  store.recoveryCandidates = [...candidates];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).payload = { appState: { profiles } };
  // Mock resolveTaskRecovery to mirror the real wrapper: trim resolved
  // candidates from the reactive list so the dialog advances naturally.
  store.resolveTaskRecovery = vi.fn(async (decisions: Record<string, "continue" | "fresh" | "skip">) => {
    const decided = new Set(Object.keys(decisions));
    store.recoveryCandidates = store.recoveryCandidates.filter((c) => !decided.has(c.workspaceId));
  });
  store.activateWorkspace = vi.fn().mockResolvedValue(undefined);
  return store;
}

describe("TaskRecoveryDialog", () => {
  test("renders the head candidate's name, round, and state label", () => {
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
    // Sequential mode: only the first candidate is visible
    expect(wrapper.text()).toContain("Auth");
    expect(wrapper.text()).not.toContain("Billing");
    expect(wrapper.text()).toContain("3/8");
    expect(wrapper.text()).toContain("Worker running");
  });

  test("shows position indicator when more than one candidate is queued", () => {
    seedStore([
      makeCandidate({ workspaceId: "ws-a" }),
      makeCandidate({ workspaceId: "ws-b" }),
      makeCandidate({ workspaceId: "ws-c" }),
    ]);
    const wrapper = mount(TaskRecoveryDialog);
    expect(wrapper.text()).toContain("Task 1 of 3");
  });

  test("hides position indicator and per-batch buttons when only one candidate", () => {
    seedStore([makeCandidate({ workspaceId: "ws-a" })]);
    const wrapper = mount(TaskRecoveryDialog);
    expect(wrapper.text()).not.toContain("Task 1 of");
    const labels = wrapper.findAll("button").map((b) => b.text());
    expect(labels).not.toContain("Resume all");
    expect(labels).not.toContain("Skip all");
  });

  test("activates the head candidate's workspace on mount", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a" }), makeCandidate({ workspaceId: "ws-b" })]);
    mount(TaskRecoveryDialog);
    await flushPromises();
    expect(store.activateWorkspace).toHaveBeenCalledWith("ws-a");
  });

  test("Resume submits one decision and advances to the next candidate", async () => {
    const store = seedStore([
      makeCandidate({ workspaceId: "ws-a", workspaceName: "Auth" }),
      makeCandidate({ workspaceId: "ws-b", workspaceName: "Billing" }),
    ]);
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const resumeBtn = wrapper.findAll("button").find((b) => b.text().startsWith("Resume") && b.text() !== "Resume all");
    expect(resumeBtn, "Resume button must exist").toBeTruthy();
    await resumeBtn!.trigger("click");
    await flushPromises();

    expect(store.resolveTaskRecovery).toHaveBeenCalledWith({ "ws-a": "continue" });
    // Workspace switched to the next candidate
    expect(store.activateWorkspace).toHaveBeenCalledWith("ws-b");
    // UI now shows the second candidate
    expect(wrapper.text()).toContain("Billing");
    expect(wrapper.text()).toContain("Task 2 of 2");
  });

  test("Skip submits skip and advances", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a" }), makeCandidate({ workspaceId: "ws-b" })]);
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const skipBtn = wrapper.findAll("button").find((b) => b.text() === "Skip");
    await skipBtn!.trigger("click");
    await flushPromises();

    expect(store.resolveTaskRecovery).toHaveBeenCalledWith({ "ws-a": "skip" });
    expect(store.activateWorkspace).toHaveBeenLastCalledWith("ws-b");
  });

  test("Restart submits fresh and advances", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a" }), makeCandidate({ workspaceId: "ws-b" })]);
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const restartBtn = wrapper.findAll("button").find((b) => b.text() === "Restart");
    await restartBtn!.trigger("click");
    await flushPromises();

    expect(store.resolveTaskRecovery).toHaveBeenCalledWith({ "ws-a": "fresh" });
    expect(store.activateWorkspace).toHaveBeenLastCalledWith("ws-b");
  });

  test("closes dialog after the last candidate is decided", async () => {
    seedStore([makeCandidate({ workspaceId: "ws-a" })]);
    const onClose = vi.fn();
    const wrapper = mount(TaskRecoveryDialog, { props: { onClose } });
    await flushPromises();

    const resumeBtn = wrapper.findAll("button").find((b) => b.text().startsWith("Resume"));
    await resumeBtn!.trigger("click");
    await flushPromises();

    expect(onClose).toHaveBeenCalled();
  });

  test("Resume all dispatches continue for every remaining candidate in one call", async () => {
    const store = seedStore([
      makeCandidate({ workspaceId: "ws-a" }),
      makeCandidate({ workspaceId: "ws-b" }),
      makeCandidate({ workspaceId: "ws-c" }),
    ]);
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const resumeAllBtn = wrapper.findAll("button").find((b) => b.text() === "Resume all");
    expect(resumeAllBtn, "Resume all button must exist").toBeTruthy();
    await resumeAllBtn!.trigger("click");
    await flushPromises();

    expect(store.resolveTaskRecovery).toHaveBeenCalledWith({
      "ws-a": "continue",
      "ws-b": "continue",
      "ws-c": "continue",
    });
  });

  test("Skip all dispatches skip for every remaining candidate", async () => {
    const store = seedStore([
      makeCandidate({ workspaceId: "ws-a" }),
      makeCandidate({ workspaceId: "ws-b" }),
      makeCandidate({ workspaceId: "ws-c" }),
    ]);
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const skipAllBtn = wrapper.findAll("button").find((b) => b.text() === "Skip all");
    await skipAllBtn!.trigger("click");
    await flushPromises();

    expect(store.resolveTaskRecovery).toHaveBeenCalledWith({
      "ws-a": "skip",
      "ws-b": "skip",
      "ws-c": "skip",
    });
  });

  test("header Close button skips all remaining and dismisses", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a" }), makeCandidate({ workspaceId: "ws-b" })]);
    const onClose = vi.fn();
    const wrapper = mount(TaskRecoveryDialog, { props: { onClose } });
    await flushPromises();

    // The header Close button is the very first ghost button
    const closeBtn = wrapper.find(".dialog__header .button--ghost");
    await closeBtn.trigger("click");
    await flushPromises();

    expect(store.resolveTaskRecovery).toHaveBeenCalledWith({ "ws-a": "skip", "ws-b": "skip" });
    expect(onClose).toHaveBeenCalled();
  });

  test("shows profile badge for non-default profile when profile exists in store", async () => {
    seedStore(
      [makeCandidate({ workspaceId: "ws-a", profileId: "work" })],
      [
        { id: "default", name: "Default", color: "#4a9eff" },
        { id: "work", name: "Work", color: "#ffa424" },
      ],
    );
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();
    expect(wrapper.find(".recovery-item__profile").text()).toBe("Work");
  });
});
