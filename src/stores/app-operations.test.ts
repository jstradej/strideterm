import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { ref, shallowRef, computed } from "vue";
import { createWorkspaceActions } from "./app-workspace-actions.js";
import { useNotificationStore } from "./notifications.js";
import type { OperationFinished } from "../../electron/shared/operation-events.js";

interface AnyApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

function makeActions(profileId = "profile-a") {
  const payload = shallowRef<AnyApi>({
    appState: { workspaces: [{ id: "ws-task", name: "Implement plan" }], activeWorkspaceId: "" },
  });
  const myActiveProfileId = ref<string | null>(profileId);
  const ctx = {
    payload,
    activeViewId: ref(null),
    activeSessionId: ref(null),
    myActiveWorkspaceId: computed(() => ""),
    myActiveProfileId,
    isRemoteTransport: ref(false),
    splitGroup: ref(null),
    hiddenViewIds: ref(new Set<string>()),
    workspaceTabs: computed(() => []),
    overlay: ref(null),
    overlayProps: ref({}),
    optimisticallyDeletedIds: ref(new Set<string>()),
    getApi: () => ({}),
    adoptPayload: () => {},
    withSuppressedBroadcast: async (fn: () => Promise<void>) => fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { actions: createWorkspaceActions(ctx as any), myActiveProfileId };
}

const started: OperationFinished = {
  operationId: "op-1",
  kind: "task.provision",
  profileId: "profile-a",
  workspaceId: "ws-task",
  finishedAt: "2026-10-17T10:00:00.000Z",
  result: { workspaceId: "ws-task", taskId: "t1", name: "Implement plan", awaitingUserInTerminal: ["worker", "judge"] },
};
const failed: OperationFinished = {
  operationId: "op-2",
  kind: "task.provision",
  profileId: "profile-a",
  finishedAt: "2026-10-17T10:01:00.000Z",
  error: { code: "checkout_conflict", message: "Branch already exists" },
};

describe("operation:finished reporting", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
  });

  it("reports a live task.provision success once, naming the trust dialog panels", () => {
    const { actions } = makeActions();
    actions.reportOperationFinished(started);
    actions.reportOperationFinished(started);
    const events = useNotificationStore().sessions.flatMap((s: AnyApi) => s.events);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Task agents started");
    expect(events[0].body).toContain("Worker and Judge");
    expect(events[0].body).toContain("trust dialog");
    expect(events[0].body).toContain("not mean the implementation is done");
  });

  it("reports an error outcome as an error notification with the message", () => {
    const { actions } = makeActions();
    actions.reportOperationFinished(failed);
    const events = useNotificationStore().sessions.flatMap((s: AnyApi) => s.events);
    expect(events[0].title).toBe("Task agents could not be started");
    expect(events[0].body).toBe("Branch already exists");
    expect(events[0].kind).toBe("error");
  });

  it("takes results from the payload snapshot and ignores malformed entries", () => {
    const { actions } = makeActions();
    actions.reportOperationRuns([started, { operationId: "" }, "x"]);
    expect(useNotificationStore().sessions.flatMap((s: AnyApi) => s.events)).toHaveLength(1);
  });

  it("skips another profile and reports it after the user switches to it", () => {
    const { actions, myActiveProfileId } = makeActions("profile-b");
    actions.reportOperationFinished(started);
    expect(useNotificationStore().sessions).toHaveLength(0);
    myActiveProfileId.value = "profile-a";
    actions.reportOperationRuns([started]);
    expect(useNotificationStore().sessions.flatMap((s: AnyApi) => s.events)).toHaveLength(1);
  });

  it("does not re-show a snapshot result after reload even when the notification was removed", () => {
    const first = makeActions();
    first.actions.reportOperationFinished(started);
    useNotificationStore().clearAll();
    setActivePinia(createPinia());
    const reloaded = makeActions();
    reloaded.actions.reportOperationRuns([started]);
    expect(useNotificationStore().sessions).toHaveLength(0);
  });

  it("keeps the stored list bounded", () => {
    const { actions } = makeActions();
    for (let i = 0; i < 230; i += 1) {
      actions.reportOperationFinished({ ...started, operationId: `op-${i}` });
    }
    const stored = JSON.parse(window.localStorage.getItem("strideterm-operations-notified-ids") || "[]");
    expect(stored).toHaveLength(200);
    expect(stored.at(-1)).toBe("op-229");
  });
});
