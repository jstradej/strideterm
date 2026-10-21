import { defineStore } from "pinia";
import { markRaw, ref, watch } from "vue";
import type { Transport, CallableTransport } from "../transport.js";
import type { StatePayload } from "../../electron/shared/types/state.js";
import { operationFinishedSchema, type OperationFinished } from "../../electron/shared/operation-events.js";
import { rlog } from "../lib/renderer-log.js";
import { managedReviewBranchAlias, sourceBranchName } from "../../electron/shared/review-source-identity.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GitSnapshot = Record<string, any>;

const newGitIdempotencyKey = (): string => crypto.randomUUID();

interface PendingGitAction {
  type: string;
  baseBranch: string;
  stashDirty?: boolean;
  /** Fetch the remote before running the action so the base ref is current. */
  fetchFirst?: boolean;
  message?: string;
  severity?: string;
  isDestructive?: boolean;
  snapshotHash?: string;
  // Destructive action fields
  action?: string;
  title?: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;
}

interface ConflictFileEntry {
  path: string;
  conflictType: string;
  stages: number[];
  binary: boolean;
  resolved: boolean;
}

interface ConflictDialogState {
  open: boolean;
  workspaceId: string;
  rootPath: string;
  /** All files (pending + resolved) — merged across loads so resolved files stay visible */
  conflicts: ConflictFileEntry[];
  loading: boolean;
  error: string;
}

interface GitUiState {
  busyAction?: string;
  /** Human-readable label for the action currently running (e.g. "Fetching origin/develop…").
   *  Drives the spinner banner; updated mid-run for multi-phase actions like fetch→rebase. */
  busyPhase?: string;
  /** Live git output streamed while a push/force-push runs (incl. pre-push hook).
   *  Shown under the spinner so a slow/blocking hook isn't an opaque wait. Reset
   *  at the start of each push; the completed output ends up in lastResult.rawOutput. */
  pushProgress?: string;
  lastResult?: {
    ok: boolean;
    summary: string;
    warnings: unknown[];
    conflicts: unknown[];
    rawOutput: string;
    operationState: unknown;
    at: string;
  } | null;
  conflictDialog?: ConflictDialogState | null;
  selectedDiff?: { path: string; scope: string } | null;
  diffPreview?: unknown;
  pendingAction?: PendingGitAction | null;
  snapshotHash?: string;
  activeRootPath?: string;
  selectedCommit?: string;
  commitDiffPreview?: unknown;
  activeTab?: string;
  /** New Git layout selection, deliberately separate from legacy tab ids. */
  activeGitView?: "history" | "changes" | "review";
  stagedCommitMessages?: Record<string, string>;
  classicCommitMessages?: Record<string, string>;
  classicSelectedPaths?: Record<string, string[]>;
  tags?: unknown[];
  tagsLoading?: boolean;
  tagsError?: string;
  remoteBranches?: unknown[];
  remoteBranchesLoading?: boolean;
  remoteBranchesError?: string;
  branchesLoading?: boolean;
  branchesError?: string;
  branchList?: {
    current: string;
    upstream: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    local: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    remotes: any[];
    defaultBranch: string;
    defaultRemote: string;
  };
  graphLoading?: boolean;
  graphRequestId?: number;
  graphError?: string;
  graph?: {
    head: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commits: any[];
    refs: Record<string, string>;
  };
  overrideBaseBranch?: string;
  baseComparison?: {
    baseBranch: string;
    aheadCount: number;
    behindCount: number;
    ok: boolean;
    error?: string;
  } | null;
  baseComparisonLoading?: boolean;
  activeReviewTab?: string;
  commentFilter?: string;
  commentSort?: string;
  commentSortDir?: string;
  commentSearch?: string;
  agentSubTab?: string;
  reviewSelectedFile?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reviewFileDiffPreview?: Record<string, any>;
  [key: string]: unknown;
}

interface ConfirmParams {
  action: string;
  severity?: string;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;
}

function buildConfirmMessage({
  type,
  snapshot,
  baseBranch,
  fetchFirst,
}: {
  type: string;
  snapshot: GitSnapshot | null;
  baseBranch?: string;
  fetchFirst?: boolean;
}): string {
  const target = baseBranch || snapshot?.baseBranch || "base";
  const branch = snapshot?.branch || "current branch";

  // The FIRST line becomes the dialog <h2> title — keep it short so it renders
  // as a normal heading, not a giant wall of text. Everything after explains,
  // in plain language, exactly what the action will do (the body renders at
  // normal size). GitPane splits line[0] as the title and the rest as the body.
  // Branch/ref names are wrapped in `backticks` — ConfirmDialog renders those
  // spans as monospace chips so the refs stand out from the prose.
  let title = "";
  const body: string[] = [];

  if (type === "merge") {
    title = `Merge \`${target}\` into your branch?`;
    body.push(
      `Brings new commits from \`${target}\` into \`${branch}\` and adds a merge commit. Your existing commit history is kept.`,
    );
  } else if (type === "rebase") {
    title = `Rebase onto \`${target}\`?`;
    body.push(
      `Re-applies your \`${branch}\` commits on top of the latest \`${target}\`. The file contents are preserved, but commit hashes change — if you already pushed, the next push needs a force-push.`,
    );
  } else if (type === "merge-into-base") {
    title = `Merge \`${branch}\` into \`${target}\`?`;
    body.push(`Runs git merge in the \`${target}\` worktree, bringing your \`${branch}\` commits into \`${target}\`.`);
  } else if (type === "abort") {
    title = "Abort the current Git operation?";
    body.push("Stops the in-progress operation and restores the working tree to the state before it started.");
  }

  if (fetchFirst && (type === "merge" || type === "rebase")) {
    body.push(
      `First fetches the latest \`${target}\` from the remote, so you integrate current work and not a stale copy.`,
    );
  }
  if (snapshot?.dirty && type !== "abort") {
    body.push("You have uncommitted changes — they will be stashed before the action and restored afterwards.");
  }
  if (snapshot?.upstream && type !== "abort") {
    body.push(`Upstream: \`${snapshot.upstream}\`.`);
  }

  return [title, ...body].join("\n");
}

// Backstop so a git IPC that never settles (hung `git fetch` waiting on a
// credential prompt, dead/wedged backend) can't pin `busyAction` forever and
// permanently disable the git controls. On timeout the action rejects, the
// banner explains it, and `finally` clears the busy flag so the UI recovers on
// its own. Refresh is still the instant manual escape hatch.
const GIT_ACTION_TIMEOUT_MS = 120_000;

// Cap on retained live push output (chars). Keeps the tail — where a failing
// pre-push hook's error summary lands — and prevents a chatty hook from growing
// the per-workspace buffer without bound.
const PUSH_PROGRESS_MAX = 100_000;

// A review Git step includes the user's decision in the proposal dialog and a
// push that may run for minutes; the runtime's operation and the operation wait
// own their own limits, so the generic backstop must not cut either short.
const REVIEW_GIT_STEP_OPTS = { timeoutMs: 0 };
// Fetch-first merge/rebase waits for the generic operation to finish, so the
// short renderer IPC backstop must not discard that accepted operation.
const GIT_OPERATION_WAIT_OPTS = { timeoutMs: 0 };

function withGitTimeout<T>(promise: Promise<T>, ms: number, action: string): Promise<T> {
  if (!ms || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Git "${action}" did not respond within ${Math.round(ms / 1000)}s. ` +
            `It may be waiting on credentials or a stalled network. Press Refresh to recover.`,
        ),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Human label shown in the spinner banner while an action runs. Multi-phase
// actions (rebase/merge with fetch-first) override this via setBusyPhase.
function defaultBusyLabel(action: string): string {
  const map: Record<string, string> = {
    fetch: "Fetching from remote…",
    pull: "Pulling…",
    push: "Pushing…",
    "force-push": "Force-pushing…",
    rebase: "Rebasing…",
    merge: "Merging…",
    "merge-into-base": "Merging into base…",
    refresh: "Refreshing…",
    checkout: "Switching branch…",
    "create-branch": "Creating branch…",
    "cherry-pick": "Cherry-picking…",
    squash: "Squashing commits…",
    commit: "Committing…",
    "stash-pop": "Restoring stash…",
    abort: "Aborting operation…",
    "remove-worktree": "Removing worktree…",
  };
  return map[action] || "Working…";
}

// Identity hash for the auto-dismiss-stale-confirm guard (UC-12). Only include
// fields whose change actually invalidates a queued rebase/merge/abort confirm:
// an operation now in progress (can't start another) or a changed dirty state
// (alters stash behaviour). The ahead/behind and compareWithBase counts are
// deliberately EXCLUDED — they flap on every background fetch and every time
// base auto-detection re-resolves, and dismissStalePending runs on every
// snapshot poll. Hashing them meant a poll landing right after the click wiped
// the just-opened confirm, so the dialog never appeared ("press button, nothing
// happens"). Those counts changing never makes the action unsafe (at worst it's
// a no-op the backend handles), so they don't belong in the staleness check.
function computeSnapshotHash(snapshot: GitSnapshot | null): string {
  if (!snapshot) return "";
  return [snapshot.operationState?.kind, snapshot.dirtyCount].join("|");
}

// Shared by gitSelectCommit/gitSelectDiff/reviewSelectFileDiff: show an
// optimistic "Loading…" placeholder immediately, then replace it with either
// the real result or an error-shaped fallback carrying the same identity
// fields (hash / path / scope) so the viewer can keep rendering something
// sensible while (or if) the fetch fails.
async function loadDiffPreview(
  ui: GitUiState,
  requestId: number,
  field: "diffPreview" | "commitDiffPreview" | "reviewFileDiffPreview",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  identity: Record<string, any>,
  loadingSummary: string,
  errorFallback: string,
  isCurrent: () => boolean,
  fetch: () => Promise<unknown>,
): Promise<void> {
  ui[field] = markGitReadPayload({ ok: true, ...identity, diff: "", summary: loadingSummary });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await fetch()) as any;
    if (isCurrent()) ui[field] = markGitReadPayload(result);
  } catch (error) {
    if (isCurrent())
      ui[field] = markGitReadPayload({
        ok: false,
        ...identity,
        diff: "",
        summary: (error as Error)?.message || errorFallback,
      });
  }
}

// Large Git read payloads are immutable and replaced as a whole, so keep them
// out of Vue's deep proxy conversion while the containing UI state stays reactive.
function markGitReadPayload<T>(value: T): T {
  return value && typeof value === "object" ? (markRaw(value as object) as T) : value;
}

function buildDestructiveConfirm({
  action,
  severity,
  title,
  body,
  confirmLabel,
  cancelLabel,
  payload,
}: ConfirmParams): PendingGitAction {
  return {
    action,
    severity: severity || "info",
    title,
    body: body || "",
    confirmLabel: confirmLabel || "Confirm",
    cancelLabel: cancelLabel || "Cancel",
    payload: payload || {},
    isDestructive: true,
    type: "",
    baseBranch: "",
  };
}

export const useGitUiStore = defineStore("git-ui", () => {
  // Per-workspace UI state indexed by workspaceId.
  //
  // VIEWER-LOCAL by design: this Pinia store lives in each renderer process,
  // so two windows showing the same workspace keep independent active tabs,
  // selected diffs/commits and active git roots — one window's clicks never
  // flip the other's view. Durable git data (snapshots, branches, repo
  // state) stays workspace-owned in the backend payload.
  const state = ref<Record<string, GitUiState>>({});
  const gitHistoryPreferences = ref<Record<string, { favorites: string[]; recent: string[] }>>({});
  const gitHistorySelections = ref<Record<string, { ref: string; commitSearch: string }>>({});
  const readGeneration = new Map<string, number>();
  const recentGitOperationOutcomes = new Map<string, OperationFinished>();
  const gitOperationWaiters = new Map<string, Set<(outcome: OperationFinished) => void>>();
  function nextReadGeneration(key: string): number {
    const next = (readGeneration.get(key) || 0) + 1;
    readGeneration.set(key, next);
    return next;
  }

  let _api: Transport | null = null;

  function init(api: Transport): void {
    _api = api;
    api.onOperationFinished?.((outcome) => {
      rememberGitOperationOutcome(outcome);
    });
    // Live push output (streamed git stdout/stderr, incl. pre-push hook). Keyed
    // by workspaceId — the busy banner is per-workspace, like busyAction. Kept
    // bounded to the tail (where a hook's error summary lives) so a chatty hook
    // can't grow this unboundedly.
    api.onGitPushProgress?.(({ workspaceId, chunk }) => {
      if (!workspaceId || !chunk) return;
      const ui = ensure(workspaceId);
      const next = (ui.pushProgress || "") + chunk;
      ui.pushProgress = next.length > PUSH_PROGRESS_MAX ? next.slice(next.length - PUSH_PROGRESS_MAX) : next;
    });
  }

  function rememberGitOperationOutcome(outcome: OperationFinished): void {
    recentGitOperationOutcomes.set(outcome.operationId, outcome);
    while (recentGitOperationOutcomes.size > 100) {
      const oldest = recentGitOperationOutcomes.keys().next().value;
      if (!oldest) break;
      recentGitOperationOutcomes.delete(oldest);
    }
    const waiters = gitOperationWaiters.get(outcome.operationId);
    if (!waiters) return;
    gitOperationWaiters.delete(outcome.operationId);
    for (const resolve of waiters) resolve(outcome);
  }

  function findGitOperationOutcome(appStore: { payload?: unknown }, operationId: string): OperationFinished | null {
    const payload = appStore.payload as { operations?: { lastResults?: unknown[] } } | null | undefined;
    const value =
      recentGitOperationOutcomes.get(operationId) ??
      payload?.operations?.lastResults?.find(
        (item) => (item as { operationId?: unknown })?.operationId === operationId,
      );
    const parsed = operationFinishedSchema.safeParse(value);
    if (!parsed.success) return null;
    rememberGitOperationOutcome(parsed.data);
    return parsed.data;
  }

  async function waitForGitOperation(appStore: { payload?: unknown }, operationId: string): Promise<OperationFinished> {
    const existing = findGitOperationOutcome(appStore, operationId);
    if (existing) return existing;
    return new Promise((resolve) => {
      const waiters = gitOperationWaiters.get(operationId) || new Set<(outcome: OperationFinished) => void>();
      let stopWatching = () => {};
      const settle = (outcome: OperationFinished) => {
        waiters.delete(settle);
        if (!waiters.size) gitOperationWaiters.delete(operationId);
        stopWatching();
        resolve(outcome);
      };
      waiters.add(settle);
      gitOperationWaiters.set(operationId, waiters);
      stopWatching = watch(
        () =>
          (appStore.payload as { operations?: { lastResults?: unknown[] } } | null | undefined)?.operations
            ?.lastResults,
        () => {
          const outcome = findGitOperationOutcome(appStore, operationId);
          if (outcome) settle(outcome);
        },
      );
      // The outcome may have landed between the first lookup and waiter registration.
      const arrived = findGitOperationOutcome(appStore, operationId);
      if (arrived) {
        settle(arrived);
      }
    });
  }

  async function resolveLongGitAction(
    appStore: { payload?: unknown },
    start: { operationId?: string; started?: boolean; result?: { ok?: boolean } } | null,
  ): Promise<{ result?: { ok?: boolean; summary?: string; warnings?: unknown[] } } | null> {
    if (!start?.started) return start;
    if (!start.operationId) {
      return {
        result: {
          ok: false,
          summary: "The Git action was accepted without an operation ID, so its result could not be verified.",
        },
      };
    }
    const outcome = await waitForGitOperation(appStore, start.operationId);
    if ("result" in outcome) {
      return {
        result: {
          ...(outcome.result as { summary?: string; warnings?: unknown[] }),
          ok: outcome.result.ok !== false,
        },
      };
    }
    return { result: { ok: false, summary: outcome.error.message } };
  }

  function ensure(workspaceId: string): GitUiState {
    if (!workspaceId) return {};
    if (!state.value[workspaceId]) {
      // Assign via spread to guarantee Vue detects the new key
      state.value = { ...state.value, [workspaceId]: {} };
    }
    return state.value[workspaceId];
  }

  function get(workspaceId: string): GitUiState {
    return state.value[workspaceId] || {};
  }

  function getStagedCommitMessage(workspaceId: string, rootPath: string): string {
    return ensure(workspaceId).stagedCommitMessages?.[rootPath || "default-root"] || "";
  }

  function setStagedCommitMessage(workspaceId: string, rootPath: string, message: string): void {
    const ui = ensure(workspaceId);
    const key = rootPath || "default-root";
    ui.stagedCommitMessages = { ...(ui.stagedCommitMessages || {}), [key]: message };
  }

  function getClassicCommitMessage(workspaceId: string, rootPath: string): string {
    return ensure(workspaceId).classicCommitMessages?.[rootPath || "default-root"] || "";
  }

  function setClassicCommitMessage(workspaceId: string, rootPath: string, message: string): void {
    const ui = ensure(workspaceId);
    const key = rootPath || "default-root";
    ui.classicCommitMessages = { ...(ui.classicCommitMessages || {}), [key]: message };
  }

  function getClassicSelectedPaths(workspaceId: string, rootPath: string): string[] {
    return [...(ensure(workspaceId).classicSelectedPaths?.[rootPath || "default-root"] || [])];
  }

  function setClassicSelectedPaths(workspaceId: string, rootPath: string, paths: string[]): void {
    const ui = ensure(workspaceId);
    const key = rootPath || "default-root";
    ui.classicSelectedPaths = { ...(ui.classicSelectedPaths || {}), [key]: [...new Set(paths)] };
  }

  function clearBusy(workspaceId: string): void {
    const ui = ensure(workspaceId);
    ui.busyAction = "";
    ui.busyPhase = "";
  }

  // Update the spinner label for the action already running — lets a single
  // runGitAction surface its phases (e.g. "Fetching…" then "Rebasing…").
  function setBusyPhase(workspaceId: string, label: string): void {
    ensure(workspaceId).busyPhase = label || "";
  }

  function cleanup(workspaceId: string): void {
    const next = { ...state.value };
    delete next[workspaceId];
    state.value = next;
  }

  function setActiveRoot(workspaceId: string, rootPath: string): void {
    const ui = ensure(workspaceId);
    const nextRoot = rootPath || "";
    if ((ui.activeRootPath || "") !== nextRoot) {
      ui.selectedDiff = null;
      ui.diffPreview = null;
      ui.selectedCommit = "";
      ui.commitDiffPreview = null;
      ui.branchList = undefined;
      ui.branchListKey = undefined;
      ui.branchListFetchedAt = undefined;
      ui.tags = [];
      ui.tagsError = "";
      ui.graph = undefined;
      ui.graphKey = undefined;
      ui.graphFetchedAt = undefined;
      ui.baseComparison = null;
      ui.baseComparisonKey = undefined;
      ui.reviewSelectedFile = "";
      ui.reviewFileDiffPreview = undefined;
    }
    // The LIVE active root is viewer-local (this renderer only). The
    // persisted workspace.activeRootPath below is just the durable DEFAULT
    // used to seed a fresh viewer on reload/first open — sibling windows
    // showing this workspace keep their own in-memory root and are never
    // flipped by this write (see getActiveGitSnapshot in app.ts).
    ui.activeRootPath = nextRoot;
    if (_api?.setWorkspaceUIState) {
      (_api.setWorkspaceUIState as (id: string, patch: Record<string, unknown>) => Promise<unknown>)(workspaceId, {
        activeRootPath: nextRoot,
      }).catch(() => {});
    }
  }

  function getActiveRoot(workspaceId: string): string {
    return state.value[workspaceId]?.activeRootPath || "";
  }

  async function runGitAction(
    workspaceId: string,
    busyAction: string,
    runner: () => Promise<unknown>,
    opts: { label?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const ui = ensure(workspaceId);
    if (ui.busyAction === busyAction) return null;
    let actionResponse: unknown = null;
    const actionRootPath = getActiveRoot(workspaceId);
    const selectedDiffAtStart = ui.selectedDiff ? { ...ui.selectedDiff } : null;
    ui.busyAction = busyAction;
    ui.busyPhase = opts.label || defaultBusyLabel(busyAction);
    // Start each push/force-push with a clean live-output buffer; chunks stream
    // in via onGitPushProgress while it runs.
    if (busyAction === "push" || busyAction === "force-push") ui.pushProgress = "";

    try {
      const { useAppStore } = await import("./app.js");
      const appStore = useAppStore();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = (await withGitTimeout(runner(), opts.timeoutMs ?? GIT_ACTION_TIMEOUT_MS, busyAction)) as any;
      actionResponse = response;
      if (response?.payload) {
        // adoptPayload, not `appStore.payload =`: the backend builds
        // payload.workspace from the DESKTOP's active workspace, so a raw
        // assignment jumps a remote/mobile viewer to whatever the desktop
        // has open (see store.adoptPayload).
        appStore.adoptPayload(response.payload as StatePayload);
      }
      const result = response?.result;
      // Success path: surface a transient toast and drop any prior banner.
      // Failure (or success with warnings/conflicts the user must read) keeps
      // the full GitOperationCard banner so they can act on it.
      const hasReadworthyExtras =
        !!result && ((result.warnings?.length ?? 0) > 0 || (result.conflicts?.length ?? 0) > 0);
      if (result && result.ok && !hasReadworthyExtras) {
        const { useNotificationStore } = await import("./notifications.js");
        useNotificationStore().pushEphemeralToast({
          title: "Git",
          body: String(result.summary || "Action completed."),
          kind: "info",
          durationMs: 4000,
        });
        ui.lastResult = null;
      } else {
        ui.lastResult = result ? { ...result, at: new Date().toISOString() } : null;
        if (result && result.ok === false) {
          const { useNotificationStore } = await import("./notifications.js");
          useNotificationStore().showError(
            "Git action failed",
            String(result.summary || "The Git action did not complete."),
          );
        }
      }

      // Auto-switch to the Conflicts tab when a git action produces conflicts
      if (result && (result.conflicts?.length ?? 0) > 0) {
        const rootPath = getActiveRoot(workspaceId);
        openConflictDialog(workspaceId, rootPath);
        gitSwitchTab(workspaceId, "conflicts");
      }

      if (
        selectedDiffAtStart?.path &&
        getActiveRoot(workspaceId) === actionRootPath &&
        ui.selectedDiff?.path === selectedDiffAtStart.path &&
        ui.selectedDiff.scope === selectedDiffAtStart.scope
      ) {
        const snapshot = appStore.getGitSnapshot(workspaceId, actionRootPath) as GitSnapshot | null;
        const preview = await (_api as Transport & { gitDiffPreview: (p: unknown) => Promise<unknown> })
          .gitDiffPreview!({
          workspaceId,
          path: selectedDiffAtStart.path,
          scope: selectedDiffAtStart.scope,
          baseBranch: snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "",
          rootPath: actionRootPath,
        }).catch(() => null);
        if (
          preview &&
          getActiveRoot(workspaceId) === actionRootPath &&
          ui.selectedDiff?.path === selectedDiffAtStart.path &&
          ui.selectedDiff.scope === selectedDiffAtStart.scope
        ) {
          ui.diffPreview = preview;
        }
      }

      return response;
    } catch (error) {
      // Surface to console as well — the in-app GitOperationCard banner reads
      // ui.lastResult, but DevTools is where we want a stack trace.
      console.error(`[git-ui] action "${busyAction}" failed for workspace ${workspaceId}:`, error);
      ui.lastResult = {
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        summary: (error as any)?.message || "Git action failed.",
        warnings: [],
        conflicts: [],
        rawOutput: "",
        operationState: null,
        at: new Date().toISOString(),
      };
      return actionResponse;
    } finally {
      clearBusy(workspaceId);
    }
  }

  // --- PR-linked checkouts ---------------------------------------------------
  //
  // A PR link is context, not a lock. While the checkout is on the PR's own
  // branch (the managed `pr-<id>-<source>` alias, or the source branch itself)
  // Push, Force push and "update from the PR target" go through the runtime's
  // review Git flow: it inspects the real checkout, targets the verified source
  // ref, and answers with a safe / blocked / confirmation-required outcome.
  // On any other branch the ordinary Git actions act on that branch as before.

  async function pullRequestContext(workspaceId: string): Promise<{
    onPullRequestBranch: boolean;
    targetBranch: string;
  }> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workspace = ((appStore.payload?.appState?.workspaces || []) as any[]).find((ws) => ws.id === workspaceId);
    const review = workspace?.review;
    const sourceRef = String(review?.pullRequest?.sourceRefName || "");
    if (!review?.prKey || !sourceRef) return { onPullRequestBranch: false, targetBranch: "" };
    const snapshot = appStore.getGitSnapshot(workspaceId, getActiveRoot(workspaceId)) as GitSnapshot | null;
    const branch = String(snapshot?.branch || "");
    const prId = review.pullRequest?.id ?? review.pullRequest?.number ?? "";
    const onPullRequestBranch =
      !!branch && (branch === managedReviewBranchAlias(prId, sourceRef) || branch === sourceBranchName(sourceRef));
    return {
      onPullRequestBranch,
      targetBranch: String(review.pullRequest?.targetRefName || "").replace(/^refs\/heads\//, ""),
    };
  }

  /** A review Git outcome in the shape the Git pane's result banner and toast already render. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function reviewOutcomeToGitResult(outcome: any): Record<string, unknown> {
    const result = outcome?.push ?? outcome ?? {};
    const status = String(result.status || "");
    const blocked = status === "blocked";
    const conflict = status === "conflict";
    const summary = [result.message, blocked ? result.guidance : ""].filter(Boolean).join(" ");
    return {
      ok: !blocked && !conflict,
      summary: summary || "Done.",
      warnings: result.baselineWarning ? [result.baselineWarning] : [],
      conflicts: conflict ? (result.conflictedPaths || []).map((path: string) => ({ path })) : [],
      rawOutput: "",
      operationState: null,
    };
  }

  async function runReviewGitStep(
    workspaceId: string,
    kind: "push" | "force-push" | "rebase" | "refresh",
  ): Promise<{ result: Record<string, unknown> }> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const outcome =
      kind === "rebase"
        ? await appStore.rebaseReviewCheckout(workspaceId)
        : kind === "refresh"
          ? await appStore.refreshReviewCheckout(workspaceId)
          : await appStore.pushReviewCheckout(workspaceId, { force: kind === "force-push" });
    return { result: reviewOutcomeToGitResult(outcome) };
  }

  // --- Git actions ---

  async function refreshGit(workspaceId: string): Promise<void> {
    // Refresh is the manual recovery hatch. If a prior action wedged (an IPC
    // that never settled, a dismissed-but-stuck confirm), drop that state up
    // front so this always runs and revives a frozen UI. runGitAction then
    // overwrites busyAction with "refresh" and clears it in finally.
    clearPendingGitAction(workspaceId);
    clearBusy(workspaceId);
    await runGitAction(workspaceId, "refresh", async () => {
      const payload = await (_api as Transport & { refreshGit: (id: string) => Promise<unknown> }).refreshGit!(
        workspaceId,
      );
      return { payload };
    });
    // An explicit refresh also reloads the open conflict list — the reactive
    // reconcile in the Conflicts tab only fires when the snapshot changes.
    if (ensure(workspaceId).conflictDialog?.open) await loadConflicts(workspaceId);
  }

  async function gitFetch(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "fetch", () =>
      (_api as Transport & { gitFetch: (p: unknown) => Promise<unknown> }).gitFetch!({
        workspaceId,
        rootPath,
        idempotencyKey: newGitIdempotencyKey(),
      }),
    );
  }

  async function gitPull(workspaceId: string, { stashDirty = false }: { stashDirty?: boolean } = {}): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "pull", () =>
      (_api as Transport & { gitPull: (p: unknown) => Promise<unknown> }).gitPull!({
        workspaceId,
        rootPath,
        stashDirty,
        idempotencyKey: newGitIdempotencyKey(),
      }),
    );
  }

  async function gitPush(workspaceId: string): Promise<void> {
    if ((await pullRequestContext(workspaceId)).onPullRequestBranch) {
      await runGitAction(workspaceId, "push", () => runReviewGitStep(workspaceId, "push"), REVIEW_GIT_STEP_OPTS);
      return;
    }
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "push", () =>
      (_api as Transport & { gitPush: (p: unknown) => Promise<unknown> }).gitPush!({
        workspaceId,
        rootPath,
        idempotencyKey: newGitIdempotencyKey(),
      }),
    );
  }

  async function gitCheckoutBranch(workspaceId: string, branch: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "checkout", () =>
      (_api as Transport & { gitCheckoutBranch: (p: unknown) => Promise<unknown> }).gitCheckoutBranch!({
        workspaceId,
        branch,
        rootPath,
      }),
    );
  }

  async function gitCreateBranch(workspaceId: string, branch: string, startPoint: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "create-branch", () =>
      (_api as Transport & { gitCreateBranch: (p: unknown) => Promise<unknown> }).gitCreateBranch!({
        workspaceId,
        branch,
        startPoint,
        rootPath,
      }),
    );
  }

  // `hashes` arrive in display order (newest first); backend handles replay
  // ordering. Both operations are audited server-side via runWriteAction.
  // Copy `hashes` into a plain array: callers pass Vue reactive proxies, and
  // structured clone in ipcRenderer.invoke rejects proxies with the opaque
  // "An object could not be cloned" error before the action ever runs.
  async function gitCherryPick(workspaceId: string, hashes: string[]): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "cherry-pick", () =>
      (_api as Transport & { gitCherryPick: (p: unknown) => Promise<unknown> }).gitCherryPick!({
        workspaceId,
        hashes: [...hashes],
        rootPath,
      }),
    );
  }

  async function gitSquashCommits(workspaceId: string, hashes: string[], message: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "squash", () =>
      (_api as Transport & { gitSquashCommits: (p: unknown) => Promise<unknown> }).gitSquashCommits!({
        workspaceId,
        hashes: [...hashes],
        message,
        rootPath,
      }),
    );
  }

  // --- Branch list & graph (Branches sub-tab) ---

  // Skip a refetch when the same workspace+rootPath was hit recently and the
  // caller didn't explicitly ask for fresh data. Mutations (checkout, merge,
  // etc.) pass force=true so they always re-read.
  const FRESH_TTL_MS = 15_000;

  async function gitListBranches(workspaceId: string, opts: { force?: boolean } = {}): Promise<void> {
    if (!_api) return;
    const ui = ensure(workspaceId);
    const rootPath = getActiveRoot(workspaceId);
    const now = Date.now();
    if (
      !opts.force &&
      !ui.branchesLoading &&
      ui.branchList &&
      ui.branchListKey === rootPath &&
      typeof ui.branchListFetchedAt === "number" &&
      now - (ui.branchListFetchedAt as number) < FRESH_TTL_MS
    ) {
      return;
    }
    const requestId = nextReadGeneration(`${workspaceId}:branches`);
    ui.branchesLoading = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (_api as CallableTransport).gitListBranches({ workspaceId, rootPath })) as any;
      if (requestId !== readGeneration.get(`${workspaceId}:branches`) || getActiveRoot(workspaceId) !== rootPath)
        return;
      if (result?.ok) {
        ui.branchList = markGitReadPayload({
          current: result.current || "",
          upstream: result.upstream || "",
          local: result.local || [],
          remotes: result.remotes || [],
          defaultBranch: result.defaultBranch || "",
          defaultRemote: result.defaultRemote || "",
        });
        ui.branchesError = "";
        ui.branchListKey = rootPath;
        ui.branchListFetchedAt = Date.now();
      } else {
        ui.branchList = { current: "", upstream: "", local: [], remotes: [], defaultBranch: "", defaultRemote: "" };
        ui.branchesError = result?.error || "Failed to load branches.";
        ui.branchListKey = undefined;
        ui.branchListFetchedAt = undefined;
      }
    } catch (error) {
      if (requestId !== readGeneration.get(`${workspaceId}:branches`) || getActiveRoot(workspaceId) !== rootPath)
        return;
      ui.branchList = { current: "", upstream: "", local: [], remotes: [], defaultBranch: "", defaultRemote: "" };
      ui.branchesError = (error as Error)?.message || "Failed to load branches.";
      ui.branchListKey = undefined;
      ui.branchListFetchedAt = undefined;
    } finally {
      if (requestId === readGeneration.get(`${workspaceId}:branches`)) ui.branchesLoading = false;
    }
  }

  async function gitDeleteBranch(workspaceId: string, branch: string, force: boolean): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "delete-branch", () =>
      (_api as CallableTransport).gitDeleteBranch({ workspaceId, branch, force, rootPath }),
    );
    // Race-net: branchList may have been stale (worktree created since the
    // last refresh). When the backend rejects with the structured code, fall
    // through to the worktree-aware confirm so the user has a one-click path
    // forward instead of just a red error banner.
    const last = state.value[workspaceId]?.lastResult as Record<string, unknown> | null | undefined;
    if (last && last.ok === false && last.code === "branch-in-worktree" && typeof last.worktreePath === "string") {
      confirmRemoveWorktreeDeleteBranch(workspaceId, {
        worktreePath: last.worktreePath,
        branch,
        // force=true means the caller already knew the branch had unmerged
        // commits; force=false means merged. Use that as the best-effort hint.
        branchMerged: !force,
      });
      return;
    }
    await gitListBranches(workspaceId);
  }

  async function gitDeleteRemoteBranch(workspaceId: string, branch: string, remote: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(
      workspaceId,
      "delete-remote-branch",
      async () => {
        const { useAppStore } = await import("./app.js");
        const start = (await (_api as CallableTransport).gitDeleteRemoteBranch({
          workspaceId,
          branch,
          remote,
          rootPath,
        })) as {
          operationId?: string;
          started?: boolean;
          result?: { ok?: boolean };
        } | null;
        return resolveLongGitAction(useAppStore(), start);
      },
      { timeoutMs: 0 },
    );
    await gitListBranches(workspaceId);
  }

  async function gitRenameBranch(workspaceId: string, branch: string, newName: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "rename-branch", () =>
      (_api as CallableTransport).gitRenameBranch({ workspaceId, branch, newName, rootPath }),
    );
    await gitListBranches(workspaceId);
  }

  async function gitCheckoutRemoteBranch(
    workspaceId: string,
    remoteBranch: string,
    localBranch: string,
  ): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "checkout-remote", () =>
      (_api as CallableTransport).gitCheckoutRemoteBranch({ workspaceId, remoteBranch, localBranch, rootPath }),
    );
    await gitListBranches(workspaceId);
  }

  async function gitLoadGraph(
    workspaceId: string,
    opts: {
      limit?: number;
      includeRemotes?: boolean;
      branch?: string;
      sinceDate?: string;
      untilDate?: string;
      paths?: string[];
      topoOrder?: boolean;
      author?: string;
      force?: boolean;
    } = {},
  ): Promise<void> {
    if (!_api) return;
    const ui = ensure(workspaceId);
    const rootPath = getActiveRoot(workspaceId);
    const payload = {
      workspaceId,
      rootPath,
      limit: opts.limit || 300,
      includeRemotes: opts.includeRemotes !== false,
      branch: opts.branch || "",
      sinceDate: opts.sinceDate || "",
      untilDate: opts.untilDate || "",
      paths: Array.isArray(opts.paths) ? opts.paths.filter(Boolean) : [],
      topoOrder: opts.topoOrder === true,
      author: opts.author || "",
    };
    // Cache key includes every param that influences the git log walk — any
    // change of these means a different commit set and we must re-fetch.
    // workspaceId is the bucket itself so we don't include it in the key.
    const { workspaceId: _ignored, ...payloadForKey } = payload;
    void _ignored;
    const cacheKey = JSON.stringify(payloadForKey);
    const requestId = Number(ui.graphRequestId || 0) + 1;
    ui.graphRequestId = requestId;
    const now = Date.now();
    if (
      !opts.force &&
      !ui.graphLoading &&
      ui.graph &&
      Array.isArray(ui.graph.commits) &&
      ui.graphKey === cacheKey &&
      typeof ui.graphFetchedAt === "number" &&
      now - (ui.graphFetchedAt as number) < FRESH_TTL_MS
    ) {
      return;
    }
    ui.graphLoading = true;
    try {
      const result = (await (_api as CallableTransport).gitLogGraph(payload)) as {
        ok?: boolean;
        head?: string;
        commits?: unknown[];
        refs?: Record<string, string>;
        error?: string;
      };
      if (ui.graphRequestId !== requestId || getActiveRoot(workspaceId) !== rootPath) return;
      if (result?.ok) {
        ui.graph = markGitReadPayload({
          head: result.head || "",
          commits: result.commits || [],
          refs: result.refs || {},
        });
        ui.graphError = "";
        ui.graphKey = cacheKey;
        ui.graphFetchedAt = Date.now();
      } else {
        ui.graph = { head: "", commits: [], refs: {} };
        ui.graphError = result?.error || "Failed to load graph.";
        ui.graphKey = undefined;
        ui.graphFetchedAt = undefined;
        if (ui.graphError) console.warn(`[git-ui] gitLoadGraph(${workspaceId}) reported error:`, ui.graphError);
      }
    } catch (error) {
      if (ui.graphRequestId !== requestId || getActiveRoot(workspaceId) !== rootPath) return;
      ui.graph = { head: "", commits: [], refs: {} };
      ui.graphError = (error as Error)?.message || "Failed to load graph.";
      ui.graphKey = undefined;
      ui.graphFetchedAt = undefined;
      console.error(`[git-ui] gitLoadGraph(${workspaceId}) threw:`, error);
    } finally {
      if (ui.graphRequestId === requestId) ui.graphLoading = false;
    }
  }

  async function bulkFetch(workspaceId: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const workspace = appStore.filteredWorkspaces?.find((w: { id: string }) => w.id === workspaceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = workspace as any;
    const roots: string[] = ws?.gitRoots?.length ? ws.gitRoots : [ws?.cwd].filter(Boolean);
    for (const rootPath of roots) {
      await runGitAction(workspaceId, `bulk-fetch:${rootPath}`, () =>
        (_api as Transport & { gitFetch: (p: unknown) => Promise<unknown> }).gitFetch!({
          workspaceId,
          rootPath,
          idempotencyKey: newGitIdempotencyKey(),
        }),
      );
    }
  }

  async function bulkPull(workspaceId: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const workspace = appStore.filteredWorkspaces?.find((w: { id: string }) => w.id === workspaceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = workspace as any;
    const roots: string[] = ws?.gitRoots?.length ? ws.gitRoots : [ws?.cwd].filter(Boolean);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = appStore.getGitWorkspaceEntry(workspaceId) as any;
    for (const rootPath of roots) {
      // Skip dirty repos
      const snap = entry?.roots?.[rootPath] || (entry?.rootPath === rootPath ? entry : null);
      if (snap?.dirty) continue;
      await runGitAction(workspaceId, `bulk-pull:${rootPath}`, () =>
        (_api as Transport & { gitPull: (p: unknown) => Promise<unknown> }).gitPull!({
          workspaceId,
          rootPath,
          idempotencyKey: newGitIdempotencyKey(),
        }),
      );
    }
  }

  function setPendingGitAction(
    workspaceId: string,
    {
      type,
      baseBranch,
      snapshot,
      fetchFirst = false,
    }: { type: string; baseBranch: string; snapshot: GitSnapshot | null; fetchFirst?: boolean },
  ): void {
    const ui = ensure(workspaceId);
    ui.pendingAction = {
      type,
      baseBranch,
      fetchFirst,
      stashDirty: snapshot?.dirty || false,
      message: buildConfirmMessage({ type, snapshot, baseBranch, fetchFirst }),
      severity: "info",
      isDestructive: false,
      snapshotHash: computeSnapshotHash(snapshot),
    };
  }

  function setPendingDestructiveAction(
    workspaceId: string,
    confirm: PendingGitAction,
    snapshot: GitSnapshot | null = null,
  ): void {
    const ui = ensure(workspaceId);
    ui.pendingAction = { ...confirm, snapshotHash: computeSnapshotHash(snapshot) };
  }

  function dismissStalePending(workspaceId: string, currentSnapshot: GitSnapshot | null): void {
    const ui = get(workspaceId);
    if (!ui.pendingAction) return;
    const stored = ui.pendingAction.snapshotHash;
    if (!stored) return;
    if (stored !== computeSnapshotHash(currentSnapshot)) {
      rlog("warn", "[git-ui] dismissStalePending CLEARED a pending confirm", {
        workspaceId,
        storedHash: stored,
        currentHash: computeSnapshotHash(currentSnapshot),
      });
      const ws = ensure(workspaceId);
      ws.pendingAction = null;
      ws.lastResult = {
        ok: false,
        summary: "Repository state changed — please reconfirm.",
        warnings: [],
        conflicts: [],
        rawOutput: "",
        operationState: null,
        at: new Date().toISOString(),
      };
    }
  }

  function clearPendingGitAction(workspaceId: string): void {
    const ui = ensure(workspaceId);
    ui.pendingAction = null;
  }

  async function gitConfirmAction(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    const pending = ui.pendingAction;
    if (!pending) return;
    ui.pendingAction = null;

    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();

    const rootPath = getActiveRoot(workspaceId);

    // Destructive actions dispatched by buildDestructiveConfirm
    if (pending.isDestructive) {
      const { action, payload: p } = pending;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = _api as any;
      if (action === "deleteLocalTag") {
        await runGitAction(workspaceId, "delete-tag", () =>
          api.gitDeleteTag({ workspaceId, tagName: p!.tagName, rootPath }),
        );
        await gitListTags(workspaceId);
      } else if (action === "deleteRemoteTag") {
        await runGitAction(
          workspaceId,
          "delete-remote-tag",
          async () =>
            resolveLongGitAction(
              appStore,
              await api.gitDeleteRemoteTag({ workspaceId, tagName: p!.tagName, rootPath }),
            ),
          { timeoutMs: 0 },
        );
        await gitListTags(workspaceId);
      } else if (action === "removeWorktree") {
        await runGitAction(workspaceId, "remove-worktree", () =>
          api.gitRemoveWorktree({ workspaceId, worktreePath: p!.worktreePath, deleteBranch: false }),
        );
      } else if (action === "removeWorktreeDeleteBranch") {
        await runGitAction(workspaceId, "remove-worktree", () =>
          api.gitRemoveWorktree({ workspaceId, worktreePath: p!.worktreePath, deleteBranch: true }),
        );
      } else if (action === "forcePushWithLease") {
        if ((await pullRequestContext(workspaceId)).onPullRequestBranch) {
          await runGitAction(
            workspaceId,
            "force-push",
            () => runReviewGitStep(workspaceId, "force-push"),
            REVIEW_GIT_STEP_OPTS,
          );
        } else {
          await runGitAction(
            workspaceId,
            "force-push",
            async () => {
              const { useAppStore } = await import("./app.js");
              const start = await api.gitForcePushWithLease({ workspaceId, rootPath });
              return resolveLongGitAction(useAppStore(), start);
            },
            { timeoutMs: 0 },
          );
        }
      }
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = _api as any;
    if (pending.type === "abort") {
      await runGitAction(workspaceId, "abort", () => api.gitAbortOperation({ workspaceId, rootPath }));
      return;
    }
    if (pending.type === "merge-into-base") {
      await runGitAction(workspaceId, "merge-into-base", () =>
        api.gitMergeCurrentIntoBase({ workspaceId, baseBranch: pending.baseBranch, rootPath }),
      );
      return;
    }
    const payload = {
      workspaceId,
      baseBranch: pending.baseBranch,
      stashDirty: pending.stashDirty,
      fetchFirst: pending.fetchFirst === true,
      rootPath,
    };
    const fetchFirst = !!pending.fetchFirst;
    const baseLabel = pending.baseBranch || "base";
    await runGitAction(
      workspaceId,
      pending.type,
      async () => {
        setBusyPhase(
          workspaceId,
          fetchFirst
            ? `Fetching and ${pending.type === "merge" ? "merging into" : "rebasing onto"} ${baseLabel}…`
            : pending.type === "merge"
              ? `Merging ${baseLabel} in…`
              : `Rebasing onto ${baseLabel}…`,
        );
        const start = (await (pending.type === "merge"
          ? api.gitMergeIntoCurrent(payload)
          : api.gitRebaseOnto(payload))) as {
          operationId?: string;
          started?: boolean;
          result?: { ok?: boolean };
        } | null;
        return await resolveLongGitAction(appStore, start);
      },
      GIT_OPERATION_WAIT_OPTS,
    );
  }

  function confirmDeleteLocalTag(workspaceId: string, tagName: string): void {
    setPendingDestructiveAction(
      workspaceId,
      buildDestructiveConfirm({
        action: "deleteLocalTag",
        severity: "warn",
        title: "Delete local tag",
        body: `Delete tag \`${tagName}\` locally?`,
        confirmLabel: "Delete",
        payload: { tagName },
      }),
    );
  }

  function confirmDeleteRemoteTag(workspaceId: string, tagName: string): void {
    setPendingDestructiveAction(
      workspaceId,
      buildDestructiveConfirm({
        action: "deleteRemoteTag",
        severity: "danger",
        title: "Delete remote tag",
        body: `Delete tag \`${tagName}\` on remote? This cannot be undone.`,
        confirmLabel: "Delete from remote",
        payload: { tagName },
      }),
    );
  }

  function confirmRemoveWorktree(
    workspaceId: string,
    { worktreePath, branch, branchMerged }: { worktreePath: string; branch: string; branchMerged: boolean },
    snapshot: GitSnapshot | null = null,
  ): void {
    const severity = branchMerged ? "warn" : "danger";
    const body = branchMerged
      ? `Remove worktree at \`${worktreePath}\`? Branch \`${branch}\` will be kept.`
      : `Remove worktree at \`${worktreePath}\`? Branch \`${branch}\` has unmerged commits and will be kept.`;
    setPendingDestructiveAction(
      workspaceId,
      buildDestructiveConfirm({
        action: "removeWorktree",
        severity,
        title: "Remove worktree",
        body,
        confirmLabel: "Remove",
        payload: { worktreePath },
      }),
      snapshot,
    );
  }

  function confirmRemoveWorktreeDeleteBranch(
    workspaceId: string,
    { worktreePath, branch, branchMerged }: { worktreePath: string; branch: string; branchMerged: boolean },
    snapshot: GitSnapshot | null = null,
  ): void {
    const severity = branchMerged ? "warn" : "danger";
    const body = branchMerged
      ? `Remove worktree and delete merged branch \`${branch}\`?`
      : `Branch \`${branch}\` has unmerged commits. Remove worktree and delete branch anyway?`;
    setPendingDestructiveAction(
      workspaceId,
      buildDestructiveConfirm({
        action: "removeWorktreeDeleteBranch",
        severity,
        title: "Remove worktree + delete branch",
        body,
        confirmLabel: severity === "danger" ? "Delete (unmerged)" : "Remove + delete",
        payload: { worktreePath },
      }),
      snapshot,
    );
  }

  function confirmForcePushWithLease(
    workspaceId: string,
    { branch, remote, behindCount }: { branch: string; remote: string; behindCount: number },
    snapshot: GitSnapshot | null = null,
  ): void {
    setPendingDestructiveAction(
      workspaceId,
      buildDestructiveConfirm({
        action: "forcePushWithLease",
        severity: "danger",
        title: "Force push (with lease)",
        body:
          `Force-push \`${branch}\` to \`${remote}/${branch}\`? Remote is ${behindCount} commit(s) ahead — those commits will be overwritten. ` +
          "`--force-with-lease` aborts if the remote branch moved away from the commit it was checked against, but users who already pulled will need to reset their local branch.",
        confirmLabel: "Force push",
        payload: { branch, remote },
      }),
      snapshot,
    );
  }

  async function gitContinue(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "continue", () =>
      (_api as Transport & { gitContinueOperation: (p: unknown) => Promise<unknown> }).gitContinueOperation!({
        workspaceId,
        rootPath,
      }),
    );
  }

  async function gitAbort(workspaceId: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    setPendingGitAction(workspaceId, { type: "abort", snapshot, baseBranch: "" });
  }

  async function gitMergeBase(
    workspaceId: string,
    baseBranch: string,
    { fetchFirst = false }: { fetchFirst?: boolean } = {},
  ): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    if (!snapshot?.available) return;
    setPendingGitAction(workspaceId, {
      type: "merge",
      snapshot,
      baseBranch: baseBranch || snapshot.baseBranch,
      fetchFirst,
    });
  }

  async function gitRebaseBase(
    workspaceId: string,
    baseBranch: string,
    { fetchFirst = false }: { fetchFirst?: boolean } = {},
  ): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    // Updating a PR checkout from the PR's own target is a TARGET rebase: the
    // runtime pins the target commit, shows what is rewritten and asks itself.
    const pr = await pullRequestContext(workspaceId);
    const requestedBase = String(baseBranch || snapshot?.baseBranch || "");
    const targetsPullRequest =
      !!pr.targetBranch && (requestedBase === pr.targetBranch || requestedBase.endsWith("/" + pr.targetBranch));
    if (pr.onPullRequestBranch && targetsPullRequest) {
      await runGitAction(workspaceId, "rebase", () => runReviewGitStep(workspaceId, "rebase"), REVIEW_GIT_STEP_OPTS);
      return;
    }
    rlog("info", "[git-ui] gitRebaseBase called", {
      workspaceId,
      baseBranch,
      fetchFirst,
      rootPath,
      hasSnapshot: !!snapshot,
      available: snapshot?.available ?? null,
      snapshotBase: snapshot?.baseBranch ?? null,
      existingPending: !!ensure(workspaceId).pendingAction,
    });
    if (!snapshot?.available) {
      rlog("warn", "[git-ui] gitRebaseBase aborted — snapshot unavailable", { workspaceId, rootPath });
      return;
    }
    setPendingGitAction(workspaceId, {
      type: "rebase",
      snapshot,
      baseBranch: baseBranch || snapshot.baseBranch,
      fetchFirst,
    });
    rlog("info", "[git-ui] gitRebaseBase set pendingAction", {
      workspaceId,
      pendingSet: !!ensure(workspaceId).pendingAction,
    });
  }

  async function gitMergeIntoBase(workspaceId: string, baseBranch: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    if (!snapshot?.available) return;
    setPendingGitAction(workspaceId, { type: "merge-into-base", snapshot, baseBranch });
  }

  async function gitRemoveWorktree(workspaceId: string, worktreePath: string, deleteBranch: boolean): Promise<void> {
    await runGitAction(workspaceId, "remove-worktree", () =>
      (_api as Transport & { gitRemoveWorktree: (p: unknown) => Promise<unknown> }).gitRemoveWorktree!({
        workspaceId,
        worktreePath,
        deleteBranch,
      }),
    );
  }

  async function gitCommitAll(
    workspaceId: string,
    message: string,
    paths?: string[],
    previousPaths?: string[],
  ): Promise<boolean> {
    if (!message) return false;
    const rootPath = getActiveRoot(workspaceId);
    const response = await runGitAction(workspaceId, "commit", () =>
      (_api as Transport & { gitCommitAll: (p: unknown) => Promise<unknown> }).gitCommitAll!({
        workspaceId,
        message,
        rootPath,
        // Omit entirely when nothing is selected so the backend commits the
        // whole tree (matches the historical "Commit all" behaviour).
        ...(paths && paths.length ? { paths } : {}),
        // Rename old-names, sent separately so the backend never stages them.
        ...(previousPaths && previousPaths.length ? { previousPaths } : {}),
      }),
    );
    return (response as { result?: { ok?: boolean } } | null)?.result?.ok === true;
  }

  async function runIndexAction(workspaceId: string, action: string, runner: () => Promise<unknown>): Promise<boolean> {
    const response = (await runGitAction(workspaceId, action, runner)) as {
      result?: { ok?: boolean };
      payload?: unknown;
    } | null;
    const result =
      response?.result ||
      (response?.payload as { result?: { ok?: boolean }; ok?: boolean } | undefined)?.result ||
      (response?.payload as { ok?: boolean } | undefined);
    return result?.ok === true;
  }

  async function gitStageFile(workspaceId: string, path: string): Promise<boolean> {
    const rootPath = getActiveRoot(workspaceId);
    return runIndexAction(workspaceId, "stage-file", () =>
      (_api as Transport & { gitStageFile: (p: unknown) => Promise<unknown> }).gitStageFile!({
        workspaceId,
        rootPath,
        path,
      }),
    );
  }

  async function gitUnstageFile(workspaceId: string, path: string): Promise<boolean> {
    const rootPath = getActiveRoot(workspaceId);
    return runIndexAction(workspaceId, "unstage-file", () =>
      (_api as Transport & { gitUnstageFile: (p: unknown) => Promise<unknown> }).gitUnstageFile!({
        workspaceId,
        rootPath,
        path,
      }),
    );
  }

  async function gitStageHunk(
    workspaceId: string,
    input: { path: string; action: "stage" | "unstage"; scope: "staged" | "unstaged"; diffToken: string; hunk: string },
  ): Promise<boolean> {
    const rootPath = getActiveRoot(workspaceId);
    return runIndexAction(workspaceId, "stage-hunk", () =>
      (_api as Transport & { gitStageHunk: (p: unknown) => Promise<unknown> }).gitStageHunk!({
        workspaceId,
        rootPath,
        ...input,
      }),
    );
  }

  async function gitCommitStaged(workspaceId: string, message: string): Promise<boolean> {
    if (!message.trim()) return false;
    const rootPath = getActiveRoot(workspaceId);
    return runIndexAction(workspaceId, "commit-staged", () =>
      (_api as Transport & { gitCommitStaged: (p: unknown) => Promise<unknown> }).gitCommitStaged!({
        workspaceId,
        rootPath,
        message,
      }),
    );
  }

  async function gitSelectCommit(workspaceId: string, hash: string): Promise<void> {
    if (!hash) return;
    const ui = ensure(workspaceId);
    ui.selectedCommit = hash;
    const rootPath = getActiveRoot(workspaceId);
    const requestKey = `${workspaceId}:commit-diff`;
    const requestId = nextReadGeneration(requestKey);
    await loadDiffPreview(
      ui,
      requestId,
      "commitDiffPreview",
      { hash },
      "Loading...",
      "Failed to load commit diff.",
      () =>
        requestId === readGeneration.get(requestKey) &&
        getActiveRoot(workspaceId) === rootPath &&
        ui.selectedCommit === hash,
      () =>
        (_api as Transport & { gitCommitDiff: (p: unknown) => Promise<unknown> }).gitCommitDiff!({
          workspaceId,
          hash,
          rootPath,
        }),
    );
  }

  async function gitSelectDiff(workspaceId: string, path: string, scope: string): Promise<void> {
    if (!path) return;
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    const ui = ensure(workspaceId);
    ui.selectedDiff = { path, scope };
    const requestKey = `${workspaceId}:working-diff`;
    const requestId = nextReadGeneration(requestKey);
    await loadDiffPreview(
      ui,
      requestId,
      "diffPreview",
      { path, scope },
      "Loading diff preview...",
      "Diff preview failed to load.",
      () =>
        requestId === readGeneration.get(requestKey) &&
        getActiveRoot(workspaceId) === rootPath &&
        ui.selectedDiff?.path === path &&
        ui.selectedDiff?.scope === scope,
      () =>
        (_api as Transport & { gitDiffPreview: (p: unknown) => Promise<unknown> }).gitDiffPreview!({
          workspaceId,
          path,
          scope,
          baseBranch: snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "",
          rootPath,
        }),
    );
  }

  function gitSwitchTab(workspaceId: string, tab: string): void {
    ensure(workspaceId).activeTab = tab;
  }

  function gitViewKey(
    workspaceId: string,
    rootPath = getActiveRoot(workspaceId),
    profileId = "default",
    reviewKey = "",
  ): string {
    return `${profileId}::${workspaceId}::${rootPath || "default-root"}::${reviewKey || "no-review"}`;
  }

  function gitSwitchView(
    workspaceId: string,
    view: "history" | "changes" | "review",
    rootPath?: string,
    profileId = "default",
    reviewKey = "",
  ): void {
    const key = gitViewKey(workspaceId, rootPath, profileId, reviewKey);
    const ui = ensure(workspaceId);
    ui.gitViewsByRoot = {
      ...((ui.gitViewsByRoot as Record<string, "history" | "changes" | "review"> | undefined) || {}),
      [key]: view,
    };
    if (_api?.setWorkspaceUIState) {
      (_api.setWorkspaceUIState as (id: string, patch: Record<string, unknown>) => Promise<unknown>)(workspaceId, {
        gitViewPreferences: { [key]: view },
      }).catch((error) =>
        rlog("warn", "[git-ui] failed to persist Git view preference", { workspaceId, error: String(error) }),
      );
    }
  }

  function getGitView(
    workspaceId: string,
    rootPath?: string,
    profileId = "default",
    reviewKey = "",
  ): "history" | "changes" | "review" | undefined {
    const ui = ensure(workspaceId);
    const workspacePreferences =
      (ui.workspaceGitViewPreferences as Record<string, "history" | "changes" | "review"> | undefined) || {};
    const payloadPreferences =
      (ui.gitViewPreferences as Record<string, "history" | "changes" | "review"> | undefined) || {};
    const views = {
      ...workspacePreferences,
      ...payloadPreferences,
      ...((ui.gitViewsByRoot as Record<string, "history" | "changes" | "review"> | undefined) || {}),
    };
    return views?.[gitViewKey(workspaceId, rootPath, profileId, reviewKey)];
  }

  function gitHistoryPreferencesKey(workspaceId: string, rootPath: string, profileId: string): string {
    return `strideterm:git-history:${encodeURIComponent(profileId)}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(rootPath || "default-root")}`;
  }

  function gitHistorySelectionKey(workspaceId: string, rootPath: string, profileId: string): string {
    return `${encodeURIComponent(profileId)}::${encodeURIComponent(workspaceId)}::${encodeURIComponent(rootPath || "default-root")}`;
  }

  function getGitHistorySelection(workspaceId: string, rootPath = getActiveRoot(workspaceId), profileId = "default") {
    return {
      ...(gitHistorySelections.value[gitHistorySelectionKey(workspaceId, rootPath, profileId)] || {
        ref: "",
        commitSearch: "",
      }),
    };
  }

  function setGitHistorySelection(
    workspaceId: string,
    rootPath: string,
    profileId: string,
    selection: { ref?: string; commitSearch?: string },
  ): void {
    const key = gitHistorySelectionKey(workspaceId, rootPath, profileId);
    const current = getGitHistorySelection(workspaceId, rootPath, profileId);
    gitHistorySelections.value = {
      ...gitHistorySelections.value,
      [key]: { ref: selection.ref ?? current.ref, commitSearch: selection.commitSearch ?? current.commitSearch },
    };
  }

  function getGitHistoryPreferences(workspaceId: string, rootPath = getActiveRoot(workspaceId), profileId = "default") {
    const key = gitHistoryPreferencesKey(workspaceId, rootPath, profileId);
    const cached = gitHistoryPreferences.value[key];
    if (cached) return { favorites: [...cached.favorites], recent: [...cached.recent] };
    try {
      const stored = JSON.parse(globalThis.localStorage?.getItem(key) || "null");
      if (stored && Array.isArray(stored.favorites) && Array.isArray(stored.recent)) {
        const preferences = {
          favorites: stored.favorites.filter((ref: unknown) => typeof ref === "string").slice(0, 100),
          recent: stored.recent.filter((ref: unknown) => typeof ref === "string").slice(0, 20),
        };
        gitHistoryPreferences.value = { ...gitHistoryPreferences.value, [key]: preferences };
        return { favorites: [...preferences.favorites], recent: [...preferences.recent] };
      }
    } catch {
      // Storage is optional; refs remain usable if the browser blocks it.
    }
    const empty = { favorites: [] as string[], recent: [] as string[] };
    gitHistoryPreferences.value = { ...gitHistoryPreferences.value, [key]: empty };
    return { favorites: [], recent: [] };
  }

  function updateGitHistoryPreferences(
    workspaceId: string,
    rootPath: string,
    profileId: string,
    update: (preferences: { favorites: string[]; recent: string[] }) => { favorites: string[]; recent: string[] },
  ): void {
    const key = gitHistoryPreferencesKey(workspaceId, rootPath, profileId);
    const next = update(getGitHistoryPreferences(workspaceId, rootPath, profileId));
    const preferences = { favorites: next.favorites.slice(0, 100), recent: next.recent.slice(0, 20) };
    gitHistoryPreferences.value = { ...gitHistoryPreferences.value, [key]: preferences };
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(preferences));
    } catch {
      rlog("warn", "[git-ui] failed to persist history references", { workspaceId, profileId });
    }
  }

  function toggleGitHistoryFavorite(
    workspaceId: string,
    ref: string,
    rootPath = getActiveRoot(workspaceId),
    profileId = "default",
  ): void {
    if (!ref) return;
    updateGitHistoryPreferences(workspaceId, rootPath, profileId, (preferences) => ({
      ...preferences,
      favorites: preferences.favorites.includes(ref)
        ? preferences.favorites.filter((item) => item !== ref)
        : [ref, ...preferences.favorites],
    }));
  }

  function recordGitHistoryRef(
    workspaceId: string,
    ref: string,
    rootPath = getActiveRoot(workspaceId),
    profileId = "default",
  ): void {
    if (!ref) return;
    updateGitHistoryPreferences(workspaceId, rootPath, profileId, (preferences) => ({
      ...preferences,
      recent: [ref, ...preferences.recent.filter((item) => item !== ref)],
    }));
  }

  function setNewViewLegacyDestination(workspaceId: string, destination: string): void {
    ensure(workspaceId).newViewLegacyDestination = destination;
  }

  function getNewViewLegacyDestination(workspaceId: string): string {
    return String(ensure(workspaceId).newViewLegacyDestination || "");
  }

  function gitClearResult(workspaceId: string): void {
    ensure(workspaceId).lastResult = null;
  }

  function gitClearSelectedDiff(workspaceId: string): void {
    const ui = ensure(workspaceId);
    ui.selectedDiff = null;
    ui.diffPreview = null;
  }

  async function gitStashPop(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "stash-pop", () =>
      (_api as Transport & { gitStashPop: (p: unknown) => Promise<unknown> }).gitStashPop!({ workspaceId, rootPath }),
    );
  }

  // --- Tag actions ---

  async function gitListTags(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    const ui = ensure(workspaceId);
    const requestId = nextReadGeneration(`${workspaceId}:tags`);
    ui.tagsLoading = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (_api as CallableTransport).gitListTags({ workspaceId, rootPath })) as any;
      if (requestId !== readGeneration.get(`${workspaceId}:tags`) || getActiveRoot(workspaceId) !== rootPath) return;
      ui.tags = markGitReadPayload(result?.tags || []);
      ui.tagsError = result?.ok === false ? result.summary : "";
    } catch (error) {
      if (requestId !== readGeneration.get(`${workspaceId}:tags`) || getActiveRoot(workspaceId) !== rootPath) return;
      ui.tags = [];
      ui.tagsError = (error as Error)?.message || "Failed to load tags.";
    } finally {
      if (requestId === readGeneration.get(`${workspaceId}:tags`)) ui.tagsLoading = false;
    }
  }

  async function gitCreateTag(workspaceId: string, tagName: string, message: string, commit = ""): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "create-tag", () =>
      (_api as Transport & { gitCreateTag: (p: unknown) => Promise<unknown> }).gitCreateTag!({
        workspaceId,
        tagName,
        message: message || "",
        commit: commit || "",
        rootPath,
      }),
    );
    await gitListTags(workspaceId);
  }

  async function gitDeleteTag(workspaceId: string, tagName: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "delete-tag", () =>
      (_api as Transport & { gitDeleteTag: (p: unknown) => Promise<unknown> }).gitDeleteTag!({
        workspaceId,
        tagName,
        rootPath,
      }),
    );
    await gitListTags(workspaceId);
  }

  async function gitPushTag(workspaceId: string, tagName: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(
      workspaceId,
      "push-tag",
      async () => {
        const { useAppStore } = await import("./app.js");
        const start = (await (_api as Transport & { gitPushTag: (p: unknown) => Promise<unknown> }).gitPushTag!({
          workspaceId,
          tagName,
          rootPath,
        })) as { operationId?: string; started?: boolean };
        return resolveLongGitAction(useAppStore(), start);
      },
      { timeoutMs: 0 },
    );
    await gitListTags(workspaceId);
  }

  async function gitPushAllTags(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(
      workspaceId,
      "push-all-tags",
      async () => {
        const { useAppStore } = await import("./app.js");
        const start = (await (_api as Transport & { gitPushAllTags: (p: unknown) => Promise<unknown> }).gitPushAllTags!(
          {
            workspaceId,
            rootPath,
          },
        )) as { operationId?: string; started?: boolean };
        return resolveLongGitAction(useAppStore(), start);
      },
      { timeoutMs: 0 },
    );
    await gitListTags(workspaceId);
  }

  async function gitDeleteRemoteTag(workspaceId: string, tagName: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(
      workspaceId,
      "delete-remote-tag",
      async () => {
        const { useAppStore } = await import("./app.js");
        const start = (await (_api as Transport & { gitDeleteRemoteTag: (p: unknown) => Promise<unknown> })
          .gitDeleteRemoteTag!({
          workspaceId,
          tagName,
          rootPath,
        })) as { operationId?: string; started?: boolean };
        return resolveLongGitAction(useAppStore(), start);
      },
      { timeoutMs: 0 },
    );
    await gitListTags(workspaceId);
  }

  function gitSetBaseBranch(workspaceId: string, baseBranch: string): void {
    const ui = ensure(workspaceId);
    ui.overrideBaseBranch = baseBranch || "";
  }

  async function gitFetchBaseComparison(
    workspaceId: string,
    baseBranch: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const ui = ensure(workspaceId);
    if (!baseBranch) {
      ui.baseComparison = null;
      return;
    }
    const rootPath = getActiveRoot(workspaceId);
    const cacheKey = `${rootPath}::${baseBranch}`;
    const now = Date.now();
    // Skip when the same base was just compared (in-flight or fresh). The
    // watches in GitBranchesTab and GitBranchTab fire this whenever
    // compareBase/effectiveBaseBranch changes — without dedup we'd thrash on
    // re-renders.
    if (
      !opts.force &&
      ui.baseComparisonKey === cacheKey &&
      (ui.baseComparisonLoading ||
        (typeof ui.baseComparisonFetchedAt === "number" && now - (ui.baseComparisonFetchedAt as number) < FRESH_TTL_MS))
    ) {
      return;
    }
    const requestId = nextReadGeneration(`${workspaceId}:base-comparison`);
    ui.baseComparisonKey = cacheKey;
    ui.baseComparisonLoading = true;
    try {
      const result = (await (_api as Transport & { gitCompareBranch: (p: unknown) => Promise<unknown> })
        .gitCompareBranch!({ workspaceId, baseBranch, rootPath })) as {
        ok?: boolean;
        baseBranch?: string;
        aheadCount?: number;
        behindCount?: number;
        error?: string;
      } | null;
      if (
        requestId !== readGeneration.get(`${workspaceId}:base-comparison`) ||
        getActiveRoot(workspaceId) !== rootPath ||
        ui.baseComparisonKey !== cacheKey
      )
        return;
      if (!result || !result.ok) {
        ui.baseComparison = {
          baseBranch,
          aheadCount: 0,
          behindCount: 0,
          ok: false,
          error: (result?.error as string) || "Failed to compare",
        };
      } else {
        ui.baseComparison = {
          baseBranch: result.baseBranch || baseBranch,
          aheadCount: result.aheadCount || 0,
          behindCount: result.behindCount || 0,
          ok: true,
        };
      }
    } catch (error) {
      if (
        requestId !== readGeneration.get(`${workspaceId}:base-comparison`) ||
        getActiveRoot(workspaceId) !== rootPath ||
        ui.baseComparisonKey !== cacheKey
      )
        return;
      ui.baseComparison = {
        baseBranch,
        aheadCount: 0,
        behindCount: 0,
        ok: false,
        error: (error as Error)?.message || "Failed to compare",
      };
    } finally {
      if (requestId === readGeneration.get(`${workspaceId}:base-comparison`)) {
        ui.baseComparisonLoading = false;
        ui.baseComparisonFetchedAt = Date.now();
      }
    }
  }

  async function azureCreatePullRequest(
    workspaceId: string,
    {
      title,
      description,
      sourceBranch,
      targetBranch,
      connectionId,
      isDraft = false,
    }: {
      title: string;
      description: string;
      sourceBranch: string;
      targetBranch: string;
      connectionId: string;
      isDraft?: boolean;
    },
  ): Promise<unknown> {
    const rootPath = getActiveRoot(workspaceId);
    return runGitAction(workspaceId, "create-pr", () =>
      (_api as Transport & { azureCreatePullRequest: (p: unknown) => Promise<unknown> }).azureCreatePullRequest!({
        workspaceId,
        title,
        description,
        sourceBranch,
        targetBranch,
        connectionId,
        isDraft,
        rootPath,
      }),
    );
  }

  async function azureListRemoteBranches(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    ui.remoteBranchesLoading = true;
    try {
      const rootPath = getActiveRoot(workspaceId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (_api as CallableTransport).azureListRemoteBranches({ workspaceId, rootPath })) as any;
      ui.remoteBranches = result?.branches || [];
      ui.remoteBranchesError = "";
    } catch (error) {
      ui.remoteBranches = [];
      ui.remoteBranchesError = (error as Error)?.message || "Failed to load remote branches.";
    } finally {
      ui.remoteBranchesLoading = false;
    }
  }

  async function openLazygit(workspaceId: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    try {
      const nextPayload = await (_api as CallableTransport).openLazygitSession({ workspaceId, rootPath });
      appStore.adoptPayload(nextPayload as StatePayload);
      appStore.activeViewId = `${workspaceId}:lazygit`;
    } catch (error) {
      // openLazygitSession's return shape (a raw payload, not { payload, result })
      // doesn't fit runGitAction's contract, so this mirrors its catch block
      // (console.error + a user-facing error) directly instead.
      console.error(`[git-ui] openLazygit failed for workspace ${workspaceId}:`, error);
      const { useNotificationStore } = await import("./notifications.js");
      useNotificationStore().showError(
        "Failed to open Lazygit",
        (error as Error)?.message || "Lazygit is not available for this workspace.",
        { workspaceId },
      );
    }
  }

  // --- Azure review UI state ---
  function reviewSwitchTab(workspaceId: string, tab: string): void {
    ensure(workspaceId).activeReviewTab = tab || "summary";
  }

  function reviewSetCommentFilter(workspaceId: string, filter: string): void {
    ensure(workspaceId).commentFilter = filter || "all";
  }

  function reviewSetCommentSort(workspaceId: string, sort: string): void {
    const ws = ensure(workspaceId);
    if (ws.commentSort === sort) {
      // Toggle direction when clicking the same sort
      ws.commentSortDir = ws.commentSortDir === "asc" ? "desc" : "asc";
    } else {
      ws.commentSort = sort || "index";
      // Default direction: newest→desc, others→asc
      ws.commentSortDir = sort === "newest" ? "desc" : "asc";
    }
  }

  function reviewSetCommentSearch(workspaceId: string, search: string): void {
    ensure(workspaceId).commentSearch = search || "";
  }

  function reviewSetAgentSubtab(workspaceId: string, subtab: string): void {
    ensure(workspaceId).agentSubTab = subtab || "prompts";
  }

  async function reviewSelectFileDiff(workspaceId: string, filePath: string, baseBranch?: string): Promise<void> {
    if (!workspaceId || !filePath) return;
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    const resolvedBase = baseBranch || snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "";
    const ui = ensure(workspaceId);
    ui.reviewSelectedFile = filePath;
    const requestKey = `${workspaceId}:review-file-diff`;
    const requestId = nextReadGeneration(requestKey);
    await loadDiffPreview(
      ui,
      requestId,
      "reviewFileDiffPreview",
      { path: filePath },
      "Loading diff preview...",
      "Diff preview failed to load.",
      () =>
        requestId === readGeneration.get(requestKey) &&
        getActiveRoot(workspaceId) === rootPath &&
        ui.reviewSelectedFile === filePath,
      () =>
        (_api as Transport & { gitDiffPreview: (p: unknown) => Promise<unknown> }).gitDiffPreview!({
          workspaceId,
          path: filePath,
          scope: "branch",
          baseBranch: resolvedBase.startsWith("origin/") ? resolvedBase : resolvedBase ? `origin/${resolvedBase}` : "",
        }),
    );
  }

  // --- Conflict resolution dialog ---

  function openConflictDialog(workspaceId: string, rootPath: string): void {
    const ui = ensure(workspaceId);
    ui.conflictDialog = { open: true, workspaceId, rootPath, conflicts: [], loading: false, error: "" };
    void loadConflicts(workspaceId);
  }

  function closeConflictDialog(workspaceId: string): void {
    const ui = ensure(workspaceId);
    if (ui.conflictDialog) ui.conflictDialog = { ...ui.conflictDialog, open: false };
    // The Conflicts tab disappears with the conflict state — land on Overview.
    if (ui.activeTab === "conflicts") ui.activeTab = "branch";
  }

  async function loadConflicts(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    dlg.loading = true;
    dlg.error = "";
    try {
      const result = (await (_api as CallableTransport).gitListConflicts({
        workspaceId,
        rootPath: dlg.rootPath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as Record<string, any>;
      // Backend (git-manager.listConflicts) returns the list under `entries`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending: Record<string, any>[] = result?.entries || result?.conflicts || [];
      const pendingPaths = new Set(pending.map((e) => e.path as string));
      // Merge: existing resolved files stay; pending files update/add
      const existingByPath = new Map(dlg.conflicts.map((c) => [c.path, c]));
      const merged: ConflictFileEntry[] = [];
      // Add/update all pending entries
      for (const p of pending) {
        merged.push({
          path: p.path as string,
          conflictType: (p.conflictType as string) || "both-modified",
          stages: (p.stages as number[]) || [],
          binary: (p.binary as boolean) || false,
          resolved: false,
        });
      }
      // Keep previously-known entries that are now resolved (no longer pending)
      for (const existing of existingByPath.values()) {
        if (!pendingPaths.has(existing.path)) {
          merged.push({ ...existing, resolved: true });
        }
      }
      // Sort: pending first, then resolved
      merged.sort((a, b) => {
        if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
        return a.path.localeCompare(b.path);
      });
      dlg.conflicts = merged;
      rlog("info", "[git-ui] loadConflicts", {
        workspaceId,
        count: merged.length,
        binary: merged.filter((c) => c.binary).length,
        paths: merged.slice(0, 40).map((c) => c.path),
      });
    } catch (err) {
      dlg.error = (err as Error)?.message || "Failed to load conflicts.";
      rlog("error", "[git-ui] loadConflicts failed", { workspaceId, error: dlg.error });
    } finally {
      dlg.loading = false;
    }
  }

  async function resolveConflictFile(
    workspaceId: string,
    filePath: string,
    mode: "ours" | "theirs" | "delete" | "manual",
    content?: string,
  ): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    await runGitAction(workspaceId, `resolve:${filePath}`, () =>
      (_api as CallableTransport).gitResolveConflict({ workspaceId, rootPath: dlg.rootPath, filePath, mode, content }),
    );
    await loadConflicts(workspaceId);
  }

  async function unresolveConflictFile(workspaceId: string, filePath: string): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    await runGitAction(workspaceId, `unresolve:${filePath}`, () =>
      (_api as CallableTransport).gitUnresolveConflict({ workspaceId, rootPath: dlg.rootPath, filePath }),
    );
    await loadConflicts(workspaceId);
  }

  async function skipConflictCommit(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    const kind = await currentOperationKind(workspaceId, dlg.rootPath);
    await runGitAction(workspaceId, "skip", () =>
      (_api as CallableTransport).gitSkipCommit({ workspaceId, rootPath: dlg.rootPath }),
    );
    // After skip, check if there are more conflicts (rebase may pause again)
    await refreshGit(workspaceId);
    // Re-load the conflicts for the current (possibly new) stopped commit
    await loadConflicts(workspaceId);
    // If no more conflicts, close the dialog
    const after = ensure(workspaceId).conflictDialog;
    if (after && !after.loading && !after.conflicts.length) closeConflictDialog(workspaceId);
    await surfaceOperationCompletion(workspaceId, dlg.rootPath, kind);
  }

  async function continueAfterConflicts(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    const kind = await currentOperationKind(workspaceId, dlg.rootPath);
    await runGitAction(workspaceId, "continue", () =>
      (_api as CallableTransport).gitContinueOperation({ workspaceId, rootPath: dlg.rootPath }),
    );
    // After continue, operation may stop again (next conflicting commit in rebase)
    await refreshGit(workspaceId);
    await loadConflicts(workspaceId);
    const after = ensure(workspaceId).conflictDialog;
    if (after && !after.loading && !after.conflicts.length) closeConflictDialog(workspaceId);
    await surfaceOperationCompletion(workspaceId, dlg.rootPath, kind);
  }

  async function currentOperationKind(workspaceId: string, rootPath: string): Promise<string> {
    const { useAppStore } = await import("./app.js");
    const snapshot = useAppStore().getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    return String((snapshot?.operationState as { kind?: string } | undefined)?.kind || "operation");
  }

  // After a continue/skip the operation may be fully done — the success toast
  // alone is easy to miss, so leave a persistent banner on the Overview tab
  // (where closeConflictDialog lands the user), and point at the follow-up
  // force push when the rewritten history diverged from upstream.
  async function surfaceOperationCompletion(workspaceId: string, rootPath: string, kind: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = useAppStore().getGitSnapshot(workspaceId, rootPath) as any;
    const op = snapshot?.operationState;
    if (!snapshot || op?.inProgress) return;
    const ui = ensure(workspaceId);
    // A failed continue/skip keeps its own error banner — don't repaint it.
    if (ui.lastResult && !ui.lastResult.ok) return;
    const diverged = (snapshot.aheadCount ?? 0) > 0 && (snapshot.behindCount ?? 0) > 0 && !!snapshot.upstream;
    const hint = diverged
      ? "History was rewritten and upstream still has the old commits — publish with “Force push (with lease)” in the banner above."
      : "";
    const summary = `${kind.charAt(0).toUpperCase()}${kind.slice(1)} completed.`;
    if (ui.lastResult) {
      // Keep backend extras (e.g. "Restored previously stashed local changes.")
      ui.lastResult.summary = summary;
      if (hint) (ui.lastResult.warnings as unknown[]).push(hint);
    } else {
      ui.lastResult = {
        ok: true,
        summary,
        warnings: hint ? [hint] : [],
        conflicts: [],
        rawOutput: "",
        operationState: null,
        at: new Date().toISOString(),
      };
    }
  }

  async function abortFromConflictDialog(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    await runGitAction(workspaceId, "abort", () =>
      (_api as CallableTransport).gitAbortOperation({ workspaceId, rootPath: dlg.rootPath }),
    );
    closeConflictDialog(workspaceId);
  }

  async function refreshRoot(workspaceId: string, rootPath: string): Promise<void> {
    await runGitAction(workspaceId, `refresh:${rootPath}`, async () => {
      const payload = await (_api as Transport & { refreshGit: (id: string) => Promise<unknown> }).refreshGit!(
        workspaceId,
      );
      return { payload };
    });
  }

  async function pullRoot(workspaceId: string, rootPath: string): Promise<void> {
    await runGitAction(workspaceId, `pull:${rootPath}`, () =>
      (_api as Transport & { gitPull: (p: unknown) => Promise<unknown> }).gitPull!({
        workspaceId,
        rootPath,
        idempotencyKey: newGitIdempotencyKey(),
      }),
    );
  }

  async function revealRoot(workspaceId: string, rootPath: string): Promise<void> {
    if (!rootPath) return;
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    await appStore.quickAddTab(rootPath);
  }

  return {
    // Read accessor
    get,
    getStagedCommitMessage,
    setStagedCommitMessage,
    getClassicCommitMessage,
    setClassicCommitMessage,
    getClassicSelectedPaths,
    setClassicSelectedPaths,
    cleanup,
    init,
    // Active root management
    setActiveRoot,
    getActiveRoot,
    // Git actions
    runGitAction,
    refreshGit,
    gitFetch,
    gitPull,
    gitPush,
    bulkFetch,
    bulkPull,
    refreshRoot,
    pullRoot,
    revealRoot,
    gitCheckoutBranch,
    gitCreateBranch,
    gitCherryPick,
    gitSquashCommits,
    gitListBranches,
    gitDeleteBranch,
    gitDeleteRemoteBranch,
    gitRenameBranch,
    gitCheckoutRemoteBranch,
    gitLoadGraph,
    setPendingGitAction,
    setPendingDestructiveAction,
    clearPendingGitAction,
    dismissStalePending,
    gitConfirmAction,
    gitContinue,
    gitAbort,
    gitMergeBase,
    gitRebaseBase,
    gitMergeIntoBase,
    gitRemoveWorktree,
    confirmDeleteLocalTag,
    confirmDeleteRemoteTag,
    confirmRemoveWorktree,
    confirmRemoveWorktreeDeleteBranch,
    confirmForcePushWithLease,
    gitCommitAll,
    gitStageFile,
    gitStageHunk,
    gitUnstageFile,
    gitCommitStaged,
    gitSelectCommit,
    gitSelectDiff,
    gitSwitchTab,
    gitSwitchView,
    getGitView,
    getGitHistoryPreferences,
    getGitHistorySelection,
    setGitHistorySelection,
    toggleGitHistoryFavorite,
    recordGitHistoryRef,
    setNewViewLegacyDestination,
    getNewViewLegacyDestination,
    gitClearResult,
    gitClearSelectedDiff,
    openLazygit,
    gitStashPop,
    gitSetBaseBranch,
    gitFetchBaseComparison,
    gitListTags,
    gitCreateTag,
    gitDeleteTag,
    gitPushTag,
    gitPushAllTags,
    gitDeleteRemoteTag,
    azureCreatePullRequest,
    azureListRemoteBranches,
    // Azure review UI actions
    reviewSwitchTab,
    reviewSetCommentFilter,
    reviewSetCommentSort,
    reviewSetCommentSearch,
    reviewSetAgentSubtab,
    reviewSelectFileDiff,
    // Conflict resolution dialog
    openConflictDialog,
    closeConflictDialog,
    loadConflicts,
    resolveConflictFile,
    unresolveConflictFile,
    skipConflictCommit,
    continueAfterConflicts,
    abortFromConflictDialog,
  };
});
