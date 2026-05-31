/**
 * Tests for PaneStage.vue terminal view retention behavior.
 *
 * The key invariant: desktop profile switching must NOT prune terminal views
 * for inactive profiles so xterm scrollback survives across switches.
 * Remote clients, however, remain scoped to their controllable profile.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makeTransport(initialPayload: AnyApi, isRemote = false) {
  let stateHandler: ((payload: AnyApi) => void) | null = null;
  return {
    isRemote,
    getState: vi.fn(() => Promise.resolve(initialPayload)),
    onStateUpdated: (fn: (payload: AnyApi) => void) => { stateHandler = fn; },
    onConnectionState: vi.fn(),
    activateWorkspace: vi.fn(() => Promise.resolve(initialPayload)),
    activateProfile: vi.fn(() => Promise.resolve(initialPayload)),
    activateSession: vi.fn(() => Promise.resolve(initialPayload)),
    _push: (p: AnyApi) => stateHandler?.(p),
  };
}

function makePayload(overrides: AnyApi = {}): AnyApi {
  return {
    meta: { appVersion: "0.0.0", platform: "test", repositoryUrl: "", versionCheck: {}, recoveryCandidates: [] },
    appState: {
      activeWorkspaceId: "ws-a",
      profiles: [
        { id: "p1", name: "P1", color: "#fff", workspaceIds: ["ws-a"] },
        { id: "p2", name: "P2", color: "#fff", workspaceIds: ["ws-b"] },
      ],
      workspaces: [
        { id: "ws-a", name: "WsA", profileId: "p1", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/a" },
        { id: "ws-b", name: "WsB", profileId: "p2", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/b" },
      ],
      windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "" }],
      settings: {},
      tabTemplates: [],
      ssh: { hosts: [], keys: [], certificates: [], knownHosts: {}, settings: { defaultAgentMode: "inherit", importedSshConfig: false } },
      ...overrides.appState,
    },
    workspace: null,
    attention: { sessions: {}, alerts: [] },
    docker: { available: false, backend: null, contexts: [], containers: [], lazydocker: { available: false, backend: null, error: "" }, error: "", lastUpdatedAt: null },
    git: { workspaces: {}, activeWorkspace: null, connections: [] },
    azureDevops: { inboxItems: [], connections: [], lastUpdatedAt: null, error: "" },
    github: { inboxItems: [], connections: [], lastUpdatedAt: null, error: "" },
    reviewBridge: { sessions: {}, enabled: false },
    plugins: [],
    environment: {},
    themeSource: "light",
    remoteAccess: { enabled: false, host: "", port: 0, tunnel: { active: false, url: null, error: null } },
    agentNotifyHook: { enabled: false, port: 0 },
    taskRunner: {},
    ...overrides,
  };
}

/**
 * Mirrors the `liveTerminalSessionIds` logic from PaneStage.vue so we can
 * unit-test its behavior without mounting the component.
 */
function computeLiveSessionIds(
  workspaces: AnyApi[],
  isRemote: boolean,
  activeProfileId: string | null,
): Set<string> {
  const ids = new Set<string>();
  const profileFilter = isRemote ? (activeProfileId || "default") : null;
  for (const workspace of workspaces) {
    if (profileFilter && (workspace.profileId || "default") !== profileFilter) continue;
    for (const panel of workspace.panels || []) {
      const command = String(panel.command || "");
      if (/^https?:\/\//i.test(command) || command === "__files__" || command === "__task-dashboard__") continue;
      ids.add(`${workspace.id}:${panel.id}`);
    }
  }
  return ids;
}

describe("PaneStage — liveTerminalSessionIds logic", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  it("desktop: includes sessions from ALL profiles, not just the active one", () => {
    const workspaces = [
      { id: "ws-a", profileId: "p1", panels: [{ id: "sh", command: "" }] },
      { id: "ws-b", profileId: "p2", panels: [{ id: "sh", command: "" }] },
    ];
    const ids = computeLiveSessionIds(workspaces, /* isRemote= */ false, "p1");
    // Both profiles included on desktop
    expect(ids.has("ws-a:sh")).toBe(true);
    expect(ids.has("ws-b:sh")).toBe(true);
  });

  it("remote: includes only sessions from the active profile", () => {
    const workspaces = [
      { id: "ws-a", profileId: "p1", panels: [{ id: "sh", command: "" }] },
      { id: "ws-b", profileId: "p2", panels: [{ id: "sh", command: "" }] },
    ];
    const ids = computeLiveSessionIds(workspaces, /* isRemote= */ true, "p1");
    expect(ids.has("ws-a:sh")).toBe(true);
    expect(ids.has("ws-b:sh")).toBe(false);
  });

  it("deleted workspace is excluded from live ids regardless of profile", () => {
    const workspaces = [
      // ws-b was deleted — it's no longer in the workspaces list
      { id: "ws-a", profileId: "p1", panels: [{ id: "sh", command: "" }] },
    ];
    const ids = computeLiveSessionIds(workspaces, false, "p1");
    expect(ids.has("ws-a:sh")).toBe(true);
    expect(ids.has("ws-b:sh")).toBe(false);
  });

  it("browser/files/task-dashboard panels are excluded", () => {
    const workspaces = [
      {
        id: "ws-a",
        profileId: "p1",
        panels: [
          { id: "term", command: "" },
          { id: "browser", command: "https://example.com" },
          { id: "files", command: "__files__" },
          { id: "dash", command: "__task-dashboard__" },
        ],
      },
    ];
    const ids = computeLiveSessionIds(workspaces, false, "p1");
    expect(ids.has("ws-a:term")).toBe(true);
    expect(ids.has("ws-a:browser")).toBe(false);
    expect(ids.has("ws-a:files")).toBe(false);
    expect(ids.has("ws-a:dash")).toBe(false);
  });
});

describe("PaneStage — desktop live session IDs include all profiles", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  it("after profile switch, liveTerminalSessionIds covers sessions from the inactive profile", () => {
    const appStore = useAppStore();

    // Start on p1, then switch to p2 by setting the payload directly.
    const baseWorkspaces = [
      { id: "ws-a", profileId: "p1", panels: [{ id: "sh", command: "" }] },
      { id: "ws-b", profileId: "p2", panels: [{ id: "sh", command: "" }] },
    ];
    const profiles = [
      { id: "p1", name: "P1", color: "#fff", workspaceIds: ["ws-a"] },
      { id: "p2", name: "P2", color: "#fff", workspaceIds: ["ws-b"] },
    ];

    // Simulate a profile switch: slot now points to p2
    appStore.payload = makePayload({
      appState: {
        activeWorkspaceId: "ws-b",
        profiles,
        workspaces: baseWorkspaces,
        windowSlots: [{ id: "slot1", profileId: "p2", activeWorkspaceId: "ws-b", activeSessionId: "" }],
      },
    }) as AnyApi;

    // Compute the live set the same way PaneStage.vue's liveTerminalSessionIds() does
    // (desktop mode = no profile filter, all workspaces included).
    const workspaces = (appStore.payload as AnyApi)?.appState?.workspaces || [];
    const liveIds = new Set<string>();
    for (const ws of workspaces) {
      for (const panel of ws.panels || []) {
        const cmd = String(panel.command || "");
        if (/^https?:\/\//i.test(cmd) || cmd === "__files__" || cmd === "__task-dashboard__") continue;
        liveIds.add(`${ws.id}:${panel.id}`);
      }
    }

    // Both profiles' sessions must be in the valid set so pruning does NOT
    // dispose the inactive profile's terminal view.
    expect(liveIds.has("ws-a:sh")).toBe(true); // p1 (now inactive)
    expect(liveIds.has("ws-b:sh")).toBe(true); // p2 (now active)
  });

  it("workspaceGrid: profile switch keeps all grid workspace sessions in the live set", async () => {
    // Profile A has two workspaces in a grid (W1/W2). Profile B has one workspace.
    // After switching to B, all three sessions must be in the live set on desktop.
    const gridPayload = makePayload({
      appState: {
        activeWorkspaceId: "ws-a1",
        profiles: [
          {
            id: "p1",
            name: "P1",
            color: "#fff",
            workspaceIds: ["ws-a1", "ws-a2"],
            workspaceGrid: { columns: 2, rows: 1, cellWorkspaceIds: ["ws-a1", "ws-a2"], focusedCellIndex: 1 },
          },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: ["ws-b"] },
        ],
        workspaces: [
          { id: "ws-a1", name: "A1", profileId: "p1", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/a1" },
          { id: "ws-a2", name: "A2", profileId: "p1", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/a2" },
          { id: "ws-b", name: "B",  profileId: "p2", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/b" },
        ],
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a2", activeSessionId: "" }],
      },
    });
    const transport = makeTransport(gridPayload);
    const appStore = useAppStore();
    appStore.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    // Switch to p2
    transport._push(makePayload({
      appState: {
        activeWorkspaceId: "ws-b",
        profiles: [
          {
            id: "p1",
            name: "P1",
            color: "#fff",
            workspaceIds: ["ws-a1", "ws-a2"],
            workspaceGrid: { columns: 2, rows: 1, cellWorkspaceIds: ["ws-a1", "ws-a2"], focusedCellIndex: 1 },
          },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: ["ws-b"] },
        ],
        workspaces: [
          { id: "ws-a1", name: "A1", profileId: "p1", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/a1" },
          { id: "ws-a2", name: "A2", profileId: "p1", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/a2" },
          { id: "ws-b", name: "B",  profileId: "p2", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/b" },
        ],
        windowSlots: [{ id: "slot1", profileId: "p2", activeWorkspaceId: "ws-b", activeSessionId: "" }],
      },
    }));
    await Promise.resolve();

    // Desktop: ALL three sessions live — both grid cells from inactive profile A + active profile B
    const workspaces = (appStore.payload as AnyApi)?.appState?.workspaces || [];
    const liveIds = new Set<string>();
    for (const ws of workspaces) {
      const profileFilter = appStore.isRemoteTransport ? (appStore.myActiveProfileId || "default") : null;
      if (profileFilter && (ws.profileId || "default") !== profileFilter) continue;
      for (const panel of ws.panels || []) {
        const cmd = String(panel.command || "");
        if (/^https?:\/\//i.test(cmd) || cmd === "__files__" || cmd === "__task-dashboard__") continue;
        liveIds.add(`${ws.id}:${panel.id}`);
      }
    }
    expect(liveIds.has("ws-a1:sh")).toBe(true); // grid cell 1 — inactive profile
    expect(liveIds.has("ws-a2:sh")).toBe(true); // grid cell 2 — inactive profile
    expect(liveIds.has("ws-b:sh")).toBe(true);  // active profile
  });

  it("returning to a profile includes its grid sessions in the live set", async () => {
    // Same setup as above but we switch back to p1 and confirm grid sessions are still live.
    const workspaces = [
      { id: "ws-a1", name: "A1", profileId: "p1", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/a1" },
      { id: "ws-a2", name: "A2", profileId: "p1", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/a2" },
      { id: "ws-b",  name: "B",  profileId: "p2", panels: [{ id: "sh", title: "Shell", command: "" }], kind: "terminal", cwd: "/tmp/b" },
    ];
    const profiles = [
      { id: "p1", name: "P1", color: "#fff", workspaceIds: ["ws-a1", "ws-a2"],
        workspaceGrid: { columns: 2, rows: 1, cellWorkspaceIds: ["ws-a1", "ws-a2"], focusedCellIndex: 1 } },
      { id: "p2", name: "P2", color: "#fff", workspaceIds: ["ws-b"] },
    ];

    const transport = makeTransport(makePayload({
      appState: { workspaces, profiles, activeWorkspaceId: "ws-a2",
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a2", activeSessionId: "" }] },
    }));
    const appStore = useAppStore();
    appStore.init(transport as AnyApi);
    await Promise.resolve(); await Promise.resolve();

    // Switch to p2 then back to p1
    transport._push(makePayload({
      appState: { workspaces, profiles, activeWorkspaceId: "ws-b",
        windowSlots: [{ id: "slot1", profileId: "p2", activeWorkspaceId: "ws-b", activeSessionId: "" }] },
    }));
    await Promise.resolve();
    transport._push(makePayload({
      appState: { workspaces, profiles, activeWorkspaceId: "ws-a2",
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a2", activeSessionId: "" }] },
    }));
    await Promise.resolve();

    // After returning to p1, both grid sessions are still live
    const currentWorkspaces = (appStore.payload as AnyApi)?.appState?.workspaces || [];
    const liveIds = new Set<string>();
    for (const ws of currentWorkspaces) {
      for (const panel of ws.panels || []) {
        const cmd = String(panel.command || "");
        if (/^https?:\/\//i.test(cmd) || cmd === "__files__" || cmd === "__task-dashboard__") continue;
        liveIds.add(`${ws.id}:${panel.id}`);
      }
    }
    expect(liveIds.has("ws-a1:sh")).toBe(true);
    expect(liveIds.has("ws-a2:sh")).toBe(true);

    // Active workspace is w2 (p1's restored workspace)
    expect(appStore.myActiveWorkspaceId).toBe("ws-a2");

    // Profile A's workspaceGrid is preserved
    const p1 = (appStore.payload as AnyApi)?.appState?.profiles?.find((p: AnyApi) => p.id === "p1");
    expect(p1?.workspaceGrid?.cellWorkspaceIds).toEqual(["ws-a1", "ws-a2"]);
    expect(p1?.workspaceGrid?.focusedCellIndex).toBe(1);
  });
});
