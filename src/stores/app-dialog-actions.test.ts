import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref, shallowRef } from "vue";
import { createDialogActions, makeOpenConnectionDialog, makeOpenQuickFixWizard } from "./app-dialog-actions.js";
import { resolveViewerProfileId } from "./app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makeCtx(payloadValue: AnyApi) {
  const ctx = {
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
    adoptPayload: (next: AnyApi) => {
      ctx.payload.value = next;
    },
    withSuppressedBroadcast: async (fn: () => Promise<void>) => fn(),
    getPanelByViewId: () => null,
    createWorktree: async () => undefined,
    quickAddTemplateTab: async () => undefined,
    resolveViewerProfileId,
  } as AnyApi;
  return ctx;
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
        // This describe block's beforeEach sets the current window to "win-b" —
        // its slot must be present for currentProfileId() to resolve it (sibling
        // tests in this block all include it; this one was missing it).
        windowSlots: [{ id: "win-b", profileId: "profile-a", activeWorkspaceId: "ws-active" }],
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

  // Category D (code-review batch, 2026-07): recheckClaude/checkProviders
  // background refreshes used to swallow a rejection with a bare `.catch(()
  // => {})` — the dialog silently kept showing stale provider availability.
  // They now log via rlog; this confirms the rejection no longer escapes as
  // an unhandled promise rejection and the warning is logged.
  it("openTaskWorkspaceDialog: a rejected recheckClaude logs a warning instead of throwing", async () => {
    // checkProviders() is no longer called from here — WorkspaceDialog.vue's
    // own onMounted is the single call site now (the redundant polling
    // channel through providerAvailabilityRef was dead weight; see review
    // 2026-07 §5.4).
    const logRenderer = vi.fn();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-b" }, logRenderer };
    const ctx = makeCtx({
      appState: {
        profiles: [{ id: "profile-a", name: "A", color: "#fff" }],
        settings: {},
        workspaces: [],
        windowSlots: [{ id: "win-b", profileId: "profile-a", activeWorkspaceId: "ws-a" }],
      },
    });
    ctx.getApi = () => ({
      isRemote: false,
      recheckClaude: () => Promise.reject(new Error("claude cli not found")),
    });
    const actions = createDialogActions(ctx);

    actions.openTaskWorkspaceDialog();
    // Let the background recheckClaude() promise settle.
    await Promise.resolve();
    await Promise.resolve();

    const warnCalls = logRenderer.mock.calls.filter((c) => c[0] === "warn");
    expect(warnCalls.some((c) => c[1].includes("recheckClaude"))).toBe(true);
  });
});

describe("createDialogActions.openCompanionAgentDialog", () => {
  it("opens CompanionAgentDialog with the exact sourceSessionId", () => {
    const ctx = makeCtx({ appState: { workspaces: [] } });
    const actions = createDialogActions(ctx);

    actions.openCompanionAgentDialog("ws-source:panel-source");

    expect(ctx.overlay.value).toBe("CompanionAgentDialog");
    expect(ctx.overlayProps.value.sourceSessionId).toBe("ws-source:panel-source");
  });

  it("on submit: creates the companion task, then starts it, merging both payloads and closing the dialog", async () => {
    const createCompanionTask = vi.fn(() =>
      Promise.resolve({ workspaceId: "ws-companion", payload: { appState: { workspaces: [{ id: "ws-companion" }] } } }),
    );
    const startTask = vi.fn(() =>
      Promise.resolve({ payload: { appState: { workspaces: [{ id: "ws-companion-started" }] } } }),
    );
    const ctx = makeCtx({ appState: { workspaces: [] } });
    ctx.getApi = () => ({ createCompanionTask, startTask });
    const actions = createDialogActions(ctx);

    actions.openCompanionAgentDialog("ws-source:panel-source");
    const submitPayload = {
      sourceSessionId: "ws-source:panel-source",
      companionRole: "reviewer",
      companionProvider: { providerId: "codex", model: "gpt-5.6-sol", skipPermissions: false },
      focus: "",
      maxRounds: 10,
    };
    await (ctx.overlayProps.value.onSubmit as (p: AnyApi) => Promise<void>)(submitPayload);

    expect(createCompanionTask).toHaveBeenCalledWith(submitPayload);
    expect(startTask).toHaveBeenCalledWith({ workspaceId: "ws-companion" });
    expect(ctx.overlay.value).toBeNull(); // dialog closed
    expect((ctx.payload.value as AnyApi).appState.workspaces[0].id).toBe("ws-companion-started");
  });

  it("on a backend rejection, re-throws so the dialog's inline error banner renders it and never calls startTask", async () => {
    const createCompanionTask = vi.fn(() => Promise.reject(new Error("Another companion loop is already attached")));
    const startTask = vi.fn();
    const ctx = makeCtx({ appState: { workspaces: [] } });
    ctx.getApi = () => ({ createCompanionTask, startTask });
    const actions = createDialogActions(ctx);

    actions.openCompanionAgentDialog("ws-source:panel-source");
    await expect(
      (ctx.overlayProps.value.onSubmit as (p: AnyApi) => Promise<void>)({ sourceSessionId: "ws-source:panel-source" }),
    ).rejects.toThrow("Another companion loop is already attached");

    expect(startTask).not.toHaveBeenCalled();
    // Dialog stays open — openCompanionAgentDialog never calls closeDialog on failure.
    expect(ctx.overlay.value).toBe("CompanionAgentDialog");
  });
});

// makeOpenConnectionDialog is the factory behind openAzureConnectionDialog /
// openGitHubConnectionDialog. These tests exercise it directly (not through
// createDialogActions) to prove "azure" vs "github" config wires the right
// provider prop, settings key, and save-transport method — both open the
// same ConnectionDialog component.
describe("makeOpenConnectionDialog", () => {
  function makeDeps() {
    const dialogCalls: Array<{ name: string; props: Record<string, unknown> }> = [];
    const openDialog = (name: string, props: Record<string, unknown> = {}) => dialogCalls.push({ name, props });
    const closeDialog = vi.fn();
    const currentProfileId = () => "profile-a";
    return { dialogCalls, openDialog, closeDialog, currentProfileId };
  }

  (
    [
      { provider: "azure", settingsKey: "azureDevops" },
      { provider: "github", settingsKey: "github" },
    ] as const
  ).forEach(({ provider, settingsKey }) => {
    it(`${provider}: opens ConnectionDialog(provider=${provider}) seeded from integrations.${settingsKey} and saves via the ${provider} transport method`, async () => {
      const saveConnection = vi.fn(async (_api: AnyApi, draft: unknown) => ({ payload: { saved: draft } }));
      const ctx = {
        payload: shallowRef({
          appState: {
            settings: {
              integrations: {
                [settingsKey]: {
                  reviewRoot: "/repos",
                  connections: [{ id: "conn-1", name: "Existing" }],
                },
              },
            },
          },
        }),
        getApi: () => ({}),
        adoptPayload: (next: AnyApi) => {
          ctx.payload.value = next;
        },
      } as AnyApi;
      const { dialogCalls, openDialog, closeDialog, currentProfileId } = makeDeps();
      const open = makeOpenConnectionDialog(ctx, openDialog, closeDialog, currentProfileId, {
        settingsKey,
        provider,
        saveConnection,
      });

      open("conn-1");

      expect(dialogCalls).toHaveLength(1);
      expect(dialogCalls[0].name).toBe("ConnectionDialog");
      expect(dialogCalls[0].props.provider).toBe(provider);
      expect(dialogCalls[0].props.connection).toEqual({ id: "conn-1", name: "Existing" });
      expect(dialogCalls[0].props.defaultReviewRoot).toBe("/repos");

      const onSave = dialogCalls[0].props.onSave as (draft: AnyApi) => Promise<void>;
      await onSave({ id: "conn-1", name: "Updated" });

      expect(saveConnection).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "conn-1", name: "Updated", profileId: "profile-a" }),
      );
      expect(ctx.payload.value).toEqual({
        saved: expect.objectContaining({ id: "conn-1", name: "Updated", profileId: "profile-a" }),
      });
      expect(closeDialog).toHaveBeenCalledTimes(1);
    });
  });
});

// makeOpenQuickFixWizard is the factory behind openQuickFixWizard (Azure) and
// openGitHubQuickFixWizard. The two are NOT perfectly symmetric: the GitHub
// wizard passes `provider: "github"` in QuickFixWizardDialog's props while
// the Azure wizard passes no `provider` prop at all — an existing divergence
// preserved via the optional `dialogProvider` config field, not normalized
// away. These tests lock that asymmetry in place.
describe("makeOpenQuickFixWizard", () => {
  function makeDeps() {
    const dialogCalls: Array<{ name: string; props: Record<string, unknown> }> = [];
    const openDialog = (name: string, props: Record<string, unknown> = {}) => dialogCalls.push({ name, props });
    const closeDialog = vi.fn();
    const currentProfileId = () => "profile-a";
    return { dialogCalls, openDialog, closeDialog, currentProfileId };
  }

  function makeQuickFixCtx(connections: AnyApi[]) {
    const ctx = {
      payload: shallowRef({
        appState: { settings: { integrations: { github: { connections }, azureDevops: { connections } } } },
      }),
      activeViewId: ref<string | null>("some-view"),
      splitGroup: ref<AnyApi>({ layout: "grid", viewIds: [] }),
      adoptPayload: (next: AnyApi) => {
        ctx.payload.value = next;
      },
    } as AnyApi;
    return ctx;
  }

  it('github: passes provider: "github" in QuickFixWizardDialog props', () => {
    const ctx = makeQuickFixCtx([{ id: "gh-1", enabled: true, profileId: "profile-a" }]);
    const { dialogCalls, openDialog, closeDialog, currentProfileId } = makeDeps();
    const openConnectionDialog = vi.fn();
    const open = makeOpenQuickFixWizard(ctx, openDialog, closeDialog, currentProfileId, {
      settingsKey: "github",
      dialogProvider: "github",
      openConnectionDialog,
    });

    open();

    expect(dialogCalls).toHaveLength(1);
    expect(dialogCalls[0].name).toBe("QuickFixWizardDialog");
    expect(dialogCalls[0].props.provider).toBe("github");
    expect(openConnectionDialog).not.toHaveBeenCalled();
  });

  it("azure: omits the provider prop entirely (existing asymmetry with the GitHub wizard)", () => {
    const ctx = makeQuickFixCtx([{ id: "az-1", enabled: true, profileId: "profile-a" }]);
    const { dialogCalls, openDialog, closeDialog, currentProfileId } = makeDeps();
    const open = makeOpenQuickFixWizard(ctx, openDialog, closeDialog, currentProfileId, {
      settingsKey: "azureDevops",
      openConnectionDialog: vi.fn(),
    });

    open();

    expect(dialogCalls).toHaveLength(1);
    expect("provider" in dialogCalls[0].props).toBe(false);
  });

  it("falls back to opening the connection dialog when no connections exist for this profile", () => {
    const ctx = makeQuickFixCtx([]);
    const { openDialog, closeDialog, currentProfileId } = makeDeps();
    const openConnectionDialog = vi.fn();
    const open = makeOpenQuickFixWizard(ctx, openDialog, closeDialog, currentProfileId, {
      settingsKey: "github",
      dialogProvider: "github",
      openConnectionDialog,
    });

    open();

    expect(openConnectionDialog).toHaveBeenCalledWith("");
  });

  it("filters connections to the current profile before opening the wizard", () => {
    const ctx = makeQuickFixCtx([
      { id: "gh-a", enabled: true, profileId: "profile-a" },
      { id: "gh-b", enabled: true, profileId: "profile-b" },
    ]);
    const { dialogCalls, openDialog, closeDialog, currentProfileId } = makeDeps();
    const open = makeOpenQuickFixWizard(ctx, openDialog, closeDialog, currentProfileId, {
      settingsKey: "github",
      dialogProvider: "github",
      openConnectionDialog: vi.fn(),
    });

    open();

    expect((dialogCalls[0].props.connections as AnyApi[]).map((c) => c.id)).toEqual(["gh-a"]);
  });

  it("onCreate adopts the result payload and resets active view / split state", () => {
    const ctx = makeQuickFixCtx([{ id: "gh-1", enabled: true, profileId: "profile-a" }]);
    const { dialogCalls, openDialog, closeDialog, currentProfileId } = makeDeps();
    const open = makeOpenQuickFixWizard(ctx, openDialog, closeDialog, currentProfileId, {
      settingsKey: "github",
      dialogProvider: "github",
      openConnectionDialog: vi.fn(),
    });

    open();
    const onCreate = dialogCalls[0].props.onCreate as (result: AnyApi) => void;
    onCreate({ some: "payload" });

    expect(ctx.payload.value).toEqual({ some: "payload" });
    expect(ctx.activeViewId.value).toBeNull();
    expect(ctx.splitGroup.value).toBeNull();
    expect(closeDialog).toHaveBeenCalledTimes(1);
  });
});

describe("createDialogActions.openTabNotesDialog", () => {
  function makeNotesCtx(panel: AnyApi) {
    const workspace = { id: "ws-a", panels: [{ id: "other" }, panel] };
    const ctx = makeCtx({ appState: { workspaces: [workspace] }, workspace });
    const saveWorkspace = vi.fn(async (ws: AnyApi) => ({ appState: { workspaces: [ws] }, workspace: ws }));
    ctx.getApi = () => ({ saveWorkspace });
    ctx.getPanelByViewId = () => ({ workspace, panel });
    return { ctx, saveWorkspace };
  }

  function savedPanels(saveWorkspace: AnyApi) {
    return saveWorkspace.mock.calls[0][0].panels;
  }

  it("seeds the dialog with the panel's existing note", () => {
    const { ctx } = makeNotesCtx({ id: "p1", title: "Bug Jana", notes: "waiting on review" });

    createDialogActions(ctx).openTabNotesDialog("ws-a:p1");

    expect(ctx.overlay.value).toBe("TextAreaDialog");
    expect(ctx.overlayProps.value.value).toBe("waiting on review");
    expect(ctx.overlayProps.value.title).toBe("Notes — Bug Jana");
    // Without this the dialog refuses to submit a cleared box.
    expect(ctx.overlayProps.value.allowEmpty).toBe(true);
  });

  it("saves the note onto the matching panel only", async () => {
    const { ctx, saveWorkspace } = makeNotesCtx({ id: "p1", title: "Bug Jana" });
    const actions = createDialogActions(ctx);

    actions.openTabNotesDialog("ws-a:p1");
    await (ctx.overlayProps.value.onSubmit as AnyApi)("  TODO: wire up retry  ");

    expect(savedPanels(saveWorkspace)).toEqual([
      { id: "other" },
      { id: "p1", title: "Bug Jana", notes: "TODO: wire up retry" },
    ]);
    expect(ctx.overlay.value).toBe(null);
  });

  it("clears the note when the box is emptied", async () => {
    const { ctx, saveWorkspace } = makeNotesCtx({ id: "p1", title: "Bug Jana", notes: "old note" });
    const actions = createDialogActions(ctx);

    actions.openTabNotesDialog("ws-a:p1");
    await (ctx.overlayProps.value.onSubmit as AnyApi)("");

    expect(savedPanels(saveWorkspace)[1].notes).toBe("");
  });

  it("skips the save when the note is unchanged", async () => {
    const { ctx, saveWorkspace } = makeNotesCtx({ id: "p1", title: "Bug Jana", notes: "same" });
    const actions = createDialogActions(ctx);

    actions.openTabNotesDialog("ws-a:p1");
    await (ctx.overlayProps.value.onSubmit as AnyApi)("same");

    expect(saveWorkspace).not.toHaveBeenCalled();
    expect(ctx.overlay.value).toBe(null);
  });

  it("does nothing for a view id with no panel", () => {
    const { ctx } = makeNotesCtx({ id: "p1" });
    ctx.getPanelByViewId = () => null;

    createDialogActions(ctx).openTabNotesDialog("ws-a:nope");

    expect(ctx.overlay.value).toBe(null);
  });
});
