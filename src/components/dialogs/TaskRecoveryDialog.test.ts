import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TaskRecoveryDialog from "./TaskRecoveryDialog.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { RecoveryCandidate, RecoveryOutcome } from "../../../electron/shared/types/state.js";

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.removeItem("strideterm-notifications-v2");
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
  failing: string[] = [],
) {
  const store = useAppStore();
  store.recoveryCandidates = [...candidates];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).payload = { appState: { profiles } };
  // Mock resolveTaskRecovery to mirror the real wrapper: report a per-workspace
  // outcome and trim only the SETTLED candidates from the reactive list, so a
  // failed one stays and the dialog advances naturally over the rest.
  const failed = new Set(failing);
  store.resolveTaskRecovery = vi.fn(async (decisions: Record<string, "continue" | "fresh" | "skip">) => {
    const outcomes: Record<string, RecoveryOutcome> = {};
    for (const [id, choice] of Object.entries(decisions)) {
      if (failed.has(id)) outcomes[id] = "failed";
      else outcomes[id] = choice === "skip" ? "skipped" : choice === "fresh" ? "fresh" : "continued";
    }
    const settled = new Set(Object.keys(outcomes).filter((id) => outcomes[id] !== "failed"));
    store.recoveryCandidates = store.recoveryCandidates.filter((c) => !settled.has(c.workspaceId));
    return { ok: Object.values(outcomes).every((outcome) => outcome !== "failed"), outcomes, unanswered: [] };
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

  test("Resume failure surfaces an error toast and re-enables the buttons", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a" })]);
    store.resolveTaskRecovery = vi.fn().mockRejectedValueOnce(new Error("agent spawn failed"));
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const resumeBtn = wrapper.findAll("button").find((b) => b.text().startsWith("Resume") && b.text() !== "Resume all");
    await resumeBtn!.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Task recovery decision failed");
    expect(notifications.sessions[0].events[0].body).toBe("agent spawn failed");

    // Busy state must reset so the buttons are usable again.
    expect(wrapper.find(".button--ghost").attributes("disabled")).toBeUndefined();
  });

  test("Skip all failure surfaces an error toast", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a" }), makeCandidate({ workspaceId: "ws-b" })]);
    store.resolveTaskRecovery = vi.fn().mockRejectedValueOnce(new Error("db locked"));
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const skipAllBtn = wrapper.findAll("button").find((b) => b.text() === "Skip all");
    await skipAllBtn!.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Skip all failed");
    expect(notifications.sessions[0].events[0].body).toBe("db locked");
  });

  test("Resume all failure surfaces an error toast", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a" }), makeCandidate({ workspaceId: "ws-b" })]);
    store.resolveTaskRecovery = vi.fn().mockRejectedValueOnce(new Error("agent pool exhausted"));
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const resumeAllBtn = wrapper.findAll("button").find((b) => b.text() === "Resume all");
    await resumeAllBtn!.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Resume all failed");
    expect(notifications.sessions[0].events[0].body).toBe("agent pool exhausted");
  });

  // V4 review, §"P1 — task recovery hlásí úspěch", oprava 5. A resolved-but-
  // failed decision used to be indistinguishable from success: the promise
  // resolved, so `runWithToast` said nothing and the candidate was dropped
  // locally even though the agent never came back.
  test("a Resume the backend reports as failed keeps the candidate and names it in a toast", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a", workspaceName: "Auth" })], [], ["ws-a"]);
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const resumeBtn = wrapper.findAll("button").find((b) => b.text().startsWith("Resume") && b.text() !== "Resume all");
    await resumeBtn!.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.persistentToasts).toHaveLength(1);
    expect(notifications.persistentToasts[0].title).toBe("Task could not be recovered");
    expect(notifications.persistentToasts[0].body).toContain("Auth");
    // The candidate is still listed, so the dialog stays open on it.
    expect(store.recoveryCandidates.map((c) => c.workspaceId)).toEqual(["ws-a"]);
    expect(wrapper.text()).toContain("Auth");
    // The buttons are usable again for a retry or a Skip.
    expect(wrapper.find(".button--ghost").attributes("disabled")).toBeUndefined();
  });

  test("a mixed Resume all reports the partial failure and keeps only the failed candidate", async () => {
    const store = seedStore(
      [
        makeCandidate({ workspaceId: "ws-a", workspaceName: "Auth" }),
        makeCandidate({ workspaceId: "ws-b", workspaceName: "Billing" }),
      ],
      [],
      ["ws-b"],
    );
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const resumeAllBtn = wrapper.findAll("button").find((b) => b.text() === "Resume all");
    await resumeAllBtn!.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.persistentToasts).toHaveLength(1);
    expect(notifications.persistentToasts[0].body).toContain("Billing");
    expect(notifications.persistentToasts[0].body).not.toContain("Auth");
    expect(store.recoveryCandidates.map((c) => c.workspaceId)).toEqual(["ws-b"]);
  });

  // V5 review, §"P2 — recovery kontrakt končí před transportní hranicí",
  // oprava 4: a response the store could not read an outcome from is a
  // PROTOCOL failure. The candidate stays and the user is told, rather than
  // the dialog closing as if the task had come back.
  test("a decision the backend never answered is reported and keeps the candidate", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a", workspaceName: "Auth" })]);
    store.resolveTaskRecovery = vi.fn(async () => ({ ok: false, outcomes: {}, unanswered: ["ws-a"] }));
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const resumeBtn = wrapper.findAll("button").find((b) => b.text().startsWith("Resume") && b.text() !== "Resume all");
    await resumeBtn!.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.persistentToasts).toHaveLength(1);
    expect(notifications.persistentToasts[0].title).toBe("Recovery answered nothing");
    expect(notifications.persistentToasts[0].body).toContain("Auth");
    expect(store.recoveryCandidates.map((c) => c.workspaceId)).toEqual(["ws-a"]);
    expect(wrapper.find(".button--ghost").attributes("disabled")).toBeUndefined();
  });

  test("a 'stale' decision settles quietly — another window already handled it", async () => {
    const store = seedStore([makeCandidate({ workspaceId: "ws-a", workspaceName: "Auth" })]);
    store.resolveTaskRecovery = vi.fn(async () => {
      store.recoveryCandidates = [];
      return { ok: true, outcomes: { "ws-a": "stale" as const }, unanswered: [] };
    });
    const onClose = vi.fn();
    const wrapper = mount(TaskRecoveryDialog, { props: { onClose } });
    await flushPromises();

    const resumeBtn = wrapper.findAll("button").find((b) => b.text().startsWith("Resume") && b.text() !== "Resume all");
    await resumeBtn!.trigger("click");
    await flushPromises();

    expect(useNotificationStore().persistentToasts).toHaveLength(0);
    expect(store.recoveryCandidates).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  test("a fully successful batch reports nothing extra", async () => {
    seedStore([makeCandidate({ workspaceId: "ws-a" }), makeCandidate({ workspaceId: "ws-b" })]);
    const wrapper = mount(TaskRecoveryDialog);
    await flushPromises();

    const resumeAllBtn = wrapper.findAll("button").find((b) => b.text() === "Resume all");
    await resumeAllBtn!.trigger("click");
    await flushPromises();

    expect(useNotificationStore().persistentToasts).toHaveLength(0);
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
