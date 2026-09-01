import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { ref, shallowRef, computed } from "vue";
import { createWorkspaceActions } from "./app-workspace-actions.js";
import { useNotificationStore } from "./notifications.js";

// Minimal harness for testing the workspace-actions factory in isolation.
// We don't spin up the full app store — just provide the refs the factory
// reads from and a stub Transport so deleteWorkspace can be exercised end
// to end without IPC.

interface AnyApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

function makeWorkspaces(): AnyApi[] {
  return [
    { id: "ws-A", name: "Project A", cwd: "C:\\work\\a" },
    {
      id: "ws-B",
      name: "Worktree B",
      cwd: "C:\\work\\a\\.strideterm\\tree\\branch-b",
      notes: "Worktree of Project A",
    },
    {
      id: "ws-C",
      name: "Review C",
      cwd: "C:\\tmp\\review-c",
      review: { checkout: { mode: "managed-worktree", rootPath: "C:\\tmp\\review-c" } },
    },
    {
      id: "ws-D",
      name: "Quickfix D",
      cwd: "C:\\tmp\\quickfix-d",
      quickfix: { parentWorkspaceId: "ws-A", rootPath: "C:\\tmp\\quickfix-d" },
    },
    {
      id: "ws-E",
      name: "Task E",
      cwd: "C:\\work\\a\\.strideterm\\tree\\task-e",
      kind: "task",
      task: { worktreeBase: "C:\\work\\a", taskId: "task-e-id" },
    },
  ];
}

function makeCtx(initialPayload: AnyApi, apiOverrides: AnyApi = {}) {
  const payload = shallowRef(initialPayload);
  const optimisticallyDeletedIds = ref(new Set<string>());
  const overlay = ref<string | null>(null);
  const overlayProps = ref<Record<string, unknown>>({});
  const splitGroup = ref<{ layout: string; viewIds: string[] } | null>(null);
  const activeViewId = ref<string | null>(null);
  const activeSessionId = ref<string | null>(null);
  const myActiveWorkspaceId = computed(() => payload.value?.appState?.activeWorkspaceId || "");
  const hiddenViewIds = ref(new Set<string>());
  const workspaceTabs = computed(
    () => [] as { id: string; type: string; title: string; status: string; tone: string }[],
  );

  const api = {
    deleteWorkspace: vi.fn(async () => initialPayload),
    ...apiOverrides,
  };

  const ctx = {
    payload,
    activeViewId,
    activeSessionId,
    myActiveWorkspaceId,
    splitGroup,
    hiddenViewIds,
    workspaceTabs,
    overlay,
    overlayProps,
    optimisticallyDeletedIds,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getApi: () => api as any,
    adoptPayload: (next: AnyApi) => {
      payload.value = next;
    },
    withSuppressedBroadcast: async (fn: () => Promise<void>) => fn(),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ctx: ctx as any, api, payload, optimisticallyDeletedIds, overlay, overlayProps };
}

describe("createWorkspaceActions.deleteWorkspace (optimistic)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function answerConfirm(ctx: AnyApi, accept = true): Promise<void> {
    await Promise.resolve();
    expect(ctx.overlay.value).toBe("ConfirmDialog");
    const props = ctx.overlayProps.value as AnyApi;
    if (accept) props.onConfirm();
    else props.onCancel();
    await Promise.resolve();
  }

  it("removes the workspace from the local payload synchronously (no waiting on the IPC)", async () => {
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    // Make the IPC hang so we can prove the UI moved on without it.
    let releaseIpc: (v: AnyApi) => void = () => {};
    const ipcCall = new Promise<AnyApi>((resolve) => (releaseIpc = resolve));
    const { ctx, payload, optimisticallyDeletedIds } = makeCtx(initial, {
      deleteWorkspace: vi.fn(() => ipcCall),
    });
    const actions = createWorkspaceActions(ctx);

    // Fire the delete; do not await.
    const finished = actions.deleteWorkspace("ws-B");
    await answerConfirm(ctx, true);
    await answerConfirm(ctx, true);
    // Yield once so the optimistic mutation lands.
    await Promise.resolve();

    // Sidebar tree no longer carries the workspace, *before* the IPC resolved.
    expect(payload.value.appState.workspaces.find((w: AnyApi) => w.id === "ws-B")).toBeUndefined();
    expect(optimisticallyDeletedIds.value.has("ws-B")).toBe(true);

    // Now release the IPC and the call resolves cleanly.
    releaseIpc({
      ...initial,
      appState: { ...initial.appState, workspaces: initial.appState.workspaces.filter((w) => w.id !== "ws-B") },
    });
    await finished;
  });

  it("switches the active workspace if the deleted one was active", async () => {
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    const { ctx, payload } = makeCtx(initial);
    const actions = createWorkspaceActions(ctx);

    const finished = actions.deleteWorkspace("ws-A");
    await answerConfirm(ctx, true);
    await finished;
    // Yield additional times for any nested microtasks.
    await Promise.resolve();
    await Promise.resolve();

    // Active workspace must have moved to the first remaining one — we
    // never want to show a "no active workspace" dead state.
    expect(payload.value.appState.activeWorkspaceId).toBe("ws-B");
    expect(payload.value.appState.workspaces.find((w: AnyApi) => w.id === "ws-A")).toBeUndefined();
  });

  it("does not change active workspace when deleting an inactive one", async () => {
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    const { ctx, payload } = makeCtx(initial);
    const actions = createWorkspaceActions(ctx);

    const finished = actions.deleteWorkspace("ws-C");
    await answerConfirm(ctx, true);
    await answerConfirm(ctx, true);
    await finished;
    await Promise.resolve();

    expect(payload.value.appState.activeWorkspaceId).toBe("ws-A");
  });

  it.each([
    ["worktree child", "ws-B"],
    ["review checkout", "ws-C"],
    ["quickfix", "ws-D"],
    ["task agent", "ws-E"],
  ])("optimistically removes a %s workspace", async (_label, idToDelete) => {
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    const { ctx, payload, optimisticallyDeletedIds } = makeCtx(initial);
    const actions = createWorkspaceActions(ctx);

    const finished = actions.deleteWorkspace(idToDelete);
    await answerConfirm(ctx, true);
    await answerConfirm(ctx, true);
    await finished;
    await Promise.resolve();

    expect(payload.value.appState.workspaces.find((w: AnyApi) => w.id === idToDelete)).toBeUndefined();
    // Until the next broadcast confirms, the id stays in the suppression set
    // so unrelated polls can't bring it back.
    expect(optimisticallyDeletedIds.value.has(idToDelete)).toBe(true);
  });

  it("uses the formatted display name ('#N' suffix) in the delete prompt for task agents", async () => {
    // Two "mhub" task agents under the same parent — without the formatted
    // name, both delete prompts say "Delete task agent 'mhub'?" and the user
    // can't tell which one is about to go. The sequence suffix in the prompt
    // matches what the sidebar card and the Telegram notification show, so
    // all three surfaces refer to the same task by the same string.
    const initial = {
      appState: {
        workspaces: [
          { id: "ws-parent", name: "mhub", cwd: "C:\\work\\mhub" },
          {
            id: "ws-mhub-2",
            name: "mhub",
            kind: "task",
            cwd: "C:\\work\\mhub",
            task: { parentWorkspaceId: "ws-parent", taskId: "t-2", sequenceNumber: 2 },
          },
        ],
        activeWorkspaceId: "ws-mhub-2",
      },
    };
    const { ctx, overlayProps } = makeCtx(initial);
    const actions = createWorkspaceActions(ctx);

    const finished = actions.deleteWorkspace("ws-mhub-2");
    // Yield for confirmInApp to mount the dialog
    await Promise.resolve();
    expect(ctx.overlay.value).toBe("ConfirmDialog");
    const props = overlayProps.value as AnyApi;
    expect(String(props.title)).toBe("Delete task agent");
    expect(String(props.message)).toContain('"mhub #2"');
    // Decline so the rest of the suite isn't affected.
    props.onCancel();
    await finished;
  });

  it("does nothing if the user declines the confirm prompt", async () => {
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    const { ctx, payload, api } = makeCtx(initial);
    const actions = createWorkspaceActions(ctx);

    const finished = actions.deleteWorkspace("ws-B");
    await answerConfirm(ctx, false);
    await finished;
    expect(payload.value.appState.workspaces).toHaveLength(5);
    expect(api.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("shows a persistent toast with the path when the backend reports a disk-delete error", async () => {
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    const { ctx } = makeCtx(initial, {
      deleteWorkspace: vi.fn(async () => ({
        ...initial,
        appState: { ...initial.appState, workspaces: initial.appState.workspaces.filter((w) => w.id !== "ws-B") },
        deleteWorkspaceError: "EBUSY: resource busy or locked",
      })),
    });
    const actions = createWorkspaceActions(ctx);
    const notifs = useNotificationStore();

    // Confirm both the delete prompt AND the "delete from disk" follow-up.
    const finished = actions.deleteWorkspace("ws-B");
    await answerConfirm(ctx, true);
    await answerConfirm(ctx, true);
    await finished;
    // Wait for the lazy import + microtask flush.
    await new Promise((r) => setTimeout(r, 10));

    expect(notifs.persistentToasts).toHaveLength(1);
    const toast = notifs.persistentToasts[0];
    expect(toast.title).toContain("Worktree B");
    expect(toast.body).toContain("EBUSY");
    // The user needs the path to finish cleanup manually — make sure it's
    // attached so the "Copy path" button has something to copy.
    expect(toast.copyPath).toContain("branch-b");
  });

  it("shows a persistent toast and rolls back the suppression set when the IPC throws", async () => {
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    const { ctx, optimisticallyDeletedIds } = makeCtx(initial, {
      deleteWorkspace: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    const actions = createWorkspaceActions(ctx);
    const notifs = useNotificationStore();

    const finished = actions.deleteWorkspace("ws-B");
    await answerConfirm(ctx, true);
    await answerConfirm(ctx, true);
    await finished;
    await new Promise((r) => setTimeout(r, 10));

    expect(notifs.persistentToasts).toHaveLength(1);
    expect(notifs.persistentToasts[0].body).toContain("ECONNREFUSED");
    // IPC failure means the backend probably still has the workspace; we
    // must let the next broadcast restore it instead of silently swallowing.
    expect(optimisticallyDeletedIds.value.has("ws-B")).toBe(false);
  });

  it("forceRemoveWorkspace removes the workspace from the local payload synchronously (no waiting on the IPC)", async () => {
    // Mirrors deleteWorkspace's own "removes...synchronously" test above —
    // forceRemoveWorkspace shares the same optimistic core, but until now had
    // no test proving its own happy path (only the IPC-throw error path below).
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    let releaseIpc: (v: AnyApi) => void = () => {};
    const ipcCall = new Promise<AnyApi>((resolve) => (releaseIpc = resolve));
    const { ctx, payload, optimisticallyDeletedIds } = makeCtx(initial, {
      deleteWorkspace: vi.fn(() => ipcCall),
    });
    const actions = createWorkspaceActions(ctx);

    const finished = actions.forceRemoveWorkspace("ws-B");
    await answerConfirm(ctx, true);
    await Promise.resolve();

    expect(payload.value.appState.workspaces.find((w: AnyApi) => w.id === "ws-B")).toBeUndefined();
    expect(optimisticallyDeletedIds.value.has("ws-B")).toBe(true);

    releaseIpc({
      ...initial,
      appState: { ...initial.appState, workspaces: initial.appState.workspaces.filter((w) => w.id !== "ws-B") },
    });
    await finished;
  });

  it("forceRemoveWorkspace switches the active workspace if the removed one was active", async () => {
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    const { ctx, payload } = makeCtx(initial);
    const actions = createWorkspaceActions(ctx);

    const finished = actions.forceRemoveWorkspace("ws-A");
    await answerConfirm(ctx, true);
    await finished;
    await Promise.resolve();
    await Promise.resolve();

    expect(payload.value.appState.activeWorkspaceId).toBe("ws-B");
    expect(payload.value.appState.workspaces.find((w: AnyApi) => w.id === "ws-A")).toBeUndefined();
  });

  it("forceRemoveWorkspace does nothing if the user declines the confirm prompt", async () => {
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    const { ctx, payload, api } = makeCtx(initial);
    const actions = createWorkspaceActions(ctx);

    const finished = actions.forceRemoveWorkspace("ws-B");
    await answerConfirm(ctx, false);
    await finished;

    expect(payload.value.appState.workspaces.find((w: AnyApi) => w.id === "ws-B")).toBeDefined();
    expect(api.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("forceRemoveWorkspace calls the backend with only deleteFromDisk:false — no diskPath key at all (vs. deleteWorkspace's disk-aware variant)", async () => {
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    const { ctx, api } = makeCtx(initial);
    const actions = createWorkspaceActions(ctx);

    const finished = actions.forceRemoveWorkspace("ws-B");
    await answerConfirm(ctx, true);
    await finished;
    await Promise.resolve();

    expect(api.deleteWorkspace).toHaveBeenCalledWith("ws-B", { deleteFromDisk: false });
  });

  it("forceRemoveWorkspace shows the same error-toast behavior as deleteWorkspace when the IPC throws (shared optimisticallyRemoveWorkspace)", async () => {
    // deleteWorkspace and forceRemoveWorkspace both route their optimistic
    // removal + failure handling through the shared optimisticallyRemoveWorkspace
    // helper. This locks down that forceRemoveWorkspace's IPC-throw path still
    // surfaces a persistent toast and rolls back the suppression set, just
    // like the deleteWorkspace case above — with force-remove's distinct
    // wording ("remove" not "delete") and no copyPath (nothing was ever
    // slated for on-disk deletion).
    const initial = {
      appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" },
    };
    const { ctx, optimisticallyDeletedIds } = makeCtx(initial, {
      deleteWorkspace: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    const actions = createWorkspaceActions(ctx);
    const notifs = useNotificationStore();

    const finished = actions.forceRemoveWorkspace("ws-B");
    await answerConfirm(ctx, true);
    await finished;
    await new Promise((r) => setTimeout(r, 10));

    expect(notifs.persistentToasts).toHaveLength(1);
    const toast = notifs.persistentToasts[0];
    expect(toast.title).toContain("Failed to remove");
    expect(toast.body).toContain("ECONNREFUSED");
    expect(toast.copyPath).toBe("");
    expect(optimisticallyDeletedIds.value.has("ws-B")).toBe(false);
  });
});

describe("workspace actions leave notification history to the runtime event", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function answerConfirm(ctx: AnyApi, accept = true): Promise<void> {
    await Promise.resolve();
    expect(ctx.overlay.value).toBe("ConfirmDialog");
    const props = ctx.overlayProps.value as AnyApi;
    if (accept) props.onConfirm();
    else props.onCancel();
    await Promise.resolve();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function seed(store: any, workspaceId: string, viewId: string): void {
    store.add({ title: "t", body: "b", kind: "waiting", workspaceId, viewId, meta: { profileId: "default" } });
  }

  // Purging here would only cover the initiating renderer, miss every other
  // client and backend-originated removal path, and — because the optimistic
  // delete can still be rolled back — destroy history that must come back.
  it("deleteWorkspace does not purge history optimistically", async () => {
    const initial = { appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" } };
    const { ctx } = makeCtx(initial, { deleteWorkspace: vi.fn(() => new Promise(() => {})) });
    const notifs = useNotificationStore();
    seed(notifs, "ws-B", "ws-B:shell");
    const actions = createWorkspaceActions(ctx);

    void actions.deleteWorkspace("ws-B");
    await answerConfirm(ctx, true);
    await answerConfirm(ctx, true);
    await Promise.resolve();

    expect(ctx.payload.value.appState.workspaces.find((w: AnyApi) => w.id === "ws-B")).toBeUndefined();
    expect(notifs.sessions.map((s: AnyApi) => s.workspaceId)).toEqual(["ws-B"]);
  });

  it("forceRemoveWorkspace does not purge history optimistically either", async () => {
    const initial = { appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" } };
    const { ctx } = makeCtx(initial, { deleteWorkspace: vi.fn(() => new Promise(() => {})) });
    const notifs = useNotificationStore();
    seed(notifs, "ws-B", "ws-B:shell");
    const actions = createWorkspaceActions(ctx);

    void actions.forceRemoveWorkspace("ws-B");
    await answerConfirm(ctx, true);
    await Promise.resolve();

    expect(ctx.payload.value.appState.workspaces.find((w: AnyApi) => w.id === "ws-B")).toBeUndefined();
    expect(notifs.sessions.map((s: AnyApi) => s.workspaceId)).toEqual(["ws-B"]);
  });

  // A Git or Docker tab is only added to hiddenViewIds — it can be reopened,
  // so nothing was removed and no history may be dropped.
  it("hiding a Git tab leaves its notification history alone", async () => {
    const initial = { appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" } };
    const { ctx } = makeCtx(initial);
    const notifs = useNotificationStore();
    seed(notifs, "ws-A", "git:ws-A");
    const actions = createWorkspaceActions(ctx);

    actions.closeTab("git:ws-A");
    await Promise.resolve();

    expect(ctx.hiddenViewIds.value.has("git:ws-A")).toBe(true);
    expect(notifs.sessions).toHaveLength(1);
  });
});

// Seba's report: a PR attached to the wrong workspace left a Review tab that
// nothing in the tab bar could remove — closing it was a silent no-op, and the
// only detach buttons live in the sidebar menu, the Git tab and the workspace
// editor.
describe("createWorkspaceActions — detaching a workspace from its PR review", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function answerConfirm(ctx: AnyApi, accept = true): Promise<void> {
    await Promise.resolve();
    expect(ctx.overlay.value).toBe("ConfirmDialog");
    const props = ctx.overlayProps.value as AnyApi;
    if (accept) props.onConfirm();
    else props.onCancel();
    await flush();
  }

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // `review: null` (the default) means "the standard PR-linked marker"; pass an
  // explicit object to vary it.
  function makeReviewPayload(review: AnyApi | null = null): AnyApi {
    return {
      appState: {
        activeWorkspaceId: "ws-pr",
        workspaces: [
          {
            id: "ws-pr",
            name: "web-app",
            cwd: "C:/work/a",
            notes: "Azure DevOps review workspace for web-app PR #123",
            panels: [{ id: "shell", title: "Shell" }],
            review:
              review === null
                ? {
                    provider: "azure-devops",
                    prKey: "ado-main:repo-1:123",
                    checkout: { mode: "linked-existing-workspace", rootPath: "C:/work/a" },
                  }
                : review,
          },
        ],
      },
    };
  }

  function makeReviewCtx(payload: AnyApi = makeReviewPayload()) {
    const saveWorkspace = vi.fn(async (ws: AnyApi) => ({
      appState: { workspaces: [ws], activeWorkspaceId: "ws-pr" },
    }));
    const harness = makeCtx(payload, { saveWorkspace });
    return { ...harness, saveWorkspace };
  }

  it("closing the Review tab offers the detach instead of silently doing nothing", async () => {
    const { ctx, saveWorkspace } = makeReviewCtx();
    const actions = createWorkspaceActions(ctx);

    actions.closeTab("review:ws-pr");
    await answerConfirm(ctx, true);

    expect(saveWorkspace).toHaveBeenCalledTimes(1);
    expect(saveWorkspace.mock.calls[0][0]).toMatchObject({ id: "ws-pr", review: null });
    // Hiding it would leave the PR link — and therefore the tab — in place.
    expect(ctx.hiddenViewIds.value.has("review:ws-pr")).toBe(false);
  });

  it("cancelling the prompt keeps the review link", async () => {
    const { ctx, saveWorkspace } = makeReviewCtx();
    const actions = createWorkspaceActions(ctx);

    actions.closeTab("review:ws-pr");
    await answerConfirm(ctx, false);

    expect(saveWorkspace).not.toHaveBeenCalled();
    expect(ctx.payload.value.appState.workspaces[0].review).not.toBeNull();
  });

  it("does not prompt for a Review tab whose workspace is no longer PR-linked", async () => {
    const { ctx, saveWorkspace } = makeReviewCtx(makeReviewPayload({ provider: "azure-devops", prKey: "" }));
    const actions = createWorkspaceActions(ctx);

    actions.closeTab("review:ws-pr");
    await flush();

    expect(ctx.overlay.value).toBeNull();
    expect(saveWorkspace).not.toHaveBeenCalled();
  });

  it("closing a normal tab of a PR-linked workspace is unaffected by the Review-tab branch", async () => {
    const { ctx, saveWorkspace } = makeReviewCtx();
    const actions = createWorkspaceActions(ctx);

    actions.closeTab("ws-pr:shell");
    await flush();

    // No prompt, and the tab takes the ordinary close path — the review link
    // is only ever cleared for the "review:" view id.
    expect(ctx.overlay.value).toBeNull();
    expect(ctx.hiddenViewIds.value.has("ws-pr:shell")).toBe(true);
    expect(saveWorkspace).not.toHaveBeenCalled();
  });

  it("confirmAndDetachWorkspaceReview clears the marker and the auto-set notes prefix", async () => {
    const { ctx, saveWorkspace } = makeReviewCtx();
    const actions = createWorkspaceActions(ctx);

    const detached = actions.confirmAndDetachWorkspaceReview("ws-pr");
    await answerConfirm(ctx, true);

    await expect(detached).resolves.toBe(true);
    expect(saveWorkspace.mock.calls[0][0]).toMatchObject({ review: null, notes: "" });
  });

  it("keeps user-written notes when detaching", async () => {
    const payload = makeReviewPayload();
    payload.appState.workspaces[0].notes = "my own note";
    const { ctx, saveWorkspace } = makeReviewCtx(payload);
    const actions = createWorkspaceActions(ctx);

    void actions.confirmAndDetachWorkspaceReview("ws-pr");
    await answerConfirm(ctx, true);

    expect(saveWorkspace.mock.calls[0][0].notes).toBe("my own note");
  });

  it("resolves false and toasts when the save fails", async () => {
    const harness = makeCtx(makeReviewPayload(), {
      saveWorkspace: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const notifs = useNotificationStore();
    const actions = createWorkspaceActions(harness.ctx);

    const detached = actions.confirmAndDetachWorkspaceReview("ws-pr");
    await answerConfirm(harness.ctx, true);

    await expect(detached).resolves.toBe(false);
    expect(notifs.persistentToasts.map((t: AnyApi) => t.title)).toContain("Detach failed");
  });

  it("ignores an unknown workspace id without prompting", async () => {
    const { ctx } = makeReviewCtx();
    const actions = createWorkspaceActions(ctx);

    await expect(actions.confirmAndDetachWorkspaceReview("ws-nope")).resolves.toBe(false);
    expect(ctx.overlay.value).toBeNull();
  });
});
