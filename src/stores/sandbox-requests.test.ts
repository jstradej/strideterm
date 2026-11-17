import { beforeEach, describe, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { sandboxDecisionSchema } from "../../electron/backend/ipc-schemas.js";
import type { SandboxDeniedRequest } from "../../electron/shared/sandbox.js";

const { fireNotificationAlert } = vi.hoisted(() => ({ fireNotificationAlert: vi.fn() }));
vi.mock("../composables/useNotificationSound.js", () => ({ fireNotificationAlert }));

const saveWorkspace = vi.fn(async (_workspace: unknown) => undefined);
const appState = {
  myActiveProfileId: "default",
  saveWorkspace,
  payload: {
    appState: {
      workspaces: [
        {
          id: "w1",
          name: "demo",
          profileId: "default",
          sandboxAllowedDomains: ["pypi.org"],
          panels: [
            { id: "p1", title: "🤖 Claude Code" },
            { id: "p2", title: "" },
          ],
        },
      ],
    },
  } as { appState: { workspaces: Array<Record<string, unknown>> } } | null,
};
vi.mock("./app.js", () => ({ useAppStore: () => appState }));

import { useNotificationStore } from "./notifications.js";
import { useSandboxRequestsStore } from "./sandbox-requests.js";

const request = (overrides: Partial<SandboxDeniedRequest> = {}): SandboxDeniedRequest => ({
  id: "req-1",
  workspaceId: "w1",
  sessionId: "w1:p1",
  host: "api.datadoghq.com",
  port: 443,
  at: Date.now(),
  state: "pending",
  ...overrides,
});

function makeApi(overrides: Record<string, unknown> = {}) {
  const handlers: { denied?: (r: SandboxDeniedRequest) => void; settled?: (r: SandboxDeniedRequest) => void } = {};
  const api = {
    onSandboxDenied: vi.fn((handler: (r: SandboxDeniedRequest) => void) => {
      handlers.denied = handler;
      return () => undefined;
    }),
    onSandboxDeniedSettled: vi.fn((handler: (r: SandboxDeniedRequest) => void) => {
      handlers.settled = handler;
      return () => undefined;
    }),
    listSandboxRequests: vi.fn(async () => [] as SandboxDeniedRequest[]),
    decideSandboxRequest: vi.fn(async (_payload: unknown) => ({ ok: true, remembered: "" })),
    ...overrides,
  };
  return { api, handlers };
}

async function started(overrides: Record<string, unknown> = {}) {
  const { api, handlers } = makeApi(overrides);
  const store = useSandboxRequestsStore();
  await store.start(api as never);
  return { api, handlers, store, notifications: useNotificationStore() };
}

describe("sandbox requests in the Notification Center", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    fireNotificationAlert.mockClear();
    saveWorkspace.mockClear();
    appState.payload = {
      appState: {
        workspaces: [
          {
            id: "w1",
            name: "demo",
            profileId: "default",
            sandboxAllowedDomains: ["pypi.org"],
            panels: [
              { id: "p1", title: "🤖 Claude Code" },
              { id: "p2", title: "" },
            ],
          },
        ],
      },
    };
  });

  test("replays an expired request silently so it can be allowed for the next run", async () => {
    const { store, api } = await started({ listSandboxRequests: vi.fn(async () => [request({ state: "expired" })]) });
    expect(store.records[0]?.outcome).toBe("expired");
    expect(fireNotificationAlert).not.toHaveBeenCalled();
    await store.allowForWorkspace(api as never, store.records[0]!.key);
    expect(api.decideSandboxRequest).toHaveBeenCalledWith({ requestId: "req-1", allow: true, remember: true });
    expect(store.records[0]?.outcome).toBe("added");
  });

  test("a pending request is one entry that names the tab and workspace, with a toast and an alert", async () => {
    const { handlers, notifications } = await started();
    handlers.denied!(request());

    expect(notifications.sessions).toHaveLength(1);
    const thread = notifications.sessions[0]!;
    expect(thread.category).toBe("sandbox");
    expect(thread.workspaceId).toBe("w1");
    expect(thread.state).toBe("waiting");
    expect(thread.events[0]!.kind).toBe("question");
    expect(thread.events[0]!.body).toContain("Claude Code · demo");
    expect(thread.events[0]!.body).toContain("api.datadoghq.com");

    const toast = notifications.latestToast!;
    expect(toast.category).toBe("sandbox");
    expect(toast.kind).toBe("question");
    expect(toast.meta?.threadId).toBe(thread.id);
    expect(toast.sourceAlertId).toBeUndefined();
    expect(fireNotificationAlert).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Claude Code · demo"),
      expect.objectContaining({ kind: "question" }),
    );
  });

  test("a second request for the same host in the same workspace while pending adds no entry", async () => {
    const { handlers, notifications, store } = await started();
    handlers.denied!(request());
    handlers.denied!(request({ id: "req-2", sessionId: "w1:p2" }));
    handlers.denied!(request({ id: "req-3", host: "other.example.org" }));

    expect(store.records.map((record) => record.host)).toEqual(["other.example.org", "api.datadoghq.com"]);
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0]!.events).toHaveLength(2);
    expect(fireNotificationAlert).toHaveBeenCalledTimes(2);
  });

  test("one answer covers every request the same destination raised, and the payloads fit the real schema", async () => {
    const { api, handlers, store } = await started();
    handlers.denied!(request());
    handlers.denied!(request({ id: "req-2" }));
    await store.decide(api as never, store.records[0]!.key, "workspace");

    expect(api.decideSandboxRequest.mock.calls.map(([payload]) => payload)).toEqual([
      { requestId: "req-1", allow: true, remember: true },
      { requestId: "req-2", allow: true, remember: true },
    ]);
    for (const [payload] of api.decideSandboxRequest.mock.calls) {
      expect(sandboxDecisionSchema.safeParse(payload).success).toBe(true);
    }
    expect(store.records[0]!.outcome).toBe("allowed-workspace");
  });

  test.each([
    ["workspace", "Allowed for this workspace", "allowed-workspace"],
    ["once", "Allowed once", "allowed-once"],
    ["deny", "Refused", "refused"],
  ] as const)("deciding %s turns the entry into its outcome and resolves the thread", async (choice, text, outcome) => {
    const { api, handlers, store, notifications } = await started();
    handlers.denied!(request());
    await store.decide(api as never, store.records[0]!.key, choice);

    expect(store.records[0]!.outcome).toBe(outcome);
    const thread = notifications.sessions[0]!;
    expect(thread.events[0]!.title).toBe(text);
    expect(thread.events[0]!.kind).toBe("info");
    expect(thread.state).toBe("resolved");
  });

  test("an answer that the sandbox settles first is read from the choice that was clicked", async () => {
    let release!: () => void;
    const { api, handlers, store } = await started({
      decideSandboxRequest: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true, remembered: "" });
          }),
      ),
    });
    handlers.denied!(request());
    const pending = store.decide(api as never, store.records[0]!.key, "once");
    handlers.settled!(request({ state: "allowed" }));
    expect(store.records[0]!.outcome).toBe("allowed-once");
    release();
    await pending;
    expect(store.records[0]!.outcome).toBe("allowed-once");
  });

  test("a request decided elsewhere shows whether the workspace now allows the destination", async () => {
    const { handlers, store } = await started();
    handlers.denied!(request({ host: "pypi.org" }));
    handlers.settled!(request({ host: "pypi.org", state: "allowed" }));
    expect(store.records[0]!.outcome).toBe("allowed-workspace");

    handlers.denied!(request({ id: "req-2" }));
    handlers.settled!(request({ id: "req-2", state: "allowed" }));
    expect(store.records[0]!.outcome).toBe("allowed-once");
  });

  test("an expired request becomes 'Refused — no answer in time' and the thread is left unacknowledged", async () => {
    const { handlers, store, notifications } = await started();
    handlers.denied!(request());
    handlers.denied!(request({ id: "req-2" }));
    handlers.settled!(request({ state: "expired" }));
    expect(store.records[0]!.outcome).toBe("pending");
    handlers.settled!(request({ id: "req-2", state: "expired" }));

    expect(store.records[0]!.outcome).toBe("expired");
    expect(notifications.sessions[0]!.events[0]!.title).toBe("Refused — no answer in time");
    expect(notifications.sessions[0]!.state).toBe("finished");
  });

  test("allowing an expired destination afterwards asks the runtime to remember it, never saves the workspace", async () => {
    const { api, handlers, store, notifications } = await started();
    handlers.denied!(request());
    handlers.settled!(request({ state: "expired" }));
    await store.allowForWorkspace(api as never, store.records[0]!.key);

    expect(api.decideSandboxRequest).toHaveBeenCalledWith({ requestId: "req-1", allow: true, remember: true });
    expect(sandboxDecisionSchema.safeParse(api.decideSandboxRequest.mock.calls[0]![0]).success).toBe(true);
    expect(saveWorkspace).not.toHaveBeenCalled();
    expect(store.records[0]!.outcome).toBe("added");
    expect(notifications.sessions[0]!.state).toBe("resolved");
  });

  test("a refused late allow (an IP address, a full list) reaches the user as an error toast and keeps the action", async () => {
    const decideSandboxRequest = vi.fn(async () => {
      throw new Error("Only a named host can be remembered for the workspace, not an IP address.");
    });
    const { api, handlers, store, notifications } = await started({ decideSandboxRequest });
    handlers.denied!(request({ host: "10.1.2.3" }));
    handlers.settled!(request({ host: "10.1.2.3", state: "denied" }));
    await store.allowForWorkspace(api as never, store.records[0]!.key);

    expect(notifications.persistentToasts.map((toast) => toast.title)).toContain("Could not allow the destination");
    expect(store.records[0]!.outcome).toBe("refused");
    expect(store.records[0]!.busy).toBe(false);
  });

  test("a failed answer shows an error toast and keeps the buttons; one the sandbox gave up on becomes expired", async () => {
    const decideSandboxRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce(new Error("This request has expired: the sandbox already refused the connection."));
    const { api, handlers, store, notifications } = await started({ decideSandboxRequest });
    const showError = vi.spyOn(notifications, "showError");
    handlers.denied!(request());

    await store.decide(api as never, store.records[0]!.key, "deny");
    expect(showError).toHaveBeenCalledTimes(1);
    expect(store.records[0]!.outcome).toBe("pending");
    expect(store.records[0]!.busy).toBe(false);

    await store.decide(api as never, store.records[0]!.key, "deny");
    expect(showError).toHaveBeenCalledTimes(2);
    expect(store.records[0]!.outcome).toBe("expired");
  });

  test("repeated refusals of one host replace each other instead of piling up", async () => {
    const { handlers, store, notifications } = await started();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      handlers.denied!(request({ id: `req-${attempt}` }));
      handlers.settled!(request({ id: `req-${attempt}`, state: "expired" }));
    }
    expect(store.records).toHaveLength(1);
    expect(store.records[0]!.ids).toEqual(["req-3"]);
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0]!.events.length).toBeLessThanOrEqual(20);
  });

  describe("label fallbacks", () => {
    test("a panel without a usable title names the workspace, an unknown panel too", async () => {
      const { handlers, store } = await started();
      handlers.denied!(request({ id: "a", sessionId: "w1:p2", host: "a.example.org" }));
      handlers.denied!(request({ id: "b", sessionId: "w1:gone", host: "b.example.org" }));
      expect(store.records.map((record) => record.label)).toEqual(["demo", "demo"]);
    });

    test("an unknown workspace is 'An isolated tab' and belongs to the profile on screen", async () => {
      const { handlers, store, notifications } = await started();
      handlers.denied!(request({ workspaceId: "ghost", sessionId: "ghost:p1" }));
      expect(store.records[0]!.label).toBe("An isolated tab");
      expect(notifications.sessions[0]!.meta?.profileId).toBe("default");
    });
  });

  test("a remote transport has none of the sandbox events and creates nothing", async () => {
    const store = useSandboxRequestsStore();
    await store.start({} as never);
    expect(store.records).toHaveLength(0);
    expect(useNotificationStore().sessions).toHaveLength(0);
  });

  test("requests that were already waiting when the window opened become entries", async () => {
    const { store, notifications } = await started({
      listSandboxRequests: vi.fn(async () => [request({ host: "late.example.org", port: 8443 })]),
    });
    expect(store.records[0]!.destination).toBe("late.example.org:8443");
    expect(notifications.sessions).toHaveLength(1);
  });
});
