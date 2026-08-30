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
    writeBuffer: vi.fn(),
    readBuffer: vi.fn(),
    readImage: () => ({ isEmpty: () => true }),
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
      get: () => callable,
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

    dispose();

    expect(handleRegistry.size).toBe(0);
    expect(new Set(removeHandlerCalls)).toEqual(registeredChannels);
    expect(removeHandlerCalls.length).toBe(registeredChannels.size);
  });

  test("every registered `on` channel is torn down via removeAllListeners", () => {
    const dispose = registerIpc(makeRuntimeStub(), () => {});

    const registeredListenerChannels = new Set(onRegistry.keys());
    expect(registeredListenerChannels).toEqual(new Set(["terminal:resize", "terminal:input", "log:renderer"]));

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

    expect(calls.map((call) => call.method)).toEqual(MUTATIONS.map((m) => m.method));
    for (const call of calls) {
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

    expect(calls[0].args[1]).toBe("");

    dispose();
  });
});
