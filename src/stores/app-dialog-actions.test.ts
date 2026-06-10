import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref, shallowRef } from "vue";
import { createDialogActions } from "./app-dialog-actions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makeCtx(payloadValue: AnyApi) {
  return {
    overlay: ref<string | null>(null),
    overlayProps: ref<Record<string, unknown>>({}),
    contextMenu: ref(null),
    layoutPickerAnchor: ref(null),
    layoutPickerMode: ref("grid"),
    payload: shallowRef(payloadValue),
    activeViewId: ref<string | null>(null),
    activeSessionId: ref<string | null>(null),
    splitGroup: ref(null),
    suppressBroadcast: ref(false),
    hiddenViewIds: ref(new Set<string>()),
    getApi: () => ({}),
    withSuppressedBroadcast: async (fn: () => Promise<void>) => fn(),
    getPanelByViewId: () => null,
    createWorktree: async () => undefined,
    quickAddTemplateTab: async () => undefined,
  } as AnyApi;
}

describe("createDialogActions.openProfilesDialog", () => {
  beforeEach(() => {
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-a" } };
  });

  it("marks this window's slot profile active instead of the global last-active profile", () => {
    const ctx = makeCtx({
      appState: {
        activeProfileId: "profile-b",
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [],
        windowSlots: [
          { id: "win-a", profileId: "profile-a", activeWorkspaceId: "ws-a" },
          { id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" },
        ],
      },
    });
    const actions = createDialogActions(ctx);

    actions.openProfilesDialog();

    expect(ctx.overlay.value).toBe("ProfilesDialog");
    expect(ctx.overlayProps.value.activeProfileId).toBe("profile-a");
  });

  it("uses the first open desktop profile as active in remote mode when remoteClient is absent", () => {
    const ctx = makeCtx({
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [],
        windowSlots: [{ id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" }],
      },
    });
    ctx.getApi = () => ({ isRemote: true });
    const actions = createDialogActions(ctx);

    actions.openProfilesDialog();

    expect(ctx.overlay.value).toBe("ProfilesDialog");
    expect(ctx.overlayProps.value.activeProfileId).toBe("profile-b");
    // EVERY profile is selectable from remote — the viewer may open a
    // profile with no desktop window.
    expect(ctx.overlayProps.value.profiles).toEqual([
      { id: "profile-a", name: "A", color: "#fff" },
      { id: "profile-b", name: "B", color: "#fff" },
    ]);
  });

  it("uses the first open desktop profile as active in remote mode when remoteClient profile is deleted", () => {
    const ctx = makeCtx({
      remoteClient: { id: "session-a", profileId: "deleted-profile", activeWorkspaceId: "", activeSessionId: "" },
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [],
        windowSlots: [{ id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" }],
      },
    });
    ctx.getApi = () => ({ isRemote: true });
    const actions = createDialogActions(ctx);

    actions.openProfilesDialog();

    expect(ctx.overlay.value).toBe("ProfilesDialog");
    expect(ctx.overlayProps.value.activeProfileId).toBe("profile-b");
    expect(ctx.overlayProps.value.profiles).toEqual([
      { id: "profile-a", name: "A", color: "#fff" },
      { id: "profile-b", name: "B", color: "#fff" },
    ]);
  });

  it("keeps the remote profile as active even when it has no desktop window (independent viewer)", () => {
    const ctx = makeCtx({
      remoteClient: { id: "session-a", profileId: "profile-a", activeWorkspaceId: "", activeSessionId: "" },
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [],
        // profile-a has NO desktop window — the remote binding still wins.
        windowSlots: [{ id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" }],
      },
    });
    ctx.getApi = () => ({ isRemote: true });
    const actions = createDialogActions(ctx);

    actions.openProfilesDialog();

    expect(ctx.overlayProps.value.activeProfileId).toBe("profile-a");
  });

  it("optimistically scopes remote profile activation to the browser client", async () => {
    let resolveActivate: (value: unknown) => void = () => undefined;
    const activateProfile = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveActivate = resolve;
        }),
    );
    const ctx = makeCtx({
      remoteClient: { id: "session-a", profileId: "profile-a", activeWorkspaceId: "ws-a", activeSessionId: "ws-a:p1" },
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [
          { id: "ws-a", profileId: "profile-a", panels: [] },
          { id: "ws-b", profileId: "profile-b", panels: [] },
        ],
        windowSlots: [
          { id: "win-a", profileId: "profile-a", activeWorkspaceId: "ws-a" },
          { id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" },
        ],
      },
    });
    ctx.getApi = () => ({ isRemote: true, activateProfile });
    const actions = createDialogActions(ctx);

    actions.openProfilesDialog();
    const activation = (ctx.overlayProps.value.onActivate as (profileId: string) => Promise<void>)("profile-b");

    expect(ctx.payload.value.remoteClient).toMatchObject({
      profileId: "profile-b",
      activeWorkspaceId: "ws-b",
      activeSessionId: "",
    });

    const serverPayload = {
      ...ctx.payload.value,
      remoteClient: { id: "session-a", profileId: "profile-b", activeWorkspaceId: "ws-b", activeSessionId: "" },
    };
    resolveActivate(serverPayload);
    await activation;

    expect(activateProfile).toHaveBeenCalledWith("profile-b");
    expect(ctx.overlay.value).toBeNull();
  });

  it("desktop profile activation adopts restored session from this window slot", async () => {
    const serverPayload = {
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [
          { id: "ws-a", profileId: "profile-a", panels: [] },
          { id: "ws-b", profileId: "profile-b", panels: [{ id: "shell", command: "" }] },
        ],
        windowSlots: [
          { id: "win-a", profileId: "profile-b", activeWorkspaceId: "ws-b", activeSessionId: "ws-b:shell" },
        ],
      },
    };
    const activateProfile = vi.fn(() => Promise.resolve(serverPayload));
    const ctx = makeCtx({
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [
          { id: "ws-a", profileId: "profile-a", panels: [] },
          { id: "ws-b", profileId: "profile-b", panels: [{ id: "shell", command: "" }] },
        ],
        windowSlots: [{ id: "win-a", profileId: "profile-a", activeWorkspaceId: "ws-a", activeSessionId: "" }],
      },
    });
    ctx.getApi = () => ({ isRemote: false, activateProfile });
    const actions = createDialogActions(ctx);

    actions.openProfilesDialog();
    await (ctx.overlayProps.value.onActivate as (profileId: string) => Promise<void>)("profile-b");

    expect(ctx.activeSessionId.value).toBe("ws-b:shell");
    expect(ctx.activeViewId.value).toBe("ws-b:shell");
    expect(ctx.overlay.value).toBeNull();
  });
});

describe("createDialogActions profile-aware saves", () => {
  beforeEach(() => {
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-b" } };
  });

  it("saves Azure connections under this desktop window's profile", async () => {
    const saveAzureConnection = vi.fn((draft: AnyApi) => Promise.resolve({ payload: { ok: true, draft } }));
    const ctx = makeCtx({
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        settings: { integrations: { azureDevops: { connections: [] } } },
        windowSlots: [
          { id: "win-a", profileId: "profile-a", activeWorkspaceId: "ws-a" },
          { id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" },
        ],
      },
    });
    ctx.getApi = () => ({ isRemote: false, saveAzureConnection });
    const actions = createDialogActions(ctx);

    actions.openAzureConnectionDialog();
    await (ctx.overlayProps.value.onSave as (draft: AnyApi) => Promise<void>)({ id: "az-1" });

    expect(saveAzureConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "az-1", profileId: "profile-b" }));
  });

  it("saves GitHub connections under the remote client's profile", async () => {
    const saveGitHubConnection = vi.fn((draft: AnyApi) => Promise.resolve({ payload: { ok: true, draft } }));
    const ctx = makeCtx({
      remoteClient: { id: "remote-a", profileId: "profile-b", activeWorkspaceId: "ws-b", activeSessionId: "" },
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        settings: { integrations: { github: { connections: [] } } },
        windowSlots: [{ id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" }],
      },
    });
    ctx.getApi = () => ({ isRemote: true, saveGitHubConnection });
    const actions = createDialogActions(ctx);

    actions.openGitHubConnectionDialog();
    await (ctx.overlayProps.value.onSave as (draft: AnyApi) => Promise<void>)({ id: "gh-1" });

    expect(saveGitHubConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "gh-1", profileId: "profile-b" }));
  });

  it("remote saves use the remote viewer's profile even when it has no desktop window", async () => {
    // profile-b is the remote client's binding; no desktop window shows it.
    // The connection must still land in profile-b — the remote client is an
    // independent viewer.
    const saveGitHubConnection = vi.fn((draft: AnyApi) => Promise.resolve({ payload: { ok: true, draft } }));
    const ctx = makeCtx({
      remoteClient: { id: "remote-a", profileId: "profile-b", activeWorkspaceId: "ws-b", activeSessionId: "" },
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        settings: { integrations: { github: { connections: [] } } },
        windowSlots: [{ id: "win-a", profileId: "profile-a", activeWorkspaceId: "ws-a" }],
      },
    });
    ctx.getApi = () => ({ isRemote: true, saveGitHubConnection });
    const actions = createDialogActions(ctx);

    actions.openGitHubConnectionDialog();
    await (ctx.overlayProps.value.onSave as (draft: AnyApi) => Promise<void>)({ id: "gh-1" });

    expect(saveGitHubConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "gh-1", profileId: "profile-b" }));
  });

  it("falls back to the first open desktop profile for remote saves when the remote profile was deleted", async () => {
    const saveGitHubConnection = vi.fn((draft: AnyApi) => Promise.resolve({ payload: { ok: true, draft } }));
    const ctx = makeCtx({
      remoteClient: { id: "remote-a", profileId: "profile-deleted", activeWorkspaceId: "", activeSessionId: "" },
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        settings: { integrations: { github: { connections: [] } } },
        windowSlots: [{ id: "win-a", profileId: "profile-a", activeWorkspaceId: "ws-a" }],
      },
    });
    ctx.getApi = () => ({ isRemote: true, saveGitHubConnection });
    const actions = createDialogActions(ctx);

    actions.openGitHubConnectionDialog();
    await (ctx.overlayProps.value.onSave as (draft: AnyApi) => Promise<void>)({ id: "gh-1" });

    expect(saveGitHubConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "gh-1", profileId: "profile-a" }));
  });

  it("auto-detects task parent within this desktop window's profile", async () => {
    const createTaskWorkspace = vi.fn((config: AnyApi) => Promise.resolve({ payload: { ok: true, config } }));
    const ctx = makeCtx({
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        settings: {},
        workspaces: [
          { id: "ws-a", name: "Repo A", profileId: "profile-a", cwd: "C:\\repo", kind: "terminal", panels: [] },
          { id: "ws-b", name: "Repo B", profileId: "profile-b", cwd: "C:\\repo", kind: "terminal", panels: [] },
        ],
        windowSlots: [
          { id: "win-a", profileId: "profile-a", activeWorkspaceId: "ws-a" },
          { id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" },
        ],
      },
      workspace: {
        workspace: { id: "ws-b", name: "Repo B", profileId: "profile-b", cwd: "C:\\repo", kind: "terminal" },
      },
    });
    ctx.getApi = () => ({ isRemote: false, createTaskWorkspace });
    const actions = createDialogActions(ctx);

    actions.openTaskWorkspaceDialog();
    await (ctx.overlayProps.value.onSubmit as (draft: AnyApi) => Promise<void>)({
      cwd: "C:\\repo",
      name: "Task",
      icon: "T",
      color: "#fff",
      notes: "",
      task: { description: "Do work", maxRounds: 10 },
      panels: [],
    });

    expect(createTaskWorkspace).toHaveBeenCalledWith(expect.objectContaining({ parentWorkspaceId: "ws-b" }));
  });

  it("seeds cwd from the kebab-clicked workspace, not the active one", async () => {
    const createTaskWorkspace = vi.fn((config: AnyApi) => Promise.resolve({ payload: { ok: true, config } }));
    const ctx = makeCtx({
      appState: {
        profiles: [{ id: "profile-a", name: "A", color: "#fff" }],
        settings: {},
        workspaces: [
          { id: "ws-active", name: "Azure", profileId: "profile-a", cwd: "C:\\active", kind: "azure", panels: [] },
          { id: "ws-clicked", name: "mhub", profileId: "profile-a", cwd: "C:\\mhub", kind: "terminal", panels: [] },
        ],
        windowSlots: [{ id: "win-a", profileId: "profile-a", activeWorkspaceId: "ws-active" }],
      },
      // Active workspace context points at the Azure workspace.
      workspace: {
        workspace: { id: "ws-active", name: "Azure", profileId: "profile-a", cwd: "C:\\active", kind: "azure" },
      },
    });
    ctx.getApi = () => ({ isRemote: false, createTaskWorkspace });
    const actions = createDialogActions(ctx);

    // Kebab menu on the (non-active) mhub workspace passes its id.
    actions.openTaskWorkspaceDialog("ws-clicked");

    // The draft cwd must come from the clicked workspace, not the active one.
    expect((ctx.overlayProps.value.workspace as AnyApi).cwd).toBe("C:\\mhub");

    await (ctx.overlayProps.value.onSubmit as (draft: AnyApi) => Promise<void>)({
      cwd: "C:\\mhub",
      name: "Task",
      icon: "T",
      color: "#fff",
      notes: "",
      task: { description: "Do work", maxRounds: 10 },
      panels: [],
    });

    expect(createTaskWorkspace).toHaveBeenCalledWith(expect.objectContaining({ parentWorkspaceId: "ws-clicked" }));
  });
});
