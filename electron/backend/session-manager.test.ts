import { beforeEach, describe, expect, test, vi } from "vitest";

const handles: FakePtyHandle[] = [];
const spawnCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
let spawnError: Error | null = null;

class FakePtyHandle {
  dataHandlers: Array<(data: string) => void> = [];
  exitHandlers: Array<(info: { exitCode: number }) => void> = [];

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (info: { exitCode: number }) => void): void {
    this.exitHandlers.push(handler);
  }

  resize(): void {}

  write(): void {}

  kill(exitCode = 0): void {
    queueMicrotask(() => {
      this.exitHandlers.forEach((handler) => handler({ exitCode }));
    });
  }
}

vi.mock("node-pty", () => ({
  default: {
    spawn: vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
      if (spawnError) {
        throw spawnError;
      }
      const handle = new FakePtyHandle();
      handles.push(handle);
      spawnCalls.push({ file, args, options });
      return handle;
    }),
  },
}));

import { SessionManager, shellIntegrationEnv } from "./session-manager.js";

function createState() {
  return {
    activeWorkspaceId: "workspace-a",
    workspaces: [
      {
        id: "workspace-a",
        cwd: "/home/user/workspace",
        activePanelId: "shell",
        panels: [
          {
            id: "shell",
            title: "Shell",
            command: "",
            startup: "default",
          },
        ],
      },
    ],
  };
}

describe("SessionManager", () => {
  beforeEach(() => {
    handles.length = 0;
    spawnCalls.length = 0;
    spawnError = null;
  });

  test("hard restart spawns a fresh session and marks old exit as intentional", async () => {
    const manager = new SessionManager();
    const exits: unknown[] = [];
    manager.on("terminal:exit", (payload) => exits.push(payload));

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");
    const restarted = await manager.restartSession(
      createState() as Parameters<typeof manager.ensureSession>[0],
      "workspace-a:shell",
    );

    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      sessionId: "workspace-a:shell",
      intentional: true,
    });
    expect(handles).toHaveLength(2);
    expect(restarted?.status).toBe("running");
    expect(manager.sessions.get("workspace-a:shell")?.status).toBe("running");
  });

  test("emits terminal:spawned on every new process generation, incl. implicit respawn", async () => {
    // Review F6: an exited session respawned via ensureSession (NOT the
    // restart button) is a new generation — the runtime clears the previous
    // generation's replay on this event.
    const manager = new SessionManager();
    const spawns: unknown[] = [];
    manager.on("terminal:spawned", (payload) => spawns.push(payload));

    const state = createState() as Parameters<typeof manager.ensureSession>[0];
    manager.ensureSession(state, "workspace-a:shell");
    expect(spawns).toEqual([{ sessionId: "workspace-a:shell" }]);

    // A running session is returned as-is — no spurious generation boundary.
    manager.ensureSession(state, "workspace-a:shell");
    expect(spawns).toHaveLength(1);

    // Kill it, then ensureSession again → implicit respawn → second spawn event.
    handles[0].kill(1);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    manager.ensureSession(state, "workspace-a:shell");
    expect(spawns).toHaveLength(2);
    expect(handles).toHaveLength(2);
  });

  test("syncWithState emits terminal:removed for a panel that no longer exists in state", async () => {
    // Review F4: a panel removed via saveWorkspace → syncWithState kills the PTY
    // but the runtime also needs to drop its replay. syncWithState signals that
    // permanent removal so the replay store doesn't leak (and can't be
    // re-served) for a pane that is gone.
    const manager = new SessionManager();
    const removed: unknown[] = [];
    manager.on("terminal:removed", (payload) => removed.push(payload));

    const state = createState() as Parameters<typeof manager.ensureSession>[0];
    manager.ensureSession(state, "workspace-a:shell");

    // New state where workspace-a has no panels → the session is orphaned.
    // Spread the full (already AppState-typed) `state` so this stays a complete,
    // assignable AppState rather than an incomplete object literal that needs an
    // unsafe cast.
    const pruned = { ...state, workspaces: [{ ...state.workspaces[0], panels: [] }] };
    manager.syncWithState(pruned);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(removed).toEqual([{ sessionId: "workspace-a:shell" }]);
    expect(manager.sessions.get("workspace-a:shell")).toBeUndefined();
  });

  test("syncWithState emits terminal:removed for a FAILED-spawn panel once its panel is gone", async () => {
    // Review F3: a PTY spawn failure surfaces as terminal:data + null and is
    // never inserted into `sessions`, yet the runtime still records the error in
    // its replay store. syncWithState must still emit terminal:removed for it
    // when the panel disappears, or that replay entry leaks for a pane that no
    // longer exists — `sessions` alone can't reach a session that never existed.
    const manager = new SessionManager();
    const removed: unknown[] = [];
    manager.on("terminal:removed", (payload) => removed.push(payload));

    spawnError = new Error("boom");
    const state = createState() as Parameters<typeof manager.ensureSession>[0];
    expect(await manager.ensureSession(state, "workspace-a:shell")).toBeNull();
    expect(manager.sessions.get("workspace-a:shell")).toBeUndefined();

    // Panel still present → the failed spawn is not a removal yet.
    manager.syncWithState(state);
    expect(removed).toEqual([]);

    // Panel removed from state → the failed-spawn id is pruned too.
    const pruned = { ...state, workspaces: [{ ...state.workspaces[0], panels: [] }] };
    manager.syncWithState(pruned);
    expect(removed).toEqual([{ sessionId: "workspace-a:shell" }]);
  });

  test("an ssh2 connection failure joins failedSpawns so its replay is cleaned up", async () => {
    // Like the local PTY case above, an ssh2 failure emits terminal:spawned and
    // (via SshManager) an inline error banner — both leave a replay entry with
    // NO session inserted. Only failedSpawns can drive its terminal:removed
    // cleanup when the panel is later removed.
    const sshManager = { createSession: vi.fn().mockRejectedValue(new Error("connection refused")) };
    const manager = new SessionManager({ sshManager: sshManager as never });
    const removed: unknown[] = [];
    manager.on("terminal:removed", (payload) => removed.push(payload));

    const workspace = { id: "ws-ssh", panels: [{ id: "remote" }] };
    const panel = { id: "remote", title: "Remote", command: "ssh", launch: { sshHostId: "h1" } };
    const result = await manager.ensureSshSession(
      {} as never,
      workspace as never,
      panel as never,
      "ws-ssh:remote",
      {} as never,
    );
    expect(result).toBeNull();
    expect(manager.sessions.get("ws-ssh:remote")).toBeUndefined();
    expect(manager.failedSpawns.has("ws-ssh:remote")).toBe(true);

    // Panel still present → the failed spawn is not a removal yet.
    manager.syncWithState({ activeWorkspaceId: "ws-ssh", workspaces: [workspace] } as never);
    expect(removed).toEqual([]);

    // Panel removed from state → the failed-spawn id is pruned via failedSpawns.
    manager.syncWithState({ activeWorkspaceId: "ws-ssh", workspaces: [{ id: "ws-ssh", panels: [] }] } as never);
    expect(removed).toEqual([{ sessionId: "ws-ssh:remote" }]);
  });

  test("a WSL launch on a non-Windows host joins failedSpawns so its replay is cleaned up", async () => {
    // ensureWslSshSession short-circuits off-Windows: no session is inserted, but
    // it emits an error banner that lands in the runtime's replay store. Like the
    // system-ssh/ssh2 paths, only failedSpawns can drive its terminal:removed
    // cleanup once the panel is gone. Force non-win32 so this is deterministic on
    // a Windows dev box too.
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const manager = new SessionManager();
      const removed: unknown[] = [];
      manager.on("terminal:removed", (payload) => removed.push(payload));

      const workspace = { id: "ws-wsl", panels: [{ id: "remote" }] };
      const panel = { id: "remote", title: "Remote", launch: { sshHostId: "h1" } };
      const result = await manager.ensureWslSshSession(
        {} as never,
        workspace as never,
        panel as never,
        "ws-wsl:remote",
        {} as never,
      );
      expect(result).toBeNull();
      expect(manager.sessions.get("ws-wsl:remote")).toBeUndefined();
      expect(manager.failedSpawns.has("ws-wsl:remote")).toBe(true);

      // Panel removed from state → the failed-spawn id is pruned via failedSpawns.
      manager.syncWithState({ activeWorkspaceId: "ws-wsl", workspaces: [{ id: "ws-wsl", panels: [] }] } as never);
      expect(removed).toEqual([{ sessionId: "ws-wsl:remote" }]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  test("removeWorkspaceSessions prunes the deleted workspace's failed spawns", async () => {
    // deleteWorkspace/pruneOrphanedWorkspaces go through removeWorkspaceSessions
    // (not syncWithState), so a failed spawn's id would otherwise leak in the set
    // until an unrelated future sync. Prune it here, and only for THIS workspace.
    const manager = new SessionManager();

    spawnError = new Error("boom");
    const state = createState() as Parameters<typeof manager.ensureSession>[0];
    expect(await manager.ensureSession(state, "workspace-a:shell")).toBeNull();
    expect(manager.failedSpawns.has("workspace-a:shell")).toBe(true);

    // A failed spawn belonging to a DIFFERENT workspace must survive the prune.
    manager.failedSpawns.add("workspace-b:shell");

    await manager.removeWorkspaceSessions("workspace-a");

    expect(manager.failedSpawns.has("workspace-a:shell")).toBe(false);
    expect(manager.failedSpawns.has("workspace-b:shell")).toBe(true);
  });

  test("marks unexpected exits as non-intentional", () => {
    const manager = new SessionManager();
    const exits: unknown[] = [];
    manager.on("terminal:exit", (payload) => exits.push(payload));

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");
    handles[0].kill(7);
    return new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => {
      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({
        sessionId: "workspace-a:shell",
        exitCode: 7,
        intentional: false,
      });
    });
  });

  test("merges session-specific environment variables into the shell", () => {
    const manager = new SessionManager({
      getSessionEnv: ({ workspace, panel, sessionId }) => ({
        STRIDETERM_REVIEW_PR_KEY: `${workspace.id}:${panel.id}:${sessionId}`,
        STRIDETERM_REVIEW_BRIEF_MD: "/tmp/review/agent-brief.md",
      }),
    });

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");

    expect(spawnCalls).toHaveLength(1);
    expect((spawnCalls[0].options.env as Record<string, string>).STRIDETERM_REVIEW_PR_KEY).toBe(
      "workspace-a:shell:workspace-a:shell",
    );
    expect((spawnCalls[0].options.env as Record<string, string>).STRIDETERM_REVIEW_BRIEF_MD).toBe(
      "/tmp/review/agent-brief.md",
    );
  });

  test("uses session launch overrides for review-aware agent sessions", () => {
    // Use os.tmpdir() so the cwd actually exists on disk — SessionManager
    // now validates cwd before pty.spawn and falls back to $HOME when the
    // directory is missing, which would otherwise mask the override here.
    const reviewCwd = (() => {
      const os = require("node:os") as typeof import("node:os");
      return os.tmpdir();
    })();
    const manager = new SessionManager({
      getSessionLaunch: () => ({
        file: "claude",
        args: ["--mcp-config", '{"mcpServers":{}}'],
        cwd: reviewCwd,
        env: {
          STRIDETERM_REVIEW_MCP: "1",
        },
        skipCommandInjection: true,
      }),
    });

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].file).toBe("claude");
    expect(spawnCalls[0].args).toEqual(["--mcp-config", '{"mcpServers":{}}']);
    expect(spawnCalls[0].options.cwd).toBe(reviewCwd);
    expect((spawnCalls[0].options.env as Record<string, string>).STRIDETERM_REVIEW_MCP).toBe("1");
  });

  test("falls back to $HOME when workspace cwd is missing on disk", async () => {
    const os = require("node:os") as typeof import("node:os");
    const manager = new SessionManager();
    const dataEvents: Array<{ sessionId: string; data: string }> = [];
    manager.on("terminal:data", (payload) => dataEvents.push(payload));

    // createState's cwd /home/user/workspace doesn't exist on the CI box —
    // SessionManager should swap it for os.homedir() and emit a banner so the
    // user knows their shell didn't open where they expected.
    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options.cwd).toBe(os.homedir());
    // The warning banner is emitted via setTimeout — give it a tick to fire.
    await new Promise((r) => setTimeout(r, 250));
    const banner = dataEvents.find((e) => e.data.includes("does not exist"));
    expect(banner?.data).toContain("/home/user/workspace");
  });

  test("ignores resize errors after a pty has already exited", () => {
    const manager = new SessionManager();

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");
    handles[0].resize = vi.fn(() => {
      throw new Error("Cannot resize a pty that has already exited");
    });

    expect(() => manager.resizeSession("workspace-a:shell", 120, 40)).not.toThrow();
  });

  test("skips native resize when effective pty size is unchanged", () => {
    const manager = new SessionManager();

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");
    handles[0].resize = vi.fn();

    manager.resizeSession("workspace-a:shell", 120, 40);
    manager.resizeSession("workspace-a:shell", 120, 40);

    expect(handles[0].resize).toHaveBeenCalledTimes(1);
    expect(handles[0].resize).toHaveBeenCalledWith(120, 40);
  });

  test("injects shell integration env vars when enabled", () => {
    const manager = new SessionManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = createState();
    state.settings = { notifications: { shellIntegration: true } };
    // Use an explicit launch config with a recognized shell
    state.workspaces[0].panels[0].launch = { file: "pwsh.exe", args: ["-NoLogo"] };

    manager.ensureSession(state, "workspace-a:shell");

    const env = spawnCalls[0].options.env as Record<string, string>;
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBe("1");
    expect(env.STRIDETERM_SHELL_INTEGRATION_SCRIPT).toMatch(/pwsh\.ps1$/);
  });

  test("skips shell integration env when disabled in settings", () => {
    const manager = new SessionManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = createState();
    state.settings = { notifications: { shellIntegration: false } };
    state.workspaces[0].panels[0].launch = { file: "pwsh.exe", args: ["-NoLogo"] };

    manager.ensureSession(state, "workspace-a:shell");

    const env = spawnCalls[0].options.env as Record<string, string>;
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBeUndefined();
  });

  test("returns null and emits terminal data when pty spawn fails", async () => {
    const manager = new SessionManager();
    const terminalData: unknown[] = [];
    spawnError = new Error("bad cwd");
    manager.on("terminal:data", (payload) => terminalData.push(payload));

    const result = await manager.ensureSession(
      createState() as Parameters<typeof manager.ensureSession>[0],
      "workspace-a:shell",
    );

    expect(result).toBeNull();
    expect(manager.sessions.has("workspace-a:shell")).toBe(false);
    expect(terminalData).toHaveLength(1);
    expect(terminalData[0]).toMatchObject({
      sessionId: "workspace-a:shell",
      data: expect.stringContaining("bad cwd"),
    });
  });

  test("coalesces concurrent ssh session starts for the same session id", async () => {
    let resolveStart: (() => void) | undefined;
    const sshManager = {
      getHost: vi.fn(() => ({
        id: "host-a",
        host: "example.test",
        advanced: { launchVia: "ssh2" },
      })),
      createSession: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveStart = resolve;
          }),
      ),
    };
    const manager = new SessionManager({ sshManager: sshManager as never });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = createState();
    state.workspaces[0].activePanelId = "ssh";
    state.workspaces[0].panels[0] = {
      id: "ssh",
      title: "SSH",
      command: "ssh",
      startup: "default",
      launch: { kind: "ssh", sshHostId: "host-a" },
    };

    const first = manager.ensureSession(state, "workspace-a:ssh");
    const second = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();

    expect(sshManager.createSession).toHaveBeenCalledTimes(1);
    expect(resolveStart).toBeTypeOf("function");
    (resolveStart as () => void)();
    const [firstSession, secondSession] = await Promise.all([first, second]);

    expect(firstSession).toBe(secondSession);
    expect(manager.sessions.get("workspace-a:ssh")).toBe(firstSession);
  });

  function makeSshRaceSetup() {
    const settles: { resolve: () => void; reject: (_err: Error) => void }[] = [];
    const sshManager = {
      getHost: vi.fn(() => ({
        id: "host-a",
        host: "example.test",
        advanced: { launchVia: "ssh2" },
      })),
      createSession: vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            settles.push({ resolve, reject });
          }),
      ),
      stop: vi.fn(() => Promise.resolve()),
    };
    const manager = new SessionManager({ sshManager: sshManager as never });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = createState();
    state.workspaces[0].activePanelId = "ssh";
    state.workspaces[0].panels[0] = {
      id: "ssh",
      title: "SSH",
      command: "ssh",
      startup: "default",
      launch: { kind: "ssh", sshHostId: "host-a" },
    };
    // getSettle returns the most-recent in-flight connect (backward compatible
    // with the single-connect tests); getSettles exposes all of them for the case
    // where two connects for the same id overlap (disconnect + fast reconnect).
    return {
      manager,
      sshManager,
      state,
      getSettle: () => settles[settles.length - 1],
      getSettles: () => settles,
    };
  }

  test("discards an SSH start that connects AFTER its workspace was removed", async () => {
    // Race: a slow SSH connect is in flight (not yet in `sessions`), the
    // workspace is deleted (removeWorkspaceSessions iterates `sessions`, so it
    // can't see the pending start), then the connect succeeds. Without the
    // cancellation tombstone the start would insert an orphan session for a
    // workspace that no longer exists.
    const { manager, sshManager, state, getSettle } = makeSshRaceSetup();
    const removed: unknown[] = [];
    manager.on("terminal:removed", (payload) => removed.push(payload));

    const startPromise = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);

    await manager.removeWorkspaceSessions("workspace-a");

    getSettle()!.resolve();
    const result = await startPromise;

    expect(result).toBeNull();
    expect(manager.sessions.has("workspace-a:ssh")).toBe(false);
    expect(manager.failedSpawns.has("workspace-a:ssh")).toBe(false);
    // The connection that slipped through was torn down, and its replay dropped.
    expect(sshManager.stop).toHaveBeenCalledWith("workspace-a:ssh");
    expect(removed).toContainEqual({ sessionId: "workspace-a:ssh" });
  });

  test("discards a FAILED SSH start whose panel was pruned mid-connect (no failedSpawns leak)", async () => {
    // Same race on the failure branch: syncWithState prunes the panel while the
    // connect is pending, then the connect fails. ensureSshSession's catch would
    // re-add the id to failedSpawns (plus its error replay) AFTER the prune — a
    // resurrected orphan. The tombstone makes the late failure drop it again.
    const { manager, state, getSettle } = makeSshRaceSetup();
    const removed: unknown[] = [];
    manager.on("terminal:removed", (payload) => removed.push(payload));

    const startPromise = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();

    manager.syncWithState({
      activeWorkspaceId: "workspace-a",
      workspaces: [{ id: "workspace-a", panels: [] }],
    } as never);
    expect(removed).toEqual([]); // nothing known to cleanup yet — the start is still pending

    getSettle()!.reject(new Error("connection refused"));
    const result = await startPromise;

    expect(result).toBeNull();
    expect(manager.failedSpawns.has("workspace-a:ssh")).toBe(false);
    expect(removed).toContainEqual({ sessionId: "workspace-a:ssh" });
  });

  test("a normal SSH start after an unrelated prune is NOT discarded", async () => {
    // Guard against over-eager tombstoning: syncWithState pruning a DIFFERENT
    // panel must not cancel this workspace's in-flight start.
    const { manager, state, getSettle } = makeSshRaceSetup();

    const startPromise = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();

    // Prune keeps workspace-a:ssh valid — only an unrelated id is gone.
    manager.syncWithState(state);

    getSettle()!.resolve();
    const result = await startPromise;

    expect(result).not.toBeNull();
    expect(manager.sessions.get("workspace-a:ssh")).toBe(result);
  });

  test("Disconnect SSH during a pending connect keeps the panel subscribed for reconnect", async () => {
    // closeSession → removeSession while the connect is still in flight must
    // tear the session down WITHOUT emitting terminal:removed: the panel stays
    // visible, so terminal:removed would unsubscribe the id on the remote server
    // and freeze a later reconnect (subscription IDs don't change, so the client
    // never re-subscribes). A fresh start of the same id must still stream.
    const { manager, sshManager, state, getSettle } = makeSshRaceSetup();
    const removed: unknown[] = [];
    manager.on("terminal:removed", (payload) => removed.push(payload));

    // 1. Connect in flight.
    const first = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();

    // 2. User disconnects (panel stays) while still connecting.
    manager.removeSession("workspace-a:ssh");

    // 3. The connect resolves after the disconnect → the session is discarded.
    getSettle()!.resolve();
    expect(await first).toBeNull();
    expect(manager.sessions.has("workspace-a:ssh")).toBe(false);
    expect(sshManager.stop).toHaveBeenCalledWith("workspace-a:ssh");
    // Crucially: NO terminal:removed — the id stays subscribed on the server.
    expect(removed).toEqual([]);

    // 4. Reconnect: a fresh start of the same id is not discarded and streams.
    const second = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    getSettle()!.resolve();
    const session = await second;

    expect(session).not.toBeNull();
    expect(manager.sessions.get("workspace-a:ssh")).toBe(session);
    // The successful reconnect clears the orphan-replay marker left by the discard.
    expect(manager.failedSpawns.has("workspace-a:ssh")).toBe(false);
  });

  test("Reconnect during a disconnected pending connect CHAINS a fresh connect (no concurrency)", async () => {
    // Variant A + serialization: Disconnect aborts the in-flight connect but keeps
    // it tracked in startingSessions. A reconnect that races the still-pending
    // connect must NOT coalesce into the dying one AND must NOT spawn a second
    // concurrent connect — for system-ssh / WSL a duplicate PTY would be orphaned
    // and a late-succeeding stale start could overwrite the live session. Instead
    // it chains a FRESH connect that begins only after the aborted one is discarded.
    const { manager, sshManager, state, getSettles } = makeSshRaceSetup();
    const removed: unknown[] = [];
    manager.on("terminal:removed", (payload) => removed.push(payload));

    // 1. Connect in flight.
    const first = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);

    // 2. Disconnect while still connecting → aborts, but keeps the start tracked.
    manager.removeSession("workspace-a:ssh");
    expect(sshManager.stop).toHaveBeenCalledWith("workspace-a:ssh");

    // 3. Reconnect BEFORE the original settles → chained, NOT a second concurrent
    //    connect. No new createSession runs yet.
    const second = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);

    // 4. The aborted connect settles (even a SUCCESS) → discarded, panel stays
    //    subscribed (disconnected, not removed). Only THEN does the chained fresh
    //    connect begin — proving the two never ran concurrently.
    getSettles()[0]!.resolve();
    expect(await first).toBeNull();
    expect(removed).toEqual([]);
    expect(manager.sessions.has("workspace-a:ssh")).toBe(false);
    for (let i = 0; i < 10 && getSettles().length < 2; i++) await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(2);

    // 5. The fresh reconnect settles → it owns the session and streams.
    getSettles()[1]!.resolve();
    const session = await second;
    expect(session).not.toBeNull();
    expect(manager.sessions.get("workspace-a:ssh")).toBe(session);
    // The discarded start's orphan-replay marker is cleared by the successful reconnect.
    expect(manager.failedSpawns.has("workspace-a:ssh")).toBe(false);
  });

  test("a queued reconnect is discarded when a shutdown lands mid-chain (finding 2)", async () => {
    // Interleaves the two scenarios the prior tests cover separately: Disconnect
    // aborts start A and a reconnect chains start B behind it, THEN a shutdown
    // (stopAll) lands while A is still settling. When A finally resolves it is
    // discarded — and must NOT consume the "removed" intent recorded against B.
    // The old shared per-id tombstone was deleted by A's discard, so B saw no
    // reason and spawned a fresh session AFTER shutdown. With a per-generation
    // record, B keeps its own "removed" reason and correctly bails.
    const { manager, sshManager, state, getSettles } = makeSshRaceSetup();

    // 1. Connect A in flight.
    const first = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);

    // 2. Disconnect aborts A but keeps it tracked.
    manager.removeSession("workspace-a:ssh");

    // 3. Reconnect BEFORE A settles → chained start B (no new connect yet).
    const second = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);

    // 4. Shutdown while A is still settling and B is queued → tombstones the
    //    CURRENT generation (B) as "removed".
    manager.stopAll();

    // 5. A resolves late → discarded. B must honor its OWN "removed" reason and
    //    bail without opening a second connect after shutdown.
    getSettles()[0]!.resolve();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);
    expect(manager.sessions.has("workspace-a:ssh")).toBe(false);
    expect(manager.startingSessions.has("workspace-a:ssh")).toBe(false);
  });

  test("a second Disconnect on a QUEUED reconnect cancels it (finding 1)", async () => {
    // Connect A → Disconnect (aborts A, keeps it tracked) → Reconnect chains B
    // behind A → a SECOND Disconnect lands on the queued B. When A finally
    // settles, B must honor the second Disconnect and bail instead of opening a
    // fresh connect the user just asked to tear down. The old continuation
    // treated "disconnected" as "this IS the reconnect, start fresh", so B ran
    // anyway; it must bail on ANY non-null reason, not only "removed".
    const { manager, sshManager, state, getSettles } = makeSshRaceSetup();
    const removed: unknown[] = [];
    manager.on("terminal:removed", (payload) => removed.push(payload));

    // 1. Connect A in flight.
    const first = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);

    // 2. Disconnect aborts A but keeps it tracked.
    manager.removeSession("workspace-a:ssh");

    // 3. Reconnect BEFORE A settles → chained start B (no new connect yet).
    const second = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);

    // 4. A SECOND Disconnect lands on the queued B.
    manager.removeSession("workspace-a:ssh");

    // 5. A resolves late → discarded. B must honor the second Disconnect and bail
    //    without opening a fresh connect, and drop the record entirely.
    getSettles()[0]!.resolve();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);
    expect(manager.sessions.has("workspace-a:ssh")).toBe(false);
    expect(manager.startingSessions.has("workspace-a:ssh")).toBe(false);
    // Disconnect, not removal → the panel stays, so no terminal:removed fires.
    expect(removed).toEqual([]);
  });

  test("restartSession during an in-flight SSH connect aborts it and starts fresh (finding 3)", async () => {
    // A Restart issued while the connect is still parked (handshake / password /
    // MFA / host-key prompt) has no live session to stop, so the old code just
    // coalesced ensureSession into the SAME pending connect — a silent no-op. The
    // restart must abort the in-flight connect and serialize a fresh one.
    const { manager, sshManager, state, getSettles } = makeSshRaceSetup();

    // 1. Connect in flight (parked, not yet in `sessions`).
    const first = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);

    // 2. Restart while still connecting → aborts the in-flight connect.
    const restarted = manager.restartSession(state, "workspace-a:ssh");
    expect(sshManager.stop).toHaveBeenCalledWith("workspace-a:ssh");

    // 3. The aborted connect settles → a FRESH connect begins (proving the
    //    restart was not a no-op).
    getSettles()[0]!.resolve();
    expect(await first).toBeNull();
    for (let i = 0; i < 10 && getSettles().length < 2; i++) await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(2);

    // 4. The fresh connect owns the session.
    getSettles()[1]!.resolve();
    const session = await restarted;
    expect(session).not.toBeNull();
    expect(manager.sessions.get("workspace-a:ssh")).toBe(session);
  });

  test("a stale Disconnect must not downgrade a 'removed' cancellation to 'disconnected'", async () => {
    // Multi-client race: syncWithState prunes the panel (tombstone "removed" →
    // the late connect emits terminal:removed so the runtime drops the replay
    // AND the remote server unsubscribes the gone id). A stale Disconnect for the
    // same in-flight start must NOT degrade that to "disconnected", or the late
    // connect would keep the id subscribed and leak an orphan replay for a pane
    // that no longer exists. The invariant is removed > disconnected.
    const { manager, sshManager, state, getSettle } = makeSshRaceSetup();
    const removed: unknown[] = [];
    manager.on("terminal:removed", (payload) => removed.push(payload));

    const startPromise = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();

    // Panel pruned from state → "removed".
    manager.syncWithState({
      activeWorkspaceId: "workspace-a",
      workspaces: [{ id: "workspace-a", panels: [] }],
    } as never);
    // Stale Disconnect racing the prune must leave "removed" intact.
    manager.removeSession("workspace-a:ssh");

    getSettle()!.resolve();
    const result = await startPromise;

    expect(result).toBeNull();
    expect(sshManager.stop).toHaveBeenCalledWith("workspace-a:ssh");
    // "removed" survived → terminal:removed fired, replay + subscription dropped,
    // and no orphan failed-spawn marker is left behind (that is the "disconnected"
    // path's behavior, which must NOT run here).
    expect(removed).toContainEqual({ sessionId: "workspace-a:ssh" });
    expect(manager.failedSpawns.has("workspace-a:ssh")).toBe(false);
  });

  test("removing a workspace cancels a still-connecting SSH start", async () => {
    // A connect parked on a prompt / handshake never settles on its own, so the
    // "removed" tombstone (which is only consulted on resolve) never fires.
    // Removing the workspace must ACTIVELY cancel it, or the hung connect and
    // its prompt leak past the deletion.
    const { manager, sshManager, state, getSettle } = makeSshRaceSetup();

    const start = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);

    await manager.removeWorkspaceSessions("workspace-a");

    // Cancelled at removal time — before the connect ever settled.
    expect(sshManager.stop).toHaveBeenCalledWith("workspace-a:ssh");

    // Let the mock connect resolve so no promise dangles; it is discarded.
    getSettle()!.resolve();
    expect(await start).toBeNull();
  });

  test("pruning a panel via syncWithState cancels a still-connecting SSH start", async () => {
    const { manager, sshManager, state, getSettle } = makeSshRaceSetup();

    const start = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();

    manager.syncWithState({
      activeWorkspaceId: "workspace-a",
      workspaces: [{ id: "workspace-a", panels: [] }],
    } as never);

    // Same as workspace removal: the prune actively cancels the hung connect.
    expect(sshManager.stop).toHaveBeenCalledWith("workspace-a:ssh");

    getSettle()!.resolve();
    expect(await start).toBeNull();
  });

  test("stopAll cancels a still-connecting SSH start (shutdown mid-connect)", async () => {
    // At shutdown a connect may still be in flight (parked on a prompt / handshake).
    // It lives in startingSessions, not `sessions`, so the live-session loop misses
    // it — stopAll must ACTIVELY cancel it, or the unfinished socket survives
    // shutdown and holds the Node process open (or emits a late event).
    const { manager, sshManager, state, getSettle } = makeSshRaceSetup();
    const removed: unknown[] = [];
    manager.on("terminal:removed", (payload) => removed.push(payload));

    const start = manager.ensureSession(state, "workspace-a:ssh");
    await Promise.resolve();
    expect(sshManager.createSession).toHaveBeenCalledTimes(1);

    manager.stopAll();

    // Cancelled at shutdown — before the connect ever settled.
    expect(sshManager.stop).toHaveBeenCalledWith("workspace-a:ssh");

    // A late resolve is discarded (tombstoned "removed"), not re-inserted into the
    // cleared session map.
    getSettle()!.resolve();
    expect(await start).toBeNull();
    expect(manager.sessions.has("workspace-a:ssh")).toBe(false);
    expect(removed).toContainEqual({ sessionId: "workspace-a:ssh" });
  });

  function makeSshExitSetup() {
    let capturedOnExit: ((_e: { exitCode: number }) => void) | undefined;
    const sshManager = {
      getHost: vi.fn(() => ({
        id: "host-a",
        host: "example.test",
        advanced: { launchVia: "ssh2" },
      })),
      createSession: vi.fn((args: { onExit: (_e: { exitCode: number }) => void }) => {
        capturedOnExit = args.onExit;
        return Promise.resolve();
      }),
      // Mirror the real SshManager: stopping a live connection fires its onExit
      // (via the ssh2 stream/client close events).
      stop: vi.fn(() => {
        capturedOnExit?.({ exitCode: 0 });
        return Promise.resolve();
      }),
    };
    const manager = new SessionManager({ sshManager: sshManager as never });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = createState();
    state.workspaces[0].activePanelId = "ssh";
    state.workspaces[0].panels[0] = {
      id: "ssh",
      title: "SSH",
      command: "ssh",
      startup: "default",
      launch: { kind: "ssh", sshHostId: "host-a" },
    };
    return { manager, sshManager, state, getOnExit: () => capturedOnExit };
  }

  test("an intentional SSH teardown reports intentional:true (no unexpected-exit noise)", async () => {
    // A pure ssh2 session has no PTY handle and is torn down via
    // sshManager.stop(), which fires its onExit. Unlike the PTY path there is no
    // suppressNextExit arming, so without marking the session the exit would be
    // reported intentional:false — the runtime would then fold a spurious
    // "[process exited]" into the replay and could raise an unexpected-exit
    // alert for a user-driven disconnect.
    const { manager, sshManager, state } = makeSshExitSetup();
    const exits: unknown[] = [];
    manager.on("terminal:exit", (payload) => exits.push(payload));

    const session = await manager.ensureSession(state, "workspace-a:ssh");
    expect(session).not.toBeNull();

    manager.removeSession("workspace-a:ssh");

    expect(sshManager.stop).toHaveBeenCalledWith("workspace-a:ssh");
    expect(exits).toEqual([{ sessionId: "workspace-a:ssh", exitCode: 0, intentional: true }]);
  });

  test("an unmarked SSH exit (server dropped the connection) stays intentional:false", async () => {
    // Guard the other direction: an exit that arrives WITHOUT an intentional
    // teardown (the remote side closed the connection) must still be reported as
    // unexpected so the runtime keeps the replay and can alert.
    const { manager, state, getOnExit } = makeSshExitSetup();
    const exits: unknown[] = [];
    manager.on("terminal:exit", (payload) => exits.push(payload));

    await manager.ensureSession(state, "workspace-a:ssh");
    getOnExit()!({ exitCode: 1 });

    expect(exits).toEqual([{ sessionId: "workspace-a:ssh", exitCode: 1, intentional: false }]);
  });
});

describe("shellIntegrationEnv", () => {
  test("returns PROMPT_COMMAND for bash", () => {
    const env = shellIntegrationEnv("/bin/bash", true);
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBe("1");
    expect(env.BASH_ENV).toMatch(/bash\.sh$/);
    expect(env.PROMPT_COMMAND).toMatch(/source/);
  });

  test("returns integration script path for zsh", () => {
    const env = shellIntegrationEnv("/usr/bin/zsh", true);
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBe("1");
    expect(env.STRIDETERM_SHELL_INTEGRATION_SCRIPT).toMatch(/zsh\.sh$/);
  });

  test("returns integration script path for pwsh", () => {
    const env = shellIntegrationEnv("pwsh.exe", true);
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBe("1");
    expect(env.STRIDETERM_SHELL_INTEGRATION_SCRIPT).toMatch(/pwsh\.ps1$/);
  });

  test("returns empty object when disabled", () => {
    const env = shellIntegrationEnv("/bin/bash", false);
    expect(env).toEqual({});
  });

  test("returns empty object for unrecognized shells", () => {
    const env = shellIntegrationEnv("/usr/bin/fish", true);
    expect(env).toEqual({});
  });
});
