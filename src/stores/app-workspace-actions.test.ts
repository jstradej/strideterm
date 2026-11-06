import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { ref, shallowRef, computed } from "vue";
import { createWorkspaceActions } from "./app-workspace-actions.js";
import { useNotificationStore } from "./notifications.js";
import { reviewPrActionOutcomeSchema } from "../../electron/shared/review-pr-actions.js";
import type { OperationFinished } from "../../electron/shared/operation-events.js";

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
  const myActiveProfileId = ref<string | null>("profile-a");
  const isRemoteTransport = ref(false);
  const hiddenViewIds = ref(new Set<string>());
  const workspaceTabs = computed(
    () => [] as { id: string; type: string; title: string; status: string; tone: string }[],
  );

  const api: AnyApi = {
    deleteWorkspace: vi.fn(async () => initialPayload),
    ...apiOverrides,
  };

  const ctx = {
    payload,
    activeViewId,
    activeSessionId,
    myActiveWorkspaceId,
    myActiveProfileId,
    activateWorkspaceInGrid: vi.fn(async () => undefined),
    isRemoteTransport,
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

describe("review agent preparation operation delivery", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("retains a result that arrives before the start response and suppresses the generic toast", () => {
    const operation = {
      operationId: "op-prepare",
      kind: "review-agent.prepare",
      profileId: "profile-a",
      finishedAt: new Date().toISOString(),
      result: { sessionId: "temporary-session", repositoryName: "repo", agentName: "claude" },
    };
    const { ctx } = makeCtx({ appState: { workspaces: [] }, operations: { lastResults: [] } });
    const actions = createWorkspaceActions(ctx);

    actions.reportOperationFinished(operation);
    expect(actions.getReviewAgentPreparationResult("op-prepare")).toEqual(operation);

    expect(ctx.activateWorkspaceInGrid).not.toHaveBeenCalled();
    expect(useNotificationStore().sessions).toHaveLength(0);
  });

  it("does not deliver an operation from another profile to a subscriber", () => {
    const operation = {
      operationId: "op-prepare-other-profile",
      kind: "review-agent.prepare",
      profileId: "profile-a",
      finishedAt: new Date().toISOString(),
      result: { sessionId: "temporary-session", repositoryName: "repo", agentName: "claude" },
    };
    const { ctx } = makeCtx({ appState: { workspaces: [] }, operations: { lastResults: [] } });
    const actions = createWorkspaceActions(ctx);
    const listener = vi.fn();
    actions.subscribeReviewAgentPreparation(listener);
    ctx.myActiveProfileId.value = "profile-b";

    actions.reportOperationFinished(operation);

    expect(ctx.activateWorkspaceInGrid).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("operation notifications", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
  });

  function report(operation: OperationFinished): AnyApi {
    const { ctx } = makeCtx({ appState: { workspaces: [] }, operations: { lastResults: [] } });
    const actions = createWorkspaceActions(ctx);
    actions.reportOperationFinished(operation);
    return useNotificationStore().sessions.flatMap((session: AnyApi) => session.events)[0];
  }

  it("explains a stale provider recheck and says no action was applied", () => {
    const entry = report({
      operationId: "op-pr-stale",
      kind: "review-pr-action",
      profileId: "profile-a",
      workspaceId: "ws-a",
      finishedAt: new Date().toISOString(),
      result: reviewPrActionOutcomeSchema.parse({
        provider: "github",
        prKey: "owner/repo#42",
        action: "merge",
        status: "stale",
        message: "The source SHA changed while waiting for approval.",
      }),
    });
    expect(entry.title).toBe("Pull request changed before the action ran");
    expect(entry.body).toContain("No action was applied");
    expect(entry.body).toContain("fresh proposal");
    expect(entry.kind).toBe("completed");
  });

  it("names the completed action and surfaces a warning without suggesting a blind retry", () => {
    const entry = report({
      operationId: "op-pr-warning",
      kind: "review-pr-action",
      profileId: "profile-a",
      workspaceId: "ws-a",
      finishedAt: new Date().toISOString(),
      result: reviewPrActionOutcomeSchema.parse({
        provider: "azure-devops",
        prKey: "project/repo/17",
        action: "complete",
        status: "completed",
        message: "The pull request was completed.",
        warning: "The final audit record could not be refreshed.",
      }),
    });
    expect(entry.title).toBe("Pull request completed · Azure DevOps");
    expect(entry.body).toContain("The pull request was completed.");
    expect(entry.body).toContain("Warning: The final audit record could not be refreshed.");
    expect(entry.kind).toBe("error");
  });

  it("reports queued completion as pending provider work", () => {
    const entry = report({
      operationId: "op-pr-queued",
      kind: "review-pr-action",
      profileId: "profile-a",
      workspaceId: "ws-a",
      finishedAt: new Date().toISOString(),
      result: reviewPrActionOutcomeSchema.parse({
        provider: "azure-devops",
        prKey: "project/repo/17",
        action: "complete",
        status: "queued",
        message: "Azure DevOps queued the pull request for completion.",
      }),
    });
    expect(entry.title).toBe("Pull request completion queued · Azure DevOps");
    expect(entry.body).toContain("Provider policies determine when completion can proceed.");
    expect(entry.kind).toBe("completed");
  });

  it("does not claim an accepted action has completed", () => {
    const entry = report({
      operationId: "op-pr-accepted",
      kind: "review-pr-action",
      profileId: "profile-a",
      workspaceId: "ws-a",
      finishedAt: new Date().toISOString(),
      result: reviewPrActionOutcomeSchema.parse({
        provider: "github",
        prKey: "owner/repo#42",
        action: "approve",
        status: "accepted",
        message: "GitHub accepted the pull request action.",
      }),
    });
    expect(entry.title).toBe("Pull request action accepted · GitHub");
    expect(entry.body).toContain("resulting state is not confirmed");
    expect(entry.body).toContain("check the pull request before retrying");
    expect(entry.title).not.toContain("approved");
  });

  it("reports an explicit provider failure as an action failure", () => {
    const entry = report({
      operationId: "op-pr-failed",
      kind: "review-pr-action",
      profileId: "profile-a",
      workspaceId: "ws-a",
      finishedAt: new Date().toISOString(),
      result: reviewPrActionOutcomeSchema.parse({
        provider: "azure-devops",
        prKey: "project/repo/17",
        action: "complete",
        status: "failed",
        message: "Azure DevOps rejected completion due to conflicts.",
      }),
    });
    expect(entry.title).toBe("Pull request action failed · Azure DevOps");
    expect(entry.body).toContain("rejected completion due to conflicts");
    expect(entry.kind).toBe("error");
  });

  it("warns that a failed action may have reached the provider", () => {
    const entry = report({
      operationId: "op-pr-error",
      kind: "review-pr-action",
      profileId: "profile-a",
      workspaceId: "ws-a",
      finishedAt: new Date().toISOString(),
      error: { code: "provider-error", message: "Connection closed after sending the request." },
    });
    expect(entry.title).toBe("Pull request action outcome is uncertain");
    expect(entry.body).toContain("provider may have applied the action");
    expect(entry.body).toContain("Check the pull request's current status before retrying");
    expect(entry.kind).toBe("error");
  });

  it.each(["review-pr-inspect", "review-pr-action-proposal"])(
    "does not notify for routine successful %s operations",
    (kind) => {
      report({
        operationId: `op-${kind}`,
        kind,
        profileId: "profile-a",
        workspaceId: "ws-a",
        finishedAt: new Date().toISOString(),
        result: { snapshot: {}, status: "pending" },
      });
      expect(useNotificationStore().sessions).toHaveLength(0);
    },
  );
  it("shows action-specific failures with retained Git diagnostics", () => {
    const { ctx } = makeCtx({
      appState: { workspaces: [{ id: "ws-A", name: "Project A" }] },
      operations: { lastResults: [] },
    });
    const actions = createWorkspaceActions(ctx);

    actions.reportOperationFinished({
      operationId: "op-git-pull",
      kind: "git.pull",
      profileId: "profile-a",
      workspaceId: "ws-A",
      rootPath: "C:\\work\\a",
      finishedAt: new Date().toISOString(),
      error: { code: "internal_error", message: "Pull stopped.\n\nGit output:\nhook failed" },
    });

    const event = useNotificationStore().sessions[0]?.events[0];
    expect(event?.title).toBe("Git Pull failed");
    expect(event?.kind).toBe("error");
    expect(event?.body).toContain("Git output:");
    expect(event?.body).toContain("hook failed");
  });
});

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
    // Two "orders" task agents under the same parent — without the formatted
    // name, both delete prompts say "Delete task agent 'orders'?" and the user
    // can't tell which one is about to go. The sequence suffix in the prompt
    // matches what the sidebar card and the Telegram notification show, so
    // all three surfaces refer to the same task by the same string.
    const initial = {
      appState: {
        workspaces: [
          { id: "ws-parent", name: "orders", cwd: "C:\\work\\orders" },
          {
            id: "ws-orders-2",
            name: "orders",
            kind: "task",
            cwd: "C:\\work\\orders",
            task: { parentWorkspaceId: "ws-parent", taskId: "t-2", sequenceNumber: 2 },
          },
        ],
        activeWorkspaceId: "ws-orders-2",
      },
    };
    const { ctx, overlayProps } = makeCtx(initial);
    const actions = createWorkspaceActions(ctx);

    const finished = actions.deleteWorkspace("ws-orders-2");
    // Yield for confirmInApp to mount the dialog
    await Promise.resolve();
    expect(ctx.overlay.value).toBe("ConfirmDialog");
    const props = overlayProps.value as AnyApi;
    expect(String(props.title)).toBe("Delete task agent");
    expect(String(props.message)).toContain('"orders #2"');
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
    expect(toast.title).toBe("Couldn't remove workspace");
    expect(toast.body).toBe("Workspace folder could not be removed. Another process may be using this folder.");
    expect(toast.details).toEqual({
      rawError: "EBUSY: resource busy or locked",
      workspaceTitle: "Worktree B",
      path: expect.stringContaining("branch-b"),
    });
    // The user needs the path to finish cleanup manually — make sure it's
    // attached so the "Copy path" button has something to copy.
    expect(toast.copyPath).toContain("branch-b");
  });

  it("does not suggest another process is using the folder for unrelated disk errors", async () => {
    const initial = { appState: { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" } };
    const { ctx } = makeCtx(initial, {
      deleteWorkspace: vi.fn(async () => ({
        ...initial,
        appState: { ...initial.appState, workspaces: initial.appState.workspaces.filter((w) => w.id !== "ws-B") },
        deleteWorkspaceError: "EACCES: permission denied",
      })),
    });
    const actions = createWorkspaceActions(ctx);
    const notifs = useNotificationStore();

    const finished = actions.deleteWorkspace("ws-B");
    await answerConfirm(ctx, true);
    await answerConfirm(ctx, true);
    await finished;
    await new Promise((r) => setTimeout(r, 10));

    expect(notifs.persistentToasts[0].body).toBe("Workspace folder could not be removed.");
    expect(notifs.persistentToasts[0].body).not.toContain("Another process");
    expect(notifs.persistentToasts[0].details?.rawError).toContain("EACCES");
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
    expect(notifs.persistentToasts[0].body).toBe("Workspace could not be removed.");
    expect(notifs.persistentToasts[0].details?.rawError).toContain("ECONNREFUSED");
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
    expect(toast.title).toBe("Couldn't remove workspace");
    expect(toast.body).toBe("Workspace could not be removed.");
    expect(toast.details?.rawError).toContain("ECONNREFUSED");
    expect(toast.copyPath).toBe("");
    expect(optimisticallyDeletedIds.value.has("ws-B")).toBe(false);
  });
});

describe("createWorkspaceActions.cleanupAzureClosedPullRequests", () => {
  // `azureClosedPrCleanup` is what runtime.ts getPayload() broadcasts: the
  // parents whose background cleanup is running right now.
  it("takes busy state from the broadcast payload and refuses a start while the backend reports one running", async () => {
    const appState = { workspaces: makeWorkspaces(), activeWorkspaceId: "ws-A" };
    const initial = { appState, azureClosedPrCleanup: { parentWorkspaceIds: [], lastRuns: [] } };
    const cleanupAzureClosedPullRequests = vi.fn(async () => ({ started: true }));
    const { ctx, payload } = makeCtx(initial, { cleanupAzureClosedPullRequests });
    const actions = createWorkspaceActions(ctx);

    await expect(actions.cleanupAzureClosedPullRequests("ws-A")).resolves.toEqual({ started: true });
    expect(cleanupAzureClosedPullRequests).toHaveBeenCalledWith("ws-A");
    // Answered at once; the spinner is the backend's to turn on.
    expect(actions.isAzureClosedPrCleanupBusy("ws-A")).toBe(false);

    payload.value = { appState, azureClosedPrCleanup: { parentWorkspaceIds: ["ws-A"], lastRuns: [] } };
    expect(actions.isAzureClosedPrCleanupBusy("ws-A")).toBe(true);
    expect(actions.isAzureClosedPrCleanupBusy("ws-B")).toBe(false);
    await expect(actions.cleanupAzureClosedPullRequests("ws-A")).rejects.toThrow("already running");
    expect(cleanupAzureClosedPullRequests).toHaveBeenCalledOnce();

    payload.value = { appState, azureClosedPrCleanup: { parentWorkspaceIds: [], lastRuns: [] } };
    expect(actions.isAzureClosedPrCleanupBusy("ws-A")).toBe(false);
  });
});

describe("quickAddTemplateTab SSH target scope", () => {
  it("persists SSH tools opt-in on the new local panel only when explicitly enabled", async () => {
    const workspace = {
      id: "ws-a",
      name: "A",
      kind: "terminal",
      profileId: "profile-a",
      panels: [],
      activePanelId: "",
    };
    const { ctx, api } = makeCtx(
      { workspace: { workspace }, appState: { workspaces: [workspace] } },
      { saveWorkspace: vi.fn(async (next: AnyApi) => ({ workspace: { workspace: next } })) },
    );
    const actions = createWorkspaceActions(ctx);

    await actions.quickAddTemplateTab("claude", "Claude", "", { sshMcpEnabled: true });
    expect(api.saveWorkspace.mock.calls[0][0].panels.at(-1)).toMatchObject({ sshMcpEnabled: true });

    ctx.payload.value.workspace.workspace.panels = [];
    await actions.quickAddTemplateTab("bash", "Shell");
    expect(api.saveWorkspace.mock.calls[1][0].panels.at(-1)).not.toHaveProperty("sshMcpEnabled");
  });

  it("rejects absent and cross-profile SSH targets and creates a tab only in the active profile", async () => {
    const active = { id: "ws-a", kind: "terminal", profileId: "profile-a", panels: [], activePanelId: "" };
    const saveWorkspace = vi.fn(async (workspace: AnyApi) => ({ workspace }));
    const initial = { workspace: { workspace: active }, appState: { workspaces: [active] } };
    const { ctx } = makeCtx(initial, { saveWorkspace });
    const actions = createWorkspaceActions(ctx);

    await expect(actions.quickAddTemplateTab("", "SSH", "", { kind: "ssh", sshHostId: "h1" })).resolves.toBeUndefined();
    expect(saveWorkspace).toHaveBeenCalledTimes(1);

    ctx.payload.value = { ...initial, workspace: { workspace: { ...active, profileId: "profile-b" } } };
    await expect(actions.quickAddTemplateTab("", "SSH", "", { kind: "ssh", sshHostId: "h1" })).rejects.toThrow(
      "different profile",
    );
    expect(saveWorkspace).toHaveBeenCalledTimes(1);

    ctx.payload.value = { ...initial, workspace: { workspace: null } };
    await expect(actions.quickAddTemplateTab("", "SSH", "", { kind: "ssh", sshHostId: "h1" })).rejects.toThrow(
      "Choose a terminal workspace",
    );
    expect(saveWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("hosted terminals", () => {
  const filesPanel = { id: "files1", title: "Files", command: "__files__" };
  const workspace = (panels: AnyApi[]) => ({
    id: "ws-a",
    name: "A",
    kind: "terminal",
    profileId: "profile-a",
    panels,
    activePanelId: "files1",
  });
  const make = (panels: AnyApi[]) => {
    const ws = workspace(panels);
    return makeWith([ws], ws);
  };
  const makeWith = (workspaces: AnyApi[], active: AnyApi) => {
    const ws = active;
    const saveWorkspace = vi.fn(async (next: AnyApi) => ({ workspace: { workspace: next } }));
    const harness = makeCtx(
      { workspace: { workspace: ws }, appState: { activeWorkspaceId: ws.id, workspaces } },
      { saveWorkspace },
    );
    harness.ctx.activeViewId.value = "files:files1";
    return { ...harness, actions: createWorkspaceActions(harness.ctx), saveWorkspace };
  };

  it("opens a hosted panel with the folder, command and host, without changing the active view or panel", async () => {
    const { actions, saveWorkspace, ctx } = make([filesPanel]);

    const viewId = await actions.openHostedTerminal("ws-a", "files:files1", {
      cwd: "/repo/src",
      command: "claude",
      title: "Claude",
    });

    const saved = saveWorkspace.mock.calls[0][0];
    expect(saved.panels).toHaveLength(2);
    expect(saved.panels[1]).toMatchObject({
      title: "Claude",
      command: "claude",
      cwd: "/repo/src",
      shell: true,
      hostedBy: "files:files1",
    });
    expect(viewId).toBe(`ws-a:${saved.panels[1].id}`);
    expect(saved.activePanelId).toBe("files1");
    expect(ctx.activeViewId.value).toBe("files:files1");
  });

  it("adds a second hosted panel beside an earlier one", async () => {
    const old = { id: "old", title: "Terminal 2", command: "", hostedBy: "files:files1" };
    const { actions, saveWorkspace } = make([filesPanel, old]);

    await actions.openHostedTerminal("ws-a", "files:files1", { command: "codex" });

    expect(saveWorkspace).toHaveBeenCalledTimes(1);
    const ids = saveWorkspace.mock.calls[0][0].panels.map((panel: AnyApi) => panel.id);
    expect(ids).toContain("old");
    expect(ids).toHaveLength(3);
  });

  it("refuses a host that is not a Files panel of the active workspace", async () => {
    const { actions, saveWorkspace } = make([filesPanel]);
    await expect(actions.openHostedTerminal("ws-a", "files:elsewhere", {})).rejects.toThrow("Files tab");
    expect(saveWorkspace).not.toHaveBeenCalled();
  });

  it("Move to a tab clears hostedBy, makes it the active panel and selects its view", async () => {
    const hosted = { id: "t2", title: "Hosted", command: "", hostedBy: "files:files1" };
    const { actions, saveWorkspace, ctx } = make([filesPanel, hosted]);

    await actions.moveHostedTerminalToTab("ws-a", "t2");

    const saved = saveWorkspace.mock.calls[0][0];
    expect(saved.panels.find((panel: AnyApi) => panel.id === "t2").hostedBy).toBe("");
    expect(saved.activePanelId).toBe("t2");
    expect(ctx.activeViewId.value).toBe("ws-a:t2");
  });

  describe("in a workspace that is not the active one", () => {
    const other = (id: string, panels: AnyApi[], profileId = "profile-a") => ({
      id,
      name: id,
      kind: "terminal",
      profileId,
      panels,
      activePanelId: "files1",
    });

    it("saves the owning workspace, never the active one, even when both share the files panel id", async () => {
      const active = other("ws-a", [filesPanel]);
      const owner = other("ws-b", [filesPanel]);
      const { actions, saveWorkspace } = makeWith([active, owner], active);

      const viewId = await actions.openHostedTerminal("ws-b", "files:files1", { command: "codex" });

      const saved = saveWorkspace.mock.calls[0][0];
      expect(saved.id).toBe("ws-b");
      expect(saved.panels[1]).toMatchObject({ command: "codex", hostedBy: "files:files1" });
      expect(viewId).toBe(`ws-b:${saved.panels[1].id}`);
    });

    it("refuses a workspace of another profile and a host the owner does not have", async () => {
      const active = other("ws-a", [filesPanel]);
      const foreign = other("ws-b", [filesPanel], "profile-b");
      const bare = other("ws-c", []);
      const { actions, saveWorkspace } = makeWith([active, foreign, bare], active);

      await expect(actions.openHostedTerminal("ws-b", "files:files1", {})).rejects.toThrow("Files tab");
      await expect(actions.openHostedTerminal("ws-c", "files:files1", {})).rejects.toThrow("Files tab");
      await expect(actions.moveHostedTerminalToTab("ws-b", "files1")).rejects.toThrow("no longer");
      expect(saveWorkspace).not.toHaveBeenCalled();
    });

    it("Move to a tab saves the owner, activates it and then selects the terminal", async () => {
      const hosted = { id: "t2", title: "Hosted", command: "", hostedBy: "files:files1" };
      const active = other("ws-a", [filesPanel, { ...hosted, id: "t9" }]);
      const owner = other("ws-b", [filesPanel, hosted]);
      const { actions, saveWorkspace, ctx } = makeWith([active, owner], active);

      await actions.moveHostedTerminalToTab("ws-b", "t2");

      const saved = saveWorkspace.mock.calls[0][0];
      expect(saved.id).toBe("ws-b");
      expect(saved.panels.find((panel: AnyApi) => panel.id === "t2").hostedBy).toBe("");
      expect(ctx.activateWorkspaceInGrid).toHaveBeenCalledWith("ws-b");
      expect(ctx.activeViewId.value).toBe("ws-b:t2");
    });

    it("closes a hosted terminal of another workspace by saving that workspace", () => {
      const hosted = { id: "t2", title: "Hosted", command: "", hostedBy: "files:files1" };
      const active = other("ws-a", [filesPanel, { ...hosted, id: "t9" }]);
      const owner = other("ws-b", [filesPanel, hosted]);
      const { actions, saveWorkspace } = makeWith([active, owner], active);

      actions.closeTab("ws-b:t2");

      expect(saveWorkspace).toHaveBeenCalledTimes(1);
      const saved = saveWorkspace.mock.calls[0][0];
      expect(saved.id).toBe("ws-b");
      expect(saved.panels.map((panel: AnyApi) => panel.id)).toEqual(["files1"]);
    });
  });

  it("Move to a tab rejects a panel the workspace no longer has", async () => {
    const { actions, saveWorkspace } = make([filesPanel]);
    await expect(actions.moveHostedTerminalToTab("ws-a", "gone")).rejects.toThrow("no longer");
    expect(saveWorkspace).not.toHaveBeenCalled();
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

// Regression: a refused grid re-shape was only console.error'd, so picking a
// layout in the chip simply did nothing.
describe("createWorkspaceActions.pickLayout — grid re-shape failure", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("tells the user when the grid layout cannot be changed", async () => {
    const { ctx } = makeCtx({ appState: { workspaces: [] } });
    ctx.layoutPickerMode = ref("grid");
    ctx.isGridVisible = ref(true);
    ctx.setGridLayout = vi.fn(() => Promise.reject(new Error("Grid is not enabled for this window")));
    ctx.enableWorkspaceGrid = vi.fn();
    const actions = createWorkspaceActions(ctx);

    actions.pickLayout("rows");
    await vi.waitFor(() => expect(useNotificationStore().sessions).toHaveLength(1));

    expect(ctx.setGridLayout).toHaveBeenCalledWith("rows");
    const event = useNotificationStore().sessions[0].events[0];
    expect(event.title).toBe("Couldn't change layout");
    expect(event.body).toBe("Grid is not enabled for this window");
  });
});

describe("createWorkspaceActions.openJiraViewInOwnWorkspace", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const parent = {
    id: "jira-ws",
    name: "Jira inbox",
    kind: "jira",
    profileId: "profile-a",
    cwd: "",
    panels: [],
    workItems: [],
  };
  const boardView = {
    viewId: "view-42",
    kind: "board" as const,
    connectionId: "jira-1",
    boardId: 42,
    boardName: "Engineering board",
    title: "Eng",
    mode: "backlog" as const,
    sprintId: null,
    quickFilterIds: [3],
    assignee: null,
    doneWithinDays: 14 as const,
    projectKeys: ["ENG"],
    createdAt: 1,
    updatedAt: 1,
  };
  const personalView = { ...boardView, viewId: "view-me", kind: "personal" as const, boardId: null };

  function setup(extraWorkspaces: AnyApi[] = [], apiOverrides: AnyApi = {}) {
    const state = {
      workspaceId: "jira-ws",
      profileId: "profile-a",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, boardView, personalView],
      activeViewId: "issues",
      syncByViewId: {},
    };
    const payload: AnyApi = {
      appState: { activeWorkspaceId: "jira-ws", workspaces: [parent, ...extraWorkspaces] },
      workspace: { workspace: parent },
      jiraWorkspaceViews: { "jira-ws": state },
    };
    const calls: string[] = [];
    const harness = makeCtx(payload, {
      saveWorkspace: vi.fn(async (draft: AnyApi) => {
        calls.push(`saveWorkspace:${draft.kind}`);
        return payload;
      }),
      saveJiraWorkspaceView: vi.fn(async () => {
        calls.push("saveJiraWorkspaceView");
        return state;
      }),
      deleteWorkspace: vi.fn(async () => {
        calls.push("deleteWorkspace");
        return payload;
      }),
      ...apiOverrides,
    });
    harness.ctx.activateWorkspaceInGrid = vi.fn(async () => {
      calls.push("activate");
    });
    return { ...harness, calls, actions: createWorkspaceActions(harness.ctx) };
  }

  it("saves a jira-board child with the saved view's settings, then activates it", async () => {
    const { actions, api, calls, ctx } = setup();
    await actions.openJiraViewInOwnWorkspace("jira:jira-ws:view:view-42");
    expect(calls).toEqual(["saveWorkspace:jira-board", "saveJiraWorkspaceView", "activate"]);
    const child = api.saveWorkspace.mock.calls[0][0];
    expect(child).toMatchObject({
      name: "Engineering board",
      kind: "jira-board",
      profileId: "profile-a",
      connectionId: "jira-1",
      cwd: "",
      panels: [],
      review: null,
      task: null,
      workItems: [],
      jiraBoard: {
        parentWorkspaceId: "jira-ws",
        connectionId: "jira-1",
        boardId: "42",
        boardName: "Engineering board",
        projectKeys: ["ENG"],
      },
    });
    expect(api.saveJiraWorkspaceView).toHaveBeenCalledWith({
      workspaceId: child.id,
      view: expect.objectContaining({
        kind: "board",
        connectionId: "jira-1",
        boardId: 42,
        mode: "backlog",
        quickFilterIds: [3],
        doneWithinDays: 14,
        projectKeys: ["ENG"],
      }),
    });
    expect(api.saveJiraWorkspaceView.mock.calls[0][0].view).not.toHaveProperty("viewId");
    expect(ctx.activateWorkspaceInGrid).toHaveBeenCalledWith(child.id);
  });

  it("opens the board workspace that already exists instead of creating a second one", async () => {
    const existing = {
      id: "board-child",
      kind: "jira-board",
      profileId: "profile-a",
      jiraBoard: { parentWorkspaceId: "jira-ws", connectionId: "jira-1", boardId: "42" },
    };
    const { actions, api, ctx } = setup([existing]);
    await actions.openJiraViewInOwnWorkspace("jira:jira-ws:view:view-42");
    expect(api.saveWorkspace).not.toHaveBeenCalled();
    expect(ctx.activateWorkspaceInGrid).toHaveBeenCalledWith("board-child");
  });

  it("checks that the board view can be saved before creating anything", async () => {
    const { actions, api } = setup([], { saveJiraWorkspaceView: undefined });
    await expect(actions.openJiraViewInOwnWorkspace("jira:jira-ws:view:view-42")).rejects.toThrow(
      /Saving a board view is not available/,
    );
    expect(api.saveWorkspace).not.toHaveBeenCalled();
  });

  it("removes the child again when its view could not be saved, and activates nothing", async () => {
    const { actions, api, ctx, calls } = setup([], {
      saveJiraWorkspaceView: vi.fn(async () => {
        throw new Error("View store locked");
      }),
    });
    await expect(actions.openJiraViewInOwnWorkspace("jira:jira-ws:view:view-42")).rejects.toThrow("View store locked");
    const childId = api.saveWorkspace.mock.calls[0][0].id;
    expect(api.deleteWorkspace).toHaveBeenCalledWith(childId, { deleteFromDisk: false });
    expect(ctx.activateWorkspaceInGrid).not.toHaveBeenCalled();
    expect(calls).toEqual(["saveWorkspace:jira-board", "deleteWorkspace"]);
  });

  it("treats a superseded activation as done, not as a failure", async () => {
    const { actions, ctx } = setup();
    ctx.activateWorkspaceInGrid = vi.fn(async () => {
      throw new Error("Workspace activation was superseded");
    });
    await expect(actions.openJiraViewInOwnWorkspace("jira:jira-ws:view:view-42")).resolves.toBeUndefined();
  });

  it("refuses a view that is not a saved board", async () => {
    const { actions, api } = setup();
    await expect(actions.openJiraViewInOwnWorkspace("jira:jira-ws:view:view-me")).rejects.toThrow(/saved board tab/);
    await expect(actions.openJiraViewInOwnWorkspace("jira:jira-ws")).rejects.toThrow(/saved board tab/);
    expect(api.saveWorkspace).not.toHaveBeenCalled();
  });
});

describe("createWorkspaceActions.closeTab for a saved Jira view", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const parent = {
    id: "jira-ws",
    name: "Jira inbox",
    kind: "jira",
    profileId: "profile-a",
    cwd: "",
    panels: [],
    workItems: [],
  };
  const boardView = {
    viewId: "view-42",
    kind: "board" as const,
    connectionId: "jira-1",
    boardId: 42,
    boardName: "Engineering board",
    title: "Eng",
    mode: "backlog" as const,
    sprintId: null,
    quickFilterIds: [],
    assignee: null,
    doneWithinDays: 14 as const,
    createdAt: 1,
    updatedAt: 1,
  };

  function stateWith(views: AnyApi[]) {
    return {
      workspaceId: "jira-ws",
      profileId: "profile-a",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, ...views],
      activeViewId: "issues",
      syncByViewId: {},
    };
  }

  async function closeAndGetUndo(afterClose: (ctx: AnyApi) => void) {
    const saveJiraWorkspaceView = vi.fn(async () => stateWith([boardView]));
    const payload: AnyApi = {
      appState: { activeWorkspaceId: "jira-ws", workspaces: [parent] },
      workspace: { workspace: parent },
      jiraWorkspaceViews: { "jira-ws": stateWith([boardView]) },
    };
    const { ctx } = makeCtx(payload, {
      removeJiraWorkspaceView: vi.fn(async () => stateWith([])),
      saveJiraWorkspaceView,
    });
    const toast = vi.spyOn(useNotificationStore(), "pushEphemeralToast");
    createWorkspaceActions(ctx).closeTab("jira:jira-ws:view:view-42");
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    afterClose(ctx);
    return { undo: toast.mock.calls[0][0].undo!, saveJiraWorkspaceView };
  }

  it("restores the closed view when nothing replaced it", async () => {
    const { undo, saveJiraWorkspaceView } = await closeAndGetUndo(() => undefined);
    await undo.run();
    expect(saveJiraWorkspaceView).toHaveBeenCalledOnce();
  });

  it("does not overwrite a view of the same board saved again after the close", async () => {
    const { undo, saveJiraWorkspaceView } = await closeAndGetUndo((ctx) => {
      ctx.payload.value = {
        ...ctx.payload.value,
        jiraWorkspaceViews: { "jira-ws": stateWith([{ ...boardView, viewId: "view-new", title: "Eng again" }]) },
      };
    });
    await expect(undo.run()).rejects.toThrow("This board tab was already reopened.");
    expect(saveJiraWorkspaceView).not.toHaveBeenCalled();
  });
});
