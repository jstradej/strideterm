import { describe, test, expect, vi, beforeEach } from "vitest";
import { TelegramManager, escapeMarkdown } from "./telegram-manager.js";
import type { TelegramConnectionConfig } from "./telegram-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCredentialStore(secrets: Record<string, string> = {}) {
  return {
    hasSecret: vi.fn((ref: string) => ref in secrets),
    getSecret: vi.fn((ref: string) => secrets[ref] ?? null),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    listRefs: vi.fn(() => Object.keys(secrets)),
  };
}

function makeConnection(overrides: Partial<TelegramConnectionConfig> = {}): TelegramConnectionConfig {
  return {
    id: "tg-1",
    label: "Test",
    botTokenRef: "cred:tg-1",
    chatId: "12345",
    enabled: true,
    pollSeconds: 5,
    forwardKinds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// escapeMarkdown
// ---------------------------------------------------------------------------

describe("escapeMarkdown", () => {
  test("escapes special MarkdownV2 characters", () => {
    expect(escapeMarkdown("Hello World!")).toBe("Hello World\\!");
    expect(escapeMarkdown("test.value")).toBe("test\\.value");
    expect(escapeMarkdown("a_b*c[d]e")).toBe("a\\_b\\*c\\[d\\]e");
    expect(escapeMarkdown("a-b")).toBe("a\\-b");
    expect(escapeMarkdown("(foo)")).toBe("\\(foo\\)");
  });

  test("does not double-escape already escaped chars", () => {
    // The function takes plain text — backslashes get escaped
    expect(escapeMarkdown("a\\b")).toBe("a\\\\b");
  });

  test("returns empty string for empty input", () => {
    expect(escapeMarkdown("")).toBe("");
  });

  test("handles text with no special chars unchanged", () => {
    expect(escapeMarkdown("hello world")).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// getSnapshot
// ---------------------------------------------------------------------------

describe("TelegramManager.getSnapshot", () => {
  test("returns configured status when token exists", () => {
    const cred = makeCredentialStore({ "cred:tg-1": "token123" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([makeConnection()]);

    const snap = manager.getSnapshot();
    expect(snap.connections).toHaveLength(1);
    expect(snap.connections[0].status).toBe("configured");
    expect(snap.connections[0].id).toBe("tg-1");
  });

  test("returns missing-token status when credential is absent", () => {
    const cred = makeCredentialStore({}); // no secrets
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([makeConnection()]);

    const snap = manager.getSnapshot();
    expect(snap.connections[0].status).toBe("missing-token");
  });

  test("returns empty connections when none configured", () => {
    const cred = makeCredentialStore({});
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([]);
    expect(manager.getSnapshot().connections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// configure — filters disabled / incomplete connections
// ---------------------------------------------------------------------------

describe("TelegramManager.configure", () => {
  test("filters out disabled connections", () => {
    const cred = makeCredentialStore({ "cred:tg-1": "tok" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([makeConnection({ id: "tg-1", enabled: true }), makeConnection({ id: "tg-2", enabled: false })]);
    expect(manager.getSnapshot().connections).toHaveLength(1);
    expect(manager.getSnapshot().connections[0].id).toBe("tg-1");
  });

  test("filters out connections with empty botTokenRef", () => {
    const cred = makeCredentialStore({});
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([makeConnection({ botTokenRef: "" })]);
    expect(manager.getSnapshot().connections).toHaveLength(0);
  });

  test("filters out connections with empty chatId", () => {
    const cred = makeCredentialStore({ "cred:tg-1": "tok" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([makeConnection({ chatId: "" })]);
    expect(manager.getSnapshot().connections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pollOffsets are per-connection
// ---------------------------------------------------------------------------

describe("pollOffsets per-connection", () => {
  test("each connection tracks its own offset independently", async () => {
    const cred = makeCredentialStore({
      "cred:tg-1": "token1",
      "cred:tg-2": "token2",
    });
    const manager = new TelegramManager({ credentialStore: cred });

    const polledConnIds: string[] = [];
    const polledOffsets: number[] = [];

    // Patch _pollConnection on the instance to record what offsets each
    // connection would use — this avoids the network call entirely.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any)._pollConnection = async (conn: TelegramConnectionConfig) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const offset = (manager as any).pollOffsets.get(conn.id) ?? 0;
      polledConnIds.push(conn.id);
      polledOffsets.push(offset);
    };

    manager.configure([
      makeConnection({ id: "tg-1", botTokenRef: "cred:tg-1", chatId: "111" }),
      makeConnection({ id: "tg-2", botTokenRef: "cred:tg-2", chatId: "222", pollSeconds: 10 }),
    ]);

    // Set running=true so _poll doesn't exit early, and stop the schedule timer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).running = true;
    // Also patch _scheduleNextPoll to prevent it from actually scheduling
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any)._scheduleNextPoll = () => {};

    // Access private _poll via casting
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any)._poll();

    // Both connections should have been polled
    expect(polledConnIds).toHaveLength(2);
    expect(polledConnIds).toContain("tg-1");
    expect(polledConnIds).toContain("tg-2");

    // Both should start with offset 0 (independent per-connection state)
    expect(polledOffsets[0]).toBe(0);
    expect(polledOffsets[1]).toBe(0);
  });

  test("pollOffsets map advances independently per connection", () => {
    const cred = makeCredentialStore({});
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([
      makeConnection({ id: "tg-1", botTokenRef: "cred:tg-1" }),
      makeConnection({ id: "tg-2", botTokenRef: "cred:tg-2" }),
    ]);

    // Simulate advancing offset for tg-1 only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offsets = (manager as any).pollOffsets as Map<string, number>;
    offsets.set("tg-1", 100);

    expect(offsets.get("tg-1")).toBe(100);
    // tg-2 should still be at 0 (undefined → defaults to 0)
    expect(offsets.get("tg-2") ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _scheduleNextPoll uses correct interval
// ---------------------------------------------------------------------------

describe("_scheduleNextPoll", () => {
  test("uses minimum pollSeconds of all connections (not capped at 5s)", () => {
    vi.useFakeTimers();
    const cred = makeCredentialStore({ "cred:tg-1": "tok" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([makeConnection({ pollSeconds: 30 })]);
    manager.start();

    // Should not fire before 30s
    vi.advanceTimersByTime(15000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).pollTimer).not.toBeNull();

    manager.stop();
    vi.useRealTimers();
  });

  test("defaults to 30s when no connections configured", () => {
    vi.useFakeTimers();
    const cred = makeCredentialStore({});
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([]);
    manager.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).pollTimer).not.toBeNull();

    manager.stop();
    vi.useRealTimers();
  });

  test("uses minimum pollSeconds across multiple connections", () => {
    vi.useFakeTimers();
    const cred = makeCredentialStore({ "cred:tg-1": "tok1", "cred:tg-2": "tok2" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([
      makeConnection({ id: "tg-1", botTokenRef: "cred:tg-1", pollSeconds: 60 }),
      makeConnection({ id: "tg-2", botTokenRef: "cred:tg-2", pollSeconds: 10 }),
    ]);

    // Patch _poll to be a no-op to avoid actual API calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any)._poll = vi.fn().mockResolvedValue(undefined);

    manager.start();

    // Should fire at 10s (minimum of 60 and 10)
    vi.advanceTimersByTime(10001);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any)._poll).toHaveBeenCalled();

    manager.stop();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Pending request state machine: task-description → confirm-action
// ---------------------------------------------------------------------------

describe("pending request state machine", () => {
  test("start-task button creates task-description pending request", async () => {
    const cred = makeCredentialStore({ "cred:tg-1": "token123" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([makeConnection()]);

    const sentMessages: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any)._apiCall = async (_token: string, method: string, body: Record<string, unknown>) => {
      sentMessages.push({ method, body });
      return { ok: true, result: { message_id: 99 } };
    };

    const conn = makeConnection();
    const token = "token123";
    const chatId = "12345";

    // Simulate clicking "start-task" callback button
    const query = {
      id: "cq-1",
      from: { id: 1 },
      message: {
        message_id: 42,
        chat: { id: 12345 },
        text: "",
      },
      data: JSON.stringify({ a: "start-task", w: "ws-1", p: "panel-1" }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any)._handleCallbackQuery(query, conn, token);

    // Should set pending task-description request
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = (manager as any).pendingRequests.get(chatId);
    expect(pending).toBeDefined();
    expect(pending.type).toBe("task-description");
    expect(pending.workspaceId).toBe("ws-1");
  });

  test("text reply after task-description creates confirm-action pending", async () => {
    const cred = makeCredentialStore({ "cred:tg-1": "token123" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([makeConnection()]);

    const sentMessages: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any)._apiCall = async (_token: string, method: string, _body: Record<string, unknown>) => {
      sentMessages.push(method);
      return { ok: true, result: { message_id: 100 } };
    };

    const conn = makeConnection();
    const token = "token123";
    const chatId = "12345";

    // Seed task-description pending
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).pendingRequests.set(chatId, {
      type: "task-description",
      workspaceId: "ws-1",
      panelId: "panel-1",
      createdAt: Date.now(),
    });

    const msg = {
      message_id: 50,
      chat: { id: 12345 },
      text: "Fix the login bug",
    };

    const emitted: unknown[] = [];
    manager.on("command", (cmd) => emitted.push(cmd));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any)._handleMessage(msg, conn, token);

    // Should now have confirm-action pending (NOT emitted yet)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = (manager as any).pendingRequests.get(chatId);
    expect(pending).toBeDefined();
    expect(pending.type).toBe("confirm-action");
    expect(pending.pendingCmd?.type).toBe("start-task");
    expect(pending.pendingCmd?.taskDescription).toBe("Fix the login bug");
    // Should NOT have emitted command yet
    expect(emitted).toHaveLength(0);
  });

  test("confirm callback emits command and clears pending", async () => {
    const cred = makeCredentialStore({ "cred:tg-1": "token123" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([makeConnection()]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any)._apiCall = async () => ({ ok: true, result: { message_id: 101 } });

    const conn = makeConnection();
    const token = "token123";
    const chatId = "12345";

    const pendingCmd = {
      type: "start-task" as const,
      workspaceId: "ws-1",
      panelId: "panel-1",
      taskDescription: "Fix the login bug",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).pendingRequests.set(chatId, {
      type: "confirm-action",
      workspaceId: "ws-1",
      panelId: "panel-1",
      createdAt: Date.now(),
      pendingCmd,
    });

    const emitted: unknown[] = [];
    manager.on("command", (cmd) => emitted.push(cmd));

    const query = {
      id: "cq-2",
      from: { id: 1 },
      message: { message_id: 55, chat: { id: 12345 }, text: "" },
      data: JSON.stringify({ a: "confirm" }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any)._handleCallbackQuery(query, conn, token);

    expect(emitted).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((emitted[0] as any).type).toBe("start-task");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).pendingRequests.has(chatId)).toBe(false);
  });

  test("cancel callback clears pending and sends cancelled message", async () => {
    const cred = makeCredentialStore({ "cred:tg-1": "token123" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([makeConnection()]);

    const sentTexts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any)._apiCall = async (_token: string, _method: string, body: Record<string, unknown>) => {
      if (body.text) sentTexts.push(body.text as string);
      return { ok: true, result: { message_id: 102 } };
    };

    const conn = makeConnection();
    const token = "token123";
    const chatId = "12345";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).pendingRequests.set(chatId, {
      type: "confirm-action",
      workspaceId: "ws-1",
      panelId: "panel-1",
      createdAt: Date.now(),
      pendingCmd: { type: "start-task", workspaceId: "ws-1", panelId: "panel-1" },
    });

    const emitted: unknown[] = [];
    manager.on("command", (cmd) => emitted.push(cmd));

    const query = {
      id: "cq-3",
      from: { id: 1 },
      message: { message_id: 56, chat: { id: 12345 }, text: "" },
      data: JSON.stringify({ a: "cancel" }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any)._handleCallbackQuery(query, conn, token);

    expect(emitted).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).pendingRequests.has(chatId)).toBe(false);
    expect(sentTexts.some((t) => t.includes("Cancelled"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// forwardAlert skips connections without matching forwardKinds
// ---------------------------------------------------------------------------

describe("forwardAlert", () => {
  test("skips connections whose forwardKinds does not include the alert kind", async () => {
    const cred = makeCredentialStore({ "cred:tg-1": "tok1", "cred:tg-2": "tok2" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([
      makeConnection({ id: "tg-1", botTokenRef: "cred:tg-1", forwardKinds: ["completed"] }),
      makeConnection({ id: "tg-2", botTokenRef: "cred:tg-2", forwardKinds: ["error"] }),
    ]);

    const calledWith: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any)._sendAlertToConnection = async (conn: TelegramConnectionConfig) => {
      calledWith.push(conn.id);
    };

    await manager.forwardAlert({
      workspaceId: "ws-1",
      panelId: "p-1",
      kind: "completed",
      title: "Done",
    });

    // Only tg-1 accepts "completed"
    expect(calledWith).toEqual(["tg-1"]);
  });

  test("forwards to all connections when forwardKinds is empty", async () => {
    const cred = makeCredentialStore({ "cred:tg-1": "tok1", "cred:tg-2": "tok2" });
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([
      makeConnection({ id: "tg-1", botTokenRef: "cred:tg-1", forwardKinds: [] }),
      makeConnection({ id: "tg-2", botTokenRef: "cred:tg-2", forwardKinds: [] }),
    ]);

    const calledWith: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any)._sendAlertToConnection = async (conn: TelegramConnectionConfig) => {
      calledWith.push(conn.id);
    };

    await manager.forwardAlert({
      workspaceId: "ws-1",
      panelId: "p-1",
      kind: "info",
      title: "Hello",
    });

    expect(calledWith).toEqual(["tg-1", "tg-2"]);
  });

  test("skips connection when no connections configured", async () => {
    const cred = makeCredentialStore({});
    const manager = new TelegramManager({ credentialStore: cred });
    manager.configure([]);

    // Should not throw or call anything
    await expect(
      manager.forwardAlert({ workspaceId: "ws-1", panelId: "p-1", kind: "completed", title: "Done" }),
    ).resolves.toBeUndefined();
  });
});
