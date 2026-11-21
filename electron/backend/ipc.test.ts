import { describe, expect, test, beforeEach, vi } from "vitest";

// Regression coverage for the IPC registration/teardown wiring in ipc.ts.
//
// The bug this guards against: every `ipcMain.handle`/`ipcMain.on` call in
// registerIpc() used to need a matching, hand-written `ipcMain.removeHandler`/
// `removeAllListeners` call in the returned dispose function. The two lists
// drifted — 29 channels were registered but never torn down — so any code
// path that calls registerIpc() twice without a full process restart (e.g.
// dispose -> re-register) would eventually throw Electron's "Attempted to
// register a second handler" error for one of the orphaned channels.
//
// registerIpc() now routes every registration through local `handle()`/`on()`
// wrappers that record the channel name as it's registered, and teardown
// iterates that recorded list instead of a separately maintained one — so
// registered and torn-down channels can never drift apart again.

const { ipcMainMock, handleRegistry, onRegistry, removeHandlerCalls, removeAllListenersCalls, resetIpcMainMock } =
  vi.hoisted(() => {
    const handleRegistry = new Map<string, unknown>();
    const onRegistry = new Map<string, Set<unknown>>();
    const removeHandlerCalls: string[] = [];
    const removeAllListenersCalls: string[] = [];

    const ipcMainMock = {
      handle: (channel: string, listener: unknown) => {
        // Mirrors real Electron behavior: registering a second handler for
        // the same channel without removing the first throws.
        if (handleRegistry.has(channel)) {
          throw new Error(`Attempted to register a second handler for '${channel}'`);
        }
        handleRegistry.set(channel, listener);
      },
      removeHandler: (channel: string) => {
        handleRegistry.delete(channel);
        removeHandlerCalls.push(channel);
      },
      on: (channel: string, listener: unknown) => {
        if (!onRegistry.has(channel)) onRegistry.set(channel, new Set());
        (onRegistry.get(channel) as Set<unknown>).add(listener);
      },
      removeAllListeners: (channel: string) => {
        onRegistry.delete(channel);
        removeAllListenersCalls.push(channel);
      },
      removeListener: () => {},
    };

    function resetIpcMainMock(): void {
      handleRegistry.clear();
      onRegistry.clear();
      removeHandlerCalls.length = 0;
      removeAllListenersCalls.length = 0;
    }

    return { ipcMainMock, handleRegistry, onRegistry, removeHandlerCalls, removeAllListenersCalls, resetIpcMainMock };
  });

// Captures getLogger(label) calls for the IPC-failure tests below while still
// forwarding every call to the real logger, so other tests are unaffected.
type LogCall = { level: string; label: string; message: string; meta?: Record<string, unknown> };
const logCalls = vi.hoisted(() => [] as LogCall[]);
vi.mock("./logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./logger.js")>();
  return {
    ...actual,
    getLogger: (label: string) => {
      const real = actual.getLogger(label);
      const wrapped = {} as Record<string, (message: string, meta?: Record<string, unknown>) => void>;
      for (const level of ["error", "warn", "info", "debug", "trace"] as const) {
        wrapped[level] = (message, meta) => {
          logCalls.push({ level, label, message, meta });
          real[level](message, meta);
        };
      }
      return wrapped;
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: {
    fromWebContents: () => null,
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  clipboard: {
    writeText: vi.fn(),
    write: vi.fn(async () => {}),
    read: vi.fn(async () => []),
    has: vi.fn(async () => false),
  },
  ClipboardItem: class {
    types: string[];
    constructor(private readonly entries: Record<string, unknown>) {
      this.types = Object.keys(entries);
    }
    async getType(type: string): Promise<unknown> {
      return this.entries[type];
    }
  },
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): void {}
    show(): void {}
  },
  app: { getAppPath: () => "", getPath: () => "" },
}));

// vi.mock calls above are hoisted above this import by vitest, so ipc.ts
// resolves "electron" to the mock even though this import appears first
// in source order.
import { registerIpc } from "./ipc.js";
import { JiraRequestError } from "./jira/jira-manager.js";
import { JIRA_IPC_FAILURE_MARKER, toJiraIpcFailure } from "../shared/jira-ipc-failure.js";
import {
  AZURE_CLOSED_PR_CLEANUP_FINISHED_CHANNEL,
  azureClosedPrCleanupFinishedSchema,
} from "../shared/azure-closed-pr-cleanup-events.js";
import type { JiraWorkspaceViewsState } from "../shared/types/jira-workspace-views.js";
import { readFileSync } from "node:fs";
import { PEER_WINDOW_ALLOWED_CHANNELS, PEER_WINDOW_REFUSED_MESSAGE } from "../shared/peer-window-channels.js";
import { defaultPeerSettings } from "../shared/peers.js";
import { createRuntimePeers } from "./runtime-peers.js";

/**
 * Minimal runtime stub: every property access returns a callable that
 * returns itself. This satisfies both `runtime.someMethod(...)` (never
 * actually invoked here, since we don't dispatch any IPC calls) and
 * `runtime.on(event, cb)` at registration time, which must return a
 * callable "unsubscribe" function.
 */
function makeRuntimeStub(): Parameters<typeof registerIpc>[0] {
  const callable = (..._args: unknown[]): unknown => callable;
  return new Proxy(
    {},
    {
      get: (target, property, receiver) =>
        Reflect.has(target, property) ? Reflect.get(target, property, receiver) : callable,
    },
  ) as Parameters<typeof registerIpc>[0];
}

describe("registerIpc teardown", () => {
  beforeEach(() => {
    resetIpcMainMock();
  });

  test("every registered handle channel is torn down, and only those channels", () => {
    const dispose = registerIpc(makeRuntimeStub(), () => {});

    const registeredChannels = new Set(handleRegistry.keys());
    // Sanity: this file wires up ~265 handle channels; a drastically smaller
    // number would mean registration silently broke.
    expect(registeredChannels.size).toBeGreaterThan(200);
    expect(registeredChannels.has("jira:board-quick-filters")).toBe(true);
    expect(registeredChannels.has("jira:users:search")).toBe(true);

    dispose();

    expect(handleRegistry.size).toBe(0);
    expect(new Set(removeHandlerCalls)).toEqual(registeredChannels);
    expect(removeHandlerCalls.length).toBe(registeredChannels.size);
  });

  test("sidebar note saves validate the payload and require an owning window", async () => {
    const runtime = makeRuntimeStub();
    const storedNote = { id: "n-1", text: "Release checklist", revision: 1, canUndo: false };
    runtime.saveSidebarNote = vi.fn(async () => storedNote);
    const dispose = registerIpc(runtime, () => {}, {
      getWindowIdByWebContentsId: (id) => (id === 7 ? "win-a" : undefined),
    });
    const save = handleRegistry.get("sidebar-notes:save") as (_event: unknown, _payload: unknown) => Promise<unknown>;
    const data = { profileId: "profile-a", workspaceId: null, id: "n-1", text: storedNote.text, expectedRevision: 0 };
    try {
      await expect(save({ sender: { id: 99 } }, data)).rejects.toThrow("Notes require an owning window");
      await expect(save({ sender: { id: 7 } }, { ...data, expectedRevision: -1 })).rejects.toThrow(
        "IPC validation failed",
      );
      expect(runtime.saveSidebarNote).not.toHaveBeenCalled();
      await expect(save({ sender: { id: 7 } }, data)).resolves.toEqual(storedNote);
      expect(runtime.saveSidebarNote).toHaveBeenCalledWith(data, "win-a");
    } finally {
      dispose();
    }
  });

  test("installation note channels validate the payload and need no owning window", async () => {
    const runtime = makeRuntimeStub();
    const stored = { note: { id: "global", text: "Shared", revision: 1, canUndo: false }, installationName: "pc" };
    runtime.getInstallationNote = vi.fn(() => stored);
    runtime.saveInstallationNote = vi.fn(async () => stored);
    runtime.undoInstallationNote = vi.fn(async () => stored);
    const dispose = registerIpc(runtime, () => {}, { getWindowIdByWebContentsId: () => undefined });
    const call = (channel: string, payload?: unknown) =>
      (handleRegistry.get(channel) as (_event: unknown, _payload: unknown) => Promise<unknown>)(
        { sender: { id: 99 } },
        payload,
      );
    try {
      await expect(call("sidebar-notes:installation:get")).resolves.toEqual(stored);
      await expect(call("sidebar-notes:installation:save", { text: "Shared", expectedRevision: 0 })).resolves.toEqual(
        stored,
      );
      expect(runtime.saveInstallationNote).toHaveBeenCalledWith({ text: "Shared", expectedRevision: 0 });
      await expect(
        call("sidebar-notes:installation:save", { text: "Shared", expectedRevision: 0, profileId: "p" }),
      ).rejects.toThrow("IPC validation failed");
      await expect(call("sidebar-notes:installation:save", { text: "x", expectedRevision: -1 })).rejects.toThrow(
        "IPC validation failed",
      );
      await expect(call("sidebar-notes:installation:undo", { expectedRevision: 1 })).resolves.toEqual(stored);
      await expect(call("sidebar-notes:installation:undo", { expectedRevision: 0 })).rejects.toThrow(
        "IPC validation failed",
      );
      expect(runtime.saveInstallationNote).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  test("Jira cache flags and board filters pass through validated IPC payloads", async () => {
    const runtime = makeRuntimeStub();
    runtime.jiraGetBoardView = vi.fn(async () => null);
    runtime.jiraGetIssue = vi.fn(async () => null);
    runtime.jiraListBoardQuickFilters = vi.fn(async () => null);
    runtime.jiraSearchUsers = vi.fn(async () => []);
    const dispose = registerIpc(runtime, () => {}, { getWindowIdByWebContentsId: () => "window-a" });
    const event = { sender: { id: 1 } } as unknown as import("electron").IpcMainInvokeEvent;
    const board = handleRegistry.get("jira:board-view") as (event: unknown, payload: unknown) => Promise<unknown>;
    const issue = handleRegistry.get("jira:issue") as (event: unknown, payload: unknown) => Promise<unknown>;
    const filters = handleRegistry.get("jira:board-quick-filters") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    const users = handleRegistry.get("jira:users:search") as (event: unknown, payload: unknown) => Promise<unknown>;
    await board(event, {
      connectionId: "jira-a",
      boardId: 7,
      quickFilterIds: [4],
      assignee: { kind: "unassigned" },
      cacheOnly: true,
    });
    await issue(event, { connectionId: "jira-a", issueId: "OPS-4", forceRefresh: true });
    await filters(event, { connectionId: "jira-a", boardId: 7, cacheOnly: true });
    await users(event, { connectionId: "jira-a", query: "alice", limit: 5 });
    expect(runtime.jiraGetBoardView).toHaveBeenCalledWith(
      expect.objectContaining({ cacheOnly: true, quickFilterIds: [4] }),
      "window-a",
    );
    expect(runtime.jiraGetIssue).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }), "window-a");
    expect(runtime.jiraListBoardQuickFilters).toHaveBeenCalledWith(
      expect.objectContaining({ cacheOnly: true }),
      "window-a",
    );
    expect(runtime.jiraSearchUsers).toHaveBeenCalledWith(expect.objectContaining({ query: "alice" }), "window-a");
    await expect(board(event, { connectionId: "jira-a", boardId: 7, quickFilterIds: [0] })).rejects.toThrow();
    dispose();
  });

  test("automation IPC validates payload and forwards the caller window", async () => {
    const runtime = makeRuntimeStub();
    runtime.runAutomationNow = vi.fn(async () => ({ runId: "run" }));
    const dispose = registerIpc(runtime, () => {}, { getWindowIdByWebContentsId: () => "window-a" });
    const event = { sender: { id: 1 } } as unknown as import("electron").IpcMainInvokeEvent;
    const call = handleRegistry.get("automation:run-now") as (event: unknown, payload: unknown) => Promise<unknown>;
    await expect(call(event, { workspaceId: "ws", idempotencyKey: "request-123" })).resolves.toEqual({ runId: "run" });
    expect(runtime.runAutomationNow).toHaveBeenCalledWith(
      { workspaceId: "ws", idempotencyKey: "request-123" },
      "window-a",
    );
    await expect(call(event, { workspaceId: "ws", idempotencyKey: "bad" })).rejects.toThrow();
    runtime.deleteAutomationRuns = vi.fn(async () => ({ deleted: 1 }));
    const remove = handleRegistry.get("automation:delete-runs") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    const payload = { workspaceId: "ws", runIds: ["d10a3220-1505-4c4c-a19a-92aa6726e911"] };
    await expect(remove(event, payload)).resolves.toEqual({ deleted: 1 });
    expect(runtime.deleteAutomationRuns).toHaveBeenCalledWith(payload, "window-a");
    await expect(remove(event, { workspaceId: "ws", runIds: [] })).rejects.toThrow();
    dispose();
  });

  test("a Jira failure crosses IPC as an envelope that keeps its code; other failures still reject", async () => {
    const runtime = makeRuntimeStub();
    runtime.jiraGetIssue = vi.fn(async () => {
      throw new JiraRequestError("rate-limited", "Jira rate limit reached.", 4000, 429);
    });
    runtime.jiraSearchUsers = vi.fn(async () => {
      throw new Error("plain failure");
    });
    const dispose = registerIpc(runtime, () => {}, { getWindowIdByWebContentsId: () => "window-a" });
    const event = { sender: { id: 1 } } as unknown as import("electron").IpcMainInvokeEvent;
    const issue = handleRegistry.get("jira:issue") as (event: unknown, payload: unknown) => Promise<unknown>;
    const users = handleRegistry.get("jira:users:search") as (event: unknown, payload: unknown) => Promise<unknown>;

    const failure = await issue(event, { connectionId: "jira-a", issueId: "OPS-4" });
    expect(failure).toEqual(
      toJiraIpcFailure({ message: "Jira rate limit reached.", code: "rate-limited", retryAfterMs: 4000 }),
    );
    expect(failure).toEqual({
      [JIRA_IPC_FAILURE_MARKER]: 1,
      message: "Jira rate limit reached.",
      code: "rate-limited",
      retryAfterMs: 4000,
    });
    await expect(users(event, { connectionId: "jira-a", query: "alice" })).rejects.toThrow("plain failure");
    dispose();
  });

  test("the task channels that look up Jira issues answer a Jira failure with the envelope, anything else still rejects", async () => {
    const runtime = makeRuntimeStub();
    runtime.createTaskWorkspace = vi.fn(async () => {
      throw new JiraRequestError("auth-expired", "Jira rejected this connection. Sign in again.", undefined, 401);
    });
    runtime.startTask = vi.fn(async () => {
      throw new Error("plain failure");
    });
    runtime.stopTask = vi.fn(() => {
      throw new JiraRequestError("auth-expired", "not for this channel", undefined, 401);
    });
    const jiraLookupFailure = () => {
      throw new JiraRequestError("auth-expired", "Jira rejected this connection. Sign in again.", undefined, 401);
    };
    runtime.azureQuickFixCreate = vi.fn(jiraLookupFailure);
    runtime.githubQuickFixCreate = vi.fn(jiraLookupFailure);
    const dispose = registerIpc(runtime, () => {}, { getWindowIdByWebContentsId: () => "window-a" });
    const event = { sender: { id: 1 } } as unknown as import("electron").IpcMainInvokeEvent;
    const call = (channel: string, payload: unknown) =>
      (handleRegistry.get(channel) as (event: unknown, payload: unknown) => Promise<unknown>)(event, payload);
    await expect(call("task:create-workspace", { cwd: "/work/repo" })).resolves.toEqual(
      toJiraIpcFailure({ message: "Jira rejected this connection. Sign in again.", code: "auth-expired" }),
    );
    const envelope = toJiraIpcFailure({
      message: "Jira rejected this connection. Sign in again.",
      code: "auth-expired",
    });
    await expect(
      call("azure:quickfix:create", {
        connectionId: "c",
        projectName: "p",
        repositoryId: "r",
        repositoryName: "r",
        remoteUrl: "https://example.com/r.git",
        baseBranch: "main",
        newBranchName: "fix",
      }),
    ).resolves.toEqual(envelope);
    await expect(
      call("github:quickfix:create", {
        connectionId: "c",
        owner: "o",
        repo: "r",
        remoteUrl: "https://example.com/r.git",
        baseBranch: "main",
        newBranchName: "fix",
      }),
    ).resolves.toEqual(envelope);
    await expect(call("task:start", { workspaceId: "ws-1" })).rejects.toThrow("plain failure");
    await expect(call("task:stop", { workspaceId: "ws-1" })).rejects.toThrow("not for this channel");
    dispose();
  });

  test("a rejected write's Jira explanation never reaches the log, even when its message was clipped", async () => {
    logCalls.length = 0;
    const runtime = makeRuntimeStub();
    const detail = "Error in the JQL Query: secret-project ".repeat(20);
    runtime.jiraGetIssue = vi.fn(async () => {
      throw Object.assign(new Error(`Jira rejected this write (400). ${detail}`.slice(0, 500)), {
        name: "JiraWriteSafetyError",
        detail,
      });
    });
    const dispose = registerIpc(runtime, () => {}, { getWindowIdByWebContentsId: () => "window-a" });
    const event = { sender: { id: 1 } } as unknown as import("electron").IpcMainInvokeEvent;
    const issue = handleRegistry.get("jira:issue") as (event: unknown, payload: unknown) => Promise<unknown>;
    await expect(issue(event, { connectionId: "jira-a", issueId: "OPS-4" })).rejects.toThrow();
    expect(JSON.stringify(logCalls.find((call) => call.meta?.channel === "jira:issue"))).not.toContain(
      "secret-project",
    );
    dispose();
  });

  test("a failing Jira call is logged with its code, status and cause code, never Jira's own explanation", async () => {
    logCalls.length = 0;
    const runtime = makeRuntimeStub();
    const refusal = new JiraRequestError(
      "unknown",
      "Jira request failed (400): Error in the JQL Query: secret-project",
      undefined,
      400,
      {
        cause: Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
        detail: "Error in the JQL Query: secret-project",
      },
    );
    runtime.jiraGetIssue = vi.fn(async () => {
      throw refusal;
    });
    const dispose = registerIpc(runtime, () => {}, { getWindowIdByWebContentsId: () => "window-a" });
    const event = { sender: { id: 1 } } as unknown as import("electron").IpcMainInvokeEvent;
    const issue = handleRegistry.get("jira:issue") as (event: unknown, payload: unknown) => Promise<unknown>;
    await issue(event, { connectionId: "jira-a", issueId: "OPS-4" });
    const meta = logCalls.find((call) => call.meta?.channel === "jira:issue")?.meta;
    expect(meta).toMatchObject({ channel: "jira:issue", code: "unknown", statusCode: 400, cause: "ECONNRESET" });
    expect(JSON.stringify(meta)).not.toContain("secret-project");
    dispose();
  });

  test("Jira workspace-view IPC methods use caller window, strict inputs, and return only view state", async () => {
    const state: JiraWorkspaceViewsState = {
      workspaceId: "jira-ws",
      profileId: "p2",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }],
      activeViewId: "issues",
      syncByViewId: {},
    };
    const runtime = makeRuntimeStub();
    runtime.getJiraWorkspaceViews = vi.fn(async () => state);
    runtime.saveJiraWorkspaceView = vi.fn(async () => state);
    runtime.renameJiraWorkspaceView = vi.fn(async () => state);
    runtime.reorderJiraWorkspaceViews = vi.fn(async () => state);
    runtime.removeJiraWorkspaceView = vi.fn(async () => state);
    runtime.setJiraWorkspaceActiveView = vi.fn(async () => state);
    runtime.refreshJiraWorkspaceViews = vi.fn(async () => state);
    const dispose = registerIpc(runtime, () => {}, {
      getWindowIdByWebContentsId: (id) => (id === 7 ? "window-a" : "window-b"),
    });
    const event = { sender: { id: 9 } };
    const invoke = (channel: string, payload: unknown) =>
      (handleRegistry.get(channel) as (event: unknown, payload: unknown) => Promise<unknown>)(event, payload);
    const get = { workspaceId: "jira-ws" };
    const view = { kind: "board", connectionId: "jira-a", boardId: 7, title: "Platform" };
    const save = { workspaceId: "jira-ws", view };
    const target = { workspaceId: "jira-ws", viewId: "saved-opaque" };
    const refresh = { workspaceId: "jira-ws", viewId: "saved-opaque" };
    const rename = { workspaceId: "jira-ws", viewId: "saved-opaque", title: "Platform" };
    const reorder = { workspaceId: "jira-ws", viewIds: ["saved-opaque"] };

    await expect(invoke("jira:workspace-views:get", get)).resolves.toEqual(state);
    await expect(invoke("jira:workspace-views:save", save)).resolves.toEqual(state);
    await expect(invoke("jira:workspace-views:rename", rename)).resolves.toEqual(state);
    await expect(invoke("jira:workspace-views:reorder", reorder)).resolves.toEqual(state);
    await expect(invoke("jira:workspace-views:remove", target)).resolves.toEqual(state);
    await expect(invoke("jira:workspace-views:active", target)).resolves.toEqual(state);
    await expect(invoke("jira:workspace-views:refresh", refresh)).resolves.toEqual(state);
    expect(runtime.getJiraWorkspaceViews).toHaveBeenCalledWith(get, "window-b");
    expect(runtime.saveJiraWorkspaceView).toHaveBeenCalledWith(save, "window-b");
    expect(runtime.renameJiraWorkspaceView).toHaveBeenCalledWith(rename, "window-b");
    expect(runtime.reorderJiraWorkspaceViews).toHaveBeenCalledWith(reorder, "window-b");
    expect(runtime.removeJiraWorkspaceView).toHaveBeenCalledWith(target, "window-b");
    expect(runtime.setJiraWorkspaceActiveView).toHaveBeenCalledWith(target, "window-b");
    expect(runtime.refreshJiraWorkspaceViews).toHaveBeenCalledWith(refresh, "window-b");
    expect(state).not.toHaveProperty("appState");

    await expect(invoke("jira:workspace-views:get", { ...get, profileId: "p1" })).rejects.toThrow();
    await expect(
      invoke("jira:workspace-views:save", {
        workspaceId: "jira-ws",
        view: { ...view, profileId: "p1" },
      }),
    ).rejects.toThrow();
    expect(runtime.getJiraWorkspaceViews).toHaveBeenCalledTimes(1);
    expect(runtime.saveJiraWorkspaceView).toHaveBeenCalledTimes(1);
    dispose();
  });

  test("Jira recent reads and history writes use the calling window and reject profile spoofing", async () => {
    const runtime = makeRuntimeStub();
    runtime.getJiraRecentSearches = vi.fn(async () => []);
    runtime.rememberJiraSearch = vi.fn(async () => ({ ok: true }));
    runtime.getJiraRecentIssues = vi.fn(async () => []);
    runtime.rememberJiraIssueViewed = vi.fn(async () => ({ ok: true }));
    const dispose = registerIpc(runtime, () => {}, { getWindowIdByWebContentsId: () => "window-a" });
    const event = { sender: { id: 1 } };
    const invoke = (channel: string, payload: unknown) =>
      (handleRegistry.get(channel) as (event: unknown, payload: unknown) => Promise<unknown>)(event, payload);
    const ref = { provider: "jira", connectionId: "jira-a", issueId: "1", issueKey: "OPS-1" };
    await invoke("jira:recent-searches:list", { connectionId: "jira-a", limit: 10 });
    await invoke("jira:recent-searches:remember", { connectionId: "jira-a", jql: "key = OPS-1" });
    await invoke("jira:recent-issues:list", { connectionId: "jira-a" });
    await invoke("jira:recent-issues:viewed", { ref });
    expect(runtime.getJiraRecentSearches).toHaveBeenCalledWith({ connectionId: "jira-a", limit: 10 }, "window-a");
    expect(runtime.rememberJiraSearch).toHaveBeenCalledWith({ connectionId: "jira-a", jql: "key = OPS-1" }, "window-a");
    expect(runtime.getJiraRecentIssues).toHaveBeenCalledWith({ connectionId: "jira-a" }, "window-a");
    expect(runtime.rememberJiraIssueViewed).toHaveBeenCalledWith({ ref }, "window-a");
    await expect(invoke("jira:recent-issues:list", { connectionId: "jira-a", profileId: "other" })).rejects.toThrow();
    expect(runtime.getJiraRecentIssues).toHaveBeenCalledTimes(1);
    dispose();
  });

  test("Jira attachment content validates its strict payload before reaching the runtime", async () => {
    const runtime = makeRuntimeStub();
    runtime.jiraGetAttachmentImage = vi.fn(async () => ({ mediaType: "image/png", bytes: new Uint8Array([1]) }));
    const dispose = registerIpc(runtime, () => {});
    const event = { sender: { id: 1 } } as unknown as import("electron").IpcMainInvokeEvent;
    const content = handleRegistry.get("jira:attachment:content") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    await expect(content(event, { connectionId: "jira-1", issueId: "OPS-1", attachmentId: "10" })).resolves.toEqual({
      mediaType: "image/png",
      bytes: new Uint8Array([1]),
    });
    await expect(content(event, { connectionId: "jira-1", issueId: "OPS-1", attachmentId: "x" })).rejects.toThrow();
    await expect(
      content(event, { connectionId: "jira-1", issueId: "OPS-1", attachmentId: "10", extra: 1 }),
    ).rejects.toThrow();
    expect(runtime.jiraGetAttachmentImage).toHaveBeenCalledTimes(1);
    dispose();
  });

  test("Jira attachment dialogs never upload without a user-selected file and honor save cancellation", async () => {
    const { dialog } = await import("electron");
    const runtime = makeRuntimeStub();
    runtime.jiraGetAttachmentBytes = vi.fn(async () => ({
      fileName: "report.pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
    }));
    runtime.jiraUploadAttachment = vi.fn(async () => ({
      ok: true as const,
      data: { status: "succeeded" as const, journalId: "j1" },
    }));
    const dispose = registerIpc(runtime, () => {});
    const event = { sender: { id: 1 } } as unknown as import("electron").IpcMainInvokeEvent;
    const save = handleRegistry.get("jira:attachment:save") as (event: unknown, payload: unknown) => Promise<unknown>;
    const upload = handleRegistry.get("jira:attachment:upload") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: "" });
    await expect(save(event, { connectionId: "jira-1", issueId: "OPS-1", attachmentId: "10" })).resolves.toEqual({
      saved: false,
    });
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(upload(event, { connectionId: "jira-1", issueId: "OPS-1" })).resolves.toEqual({
      ok: true,
      cancelled: true,
    });
    expect(runtime.jiraGetAttachmentBytes).toHaveBeenCalledTimes(1);
    expect(runtime.jiraUploadAttachment).not.toHaveBeenCalled();
    dispose();

    vi.mocked(dialog.showSaveDialog).mockClear();
    vi.mocked(dialog.showOpenDialog).mockClear();
    const remoteDispose = registerIpc(runtime, () => {}, { getWindowIdByWebContentsId: () => "remote:session-1" });
    const remoteSave = handleRegistry.get("jira:attachment:save") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    const remoteUpload = handleRegistry.get("jira:attachment:upload") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    await expect(remoteSave(event, { connectionId: "jira-1", issueId: "OPS-1", attachmentId: "10" })).rejects.toThrow(
      "only from the desktop app",
    );
    await expect(remoteUpload(event, { connectionId: "jira-1", issueId: "OPS-1" })).rejects.toThrow(
      "only from the desktop app",
    );
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    remoteDispose();
  });

  test("every registered `on` channel is torn down via removeAllListeners", () => {
    const dispose = registerIpc(makeRuntimeStub(), () => {});

    const registeredListenerChannels = new Set(onRegistry.keys());
    expect(registeredListenerChannels).toEqual(
      new Set([
        "terminal:resize",
        "terminal:input",
        "terminal:submit",
        "log:renderer",
        "peer:ws:open",
        "peer:ws:send",
        "peer:ws:close",
      ]),
    );

    dispose();

    expect(onRegistry.size).toBe(0);
    expect(new Set(removeAllListenersCalls)).toEqual(registeredListenerChannels);
  });

  test("register -> dispose -> register again does not throw 'second handler' errors", () => {
    const dispose1 = registerIpc(makeRuntimeStub(), () => {});
    expect(() => dispose1()).not.toThrow();

    let dispose2: () => void;
    expect(() => {
      dispose2 = registerIpc(makeRuntimeStub(), () => {});
    }).not.toThrow();
    expect(() => dispose2()).not.toThrow();
  });

  test("previously-orphaned channels are now torn down", () => {
    const dispose = registerIpc(makeRuntimeStub(), () => {});

    // Spot-check channels from each of the four families the review found
    // registered but never appearing in the (formerly hand-maintained)
    // teardown list: 11 azure:pipelines:*, 10 git:*, task:update-description,
    // and 5 workspace-grid:*.
    const previouslyOrphaned = [
      "azure:pipelines:list",
      "azure:pipelines:run-detail",
      "git:list-branches",
      "git:compare-branch",
      "task:update-description",
      "workspace-grid:enable",
      "workspace-grid:swap-cells",
    ];
    for (const channel of previouslyOrphaned) {
      expect(handleRegistry.has(channel)).toBe(true);
    }

    dispose();

    for (const channel of previouslyOrphaned) {
      expect(removeHandlerCalls).toContain(channel);
    }
  });

  test("state:get is registered and torn down only when includeStateGet is not false", () => {
    const dispose = registerIpc(makeRuntimeStub(), () => {}, { includeStateGet: false });
    expect(handleRegistry.has("state:get")).toBe(false);
    dispose();
    expect(removeHandlerCalls).not.toContain("state:get");
  });
});

/**
 * V6 review, §"P1 — desktop Azure/GitHub mutation ztrácí viewer/window
 * kontext".
 *
 * The runtime handlers and the remote slot-aware routes both took a
 * `windowId`, but five desktop IPC adapters threw `event` away. The runtime
 * then asked `getViewerActiveWorkspaceId(undefined)`, which falls back to the
 * legacy global `activeWorkspaceId` — so in a multi-window / multi-profile
 * session the provider-root stamp could land on another window's workspace, or
 * not happen at all, and `assertPrInViewerProfile` had no caller profile with
 * which to refuse a foreign PR.
 *
 * The existing helper tests call the runtime handler directly with a
 * hand-written `"win-1"`, so they could never see an adapter that drops it.
 * These dispatch the REGISTERED channel instead.
 */
describe("registerIpc — provider review mutations carry the viewer's window", () => {
  beforeEach(() => {
    resetIpcMainMock();
  });

  /** A runtime that records the arguments each provider mutation was called with. */
  function makeRecordingRuntime(): {
    runtime: Parameters<typeof registerIpc>[0];
    calls: Array<{ method: string; args: unknown[] }>;
  } {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, method: string) => {
          // `runtime.on(...)` must still return a callable unsubscribe.
          if (method === "on") return callable;
          return (...args: unknown[]) => {
            calls.push({ method, args });
            return { ok: true };
          };
        },
      },
    ) as Parameters<typeof registerIpc>[0];
    return { runtime, calls };
  }

  /**
   * The mutation calls only.
   *
   * `registerIpc` also performs one-time wiring on the runtime — handing over the external-URL
   * opener, for instance — and the Proxy above records EVERY property access as a call. Asserting
   * the raw list would make this test about the registration's incidental shape rather than about
   * which window a provider mutation is attributed to.
   */
  function mutationCalls(
    calls: Array<{ method: string; args: unknown[] }>,
  ): Array<{ method: string; args: unknown[] }> {
    const names = new Set(MUTATIONS.map((mutation) => mutation.method));
    return calls.filter((call) => names.has(call.method));
  }

  const MUTATIONS = [
    {
      channel: "azure:pull-request:comment",
      method: "commentAzurePullRequest",
      payload: { prKey: "pr", content: "x" },
    },
    {
      channel: "azure:pull-request:thread-status",
      method: "updateAzureThreadStatus",
      payload: { prKey: "pr", threadId: 1, status: "closed" },
    },
    { channel: "azure:pull-request:vote", method: "voteAzurePullRequest", payload: { prKey: "pr", vote: 10 } },
    { channel: "github:pull-request:comment", method: "commentGitHubPullRequest", payload: { prKey: "pr", body: "x" } },
    {
      channel: "github:pull-request:review",
      method: "submitGitHubPullRequestReview",
      payload: { prKey: "pr", event: "APPROVE", body: "x" },
    },
  ];

  test("all five adapters resolve the deciding window from event.sender and pass it on", async () => {
    const { runtime, calls } = makeRecordingRuntime();
    const dispose = registerIpc(runtime, () => {}, {
      // Two windows, two profiles — window B is the one acting.
      getWindowIdByWebContentsId: (id) => (id === 7 ? "win-B" : "win-A"),
    });

    for (const mutation of MUTATIONS) {
      const listener = handleRegistry.get(mutation.channel) as (event: unknown, payload: unknown) => Promise<unknown>;
      expect(listener, mutation.channel).toBeTypeOf("function");
      await listener({ sender: { id: 7 } }, mutation.payload);
    }

    expect(mutationCalls(calls).map((call) => call.method)).toEqual(MUTATIONS.map((m) => m.method));
    for (const call of mutationCalls(calls)) {
      // The validated payload first, the viewer's window slot id second —
      // exactly the shape `azure:pull-request:open` and the recovery route use.
      expect(call.args[1], call.method).toBe("win-B");
    }

    dispose();
  });

  test("a window the map does not know resolves to an empty id, never to another window's", async () => {
    const { runtime, calls } = makeRecordingRuntime();
    const dispose = registerIpc(runtime, () => {}, { getWindowIdByWebContentsId: () => undefined });

    const listener = handleRegistry.get("azure:pull-request:comment") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    await listener({ sender: { id: 99 } }, { prKey: "pr", content: "x" });

    expect(mutationCalls(calls)[0]!.args[1]).toBe("");

    dispose();
  });
});

describe("registerIpc — online bootstrap actions are bound to their sending window", () => {
  beforeEach(() => {
    resetIpcMainMock();
  });

  test("retry and cancel carry the sender's window id and accept no renderer payload", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, method: string) => {
          if (method === "on") return callable;
          return (...args: unknown[]) => {
            calls.push({ method, args });
            return { ok: true };
          };
        },
      },
    ) as Parameters<typeof registerIpc>[0];
    const dispose = registerIpc(runtime, () => {}, {
      getWindowIdByWebContentsId: (id) => (id === 7 ? "account-window" : undefined),
    });

    const retry = handleRegistry.get("account:online-bootstrap:retry") as (event: unknown) => Promise<unknown>;
    const cancel = handleRegistry.get("account:online-bootstrap:cancel") as (event: unknown) => Promise<unknown>;
    await retry({ sender: { id: 7 } });
    await cancel({ sender: { id: 7 } });

    expect(calls.find((call) => call.method === "accountRetryOnlineBootstrap")?.args).toEqual(["account-window"]);
    expect(calls.find((call) => call.method === "accountCancelOnlineBootstrap")?.args).toEqual(["account-window"]);
    dispose();
  });
});

describe("notification:target-removed IPC forwarding", () => {
  beforeEach(() => {
    resetIpcMainMock();
  });

  /** Runtime stub that hands back the `on` callbacks so a test can fire one. */
  function makeSubscribableRuntime(): {
    runtime: Parameters<typeof registerIpc>[0];
    handlers: Map<string, (payload: unknown) => void>;
  } {
    const handlers = new Map<string, (payload: unknown) => void>();
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop !== "on") return callable;
          return (event: string, cb: (payload: unknown) => void) => {
            handlers.set(event, cb);
            return () => {};
          };
        },
      },
    ) as Parameters<typeof registerIpc>[0];
    return { runtime, handlers };
  }

  test("forwards the event to every renderer window", () => {
    // Broadcast rather than targeted: notification history is per-renderer, so
    // a second window of the same profile holds its own copy of the threads.
    const { runtime, handlers } = makeSubscribableRuntime();
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const dispose = registerIpc(runtime, (channel, payload) => emitted.push({ channel, payload }));

    const event = { target: "workspace", workspaceId: "ws-1", profileId: "default" };
    handlers.get("notification:target-removed")!(event);

    expect(emitted).toContainEqual({ channel: "notification:target-removed", payload: event });

    dispose();
  });

  test("forwards a finished closed-PR cleanup to every renderer window", () => {
    // Every window of the profile shows the summary, not only the one that asked
    // — a cleanup started from the phone has no desktop window waiting for it.
    const { runtime, handlers } = makeSubscribableRuntime();
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const dispose = registerIpc(runtime, (channel, payload) => emitted.push({ channel, payload }));

    const event = azureClosedPrCleanupFinishedSchema.parse({
      runId: "run-1",
      parentWorkspaceId: "azure-root",
      profileId: "default",
      finishedAt: "2026-10-14T10:00:00.000Z",
      result: { deleted: 2, skipped: [], errors: [] },
    });
    handlers.get(AZURE_CLOSED_PR_CLEANUP_FINISHED_CHANNEL)!(event);

    expect(emitted).toContainEqual({ channel: AZURE_CLOSED_PR_CLEANUP_FINISHED_CHANNEL, payload: event });

    dispose();
  });
});

describe("SSH test IPC ownership and event privacy", () => {
  beforeEach(() => resetIpcMainMock());

  test("test output and prompts go only to the owning window; unknown reserved ids never broadcast", () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const ownerBySession = new Map([["ssh-test:live", "window-a"]]);
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "on") {
            return (event: string, cb: (payload: unknown) => void) => {
              handlers.set(event, cb);
              return () => {};
            };
          }
          if (prop === "sshTestSessionOwner") return (id: string) => ownerBySession.get(id);
          if (prop === "isSshTestSessionId") return (id: string) => String(id).startsWith("ssh-test:");
          return callable;
        },
      },
    ) as Parameters<typeof registerIpc>[0];
    const delivered: Array<{ windowId: string; channel: string; payload: unknown }> = [];
    const broadcast: Array<{ channel: string; payload: unknown }> = [];
    const dispose = registerIpc(runtime, (channel, payload) => broadcast.push({ channel, payload }), {
      emitToWindow: (windowId, channel, payload) => delivered.push({ windowId, channel, payload }),
    });

    for (const channel of [
      "terminal:data",
      "terminal:exit",
      "ssh:auth-prompt",
      "ssh:auth-prompt-cancel",
      "ssh:host-key-change",
      "ssh:connection-state",
      "ssh:test:state",
    ]) {
      const payload = { sessionId: "ssh-test:live", channel };
      handlers.get(channel)!(payload);
      expect(delivered).toContainEqual({ windowId: "window-a", channel, payload });
    }
    handlers.get("terminal:data")!({ sessionId: "ssh-test:retired", data: "late" });
    expect(broadcast).toEqual([]);
    dispose();
  });

  test("a second desktop window cannot answer, cancel, trust, stop, write, or resize a test session", async () => {
    const ownerBySession = new Map([["ssh-test:live", "window-a"]]);
    const writes: unknown[][] = [];
    const sizes: unknown[][] = [];
    const answers: unknown[][] = [];
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "on") return callable;
          if (prop === "sshTestSessionOwner") return (id: string) => ownerBySession.get(id);
          if (prop === "isSshTestSessionId") return (id: string) => String(id).startsWith("ssh-test:");
          if (prop === "sshTestWrite") return (...args: unknown[]) => writes.push(args);
          if (prop === "sshTestResize") return (...args: unknown[]) => sizes.push(args);
          if (prop === "sshTestStop")
            return async (_payload: unknown, windowId: string) => {
              if (windowId !== "window-a") throw new Error("SSH test belongs to another window");
              return { ok: true };
            };
          if (
            ["ssh:auth:answer", "ssh:auth:cancel", "ssh:host-key:accept", "ssh:host-key:reject"].includes(String(prop))
          ) {
            return (...args: unknown[]) => answers.push([String(prop), ...args]);
          }
          return callable;
        },
      },
    ) as Parameters<typeof registerIpc>[0];
    const dispose = registerIpc(runtime, () => {}, {
      getWindowIdByWebContentsId: (id) => (id === 7 ? "window-a" : "window-b"),
    });
    const event = { sender: { id: 8 } };
    const call = async (channel: string, payload: unknown) =>
      (handleRegistry.get(channel) as (event: unknown, payload: unknown) => Promise<unknown>)(event, payload);

    for (const [channel, payload] of [
      ["ssh:auth:answer", { sessionId: "ssh-test:live", answers: ["x"], promptId: "p" }],
      ["ssh:auth:cancel", { sessionId: "ssh-test:live", promptId: "p" }],
      ["ssh:host-key:accept", { sessionId: "ssh-test:live", mode: "permanent", promptId: "p" }],
      ["ssh:host-key:reject", { sessionId: "ssh-test:live", promptId: "p" }],
      ["ssh:test:stop", { sessionId: "ssh-test:live" }],
    ] as const) {
      await expect(call(channel, payload)).rejects.toThrow("another window");
    }
    const input = [...(onRegistry.get("terminal:input") || [])][0] as (...args: unknown[]) => void;
    const submit = [...(onRegistry.get("terminal:submit") || [])][0] as (...args: unknown[]) => void;
    const resize = [...(onRegistry.get("terminal:resize") || [])][0] as (...args: unknown[]) => void;
    input(event, "ssh-test:live", "pwd\r");
    submit(event, "ssh-test:live", "pwd");
    resize(event, "ssh-test:live", { cols: 90, rows: 30 });
    expect(writes).toEqual([]);
    expect(sizes).toEqual([]);
    expect(answers).toEqual([]);
    dispose();
  });

  test("terminal:submit forwards validated text, origin, and viewer", () => {
    const submitted: unknown[][] = [];
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "on") return callable;
          if (prop === "sshTestSessionOwner") return () => undefined;
          if (prop === "isPrivateSshOperationSessionId") return () => false;
          if (prop === "submitToSession") return (...args: unknown[]) => submitted.push(args);
          return callable;
        },
      },
    ) as Parameters<typeof registerIpc>[0];
    const dispose = registerIpc(runtime, () => {}, {
      getWindowIdByWebContentsId: (id) => (id === 7 ? "window-a" : "window-b"),
    });
    const submit = [...(onRegistry.get("terminal:submit") || [])][0] as (...args: unknown[]) => void;
    submit({ sender: { id: 7 } }, "ws-a:panel", "hello", "ws-task");
    submit({ sender: { id: 7 } }, "ws-a:panel", 4, "ws-task");
    expect(submitted).toEqual([["ws-a:panel", "hello", "window-a", "ws-task"]]);
    dispose();
  });

  test("terminal:input forwards a tap's pointer arrival with the click, and drops a malformed one", () => {
    const written: unknown[][] = [];
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "on") return callable;
          if (prop === "sshTestSessionOwner") return () => undefined;
          if (prop === "isPrivateSshOperationSessionId") return () => false;
          if (prop === "writeToSession") return (...args: unknown[]) => written.push(args);
          return callable;
        },
      },
    ) as Parameters<typeof registerIpc>[0];
    const dispose = registerIpc(runtime, () => {}, {
      getWindowIdByWebContentsId: () => "window-a",
    });
    const input = [...(onRegistry.get("terminal:input") || [])][0] as (...args: unknown[]) => void;
    input({ sender: { id: 7 } }, "ws-a:panel", "<down><up>", "ws-a", "<move>");
    input({ sender: { id: 7 } }, "ws-a:panel", "x", undefined, 42);
    input({ sender: { id: 7 } }, "ws-a:panel", "<down><up>", undefined, "m".repeat(257));
    expect(written).toEqual([
      ["ws-a:panel", "<down><up>", "window-a", "ws-a", "<move>"],
      ["ws-a:panel", "x", "window-a", undefined, undefined],
      ["ws-a:panel", "<down><up>", "window-a", undefined, undefined],
    ]);
    dispose();
  });

  test("terminal:submit allows a private SSH submit only from its owner", () => {
    const writes: unknown[][] = [];
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "on") return callable;
          if (prop === "sshTestSessionOwner") return () => "window-a";
          if (prop === "isPrivateSshOperationSessionId") return () => true;
          if (prop === "sshTestWrite") return (...args: unknown[]) => writes.push(args);
          return callable;
        },
      },
    ) as Parameters<typeof registerIpc>[0];
    const dispose = registerIpc(runtime, () => {}, {
      getWindowIdByWebContentsId: (id) => (id === 7 ? "window-a" : "window-b"),
    });
    const submit = [...(onRegistry.get("terminal:submit") || [])][0] as (...args: unknown[]) => void;
    submit({ sender: { id: 8 } }, "ssh-test:private", "denied");
    submit({ sender: { id: 7 } }, "ssh-test:private", "accepted");
    expect(writes).toEqual([["ssh-test:private", "accepted\r", "window-a"]]);
    dispose();
  });

  test("key-transfer upload and verification prompts are private to their owning window", async () => {
    const uploadId = "ssh-transfer:upload-1";
    const verifyId = `${uploadId}:verify`;
    const ownerBySession = new Map([
      [uploadId, "window-a"],
      [verifyId, "window-a"],
    ]);
    const handlers = new Map<string, (payload: unknown) => void>();
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "on")
            return (event: string, cb: (payload: unknown) => void) => {
              handlers.set(event, cb);
              return () => handlers.delete(event);
            };
          if (prop === "sshTestSessionOwner") return (id: string) => ownerBySession.get(id);
          if (prop === "isPrivateSshOperationSessionId")
            return (id: string) => /^(ssh-test:|ssh-transfer:)/.test(String(id));
          if (prop === "isSshTestSessionId") return (id: string) => String(id).startsWith("ssh-test:");
          if (prop === "sshTestWrite" || prop === "sshTestResize") return callable;
          if (prop === "sshKeysTransferStop") return async () => ({ ok: true });
          if (
            ["ssh:auth:answer", "ssh:auth:cancel", "ssh:host-key:accept", "ssh:host-key:reject"].includes(String(prop))
          )
            return callable;
          return callable;
        },
      },
    ) as Parameters<typeof registerIpc>[0];
    const delivered: Array<{ windowId: string; channel: string; payload: unknown }> = [];
    const broadcast: Array<{ channel: string; payload: unknown }> = [];
    const dispose = registerIpc(runtime, (channel, payload) => broadcast.push({ channel, payload }), {
      emitToWindow: (windowId, channel, payload) => delivered.push({ windowId, channel, payload }),
      getWindowIdByWebContentsId: (id) => (id === 7 ? "window-a" : "window-b"),
    });

    const transferEvent = { operationId: uploadId, hostId: "h1", keyId: "k1", status: "uploading" };
    handlers.get("ssh:key-transfer:state")!(transferEvent);
    for (const sessionId of [uploadId, verifyId]) {
      for (const channel of [
        "terminal:data",
        "terminal:exit",
        "ssh:auth-prompt",
        "ssh:auth-prompt-cancel",
        "ssh:host-key-change",
        "ssh:connection-state",
      ]) {
        const payload = { sessionId, channel };
        handlers.get(channel)!(payload);
        expect(delivered).toContainEqual({ windowId: "window-a", channel, payload });
      }
    }
    expect(delivered).toContainEqual({
      windowId: "window-a",
      channel: "ssh:key-transfer:state",
      payload: transferEvent,
    });
    expect(broadcast).toEqual([]);

    const invokeEvent = { sender: { id: 8 } };
    const call = async (channel: string, payload: unknown) =>
      (handleRegistry.get(channel) as (event: unknown, payload: unknown) => Promise<unknown>)(invokeEvent, payload);
    await expect(call("ssh:auth:answer", { sessionId: uploadId, answers: ["secret"], promptId: "p1" })).rejects.toThrow(
      "another window",
    );
    await expect(
      call("ssh:host-key:accept", { sessionId: verifyId, mode: "permanent", promptId: "p2" }),
    ).rejects.toThrow("another window");
    dispose();
  });

  test("destroying the transfer owner window stops its upload and verification operations", async () => {
    const operations = ["ssh-transfer:upload-2", "ssh-transfer:upload-2:verify"];
    const ownerBySession = new Map(operations.map((id) => [id, "window-a"]));
    const stoppedOwners: string[] = [];
    let destroyed: (() => void) | undefined;
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "on") return callable;
          if (prop === "sshTestSessionOwner") return (id: string) => ownerBySession.get(id);
          if (prop === "isPrivateSshOperationSessionId")
            return (id: string) => /^(ssh-test:|ssh-transfer:)/.test(String(id));
          if (prop === "sshKeysTransferStart")
            return async (_payload: unknown, ownerId: string) => {
              expect(ownerId).toBe("window-a");
              return { operationId: operations[0], status: "connecting" };
            };
          if (prop === "sshTestStopOwner") return async (ownerId: string) => stoppedOwners.push(ownerId);
          return callable;
        },
      },
    ) as Parameters<typeof registerIpc>[0];
    const dispose = registerIpc(runtime, () => {}, {
      getWindowIdByWebContentsId: () => "window-a",
    });
    const event = {
      sender: {
        id: 7,
        isDestroyed: () => false,
        once: (name: string, listener: () => void) => {
          expect(name).toBe("destroyed");
          destroyed = listener;
        },
      },
    };
    await (handleRegistry.get("ssh:keys:transfer:start") as (event: unknown, payload: unknown) => Promise<unknown>)(
      event,
      { profileId: "default", hostId: "h1", keyId: "k1" },
    );
    expect(destroyed).toBeTypeOf("function");
    destroyed?.();
    await Promise.resolve();
    expect(stoppedOwners).toEqual(["window-a"]);
    expect(ownerBySession.size).toBe(2);
    dispose();
  });
});

// Before this, a failing IPC call left no trace in strideterm.log unless the
// renderer happened to log it — and Approve, Resolve and New worktree did not.
describe("registerIpc — every failing handler is logged", () => {
  beforeEach(() => {
    resetIpcMainMock();
    logCalls.length = 0;
  });

  function ipcFailures(): LogCall[] {
    return logCalls.filter((call) => call.label === "ipc" && call.message === "ipc handler failed");
  }

  test("a rejected handler is logged with its channel and keeps Error details", async () => {
    const dispose = registerIpc(makeRuntimeStub(), () => {});
    const listener = handleRegistry.get("azure:pull-request:vote") as (e: unknown, p: unknown) => Promise<unknown>;

    // The vote the renderer used to send: refused by azureVoteSchema.
    const error = await listener({ sender: { id: 1 } }, { prKey: "pr", vote: "10" }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/IPC validation failed on 'azure:pull-request:vote'/);
    expect(ipcFailures()).toEqual([
      expect.objectContaining({
        level: "warn",
        meta: { channel: "azure:pull-request:vote", err: (error as Error).message },
      }),
    ]);
    dispose();
  });

  test("a structured process rejection becomes a readable Error and keeps useful fields", async () => {
    const failure = {
      error: new Error("Command failed"),
      stdout: "",
      stderr: "fatal: bad ref\n",
      code: "checkout_conflict",
      status: 409,
    };
    const runtime = new Proxy(
      {},
      {
        get: (_target, method: string) =>
          method === "createWorktree" ? () => Promise.reject(failure) : () => () => {},
      },
    ) as Parameters<typeof registerIpc>[0];
    const dispose = registerIpc(runtime, () => {});
    const listener = handleRegistry.get("git:create-worktree") as (e: unknown, p: unknown) => Promise<unknown>;

    const normalized = await listener({ sender: { id: 1 } }, { workspaceId: "ws", name: "x" }).catch(
      (error: unknown) => error,
    );
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized).toMatchObject({
      message: "fatal: bad ref",
      stderr: "fatal: bad ref\n",
      code: "checkout_conflict",
      status: 409,
      cause: failure,
    });
    expect((normalized as Error).message).not.toContain("[object Object]");
    expect(ipcFailures()[0]?.meta).toEqual({
      channel: "git:create-worktree",
      err: "fatal: bad ref",
      code: "checkout_conflict",
      statusCode: 409,
    });
    dispose();
  });

  test("an Error with captured process output uses the diagnostic as its IPC message", async () => {
    const failure = Object.assign(new Error("Command failed: git worktree add"), {
      stderr: "fatal: a branch named 'feature' already exists\n",
      exitCode: 128,
    });
    const runtime = new Proxy(
      {},
      {
        get: (_target, method: string) =>
          method === "createWorktree" ? () => Promise.reject(failure) : () => () => {},
      },
    ) as Parameters<typeof registerIpc>[0];
    const dispose = registerIpc(runtime, () => {});
    const listener = handleRegistry.get("git:create-worktree") as (e: unknown, p: unknown) => Promise<unknown>;

    const normalized = await listener({ sender: { id: 1 } }, { workspaceId: "ws", name: "x" }).catch(
      (error: unknown) => error,
    );
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized).toMatchObject({
      message: "fatal: a branch named 'feature' already exists",
      stderr: failure.stderr,
      exitCode: 128,
      cause: failure,
    });
    dispose();
  });

  test("the same failure on the same channel is logged once a minute at most", async () => {
    const dispose = registerIpc(makeRuntimeStub(), () => {});
    const vote = handleRegistry.get("azure:pull-request:vote") as (e: unknown, p: unknown) => Promise<unknown>;
    const comment = handleRegistry.get("azure:pull-request:comment") as (e: unknown, p: unknown) => Promise<unknown>;

    for (let i = 0; i < 3; i++) await vote({ sender: { id: 1 } }, { prKey: "pr", vote: "10" }).catch(() => {});
    await comment({ sender: { id: 1 } }, { prKey: "", content: "x" }).catch(() => {});

    expect(ipcFailures().map((call) => call.meta?.channel)).toEqual([
      "azure:pull-request:vote",
      "azure:pull-request:comment",
    ]);
    dispose();
  });
});

describe("registerIpc — ssh:capabilities:get", () => {
  beforeEach(() => {
    resetIpcMainMock();
  });

  test("forwards the explicit refresh the preload sends, so Settings → SSH is not answered from the cache", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, method: string) =>
          method === "on"
            ? callable
            : (...args: unknown[]) => {
                calls.push({ method, args });
                return {};
              },
      },
    ) as Parameters<typeof registerIpc>[0];
    const dispose = registerIpc(runtime, () => {});
    const listener = handleRegistry.get("ssh:capabilities:get") as (event: unknown, ...args: unknown[]) => unknown;

    // preload.cts: `sshCapabilitiesGet: (payload) => ipcRenderer.invoke("ssh:capabilities:get", payload)`.
    await listener({ sender: { id: 1 } }, { refresh: true });
    await listener({ sender: { id: 1 } }, undefined);

    expect(calls.filter((call) => call.method === "ssh:capabilities:get").map((call) => call.args[0])).toEqual([
      { refresh: true },
      undefined,
    ]);
    dispose();
  });
});

describe("registerIpc — Jira issue pop-out", () => {
  beforeEach(() => {
    resetIpcMainMock();
  });

  const ref = { connectionId: "c1", issueId: "10001", issueKey: "OPS-1" };

  function setup(overrides: { windowId?: string; profile?: () => string } = {}) {
    const resolved: Array<[string, string]> = [];
    const opened: unknown[] = [];
    const base = makeRuntimeStub();
    const runtime = new Proxy(base, {
      get: (target, property, receiver) =>
        property === "resolveJiraIssuePopoutProfile"
          ? (workspaceId: string, windowId: string) => {
              resolved.push([workspaceId, windowId]);
              return overrides.profile ? overrides.profile() : "default";
            }
          : Reflect.get(target, property, receiver),
    }) as typeof base;
    const dispose = registerIpc(runtime, () => {}, {
      getWindowIdByWebContentsId: (id) => (id === 5 ? (overrides.windowId ?? "win-a") : undefined),
      openJiraIssuePopout: (target) => {
        opened.push(target);
        return { focused: false };
      },
      getJiraIssuePopoutInit: (id) => (id === 9 ? ({ openerWindowId: "win-a" } as never) : null),
    });
    const call = (payload: unknown, senderId = 5) =>
      (handleRegistry.get("jira:issue:popout") as (event: unknown, payload: unknown) => Promise<unknown>)(
        { sender: { id: senderId } },
        payload,
      );
    return { call, resolved, opened, dispose };
  }

  test("opens the window for the caller's window, resolved profile and validated issue", async () => {
    const { call, resolved, opened, dispose } = setup();
    await expect(call({ workspaceId: "ws1", ref, summary: "Fix it" })).resolves.toEqual({ focused: false });
    expect(resolved).toEqual([["ws1", "win-a"]]);
    expect(opened).toEqual([
      { openerWindowId: "win-a", profileId: "default", workspaceId: "ws1", ref, summary: "Fix it" },
    ]);
    dispose();
  });

  test("refuses payloads that do not match the schema, without resolving or opening anything", async () => {
    const { call, resolved, opened, dispose } = setup();
    for (const bad of [
      undefined,
      {},
      { workspaceId: "", ref },
      { workspaceId: "ws1", ref: { connectionId: "c1", issueId: "1" } },
      { workspaceId: "ws1", ref: { ...ref, extra: 1 } },
      { workspaceId: "ws1", ref, profileId: "other" },
      { workspaceId: "ws1", ref, summary: "x".repeat(501) },
    ])
      await expect(call(bad)).rejects.toThrow();
    expect(resolved).toEqual([]);
    expect(opened).toEqual([]);
    dispose();
  });

  test("a workspace of another profile is refused and nothing opens", async () => {
    const { call, opened, dispose } = setup({
      profile: () => {
        throw new Error("This Jira workspace is not available in the current profile.");
      },
    });
    await expect(call({ workspaceId: "foreign", ref })).rejects.toThrow(/not available in the current profile/);
    expect(opened).toEqual([]);
    dispose();
  });

  test("a sender without a desktop window id, or a remote viewer, cannot pop out", async () => {
    const unknown = setup();
    await expect(unknown.call({ workspaceId: "ws1", ref }, 77)).rejects.toThrow(/desktop app/);
    unknown.dispose();
    resetIpcMainMock();
    const remote = setup({ windowId: "remote:session-1" });
    await expect(remote.call({ workspaceId: "ws1", ref })).rejects.toThrow(/desktop app/);
    expect(remote.opened).toEqual([]);
    remote.dispose();
  });

  test("the popout fetches its own target by webContents id and gets null for any other sender", async () => {
    const { dispose } = setup();
    const init = handleRegistry.get("jira:issue:popout:get-init") as (event: unknown) => Promise<unknown>;
    await expect(init({ sender: { id: 9 } })).resolves.toEqual({ openerWindowId: "win-a" });
    await expect(init({ sender: { id: 5 } })).resolves.toBeNull();
    dispose();
  });
});

describe("registerIpc — windows attached to another desktop", () => {
  beforeEach(() => {
    resetIpcMainMock();
    logCalls.length = 0;
  });

  type Handler = (event: unknown, payload?: unknown) => Promise<unknown>;
  const PEER_SENDER = 11;
  const LOCAL_SENDER = 12;
  const windowOf = (id: number) => (id === PEER_SENDER ? "peer-win" : id === LOCAL_SENDER ? "local-win" : undefined);
  const channelsOnDisk = () =>
    ["./ipc.ts", "../main.ts"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");

  class FakeSocket {
    readonly handlers: Record<string, Array<(arg?: never) => void>> = {};
    readonly sent: string[] = [];
    closed: Array<{ code?: number; reason?: string }> = [];
    on(event: string, handler: (arg?: never) => void) {
      (this.handlers[event] ??= []).push(handler);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close(code?: number, reason?: string) {
      this.closed.push({ code, reason });
    }
    fire(event: string, arg?: unknown) {
      for (const handler of this.handlers[event] ?? []) handler(arg as never);
    }
  }

  function setup(options: { adapter?: boolean; peer?: Record<string, unknown> } = {}) {
    const runtime = makeRuntimeStub();
    const sockets: FakeSocket[] = [];
    runtime.isPeerWindow = vi.fn((windowId: string) => windowId === "peer-win") as never;
    runtime.getWindowBackend = vi.fn((windowId: string) =>
      windowId === "peer-win"
        ? { kind: "peer", hostId: "host-aaaaaaaa", hostLabel: "Mac", remoteProfileId: "work", clientId: "w123" }
        : { kind: "local" },
    ) as never;
    runtime.peerWindowOpenSocket = vi.fn((windowId: string) => {
      if (windowId !== "peer-win") throw new Error("This window is not attached to another desktop.");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }) as never;
    runtime.createPeerWindowSlot = vi.fn(async (input: { hostId: string; profileId: string }) => ({
      id: "new-peer-win",
      hostId: input.hostId,
      profileId: input.profileId,
    })) as never;
    runtime.removePeerWindowSlot = vi.fn(async () => undefined) as never;
    runtime.convertWindowToPeer = vi.fn(async () => ({})) as never;
    runtime.convertWindowToLocal = vi.fn(async () => ({})) as never;
    runtime.setPeerWindowProfile = vi.fn(async () => undefined) as never;
    runtime.requirePeerHostOnline = vi.fn(async () => ({})) as never;
    runtime.retargetPeerWindow = vi.fn(async () => ({})) as never;
    runtime.setPeerWindowFontSize = vi.fn(async () => undefined) as never;
    for (const [name, fn] of Object.entries(options.peer ?? {})) (runtime as Record<string, unknown>)[name] = fn;
    const adapter = { open: vi.fn(), reload: vi.fn(), setAttention: vi.fn() };
    const emitted: Array<{ windowId: string; channel: string; payload: unknown }> = [];
    const dispose = registerIpc(runtime, () => {}, {
      getWindowIdByWebContentsId: windowOf,
      emitToWindow: (windowId, channel, payload) => emitted.push({ windowId, channel, payload }),
      ...(options.adapter === false ? {} : { peerWindows: adapter }),
    });
    const sender = (id: number) => ({ sender: { id, isDestroyed: () => false, once: vi.fn() } });
    const call = (channel: string, payload?: unknown, senderId = PEER_SENDER) =>
      (handleRegistry.get(channel) as Handler)(sender(senderId), payload);
    const sendAs = (senderId: number, channel: string, ...args: unknown[]) => {
      for (const listener of onRegistry.get(channel) ?? [])
        (listener as (e: unknown, ...a: unknown[]) => void)(sender(senderId), ...args);
    };
    const send = (channel: string, payload?: unknown, senderId = PEER_SENDER) => {
      for (const listener of onRegistry.get(channel) ?? [])
        (listener as (e: unknown, p?: unknown) => void)(sender(senderId), payload);
    };
    return { runtime, adapter, emitted, sockets, dispose, call, send, sendAs };
  }

  test("every allowlisted channel is registered in ipc.ts or main.ts and none is a data channel", () => {
    const source = channelsOnDisk();
    for (const channel of PEER_WINDOW_ALLOWED_CHANNELS) {
      expect(source, channel).toMatch(new RegExp(`\\b(handle|on|handleIpc)\\(\\s*"${channel}"`));
      expect(
        /^(workspace|session|terminal|file|git|settings|state|credentials|profile|azure|github|jira|docker|ssh|task|peers:host):/.test(
          channel,
        ),
        channel,
      ).toBe(false);
    }
    expect(PEER_WINDOW_ALLOWED_CHANNELS.has("state:get")).toBe(false);
    expect([...PEER_WINDOW_ALLOWED_CHANNELS].some((channel) => channel.startsWith("peers:host:"))).toBe(false);
  });

  test("a data channel is refused from a peer window, logged once, and never reaches the runtime", async () => {
    const { runtime, call, sendAs, dispose } = setup();
    runtime.saveWorkspace = vi.fn() as never;
    runtime.getInitialState = vi.fn() as never;
    runtime.writeToSession = vi.fn() as never;
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(call("workspace:save", { id: "ws" })).rejects.toThrow(PEER_WINDOW_REFUSED_MESSAGE);
      await expect(call("state:get")).rejects.toThrow(PEER_WINDOW_REFUSED_MESSAGE);
      sendAs(PEER_SENDER, "terminal:input", "ws:shell", "ls\r");
    }
    expect(runtime.saveWorkspace).not.toHaveBeenCalled();
    expect(runtime.getInitialState).not.toHaveBeenCalled();
    expect(runtime.writeToSession).not.toHaveBeenCalled();
    const refusals = logCalls.filter((entry) => entry.message.startsWith("refused a channel"));
    expect(refusals.map((entry) => entry.meta?.channel).sort()).toEqual([
      "state:get",
      "terminal:input",
      "workspace:save",
    ]);
    expect(logCalls.some((entry) => entry.message === "ipc handler failed")).toBe(false);
    dispose();
  });

  test("the same calls from a local window go through", async () => {
    const { runtime, call, sendAs, dispose } = setup();
    runtime.saveWorkspace = vi.fn(async () => ({ ok: true })) as never;
    runtime.getInitialState = vi.fn(async () => ({ ok: true })) as never;
    runtime.writeToSession = vi.fn() as never;
    runtime.sshTestSessionOwner = (() => undefined) as never;
    runtime.isPrivateSshOperationSessionId = (() => false) as never;
    runtime.reviewAgentPreparationSessionOwner = (() => undefined) as never;
    await expect(call("workspace:save", { id: "ws", name: "x" }, LOCAL_SENDER)).resolves.toEqual({ ok: true });
    await expect(call("state:get", undefined, LOCAL_SENDER)).resolves.toEqual({ ok: true });
    sendAs(LOCAL_SENDER, "terminal:input", "ws:shell", "ls\r");
    expect(runtime.saveWorkspace).toHaveBeenCalledTimes(1);
    expect(runtime.getInitialState).toHaveBeenCalledTimes(1);
    expect(runtime.writeToSession).toHaveBeenCalledTimes(1);
    dispose();
  });

  test("copying a host's attachments is refused from a peer window and goes through from a local one", async () => {
    const list = vi.fn(async () => ({ items: [], truncated: false }));
    const start = vi.fn(async () => ({ copyId: "c1" }));
    const cancel = vi.fn(() => ({ ok: true }));
    const { runtime, call, dispose } = setup();
    runtime.listPeerAttachments = list as never;
    runtime.startPeerAttachmentCopy = start as never;
    runtime.cancelPeerAttachmentCopy = cancel as never;
    const copy = {
      hostId: "host-aaaaaaaa",
      source: {
        workspaceId: "ws",
        transferId: "11111111-1111-4111-8111-111111111111",
        name: "a.png",
        size: 5,
        sha256: "a".repeat(64),
      },
      targetWorkspaceId: "lw",
    };
    const calls: Array<[string, unknown]> = [
      ["peers:client:attachments:list", { hostId: "host-aaaaaaaa" }],
      ["peers:client:attachments:copy", copy],
      ["peers:client:attachments:cancel", { copyId: "11111111-1111-4111-8111-111111111111" }],
    ];
    for (const [channel, payload] of calls) {
      expect(PEER_WINDOW_ALLOWED_CHANNELS.has(channel), channel).toBe(false);
      await expect(call(channel, payload)).rejects.toThrow(PEER_WINDOW_REFUSED_MESSAGE);
    }
    expect(list).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();

    await expect(call(calls[0]![0], calls[0]![1], LOCAL_SENDER)).resolves.toEqual({ items: [], truncated: false });
    await expect(call(calls[1]![0], calls[1]![1], LOCAL_SENDER)).resolves.toEqual({ copyId: "c1" });
    await expect(call(calls[2]![0], calls[2]![1], LOCAL_SENDER)).resolves.toEqual({ ok: true });
    expect(list).toHaveBeenCalledWith("host-aaaaaaaa");
    expect(start).toHaveBeenCalledWith(copy, "local-win");
    expect(cancel).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "local-win");
    await expect(call(calls[1]![0], { ...copy, extra: 1 }, LOCAL_SENDER)).rejects.toThrow(/validation failed/);
    await expect(call(calls[0]![0], { hostId: "host-aaaaaaaa", path: "/etc" }, LOCAL_SENDER)).rejects.toThrow(
      /validation failed/,
    );
    dispose();
  });

  test("a host's global note is refused from a peer window and goes through from a local one", async () => {
    const get = vi.fn(async () => ({ note: { id: "global" }, installationName: "Host" }));
    const save = vi.fn(async () => ({ note: { id: "global" }, installationName: "Host" }));
    const undo = vi.fn(async () => ({ note: { id: "global" }, installationName: "Host" }));
    const { runtime, call, dispose } = setup();
    runtime.getPeerGlobalNote = get as never;
    runtime.savePeerGlobalNote = save as never;
    runtime.undoPeerGlobalNote = undo as never;
    const calls: Array<[string, unknown]> = [
      ["peers:client:global-note:get", { hostId: "host-aaaaaaaa" }],
      ["peers:client:global-note:save", { hostId: "host-aaaaaaaa", text: "note", expectedRevision: 2 }],
      ["peers:client:global-note:undo", { hostId: "host-aaaaaaaa", expectedRevision: 3 }],
    ];
    for (const [channel, payload] of calls) {
      expect(PEER_WINDOW_ALLOWED_CHANNELS.has(channel), channel).toBe(false);
      await expect(call(channel, payload)).rejects.toThrow(PEER_WINDOW_REFUSED_MESSAGE);
    }
    expect(get).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();

    for (const [channel, payload] of calls) await call(channel, payload, LOCAL_SENDER);
    expect(get).toHaveBeenCalledWith("host-aaaaaaaa");
    expect(save).toHaveBeenCalledWith("host-aaaaaaaa", { text: "note", expectedRevision: 2 });
    expect(undo).toHaveBeenCalledWith("host-aaaaaaaa", { expectedRevision: 3 });
    await expect(call(calls[0]![0], { hostId: "host-aaaaaaaa", path: "/x" }, LOCAL_SENDER)).rejects.toThrow(
      /validation failed/,
    );
    await expect(call(calls[1]![0], { hostId: "host-aaaaaaaa", text: "n" }, LOCAL_SENDER)).rejects.toThrow(
      /validation failed/,
    );
    await expect(call(calls[2]![0], { hostId: "host-aaaaaaaa", expectedRevision: 0 }, LOCAL_SENDER)).rejects.toThrow(
      /validation failed/,
    );
    dispose();
  });

  test("host-side channels are refused from a peer window", async () => {
    const { runtime, call, dispose } = setup();
    runtime.getPeerHostState = vi.fn() as never;
    await expect(call("peers:host:get")).rejects.toThrow(PEER_WINDOW_REFUSED_MESSAGE);
    expect(runtime.getPeerHostState).not.toHaveBeenCalled();
    dispose();
  });

  test("peer:http from a local window is refused by the runtime as not attached", async () => {
    const peers = createRuntimePeers({
      getState: () =>
        ({
          settings: { integrations: { peers: defaultPeerSettings() } },
          peerWindows: [],
          workspaces: [],
          profiles: [],
          windowSlots: [],
        }) as never,
      mutate: async () => undefined,
      credentials: {} as never,
      appVersion: "1.0.0",
      emit: () => undefined,
    });
    const { call, dispose } = setup({
      peer: { peerWindowRequest: (windowId: string, request: never) => peers.peerWindowRequest(windowId, request) },
    });
    const request = { method: "GET", pathname: "/api/state", headers: {} };
    await expect(call("peer:http", request, LOCAL_SENDER)).rejects.toThrow(
      "This window is not attached to another desktop.",
    );
    await expect(call("peer:http", { ...request, pathname: "" }, PEER_SENDER)).rejects.toThrow("IPC validation failed");
    await expect(call("peer:http", { ...request, extra: 1 }, PEER_SENDER)).rejects.toThrow("IPC validation failed");
    await expect(call("peer:http", { ...request, headers: { a: 1 } }, PEER_SENDER)).rejects.toThrow(
      "IPC validation failed",
    );
    dispose();
  });

  test("peer:http forwards the validated request together with the calling window id", async () => {
    const peerWindowRequest = vi.fn(async () => ({ status: 200, headers: {}, body: "{}" }));
    const { call, dispose } = setup({ peer: { peerWindowRequest } });
    const request = { method: "POST", pathname: "/api/x?y=1", headers: { "x-a": "b" }, body: "{}" };
    await expect(call("peer:http", request)).resolves.toEqual({ status: 200, headers: {}, body: "{}" });
    expect(peerWindowRequest).toHaveBeenCalledWith("peer-win", request);
    dispose();
  });

  describe("the peer socket", () => {
    test("reports open, relays messages both ways and reports the close", () => {
      const { send, sockets, emitted, dispose } = setup();
      send("peer:ws:open", { clientId: "ignored" });
      expect(sockets).toHaveLength(1);
      sockets[0]!.fire("open");
      sockets[0]!.fire("message", "hello");
      send("peer:ws:send", "ping");
      expect(sockets[0]!.sent).toEqual(["ping"]);
      send("peer:ws:close", { code: 1000, reason: "bye" });
      expect(sockets[0]!.closed).toEqual([{ code: 1000, reason: "bye" }]);
      sockets[0]!.fire("close", { code: 1000, reason: "bye" });
      expect(emitted).toEqual([
        { windowId: "peer-win", channel: "peer:ws:state", payload: { state: "open" } },
        { windowId: "peer-win", channel: "peer:ws:message", payload: "hello" },
        { windowId: "peer-win", channel: "peer:ws:state", payload: { state: "closed", code: 1000, reason: "bye" } },
      ]);
      dispose();
    });

    test("an open replaces the previous socket, whose later events are never delivered", () => {
      const { send, sockets, emitted, dispose } = setup();
      send("peer:ws:open", {});
      send("peer:ws:open", {});
      expect(sockets).toHaveLength(2);
      expect(sockets[0]!.closed).toEqual([{ code: 1000, reason: "replaced" }]);
      sockets[0]!.fire("message", "stale");
      sockets[0]!.fire("close", { code: 1000, reason: "replaced" });
      expect(emitted).toEqual([]);
      sockets[1]!.fire("open");
      send("peer:ws:send", "to-new");
      expect(sockets[0]!.sent).toEqual([]);
      expect(sockets[1]!.sent).toEqual(["to-new"]);
      expect(emitted).toEqual([{ windowId: "peer-win", channel: "peer:ws:state", payload: { state: "open" } }]);
      dispose();
    });

    test("a refused or malformed open is reported as a closed socket", () => {
      const { send, emitted, dispose } = setup();
      send("peer:ws:open", {}, LOCAL_SENDER);
      send("peer:ws:open", { a: 1 });
      expect(emitted).toEqual([
        {
          windowId: "local-win",
          channel: "peer:ws:state",
          payload: { state: "closed", code: 1008, reason: "This window is not attached to another desktop." },
        },
        {
          windowId: "peer-win",
          channel: "peer:ws:state",
          payload: { state: "closed", code: 1008, reason: "The socket request is not valid." },
        },
      ]);
      dispose();
    });

    test("sends and closes from a window that opened nothing are dropped", () => {
      const { send, sockets, dispose } = setup();
      send("peer:ws:open", {});
      send("peer:ws:send", "from-local", LOCAL_SENDER);
      send("peer:ws:close", {}, LOCAL_SENDER);
      send("peer:ws:send", 42);
      expect(sockets[0]!.sent).toEqual([]);
      expect(sockets[0]!.closed).toEqual([]);
      dispose();
    });

    test("the socket closes when its window's webContents is destroyed, and everything closes on dispose", () => {
      const { sockets, dispose, runtime } = setup();
      let destroyed: (() => void) | undefined;
      const open = [...(onRegistry.get("peer:ws:open") ?? [])][0] as (e: unknown, p?: unknown) => void;
      open(
        {
          sender: {
            id: PEER_SENDER,
            isDestroyed: () => false,
            once: (_event: string, cb: () => void) => (destroyed = cb),
          },
        },
        {},
      );
      expect(sockets).toHaveLength(1);
      destroyed!();
      expect(sockets[0]!.closed).toEqual([{ code: 1001, reason: "window closed" }]);

      open({ sender: { id: PEER_SENDER, isDestroyed: () => false, once: () => undefined } }, {});
      expect(sockets).toHaveLength(2);
      dispose();
      expect(sockets[1]!.closed).toEqual([{ code: 1001, reason: "shutting down" }]);
      expect(runtime.peerWindowOpenSocket).toHaveBeenCalledTimes(2);
    });
  });

  describe("window operations", () => {
    test("open creates the slot, then asks the window layer to open it; a failure removes the slot", async () => {
      const { runtime, adapter, call, dispose } = setup();
      await expect(call("peers:window:open", { hostId: "host-aaaaaaaa", profileId: "work" })).resolves.toEqual({
        windowId: "new-peer-win",
      });
      expect(runtime.createPeerWindowSlot).toHaveBeenCalledWith({
        hostId: "host-aaaaaaaa",
        profileId: "work",
        cloneFromWindowId: "peer-win",
      });
      expect(adapter.open).toHaveBeenCalledWith({ id: "new-peer-win", hostId: "host-aaaaaaaa", profileId: "work" });

      adapter.open.mockRejectedValueOnce(new Error("no screen"));
      await expect(call("peers:window:open", { hostId: "host-aaaaaaaa", profileId: "work" })).rejects.toThrow(
        "no screen",
      );
      expect(runtime.removePeerWindowSlot).toHaveBeenCalledWith("new-peer-win");
      await expect(call("peers:window:open", { hostId: "x", profileId: "work" })).rejects.toThrow(
        "IPC validation failed",
      );
      dispose();
    });

    test("activate converts a local window and reloads it; a window of the same host only switches profile", async () => {
      const { runtime, adapter, call, dispose } = setup();
      await expect(
        call("peers:window:activate", { hostId: "host-aaaaaaaa", profileId: "home" }, LOCAL_SENDER),
      ).resolves.toEqual({
        reloaded: true,
      });
      expect(runtime.convertWindowToPeer).toHaveBeenCalledWith("local-win", {
        hostId: "host-aaaaaaaa",
        profileId: "home",
      });
      expect(adapter.reload).toHaveBeenCalledWith("local-win");

      adapter.reload.mockClear();
      await expect(
        call("peers:window:activate", { hostId: "host-aaaaaaaa", profileId: "home" }, PEER_SENDER),
      ).resolves.toEqual({
        reloaded: false,
      });
      expect(runtime.setPeerWindowProfile).toHaveBeenCalledWith("peer-win", "home");
      expect(runtime.convertWindowToPeer).toHaveBeenCalledTimes(1);
      expect(adapter.reload).not.toHaveBeenCalled();
      dispose();
    });

    test("activate from a window of another host retargets it in place and reloads it, without a local detour", async () => {
      const { runtime, adapter, call, dispose } = setup();
      await expect(
        call("peers:window:activate", { hostId: "host-bbbbbbbb", profileId: "home" }, PEER_SENDER),
      ).resolves.toEqual({ reloaded: true });
      expect(runtime.retargetPeerWindow).toHaveBeenCalledWith("peer-win", {
        hostId: "host-bbbbbbbb",
        profileId: "home",
      });
      expect(runtime.convertWindowToPeer).not.toHaveBeenCalled();
      expect(runtime.convertWindowToLocal).not.toHaveBeenCalled();
      expect(runtime.setPeerWindowProfile).not.toHaveBeenCalled();
      expect(adapter.reload).toHaveBeenCalledWith("peer-win");
      dispose();
    });

    test("open and activate refuse a host that is not online, with the reason, and change nothing", async () => {
      const { runtime, adapter, call, dispose } = setup();
      runtime.requirePeerHostOnline = vi.fn(async () => {
        throw new Error("Mac cannot be reached.");
      }) as never;
      await expect(call("peers:window:open", { hostId: "host-aaaaaaaa", profileId: "work" })).rejects.toThrow(
        "Mac cannot be reached.",
      );
      await expect(
        call("peers:window:activate", { hostId: "host-aaaaaaaa", profileId: "work" }, LOCAL_SENDER),
      ).rejects.toThrow("Mac cannot be reached.");
      await expect(
        call("peers:window:activate", { hostId: "host-bbbbbbbb", profileId: "work" }, PEER_SENDER),
      ).rejects.toThrow("Mac cannot be reached.");
      expect(runtime.requirePeerHostOnline).toHaveBeenCalledWith("host-aaaaaaaa");
      expect(runtime.createPeerWindowSlot).not.toHaveBeenCalled();
      expect(runtime.convertWindowToPeer).not.toHaveBeenCalled();
      expect(runtime.retargetPeerWindow).not.toHaveBeenCalled();
      expect(runtime.setPeerWindowProfile).not.toHaveBeenCalled();
      expect(adapter.open).not.toHaveBeenCalled();
      expect(adapter.reload).not.toHaveBeenCalled();
      dispose();
    });

    test("the gate runs before the slot is created", async () => {
      const { runtime, call, dispose } = setup();
      const order: string[] = [];
      runtime.requirePeerHostOnline = vi.fn(async () => {
        order.push("gate");
        return {};
      }) as never;
      runtime.createPeerWindowSlot = vi.fn(async () => {
        order.push("slot");
        return { id: "new-peer-win" };
      }) as never;
      await call("peers:window:open", { hostId: "host-aaaaaaaa", profileId: "work" });
      expect(order).toEqual(["gate", "slot"]);
      dispose();
    });

    test("font-size writes this desktop's size for a peer window only, inside the setting's range", async () => {
      const { runtime, call, dispose } = setup();
      await expect(call("peers:window:font-size", { size: 20 })).resolves.toBe(true);
      expect(runtime.setPeerWindowFontSize).toHaveBeenCalledWith(20);
      for (const size of [8, 32]) await expect(call("peers:window:font-size", { size })).resolves.toBe(true);
      for (const bad of [{ size: 7 }, { size: 33 }, { size: 13.5 }, { size: "13" }, {}, { size: 13, extra: 1 }]) {
        await expect(call("peers:window:font-size", bad)).rejects.toThrow("IPC validation failed");
      }
      await expect(call("peers:window:font-size", { size: 12 }, LOCAL_SENDER)).rejects.toThrow("not attached");
      expect(runtime.setPeerWindowFontSize).toHaveBeenCalledTimes(3);
      dispose();
    });

    test("activate-local converts a peer window back and reloads it; set-profile and attention act on the caller", async () => {
      const { runtime, adapter, call, dispose } = setup();
      await expect(call("peers:window:activate-local", { profileId: "default" })).resolves.toEqual({ reloaded: true });
      expect(runtime.convertWindowToLocal).toHaveBeenCalledWith("peer-win", "default");
      expect(adapter.reload).toHaveBeenCalledWith("peer-win");

      await expect(call("peers:window:set-profile", { profileId: "work" })).resolves.toBe(true);
      expect(runtime.setPeerWindowProfile).toHaveBeenCalledWith("peer-win", "work");

      await call("peers:window:attention", { count: 4 });
      expect(adapter.setAttention).toHaveBeenCalledWith("peer-win", 4);
      await expect(call("peers:window:attention", { count: 4 }, LOCAL_SENDER)).rejects.toThrow("not attached");
      for (const bad of [{ count: -1 }, { count: 10000 }, { count: 1.5 }, { count: "3" }, {}])
        await expect(call("peers:window:attention", bad)).rejects.toThrow("IPC validation failed");
      expect(adapter.setAttention).toHaveBeenCalledTimes(1);
      dispose();
    });

    test("without a window adapter the three window operations reject and change nothing", async () => {
      const { runtime, call, dispose } = setup({ adapter: false });
      await expect(call("peers:window:open", { hostId: "host-aaaaaaaa", profileId: "work" })).rejects.toThrow(
        /not available/,
      );
      await expect(
        call("peers:window:activate", { hostId: "host-aaaaaaaa", profileId: "work" }, LOCAL_SENDER),
      ).rejects.toThrow(/not available/);
      await expect(call("peers:window:activate-local", { profileId: "default" })).rejects.toThrow(/not available/);
      expect(runtime.createPeerWindowSlot).not.toHaveBeenCalled();
      expect(runtime.convertWindowToPeer).not.toHaveBeenCalled();
      expect(runtime.convertWindowToLocal).not.toHaveBeenCalled();
      dispose();
    });

    test("window:get-backend answers for the calling window", async () => {
      const { call, dispose } = setup();
      await expect(call("window:get-backend", undefined, LOCAL_SENDER)).resolves.toEqual({ kind: "local" });
      await expect(call("window:get-backend")).resolves.toMatchObject({
        kind: "peer",
        hostId: "host-aaaaaaaa",
        clientId: "w123",
      });
      dispose();
    });
  });

  describe("host management", () => {
    test("each channel validates its strict payload and then calls the runtime", async () => {
      const peer = {
        listPeerHosts: vi.fn(async () => []),
        refreshPeerHost: vi.fn(async () => null),
        startPeerPairing: vi.fn(async () => ({})),
        cancelPeerPairing: vi.fn(() => undefined),
        removePeerHost: vi.fn(async () => true),
        updatePeerHostAddress: vi.fn(async () => true),
        renamePeerHost: vi.fn(async () => true),
        getLocalProfilesOverview: vi.fn(() => []),
      };
      const { call, dispose } = setup({ peer });
      await call("peers:client:list", undefined, LOCAL_SENDER);
      await call("peers:client:refresh", { hostId: "host-aaaaaaaa" }, LOCAL_SENDER);
      expect(peer.refreshPeerHost).toHaveBeenLastCalledWith("host-aaaaaaaa", { force: false });
      await call("peers:client:refresh", { hostId: "host-aaaaaaaa", force: true }, LOCAL_SENDER);
      expect(peer.refreshPeerHost).toHaveBeenLastCalledWith("host-aaaaaaaa", { force: true });
      await call("peers:client:pair:start", { address: "192.168.1.9", port: 43124 }, LOCAL_SENDER);
      expect(peer.startPeerPairing).toHaveBeenCalledWith({ address: "192.168.1.9", port: 43124 });
      await call("peers:client:pair:cancel", { attemptId: "attempt-0001" }, LOCAL_SENDER);
      expect(peer.cancelPeerPairing).toHaveBeenCalledWith("attempt-0001");
      await call("peers:client:remove", { hostId: "host-aaaaaaaa" }, LOCAL_SENDER);
      expect(peer.removePeerHost).toHaveBeenCalledWith("host-aaaaaaaa");
      const update = { hostId: "host-aaaaaaaa", address: "10.0.0.2", port: 43125 };
      await call("peers:client:update-address", update, LOCAL_SENDER);
      expect(peer.updatePeerHostAddress).toHaveBeenCalledWith(update);
      await call("peers:client:rename", { hostId: "host-aaaaaaaa", label: "  Office  " }, LOCAL_SENDER);
      expect(peer.renamePeerHost).toHaveBeenCalledWith({ hostId: "host-aaaaaaaa", label: "Office" });
      await call("peers:local-profiles", undefined, LOCAL_SENDER);
      expect(peer.getLocalProfilesOverview).toHaveBeenCalledTimes(1);

      for (const [channel, bad] of [
        ["peers:client:refresh", { hostId: "x" }],
        ["peers:client:refresh", { hostId: "host-aaaaaaaa", force: "yes" }],
        ["peers:client:pair:start", { address: "bad host!", port: 43124 }],
        ["peers:client:pair:start", { address: "h", port: 0 }],
        ["peers:client:pair:cancel", {}],
        ["peers:client:remove", "host-aaaaaaaa"],
        ["peers:client:update-address", { address: "h", port: 1 }],
        ["peers:client:rename", { hostId: "host-aaaaaaaa", label: "   " }],
        ["peers:client:rename", { hostId: "host-aaaaaaaa", label: "x".repeat(65) }],
        ["peers:client:rename", { hostId: "host-aaaaaaaa", label: "ok", extra: 1 }],
      ] as const) {
        await expect(call(channel, bad, LOCAL_SENDER), channel).rejects.toThrow("IPC validation failed");
      }
      expect(peer.startPeerPairing).toHaveBeenCalledTimes(1);
      dispose();
    });

    test("the end of a pairing attempt reaches desktop windows", () => {
      const handlers = new Map<string, (payload: unknown) => void>();
      const callable = (..._args: unknown[]): unknown => callable;
      const runtime = new Proxy(
        {},
        {
          get: (_target, prop) =>
            prop === "on"
              ? (event: string, cb: (payload: unknown) => void) => {
                  handlers.set(event, cb);
                  return () => {};
                }
              : callable,
        },
      ) as Parameters<typeof registerIpc>[0];
      const emitted: Array<{ channel: string; payload: unknown }> = [];
      const dispose = registerIpc(runtime, (channel, payload) => emitted.push({ channel, payload }));
      handlers.get("peers:pairing-result")!({ attemptId: "attempt-0001", state: "approved" });
      expect(emitted).toContainEqual({
        channel: "peers:pairing-result",
        payload: { attemptId: "attempt-0001", state: "approved" },
      });
      dispose();
    });
  });
});

describe("registerIpc — attaching profiles between desktops (host side)", () => {
  beforeEach(() => {
    resetIpcMainMock();
  });

  const pairingId = "pairing-0001";
  const deviceId = "device-0001";
  type Handler = (event: unknown, payload?: unknown) => Promise<unknown>;

  function setup() {
    const runtime = makeRuntimeStub();
    runtime.getPeerHostState = vi.fn(() => ({ marker: "state" })) as never;
    runtime.setPeerHosting = vi.fn(async () => ({ marker: "state" })) as never;
    runtime.approvePeerPairing = vi.fn(async () => "approved") as never;
    runtime.rejectPeerPairing = vi.fn(() => true) as never;
    runtime.removePeerDevice = vi.fn(async () => true) as never;
    runtime.renamePeerDevice = vi.fn(async () => true) as never;
    const dispose = registerIpc(runtime, () => {});
    const call = (channel: string, payload?: unknown) => (handleRegistry.get(channel) as Handler)({}, payload);
    return { runtime, dispose, call };
  }

  test("each channel validates its strict payload and then calls the runtime", async () => {
    const { runtime, dispose, call } = setup();
    try {
      await call("peers:host:get");
      expect(runtime.getPeerHostState).toHaveBeenCalledTimes(1);

      await call("peers:host:set-hosting", { enabled: true, port: 43124 });
      expect(runtime.setPeerHosting).toHaveBeenCalledWith({ enabled: true, port: 43124 });

      await expect(call("peers:host:approve", { pairingId, code: "12345678" })).resolves.toBe("approved");
      expect(runtime.approvePeerPairing).toHaveBeenCalledWith({ pairingId, code: "12345678" });

      await expect(call("peers:host:reject", { pairingId })).resolves.toBe(true);
      expect(runtime.rejectPeerPairing).toHaveBeenCalledWith(pairingId);

      await expect(call("peers:host:remove-device", { deviceId })).resolves.toBe(true);
      expect(runtime.removePeerDevice).toHaveBeenCalledWith(deviceId);

      await expect(call("peers:host:device:rename", { deviceId, name: " Desk " })).resolves.toBe(true);
      expect(runtime.renamePeerDevice).toHaveBeenCalledWith({ deviceId, name: "Desk" });
    } finally {
      dispose();
    }
  });

  test("junk payloads are refused before the runtime is touched", async () => {
    const { runtime, dispose, call } = setup();
    try {
      await expect(call("peers:host:set-hosting", { enabled: true, port: 0 })).rejects.toThrow("IPC validation failed");
      await expect(call("peers:host:set-hosting", { enabled: "yes", port: 43124 })).rejects.toThrow(
        "IPC validation failed",
      );
      await expect(call("peers:host:set-hosting", { enabled: true, port: 43124, extra: 1 })).rejects.toThrow(
        "IPC validation failed",
      );
      await expect(call("peers:host:approve", { pairingId: "x", code: "1" })).rejects.toThrow("IPC validation failed");
      await expect(call("peers:host:reject", "pairing-0001")).rejects.toThrow("IPC validation failed");
      await expect(call("peers:host:remove-device", {})).rejects.toThrow("IPC validation failed");
      await expect(call("peers:host:device:rename", { deviceId, name: "" })).rejects.toThrow("IPC validation failed");
      await expect(call("peers:host:device:rename", { deviceId, name: "x".repeat(65) })).rejects.toThrow(
        "IPC validation failed",
      );
      expect(runtime.renamePeerDevice).not.toHaveBeenCalled();
      expect(runtime.setPeerHosting).not.toHaveBeenCalled();
      expect(runtime.approvePeerPairing).not.toHaveBeenCalled();
      expect(runtime.rejectPeerPairing).not.toHaveBeenCalled();
      expect(runtime.removePeerDevice).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  test("pairing progress and updates reach desktop windows", () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const callable = (..._args: unknown[]): unknown => callable;
    const runtime = new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "on"
            ? (event: string, cb: (payload: unknown) => void) => {
                handlers.set(event, cb);
                return () => {};
              }
            : callable,
      },
    ) as Parameters<typeof registerIpc>[0];
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const dispose = registerIpc(runtime, (channel, payload) => emitted.push({ channel, payload }));
    handlers.get("peers:pairing-progress")!({ pairingId, state: "awaiting-approval" });
    handlers.get("peers:updated")!({});
    expect(emitted).toContainEqual({
      channel: "peers:pairing-progress",
      payload: { pairingId, state: "awaiting-approval" },
    });
    expect(emitted).toContainEqual({ channel: "peers:updated", payload: {} });
    dispose();
  });
});

describe("attachment transfer IPC", () => {
  beforeEach(() => {
    resetIpcMainMock();
  });

  async function withWindows(
    run: (
      invoke: (sender: number, channel: string, payload: unknown) => Promise<Record<string, unknown>>,
    ) => Promise<void>,
  ) {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-ipc-attachments-"));
    const runtime = makeRuntimeStub() as unknown as { getPayload: () => unknown };
    runtime.getPayload = () => ({
      appState: {
        workspaces: [
          { id: "ws", profileId: "p1", kind: "manual", cwd: root, panels: [] },
          { id: "ssh-ws", profileId: "p1", kind: "ssh", cwd: root, panels: [] },
          { id: "other-ws", profileId: "p2", kind: "manual", cwd: root, panels: [] },
        ],
        windowSlots: [
          { id: "window-a", profileId: "p1" },
          { id: "window-b", profileId: "p1" },
        ],
      },
    });
    const senders: Record<number, string> = { 1: "window-a", 2: "window-b" };
    const dispose = registerIpc(runtime as never, () => {}, { getWindowIdByWebContentsId: (id) => senders[id] });
    const invoke = (sender: number, channel: string, payload: unknown) =>
      (handleRegistry.get(channel) as (event: unknown, payload: unknown) => Promise<Record<string, unknown>>)(
        { sender: { id: sender } },
        payload,
      );
    try {
      await run(invoke);
    } finally {
      dispose();
      await rm(root, { recursive: true, force: true });
    }
  }

  test("each channel validates its payload and reaches the implementation with the window as owner", async () => {
    await withWindows(async (invoke) => {
      const data = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("rest")]);
      const begin = await invoke(1, "attachment:upload:begin", { workspaceId: "ws", name: "a.png", size: data.length });
      expect(begin).toMatchObject({ chunkBytes: 512 * 1024, received: 0 });
      const block = { workspaceId: "ws", transferId: begin.transferId, offset: 0, data: data.toString("base64") };
      await expect(invoke(2, "attachment:upload:chunk", block)).rejects.toThrow(/owner/);
      await expect(invoke(1, "attachment:upload:chunk", block)).resolves.toEqual({ received: data.length });
      const finishPayload = { workspaceId: "ws", transferId: begin.transferId };
      await expect(invoke(2, "attachment:upload:finish", finishPayload)).rejects.toThrow(/owner/);
      const record = await invoke(1, "attachment:upload:finish", finishPayload);
      expect(record).toMatchObject({ name: "a.png", size: data.length, transferId: begin.transferId });
      const window = await invoke(2, "attachment:read", {
        workspaceId: "ws",
        transferId: begin.transferId,
        name: "a.png",
        offset: 0,
        length: 1024,
      });
      expect(window).toEqual({ data: data.toString("base64"), size: data.length, eof: true });
      const second = await invoke(1, "attachment:upload:begin", { workspaceId: "ws", name: "b.png", size: 3 });
      await expect(
        invoke(2, "attachment:upload:cancel", { workspaceId: "ws", transferId: second.transferId }),
      ).rejects.toThrow(/owner/);
      await expect(
        invoke(1, "attachment:upload:cancel", { workspaceId: "ws", transferId: second.transferId }),
      ).resolves.toEqual({ ok: true });
    });
  });

  test("refuses malformed payloads, an unknown window, another profile's workspace and SSH workspaces", async () => {
    await withWindows(async (invoke) => {
      const good = { workspaceId: "ws", name: "a.png", size: 5 };
      await expect(invoke(1, "attachment:upload:begin", { ...good, size: 0 })).rejects.toThrow(/validation failed/);
      await expect(invoke(1, "attachment:upload:begin", { ...good, extra: 1 })).rejects.toThrow(/validation failed/);
      await expect(
        invoke(1, "attachment:upload:chunk", { workspaceId: "ws", transferId: "nope", offset: 0, data: "AAAA" }),
      ).rejects.toThrow(/validation failed/);
      await expect(
        invoke(1, "attachment:read", { workspaceId: "ws", transferId: "nope", name: "a", offset: 0, length: 1 }),
      ).rejects.toThrow(/validation failed/);
      await expect(invoke(9, "attachment:upload:begin", good)).rejects.toThrow(/caller identity/);
      await expect(invoke(1, "attachment:upload:begin", { ...good, workspaceId: "other-ws" })).rejects.toThrow(
        /no local filesystem root/,
      );
      await expect(invoke(1, "attachment:upload:begin", { ...good, workspaceId: "ssh-ws" })).rejects.toThrow(
        /unavailable for SSH or container/,
      );
    });
  });

  test("none of the channels is allowed in a window attached to another desktop", async () => {
    const { PEER_WINDOW_ALLOWED_CHANNELS } = await import("../shared/peer-window-channels.js");
    for (const channel of [
      "attachment:upload:begin",
      "attachment:upload:chunk",
      "attachment:upload:finish",
      "attachment:upload:cancel",
      "attachment:read",
    ])
      expect(PEER_WINDOW_ALLOWED_CHANNELS.has(channel), channel).toBe(false);
  });
});
