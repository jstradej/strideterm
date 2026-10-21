import { describe, expect, test, beforeEach, vi } from "vitest";
import { computed, isReactive, nextTick, reactive } from "vue";
import { setActivePinia, createPinia } from "pinia";
import { useGitUiStore } from "./git-ui.js";
import { useNotificationStore } from "./notifications.js";
import type { Transport } from "../transport.js";
import type { OperationFinished } from "../../electron/shared/operation-events.js";

// gitSelectDiff is the only one of the three diff-preview loaders that reads
// the app store's git snapshot (to resolve rootPath/baseBranch), so it needs
// a mock here; the default null return matches the real store's behaviour
// when no payload has been loaded, which is what the other describe blocks
// below implicitly relied on before this mock existed.
const getGitSnapshot = vi.fn((_workspaceId: string, _rootPath?: string | null): unknown => null);
// Git actions adopt the backend payload through the app store. It MUST be
// adoptPayload (viewer-scoped) and never a raw `appStore.payload =` — the
// backend's payload.workspace is always the DESKTOP's active workspace, so a
// raw assignment jumps a remote/mobile viewer into another workspace.
const adoptPayload = vi.fn();
// PR-linked checkouts route Push / Force push / "update from the PR target"
// through the review Git operations the app store exposes.
const pushReviewCheckout = vi.fn(
  async (_workspaceId: string, _options?: { force?: boolean }): Promise<unknown> => null,
);
const rebaseReviewCheckout = vi.fn(async (_workspaceId: string): Promise<unknown> => null);
const appStoreMock = reactive({
  getGitSnapshot,
  adoptPayload,
  payload: null as unknown,
  pushReviewCheckout,
  rebaseReviewCheckout,
});
vi.mock("./app.js", () => ({
  useAppStore: () => appStoreMock,
}));

beforeEach(() => {
  setActivePinia(createPinia());
  getGitSnapshot.mockReset();
  getGitSnapshot.mockReturnValue(null);
  adoptPayload.mockReset();
  pushReviewCheckout.mockReset();
  rebaseReviewCheckout.mockReset();
  appStoreMock.payload = null;
});

describe("git-ui store", () => {
  test("new Git view selection is independent for each repository root", () => {
    const store = useGitUiStore();
    store.setActiveRoot("ws1", "/repo/a");
    store.gitSwitchView("ws1", "history", "/repo/a");
    store.setActiveRoot("ws1", "/repo/b");
    expect(store.getGitView("ws1", "/repo/a")).toBe("history");
    expect(store.getGitView("ws1", "/repo/b")).toBeUndefined();
    store.gitSwitchView("ws1", "changes", "/repo/b");
    expect(store.getGitView("ws1", "/repo/a")).toBe("history");
    expect(store.getGitView("ws1", "/repo/b")).toBe("changes");
    store.gitSwitchView("ws1", "review", "/repo/a", "profile-b");
    expect(store.getGitView("ws1", "/repo/a", "profile-b")).toBe("review");
    expect(store.getGitView("ws1", "/repo/a", "default")).toBe("history");
    store.gitSwitchView("ws1", "changes", "/repo/a", "profile-b", "azure:123");
    expect(store.getGitView("ws1", "/repo/a", "profile-b", "azure:123")).toBe("changes");
    expect(store.getGitView("ws1", "/repo/a", "profile-b", "github:123")).toBeUndefined();
  });

  test("History ref and search restore per profile, workspace, and root", () => {
    const store = useGitUiStore();
    store.setGitHistorySelection("ws1", "/repo/a", "profile-a", { ref: "feature/a", commitSearch: "fix" });
    expect(store.getGitHistorySelection("ws1", "/repo/a", "profile-a")).toEqual({
      ref: "feature/a",
      commitSearch: "fix",
    });
    expect(store.getGitHistorySelection("ws1", "/repo/b", "profile-a")).toEqual({ ref: "", commitSearch: "" });
    expect(store.getGitHistorySelection("ws1", "/repo/a", "profile-b")).toEqual({ ref: "", commitSearch: "" });
  });

  test("persists new-view selection and ignores out-of-order history responses", async () => {
    const requests: Array<(value: unknown) => void> = [];
    const api = {
      setWorkspaceUIState: vi.fn().mockResolvedValue(null),
      gitLogGraph: vi.fn(() => new Promise((resolve) => requests.push(resolve))),
    } as unknown as Transport;
    const store = useGitUiStore();
    store.init(api);
    store.gitSwitchView("ws1", "review", "/repo/a", "profile-a", "pr-1");
    expect(api.setWorkspaceUIState).toHaveBeenCalledWith("ws1", {
      gitViewPreferences: { "profile-a::ws1::/repo/a::pr-1": "review" },
    });

    store.setActiveRoot("ws1", "/repo/a");
    const first = store.gitLoadGraph("ws1", { branch: "main", force: true });
    const second = store.gitLoadGraph("ws1", { branch: "feature", force: true });
    requests[1]({ ok: true, head: "new", commits: [{ hash: "new" }], refs: {} });
    await second;
    requests[0]({ ok: true, head: "old", commits: [{ hash: "old" }], refs: {} });
    await first;
    expect(store.get("ws1").graph?.head).toBe("new");
  });

  test("keeps large graph and diff read payloads outside deep reactivity", async () => {
    const graph = { head: "abc", commits: [{ hash: "abc", message: "commit" }], refs: { main: "abc" } };
    const diff = { ok: true, path: "large.txt", scope: "unstaged", diff: "+content", summary: "loaded" };
    const store = useGitUiStore();
    store.init({
      gitLogGraph: vi.fn().mockResolvedValue({ ok: true, ...graph }),
      gitDiffPreview: vi.fn().mockResolvedValue(diff),
    } as unknown as Transport);
    store.setActiveRoot("ws-shallow-git", "/repo");

    await store.gitLoadGraph("ws-shallow-git", { branch: "main", force: true });
    await store.gitSelectDiff("ws-shallow-git", "large.txt", "unstaged");

    expect(isReactive(store.get("ws-shallow-git").graph)).toBe(false);
    expect(isReactive(store.get("ws-shallow-git").graph?.commits)).toBe(false);
    expect(isReactive(store.get("ws-shallow-git").diffPreview)).toBe(false);
    expect(store.get("ws-shallow-git").graph?.head).toBe("abc");
    expect(store.get("ws-shallow-git").diffPreview).toMatchObject({ diff: "+content" });
  });

  test("ignores an old History graph response after switching repository roots", async () => {
    const requests: Array<(value: unknown) => void> = [];
    const api = {
      gitLogGraph: vi.fn(() => new Promise((resolve) => requests.push(resolve))),
    } as unknown as Transport;
    const store = useGitUiStore();
    store.init(api);
    store.setActiveRoot("ws1", "/repo/a");
    const oldRootRequest = store.gitLoadGraph("ws1", { branch: "release-a", force: true });

    store.setActiveRoot("ws1", "/repo/b");
    const newRootRequest = store.gitLoadGraph("ws1", { branch: "release-b", force: true });
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    requests[1]({ ok: true, head: "root-b", commits: [{ hash: "from-b" }], refs: {} });
    await newRootRequest;
    requests[0]({ ok: true, head: "root-a", commits: [{ hash: "from-a" }], refs: {} });
    await oldRootRequest;

    expect(store.get("ws1").graph).toMatchObject({ head: "root-b", commits: [{ hash: "from-b" }] });
  });

  test("updates favorites and recent refs reactively without rereading storage", async () => {
    const store = useGitUiStore();
    const preferences = computed(() => store.getGitHistoryPreferences("ws-history", "/repo", "profile-a"));

    expect(preferences.value).toEqual({ favorites: [], recent: [] });
    store.toggleGitHistoryFavorite("ws-history", "feature/topic", "/repo", "profile-a");
    store.recordGitHistoryRef("ws-history", "feature/topic", "/repo", "profile-a");
    await nextTick();

    expect(preferences.value).toEqual({ favorites: ["feature/topic"], recent: ["feature/topic"] });
    store.toggleGitHistoryFavorite("ws-history", "feature/topic", "/repo", "profile-a");
    await nextTick();
    expect(preferences.value.favorites).toEqual([]);
  });

  test("ignores stale branch and tag reads after the repository root changes", async () => {
    const branchRequests: Array<(value: unknown) => void> = [];
    const tagRequests: Array<(value: unknown) => void> = [];
    const api = {
      gitListBranches: vi.fn(() => new Promise((resolve) => branchRequests.push(resolve))),
      gitListTags: vi.fn(() => new Promise((resolve) => tagRequests.push(resolve))),
    } as unknown as Transport;
    const store = useGitUiStore();
    store.init(api);
    store.setActiveRoot("ws1", "/repo/a");
    const branchesA = store.gitListBranches("ws1", { force: true });
    const tagsA = store.gitListTags("ws1");
    store.setActiveRoot("ws1", "/repo/b");
    const branchesB = store.gitListBranches("ws1", { force: true });
    const tagsB = store.gitListTags("ws1");
    branchRequests[1]({ ok: true, current: "feature", local: [{ name: "feature" }] });
    tagRequests[1]({ ok: true, tags: [{ name: "release-b" }] });
    await Promise.all([branchesB, tagsB]);
    branchRequests[0]({ ok: true, current: "main", local: [{ name: "main" }] });
    tagRequests[0]({ ok: true, tags: [{ name: "release-a" }] });
    await Promise.all([branchesA, tagsA]);
    expect(store.get("ws1").branchList?.current).toBe("feature");
    expect(store.get("ws1").tags).toEqual([{ name: "release-b" }]);
  });

  test("does not let an old file diff replace the currently selected file", async () => {
    const requests: Array<(value: unknown) => void> = [];
    const store = useGitUiStore();
    store.setActiveRoot("ws1", "/repo/a");
    store.init({
      gitDiffPreview: vi.fn(() => new Promise((resolve) => requests.push(resolve))),
    } as unknown as Transport);
    const first = store.gitSelectDiff("ws1", "first.txt", "unstaged");
    const second = store.gitSelectDiff("ws1", "second.txt", "unstaged");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]({ ok: true, path: "second.txt", diff: "new selection" });
    await second;
    requests[0]({ ok: true, path: "first.txt", diff: "stale selection" });
    await first;
    expect(store.get("ws1").diffPreview).toMatchObject({ path: "second.txt", diff: "new selection" });
  });

  test("history favorites and recent refs stay scoped to profile, workspace, and root", () => {
    const store = useGitUiStore();
    store.toggleGitHistoryFavorite("ws1", "main", "/repo/a", "profile-a");
    store.recordGitHistoryRef("ws1", "main", "/repo/a", "profile-a");
    expect(store.getGitHistoryPreferences("ws1", "/repo/a", "profile-a")).toEqual({
      favorites: ["main"],
      recent: ["main"],
    });
    expect(store.getGitHistoryPreferences("ws1", "/repo/b", "profile-a")).toEqual({ favorites: [], recent: [] });
    expect(store.getGitHistoryPreferences("ws1", "/repo/a", "profile-b")).toEqual({ favorites: [], recent: [] });
  });

  test("index action results preserve structured success instead of depending on a cleared banner", async () => {
    const store = useGitUiStore();
    store.init({ gitStageFile: async () => ({ payload: {}, result: { ok: true } }) } as unknown as Transport);
    expect(await store.gitStageFile("ws1", "a.txt")).toBe(true);
  });

  describe("runGitAction payload adoption", () => {
    test("requires a successful root refresh before retrying an index write with a lost response", async () => {
      const stageFile = vi
        .fn()
        .mockRejectedValueOnce(new Error("Remote transport disconnected."))
        .mockResolvedValueOnce({ result: { ok: true } });
      const refreshGit = vi.fn().mockResolvedValue({ fresh: true });
      getGitSnapshot.mockReturnValue({ available: true });
      const store = useGitUiStore();
      store.init({ gitStageFile: stageFile, refreshGit } as unknown as Transport);
      store.setActiveRoot("ws-uncertain-index", "/repo/a");

      expect(await store.gitStageFile("ws-uncertain-index", "a.txt")).toBe(false);
      expect(store.get("ws-uncertain-index").lastResult).toMatchObject({
        ok: false,
        summary: expect.stringContaining("verify its state before retrying"),
      });
      expect(Object.keys(store.get("ws-uncertain-index").uncertainWrites || {})).toHaveLength(1);

      store.setActiveRoot("ws-uncertain-index", "/repo/b");
      await store.refreshGit("ws-uncertain-index");
      expect(Object.keys(store.get("ws-uncertain-index").uncertainWrites || {})).toHaveLength(1);

      store.setActiveRoot("ws-uncertain-index", "/repo/a");
      expect(await store.gitStageFile("ws-uncertain-index", "a.txt")).toBe(false);
      expect(stageFile).toHaveBeenCalledTimes(1);
      expect(store.get("ws-uncertain-index").lastResult?.summary).toContain("Refresh this repository");

      await store.refreshGit("ws-uncertain-index");
      expect(store.get("ws-uncertain-index").uncertainWrites).toEqual({});
      expect(await store.gitStageFile("ws-uncertain-index", "a.txt")).toBe(true);
      expect(stageFile).toHaveBeenCalledTimes(2);
      expect(refreshGit).toHaveBeenCalledTimes(2);
    });

    test("requires repository verification before retrying a branch mutation with a lost response", async () => {
      const checkout = vi
        .fn()
        .mockRejectedValueOnce(new Error("Remote transport disconnected."))
        .mockResolvedValueOnce({ result: { ok: true } });
      const store = useGitUiStore();
      store.init({ gitCheckoutBranch: checkout } as unknown as Transport);
      store.setActiveRoot("ws-uncertain-branch", "/repo/a");

      await store.gitCheckoutBranch("ws-uncertain-branch", "feature/example");
      expect(store.get("ws-uncertain-branch").lastResult?.summary).toContain("outcome is uncertain");
      expect(Object.keys(store.get("ws-uncertain-branch").uncertainWrites || {})).toHaveLength(1);

      await store.gitCheckoutBranch("ws-uncertain-branch", "feature/example");
      expect(checkout).toHaveBeenCalledTimes(1);

      getGitSnapshot.mockReturnValue({ available: true });
      store.init({
        gitCheckoutBranch: checkout,
        refreshGit: vi.fn().mockResolvedValue({ fresh: true }),
      } as unknown as Transport);
      await store.refreshGit("ws-uncertain-branch");
      expect(store.get("ws-uncertain-branch").uncertainWrites).toEqual({});
      await store.gitCheckoutBranch("ws-uncertain-branch", "feature/example");
      expect(checkout).toHaveBeenCalledTimes(2);
    });

    test("surfaces and records a rejected long-operation start", async () => {
      const request = vi.fn().mockRejectedValue(new Error("Remote transport disconnected."));
      const store = useGitUiStore();
      store.init({ gitFetch: request } as unknown as Transport);
      store.setActiveRoot("ws1", "/repo/a");
      const priorFailureCount = useNotificationStore().items.filter(
        (toast) => toast.title === "Git action failed",
      ).length;
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await store.gitFetch("ws1");
      } finally {
        consoleError.mockRestore();
      }

      expect(request).toHaveBeenCalledTimes(1);
      expect(store.get("ws1").busyAction).toBe("");
      expect(store.get("ws1").lastResult).toMatchObject({
        ok: false,
        summary: "Remote transport disconnected.",
      });
      expect(useNotificationStore().items.filter((toast) => toast.title === "Git action failed")).toHaveLength(
        priorFailureCount + 1,
      );
    });

    test.each([
      ["fetch", "gitFetch"],
      ["pull", "gitPull"],
      ["push", "gitPush"],
    ] as const)("handles %s failure delivered by event and payload exactly once", async (action, method) => {
      let finish!: (outcome: OperationFinished) => void;
      const onOperationFinished = vi.fn((handler: (outcome: OperationFinished) => void) => {
        finish = handler;
      });
      const request = vi.fn().mockResolvedValue({ started: true, operationId: `op-${action}` });
      const store = useGitUiStore();
      store.init({ [method]: request, onOperationFinished } as unknown as Transport);
      store.setActiveRoot("ws1", "/repo/a");
      store.setStagedCommitMessage("ws1", "/repo/a", "Keep this commit draft after network failure");
      appStoreMock.payload = { operations: { lastResults: [] } };
      const priorFailureCount = useNotificationStore().items.filter(
        (toast) => toast.title === "Git action failed",
      ).length;

      const pending = store[action === "fetch" ? "gitFetch" : action === "pull" ? "gitPull" : "gitPush"]("ws1");
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(store.get("ws1").busyAction).toBe(action));
      expect(store.get("ws1").lastResult).toBeUndefined();

      const outcome: OperationFinished = {
        operationId: `op-${action}`,
        kind: `git.${action}`,
        profileId: "profile-a",
        workspaceId: "ws1",
        rootPath: "/repo/a",
        finishedAt: new Date().toISOString(),
        result: {
          ok: false,
          summary: `${action} failed after acceptance`,
          warnings: ["Pre-push hook rejected the update."],
          rawOutput: "pre-push hook: typecheck failed",
        },
      };
      appStoreMock.payload = { operations: { lastResults: [outcome] } };
      finish(outcome);
      await pending;

      expect(store.get("ws1").busyAction).toBe("");
      expect(store.get("ws1").lastResult).toMatchObject({
        ok: false,
        summary: `${action} failed after acceptance`,
        warnings: ["Pre-push hook rejected the update."],
        rawOutput: "pre-push hook: typecheck failed",
      });
      expect(store.getStagedCommitMessage("ws1", "/repo/a")).toBe("Keep this commit draft after network failure");
      expect(useNotificationStore().items.filter((toast) => toast.title === "Git action failed")).toHaveLength(
        priorFailureCount + 1,
      );
    });

    test("retains diagnostics from a failed long-operation error", async () => {
      let finish!: (outcome: OperationFinished) => void;
      const onOperationFinished = vi.fn((handler: (outcome: OperationFinished) => void) => {
        finish = handler;
      });
      const store = useGitUiStore();
      store.init({
        gitPull: vi.fn().mockResolvedValue({ started: true, operationId: "op-pull-diagnostics" }),
        onOperationFinished,
      } as unknown as Transport);
      store.setActiveRoot("ws1", "/repo/a");
      appStoreMock.payload = { operations: { lastResults: [] } };
      const pending = store.gitPull("ws1");
      await vi.waitFor(() => expect(store.get("ws1").busyAction).toBe("pull"));
      finish({
        operationId: "op-pull-diagnostics",
        kind: "git.pull",
        profileId: "profile-a",
        workspaceId: "ws1",
        rootPath: "/repo/a",
        finishedAt: new Date().toISOString(),
        error: {
          code: "git_operation_failed",
          message: "Pull failed.",
          warnings: ["Local changes were restored."],
          conflicts: ["src/conflicted.ts"],
          rawOutput: "hook: validation failed",
        },
      } as OperationFinished);
      await pending;
      expect(store.get("ws1").lastResult).toMatchObject({
        ok: false,
        summary: "Pull failed.",
        warnings: ["Local changes were restored."],
        conflicts: ["src/conflicted.ts"],
        rawOutput: "hook: validation failed",
      });
    });

    test("recovers a pull outcome from the persisted operation payload after a missed event", async () => {
      const request = vi.fn().mockResolvedValue({ started: true, operationId: "op-pull-replay" });
      const store = useGitUiStore();
      store.init({ gitPull: request } as unknown as Transport);
      store.setActiveRoot("ws1", "/repo/a");
      appStoreMock.payload = { operations: { lastResults: [] } };

      const pending = store.gitPull("ws1");
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(store.get("ws1").busyAction).toBe("pull"));
      appStoreMock.payload = {
        operations: {
          lastResults: [
            {
              operationId: "op-pull-replay",
              kind: "git.pull",
              profileId: "profile-a",
              workspaceId: "ws1",
              rootPath: "/repo/a",
              finishedAt: new Date().toISOString(),
              result: { ok: true, summary: "Recovered pull result." },
            },
          ],
        },
      };
      await pending;

      expect(store.get("ws1").busyAction).toBe("");
      expect(useNotificationStore().persistentToasts.at(-1)?.body).toBe("Recovered pull result.");
    });

    test("blocks a duplicate action while the first request is still pending", async () => {
      let finishFetch!: (value: unknown) => void;
      const gitFetch = vi.fn(() => new Promise((resolve) => (finishFetch = resolve)));
      const store = useGitUiStore();
      store.init({ gitFetch } as unknown as Transport);

      const first = store.gitFetch("ws1");
      const duplicate = await store.gitFetch("ws1");
      expect(duplicate).toBeUndefined();
      await vi.waitFor(() => expect(gitFetch).toHaveBeenCalledTimes(1));
      expect(store.get("ws1").busyAction).toBe("fetch");
      finishFetch({ result: { ok: true, summary: "Fetch complete." } });
      await first;
      expect(store.get("ws1").busyAction).toBe("");
    });

    test("reuses the long-operation idempotency key after a lost start response", async () => {
      const request = vi
        .fn()
        .mockRejectedValueOnce({ message: "Connection lost before the operation ID arrived." })
        .mockResolvedValueOnce({ result: { ok: true, summary: "Fetch recovered." } });
      const store = useGitUiStore();
      store.init({ gitFetch: request } as unknown as Transport);
      store.setActiveRoot("ws1", "/repo/a");

      await store.gitFetch("ws1");
      expect(store.get("ws1").lastResult).toMatchObject({ ok: false });
      await store.gitFetch("ws1");

      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[0][0]).toMatchObject({
        rootPath: "/repo/a",
        idempotencyKey: expect.any(String),
      });
      expect(request.mock.calls[1][0]).toMatchObject({
        rootPath: "/repo/a",
        idempotencyKey: request.mock.calls[0][0].idempotencyKey,
      });
      expect(store.get("ws1").busyAction).toBe("");
    });

    test.each([
      ["pull", "gitPull", (store: ReturnType<typeof useGitUiStore>) => store.gitPull("ws1")],
      ["push", "gitPush", (store: ReturnType<typeof useGitUiStore>) => store.gitPush("ws1")],
    ] as const)(
      "reuses the %s key after a lost start response without automatically retrying",
      async (_action, method, run) => {
        const request = vi
          .fn()
          .mockRejectedValueOnce(new Error("Connection lost before the operation ID arrived."))
          .mockResolvedValueOnce({ result: { ok: true, summary: "Recovered." } });
        const store = useGitUiStore();
        store.init({ [method]: request } as unknown as Transport);
        store.setActiveRoot("ws1", "/repo/a");

        await run(store);
        expect(request).toHaveBeenCalledTimes(1);
        expect(store.get("ws1").busyAction).toBe("");
        expect(store.get("ws1").pendingLongOperationKeys).toBeTruthy();
        await run(store);

        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[1]![0]).toMatchObject({
          rootPath: "/repo/a",
          idempotencyKey: request.mock.calls[0]![0].idempotencyKey,
        });
        expect(store.get("ws1").pendingLongOperationKeys).toEqual({});
      },
    );

    test("reuses a tag-push idempotency key after its start response is lost", async () => {
      const pushTag = vi
        .fn()
        .mockRejectedValueOnce(new Error("Connection lost before the operation ID arrived."))
        .mockResolvedValueOnce({ result: { ok: true, summary: "Tag pushed." } });
      const store = useGitUiStore();
      store.init({ gitPushTag: pushTag, gitListTags: vi.fn().mockResolvedValue({ tags: [] }) } as unknown as Transport);
      store.setActiveRoot("ws1", "/repo/a");

      await store.gitPushTag("ws1", "v1.2.3");
      await store.gitPushTag("ws1", "v1.2.3");

      expect(pushTag).toHaveBeenCalledTimes(2);
      expect(pushTag.mock.calls[0]![0]).toMatchObject({
        rootPath: "/repo/a",
        tagName: "v1.2.3",
        idempotencyKey: expect.any(String),
      });
      expect(pushTag.mock.calls[1]![0]).toMatchObject({
        idempotencyKey: pushTag.mock.calls[0]![0].idempotencyKey,
      });
      expect(store.get("ws1").pendingLongOperationKeys).toEqual({});
    });

    test("reuses a remote branch deletion key after its start response is lost", async () => {
      const deleteRemoteBranch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Connection lost before the operation ID arrived."))
        .mockResolvedValueOnce({ result: { ok: true, summary: "Remote branch deleted." } });
      const store = useGitUiStore();
      store.init({
        gitDeleteRemoteBranch: deleteRemoteBranch,
        gitListBranches: vi.fn().mockResolvedValue({ ok: true, local: [], remotes: [] }),
      } as unknown as Transport);
      store.setActiveRoot("ws1", "/repo/a");

      await store.gitDeleteRemoteBranch("ws1", "feature/old", "origin");
      await store.gitDeleteRemoteBranch("ws1", "feature/old", "origin");

      expect(deleteRemoteBranch).toHaveBeenCalledTimes(2);
      expect(deleteRemoteBranch.mock.calls[0]![0]).toMatchObject({
        rootPath: "/repo/a",
        branch: "feature/old",
        remote: "origin",
        idempotencyKey: expect.any(String),
      });
      expect(deleteRemoteBranch.mock.calls[1]![0]).toMatchObject({
        idempotencyKey: deleteRemoteBranch.mock.calls[0]![0].idempotencyKey,
      });
      expect(store.get("ws1").pendingLongOperationKeys).toEqual({});
    });

    test("adopts the action payload through adoptPayload, not a raw store write", async () => {
      const store = useGitUiStore();
      const responsePayload = { appState: { workspaces: [] } };
      store.init({
        gitFetch: async () => ({ payload: responsePayload, result: { ok: true } }),
      } as unknown as Transport);

      await store.gitFetch("ws1");

      expect(adoptPayload).toHaveBeenCalledWith(responsePayload);
    });

    test("post-action diff refresh stays on the originating root and ignores a changed selection", async () => {
      let finishAction!: (value: unknown) => void;
      let finishPreview!: (value: unknown) => void;
      const gitFetch = vi.fn(() => new Promise((resolve) => (finishAction = resolve)));
      const gitDiffPreview = vi.fn(() => new Promise((resolve) => (finishPreview = resolve)));
      const store = useGitUiStore();
      store.init({ gitFetch, gitDiffPreview } as unknown as Transport);
      store.setActiveRoot("ws1", "/repo/a");
      store.get("ws1").selectedDiff = { path: "a.txt", scope: "unstaged" };
      const pending = store.gitFetch("ws1");
      await vi.waitFor(() => expect(gitFetch).toHaveBeenCalledTimes(1));
      finishAction({ result: { ok: true } });
      await vi.waitFor(() => expect(gitDiffPreview).toHaveBeenCalledTimes(1));
      store.setActiveRoot("ws1", "/repo/b");
      store.get("ws1").selectedDiff = { path: "b.txt", scope: "staged" };
      finishPreview({ ok: true, path: "a.txt", diff: "old root" });
      await pending;
      expect(gitDiffPreview).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws1", rootPath: "/repo/a", path: "a.txt" }),
      );
      expect(store.get("ws1").diffPreview).not.toMatchObject({ path: "a.txt", diff: "old root" });
    });
  });
});

describe("git-ui store", () => {
  describe("setActiveRoot / getActiveRoot", () => {
    test("round-trip: setActiveRoot then getActiveRoot returns the same path", () => {
      const store = useGitUiStore();
      store.setActiveRoot("ws1", "/repo/a");
      expect(store.getActiveRoot("ws1")).toBe("/repo/a");
    });

    test("getActiveRoot returns empty string when workspace is not known", () => {
      const store = useGitUiStore();
      expect(store.getActiveRoot("unknown")).toBe("");
    });

    test("setActiveRoot clears when empty string is passed", () => {
      const store = useGitUiStore();
      store.setActiveRoot("ws1", "/repo/a");
      store.setActiveRoot("ws1", "");
      expect(store.getActiveRoot("ws1")).toBe("");
    });

    test("setActiveRoot with one workspace does not affect another workspace", () => {
      const store = useGitUiStore();
      store.setActiveRoot("ws1", "/repo/a");
      store.setActiveRoot("ws2", "/repo/b");
      expect(store.getActiveRoot("ws1")).toBe("/repo/a");
      expect(store.getActiveRoot("ws2")).toBe("/repo/b");
    });
  });

  describe("setActiveRoot persistence via api.setWorkspaceUIState", () => {
    test("calls setWorkspaceUIState with correct arguments after init", () => {
      const mockApi = {
        setWorkspaceUIState: vi.fn().mockResolvedValue(null),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/b");
      expect(mockApi.setWorkspaceUIState).toHaveBeenCalledWith("ws1", { activeRootPath: "/repo/b" });
    });

    test("does not throw when api is not initialized (no init call)", () => {
      const store = useGitUiStore();
      // _api is null — should be a no-op, not crash
      expect(() => store.setActiveRoot("ws1", "/repo/a")).not.toThrow();
      expect(store.getActiveRoot("ws1")).toBe("/repo/a");
    });

    test("passes empty string to setWorkspaceUIState when root is cleared", () => {
      const mockApi = {
        setWorkspaceUIState: vi.fn().mockResolvedValue(null),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "");
      expect(mockApi.setWorkspaceUIState).toHaveBeenCalledWith("ws1", { activeRootPath: "" });
    });
  });

  // gitSelectCommit/gitSelectDiff/reviewSelectFileDiff each independently
  // reimplemented "optimistic Loading… placeholder, then real result or
  // error-shaped fallback carrying the same identity fields" before being
  // migrated onto the shared loadDiffPreview() helper.
  describe("diff preview loading (gitSelectCommit / gitSelectDiff / reviewSelectFileDiff)", () => {
    test("gitSelectCommit replaces the loading placeholder with the fetched result", async () => {
      const gitCommitDiff = vi.fn().mockResolvedValue({ ok: true, hash: "abc123", diff: "+line", summary: "1 file" });
      const mockApi = { gitCommitDiff } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      const pending = store.gitSelectCommit("ws1", "abc123");
      expect(store.get("ws1").commitDiffPreview).toEqual({
        ok: true,
        hash: "abc123",
        diff: "",
        summary: "Loading...",
      });

      await pending;
      expect(gitCommitDiff).toHaveBeenCalledWith({ workspaceId: "ws1", hash: "abc123", rootPath: "" });
      expect(store.get("ws1").commitDiffPreview).toEqual({
        ok: true,
        hash: "abc123",
        diff: "+line",
        summary: "1 file",
      });
    });

    test("gitSelectCommit falls back to an error-shaped result carrying the hash when the fetch rejects", async () => {
      const gitCommitDiff = vi.fn().mockRejectedValue(new Error("network down"));
      const mockApi = { gitCommitDiff } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      await store.gitSelectCommit("ws1", "abc123");

      expect(store.get("ws1").commitDiffPreview).toEqual({
        ok: false,
        hash: "abc123",
        diff: "",
        summary: "network down",
      });
    });

    test("gitSelectCommit is a no-op for an empty hash", async () => {
      const store = useGitUiStore();
      await store.gitSelectCommit("ws1", "");
      expect(store.get("ws1").commitDiffPreview).toBeUndefined();
    });

    test("gitSelectDiff replaces the loading placeholder with the fetched result, carrying scope and resolving rootPath/baseBranch from the app-store snapshot", async () => {
      getGitSnapshot.mockReturnValue({ baseBranch: "main" });
      // A manually-controlled promise (rather than mockResolvedValue) so the
      // in-flight "Loading…" placeholder can be observed deterministically:
      // gitSelectDiff awaits a dynamic import before loadDiffPreview ever
      // runs, so the placeholder isn't visible synchronously the way
      // gitSelectCommit's is — flushing via a macrotask (setTimeout) drains
      // every microtask ahead of it (the import + loadDiffPreview's
      // pre-fetch code) while this fetch stays deliberately unresolved.
      let resolveFetch: (value: unknown) => void = () => {};
      const gitDiffPreview = vi.fn(() => new Promise((resolve) => (resolveFetch = resolve)));
      const mockApi = { gitDiffPreview } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/a");

      const pending = store.gitSelectDiff("ws1", "src/foo.ts", "staged");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.get("ws1").diffPreview).toEqual({
        ok: true,
        path: "src/foo.ts",
        scope: "staged",
        diff: "",
        summary: "Loading diff preview...",
      });
      expect(store.get("ws1").selectedDiff).toEqual({ path: "src/foo.ts", scope: "staged" });
      expect(gitDiffPreview).toHaveBeenCalledWith({
        workspaceId: "ws1",
        path: "src/foo.ts",
        scope: "staged",
        baseBranch: "main",
        rootPath: "/repo/a",
      });

      resolveFetch({ ok: true, path: "src/foo.ts", scope: "staged", diff: "+line", summary: "1 file" });
      await pending;
      expect(store.get("ws1").diffPreview).toEqual({
        ok: true,
        path: "src/foo.ts",
        scope: "staged",
        diff: "+line",
        summary: "1 file",
      });
    });

    test("gitSelectDiff falls back to an error-shaped result carrying the path and scope when the fetch rejects", async () => {
      const gitDiffPreview = vi.fn().mockRejectedValue(new Error("diff fetch failed"));
      const mockApi = { gitDiffPreview } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      await store.gitSelectDiff("ws1", "src/foo.ts", "unstaged");

      expect(store.get("ws1").diffPreview).toEqual({
        ok: false,
        path: "src/foo.ts",
        scope: "unstaged",
        diff: "",
        summary: "diff fetch failed",
      });
    });

    test("gitSelectDiff is a no-op for an empty path", async () => {
      const store = useGitUiStore();
      await store.gitSelectDiff("ws1", "", "staged");
      expect(store.get("ws1").diffPreview).toBeUndefined();
    });

    test("reviewSelectFileDiff falls back to an error-shaped result carrying only the path (no scope)", async () => {
      const gitDiffPreview = vi.fn().mockRejectedValue(new Error("diff fetch failed"));
      const mockApi = { gitDiffPreview } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      await store.reviewSelectFileDiff("ws1", "src/foo.ts");

      expect(store.get("ws1").reviewFileDiffPreview).toEqual({
        ok: false,
        path: "src/foo.ts",
        diff: "",
        summary: "diff fetch failed",
      });
    });
  });

  describe("cleanup", () => {
    test("cleanup removes workspace state so getActiveRoot returns empty string", () => {
      const store = useGitUiStore();
      store.setActiveRoot("ws1", "/repo/a");
      store.cleanup("ws1");
      expect(store.getActiveRoot("ws1")).toBe("");
    });
  });

  describe("PR rootPath routing", () => {
    test("azureCreatePullRequest includes the active rootPath", async () => {
      const mockApi = {
        azureCreatePullRequest: vi.fn().mockResolvedValue({ result: { ok: true, pullRequestId: 123 }, payload: null }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/b");

      await store.azureCreatePullRequest("ws1", {
        title: "My PR",
        description: "desc",
        sourceBranch: "feature/test",
        targetBranch: "main",
        connectionId: "ado-1",
      });

      expect(mockApi.azureCreatePullRequest).toHaveBeenCalledWith({
        workspaceId: "ws1",
        title: "My PR",
        description: "desc",
        sourceBranch: "feature/test",
        targetBranch: "main",
        connectionId: "ado-1",
        isDraft: false,
        rootPath: "/repo/b",
      });
    });

    test("azureCreatePullRequest forwards isDraft when provided", async () => {
      const mockApi = {
        azureCreatePullRequest: vi.fn().mockResolvedValue({ result: { ok: true, pullRequestId: 7 }, payload: null }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/b");

      await store.azureCreatePullRequest("ws1", {
        title: "WIP",
        description: "",
        sourceBranch: "feature/test",
        targetBranch: "main",
        connectionId: "ado-1",
        isDraft: true,
      });

      expect(mockApi.azureCreatePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ isDraft: true, title: "WIP" }),
      );
    });

    test("azureListRemoteBranches includes the active rootPath", async () => {
      const mockApi = {
        azureListRemoteBranches: vi.fn().mockResolvedValue({ branches: ["main", "develop"] }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/b");

      await store.azureListRemoteBranches("ws1");

      expect(mockApi.azureListRemoteBranches).toHaveBeenCalledWith({
        workspaceId: "ws1",
        rootPath: "/repo/b",
      });
    });

    // Regression: a failed fetch used to silently collapse to an empty
    // branch list with no error field — indistinguishable in the picker UI
    // from "this repo genuinely has no other branches."
    test("azureListRemoteBranches sets remoteBranchesError and clears the list when the API call fails", async () => {
      const mockApi = {
        azureListRemoteBranches: vi.fn().mockRejectedValue(new Error("network unreachable")),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/b");

      await store.azureListRemoteBranches("ws1");

      expect(store.get("ws1").remoteBranches).toEqual([]);
      expect(store.get("ws1").remoteBranchesError).toBe("network unreachable");
    });
  });

  describe("openLazygit", () => {
    // Regression: openLazygit had no error handling at all, so a click did
    // nothing when lazygit wasn't installed/available — no banner, no toast.
    test("surfaces an error notification when the session fails to open", async () => {
      const mockApi = {
        openLazygitSession: vi.fn().mockRejectedValue(new Error("Lazygit is not available for this workspace.")),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/a");

      await store.openLazygit("ws1");

      const notifications = useNotificationStore();
      expect(notifications.latestToast?.kind).toBe("error");
      expect(notifications.latestToast?.title).toBe("Failed to open Lazygit");
      expect(notifications.latestToast?.body).toBe("Lazygit is not available for this workspace.");
    });
  });

  describe("dismissStalePending — volatile counts must not nuke a fresh confirm", () => {
    // Regression: the screenshot bug. A pending rebase confirm was set, then a
    // background snapshot poll (ahead/behind + auto-detected compareWithBase
    // counts flapping) silently dismissed it via dismissStalePending — so the
    // confirm dialog vanished the instant a poll landed and the Update button
    // "did nothing". The staleness hash must ignore those volatile counts.
    const snap = (over: Record<string, unknown> = {}) => ({
      available: true,
      branch: "feature/x",
      baseBranch: "develop",
      dirty: false,
      dirtyCount: 0,
      aheadCount: 2,
      behindCount: 11,
      operationState: { kind: "idle", inProgress: false, conflicts: [] },
      compareWithBase: { baseBranch: "origin/develop", aheadCount: 2, behindCount: 11 },
      ...over,
    });

    test("keeps the pending confirm when only ahead/behind + compareWithBase counts change", () => {
      const store = useGitUiStore();
      store.setPendingGitAction("ws1", { type: "rebase", baseBranch: "origin/develop", snapshot: snap() });
      expect(store.get("ws1").pendingAction).toBeTruthy();

      // A poll lands: counts flap (base re-detected / fetch happened) but no
      // operation started and the tree is still clean.
      store.dismissStalePending(
        "ws1",
        snap({
          aheadCount: 0,
          behindCount: 0,
          compareWithBase: { baseBranch: "origin/jstradej/feature-x", aheadCount: 0, behindCount: 0 },
        }),
      );

      expect(store.get("ws1").pendingAction).toBeTruthy();
    });

    test("dismisses the pending confirm when an operation starts", () => {
      const store = useGitUiStore();
      store.setPendingGitAction("ws1", { type: "rebase", baseBranch: "origin/develop", snapshot: snap() });
      store.dismissStalePending("ws1", snap({ operationState: { kind: "rebase", inProgress: true, conflicts: [] } }));
      expect(store.get("ws1").pendingAction).toBeNull();
    });

    test("dismisses the pending confirm when the working tree dirty state changes", () => {
      const store = useGitUiStore();
      store.setPendingGitAction("ws1", { type: "merge", baseBranch: "origin/develop", snapshot: snap() });
      store.dismissStalePending("ws1", snap({ dirty: true, dirtyCount: 3 }));
      expect(store.get("ws1").pendingAction).toBeNull();
    });
  });

  describe("Conflict Center — listConflicts contract", () => {
    // Regression: git-manager.listConflicts returns the list under `entries`.
    // loadConflicts previously read `result.conflicts`, which never exists, so
    // the Conflict Center table always rendered empty. This locks the contract.
    test("loadConflicts populates the dialog from the backend `entries` key", async () => {
      const mockApi = {
        gitListConflicts: vi.fn().mockResolvedValue({
          ok: true,
          entries: [
            { path: "app.py", conflictType: "both-modified", stages: [1, 2, 3], binary: false },
            { path: "logo.png", conflictType: "both-added", stages: [2, 3], binary: true },
          ],
        }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      store.openConflictDialog("ws1", "/repo/a");
      await store.loadConflicts("ws1");

      expect(mockApi.gitListConflicts).toHaveBeenCalledWith({ workspaceId: "ws1", rootPath: "/repo/a" });
      const dlg = store.get("ws1").conflictDialog;
      expect(dlg?.conflicts.map((c) => c.path)).toEqual(["app.py", "logo.png"]);
      const png = dlg?.conflicts.find((c) => c.path === "logo.png");
      expect(png?.binary).toBe(true);
      expect(png?.conflictType).toBe("both-added");
      expect(dlg?.conflicts.every((c) => c.resolved === false)).toBe(true);
    });
  });

  describe("live push progress (onGitPushProgress)", () => {
    type ProgressHandler = (p: { workspaceId: string; rootPath: string; chunk: string }) => void;

    test("init subscribes and streamed chunks accumulate on the workspace", () => {
      let handler: ProgressHandler | null = null;
      const mockApi = {
        onGitPushProgress: vi.fn((h: ProgressHandler) => {
          handler = h;
        }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      expect(mockApi.onGitPushProgress).toHaveBeenCalledTimes(1);

      handler!({ workspaceId: "ws1", rootPath: "/repo", chunk: "Running pre-push hook…\n" });
      handler!({ workspaceId: "ws1", rootPath: "/repo", chunk: "✓ typecheck\n" });

      expect(store.get("ws1").pushProgress).toBe("Running pre-push hook…\n✓ typecheck\n");
    });

    test("progress for one workspace does not leak into another", () => {
      let handler: ProgressHandler | null = null;
      const mockApi = {
        onGitPushProgress: vi.fn((h: ProgressHandler) => {
          handler = h;
        }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      handler!({ workspaceId: "ws1", rootPath: "/repo", chunk: "ws1 output" });
      expect(store.get("ws1").pushProgress).toBe("ws1 output");
      expect(store.get("ws2").pushProgress).toBeUndefined();
    });

    test("a push clears any stale live output at the start", async () => {
      let handler: ProgressHandler | null = null;
      const mockApi = {
        onGitPushProgress: vi.fn((h: ProgressHandler) => {
          handler = h;
        }),
        gitPush: vi.fn().mockResolvedValue({ result: { ok: true, summary: "pushed" } }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      // A previous push left output behind.
      handler!({ workspaceId: "ws1", rootPath: "/repo", chunk: "old output" });
      expect(store.get("ws1").pushProgress).toBe("old output");

      await store.gitPush("ws1");
      expect(store.get("ws1").pushProgress).toBe("");
    });
  });
});

describe("PR-linked checkouts", () => {
  const linked = (branch: string) => {
    appStoreMock.payload = {
      appState: {
        workspaces: [
          {
            id: "ws1",
            review: {
              prKey: "gh:7",
              pullRequest: { id: 7, sourceRefName: "refs/heads/feature/login", targetRefName: "refs/heads/main" },
            },
          },
        ],
      },
    };
    getGitSnapshot.mockReturnValue({ available: true, branch });
  };
  const api = () =>
    ({
      gitPush: vi.fn().mockResolvedValue({ result: { ok: true, summary: "plain push" } }),
      gitForcePushWithLease: vi.fn().mockResolvedValue({ result: { ok: true, summary: "plain force" } }),
      gitRebaseBase: vi.fn().mockResolvedValue({ result: { ok: true, summary: "plain rebase" } }),
    }) as unknown as Transport & Record<string, ReturnType<typeof vi.fn>>;

  test.each(["pr-7-feature-login", "feature/login"])(
    "Push on the PR branch (%s) is the review push: it targets the PR source branch, not the local name",
    async (branch) => {
      linked(branch);
      pushReviewCheckout.mockResolvedValue({ status: "pushed", message: "Pushed abc to feature/login." });
      const transport = api();
      const store = useGitUiStore();
      store.init(transport);

      await store.gitPush("ws1");

      expect(pushReviewCheckout).toHaveBeenCalledWith("ws1", { force: false });
      expect(transport.gitPush).not.toHaveBeenCalled();
      expect(store.get("ws1").lastResult).toBeNull();
    },
  );

  test("a blocked review push shows the reason and the way out in the Git pane's result banner", async () => {
    linked("pr-7-feature-login");
    pushReviewCheckout.mockResolvedValue({
      status: "blocked",
      code: "dirty-tree",
      message: "HEAD is detached.",
      guidance: "Switch back to the PR branch.",
    });
    const store = useGitUiStore();
    store.init(api());

    await store.gitPush("ws1");

    expect(store.get("ws1").lastResult).toMatchObject({
      ok: false,
      summary: "HEAD is detached. Switch back to the PR branch.",
    });
  });

  test("on any other branch the ordinary push acts on that branch, even in a PR-linked workspace", async () => {
    linked("develop");
    const transport = api();
    const store = useGitUiStore();
    store.init(transport);

    await store.gitPush("ws1");

    expect(transport.gitPush).toHaveBeenCalledTimes(1);
    expect(pushReviewCheckout).not.toHaveBeenCalled();
  });

  test("a confirmed Force push on another branch is the ordinary force push of that branch", async () => {
    linked("develop");
    const transport = api();
    const store = useGitUiStore();
    store.init(transport);

    store.confirmForcePushWithLease("ws1", { branch: "develop", remote: "origin", behindCount: 2 });
    await store.gitConfirmAction("ws1");

    expect(transport.gitForcePushWithLease).toHaveBeenCalledTimes(1);
    expect(pushReviewCheckout).not.toHaveBeenCalled();
  });

  test("a review push that waits on the proposal dialog is not cut off by the generic 120 s backstop", async () => {
    vi.useFakeTimers();
    try {
      linked("pr-7-feature-login");
      let finish!: (value: unknown) => void;
      pushReviewCheckout.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const store = useGitUiStore();
      store.init(api());

      const pending = store.gitPush("ws1");
      await vi.advanceTimersByTimeAsync(300_000);
      expect(store.get("ws1").busyAction).toBe("push");
      finish({ status: "pushed", message: "Pushed abc to feature/login." });
      await pending;

      expect(store.get("ws1").lastResult).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a workspace without a PR link always pushes the ordinary way", async () => {
    appStoreMock.payload = { appState: { workspaces: [{ id: "ws1", review: null }] } };
    getGitSnapshot.mockReturnValue({ available: true, branch: "pr-7-feature-login" });
    const transport = api();
    const store = useGitUiStore();
    store.init(transport);

    await store.gitPush("ws1");

    expect(transport.gitPush).toHaveBeenCalledTimes(1);
    expect(pushReviewCheckout).not.toHaveBeenCalled();
  });

  test("a confirmed Force push on the PR branch is a review force push", async () => {
    linked("pr-7-feature-login");
    pushReviewCheckout.mockResolvedValue({ status: "pushed", message: "Force pushed." });
    const transport = api();
    const store = useGitUiStore();
    store.init(transport);

    store.confirmForcePushWithLease("ws1", { branch: "pr-7-feature-login", remote: "origin", behindCount: 2 });
    await store.gitConfirmAction("ws1");

    expect(pushReviewCheckout).toHaveBeenCalledWith("ws1", { force: true });
    expect(transport.gitForcePushWithLease).not.toHaveBeenCalled();
  });

  test("updating a PR branch from its own target is a TARGET rebase run by the runtime (it asks itself)", async () => {
    linked("pr-7-feature-login");
    rebaseReviewCheckout.mockResolvedValue({ status: "rebased", message: "Rebased onto main." });
    const transport = api();
    const store = useGitUiStore();
    store.init(transport);

    await store.gitRebaseBase("ws1", "origin/main");

    expect(rebaseReviewCheckout).toHaveBeenCalledWith("ws1");
    expect(transport.gitRebaseBase).not.toHaveBeenCalled();
    expect(store.get("ws1").pendingAction ?? null).toBeNull();
  });

  test("rebasing a PR branch onto some other base is the ordinary rebase with its own confirmation", async () => {
    linked("pr-7-feature-login");
    const transport = api();
    const store = useGitUiStore();
    store.init(transport);

    await store.gitRebaseBase("ws1", "origin/release/1.0");

    expect(rebaseReviewCheckout).not.toHaveBeenCalled();
    expect(store.get("ws1").pendingAction).toMatchObject({ type: "rebase", baseBranch: "origin/release/1.0" });
  });
});

describe("branch update waits for its accepted long operation", () => {
  function setupFetchFirst(type: "merge" | "rebase") {
    let finishOperation: ((event: OperationFinished) => void) | undefined;
    const gitMergeIntoCurrent = vi.fn().mockResolvedValue({ started: true, operationId: "op-update" });
    const gitRebaseOnto = vi.fn().mockResolvedValue({ started: true, operationId: "op-update" });
    const api = {
      onOperationFinished: (handler: (event: OperationFinished) => void) => {
        finishOperation = handler;
      },
      gitMergeIntoCurrent,
      gitRebaseOnto,
    } as unknown as Transport;
    const store = useGitUiStore();
    store.init(api);
    store.setPendingGitAction("ws1", {
      type,
      baseBranch: "origin/main",
      fetchFirst: true,
      snapshot: { available: true, branch: "feature", operationState: { inProgress: false } },
    });
    return {
      store,
      finish: (event: OperationFinished) => finishOperation?.(event),
      gitMergeIntoCurrent,
      gitRebaseOnto,
    };
  }

  const updateOutcome = (type: "merge" | "rebase"): OperationFinished => ({
    operationId: "op-update",
    kind: `git.${type}`,
    profileId: "default",
    rootPath: "/repo",
    finishedAt: new Date().toISOString(),
    result: { ok: true, summary: `${type} completed.` },
  });

  test.each(["merge", "rebase"] as const)("keeps %s busy until its long operation completes", async (type) => {
    const { store, finish, gitMergeIntoCurrent, gitRebaseOnto } = setupFetchFirst(type);
    const pending = store.gitConfirmAction("ws1");
    await vi.waitFor(() => expect(store.get("ws1").busyAction).toBe(type));
    await vi.waitFor(() => expect(type === "merge" ? gitMergeIntoCurrent : gitRebaseOnto).toHaveBeenCalled());

    expect(type === "merge" ? gitMergeIntoCurrent : gitRebaseOnto).toHaveBeenCalledWith(
      expect.objectContaining({ fetchFirst: true, idempotencyKey: expect.any(String) }),
    );
    finish(updateOutcome(type));
    await pending;

    expect(type === "merge" ? gitMergeIntoCurrent : gitRebaseOnto).toHaveBeenCalledTimes(1);
    expect(store.get("ws1").busyAction).toBe("");
  });

  test("shows an error from the fetch-first operation and does not issue a second mutation", async () => {
    const { store, finish, gitMergeIntoCurrent, gitRebaseOnto } = setupFetchFirst("rebase");
    const pending = store.gitConfirmAction("ws1");
    await vi.waitFor(() => expect(store.get("ws1").busyAction).toBe("rebase"));
    finish({
      operationId: "op-update",
      kind: "git.rebase",
      profileId: "default",
      rootPath: "/repo",
      finishedAt: new Date().toISOString(),
      error: { code: "internal_error", message: "Remote authentication failed." },
    });
    await pending;

    expect(gitMergeIntoCurrent).not.toHaveBeenCalled();
    expect(gitRebaseOnto).toHaveBeenCalledTimes(1);
    expect(store.get("ws1").lastResult).toMatchObject({ ok: false, summary: "Remote authentication failed." });
  });

  test("recovers the update result from the operations payload when its event was missed", async () => {
    const { store, gitRebaseOnto } = setupFetchFirst("rebase");
    const pending = store.gitConfirmAction("ws1");
    await vi.waitFor(() => expect(store.get("ws1").busyAction).toBe("rebase"));
    appStoreMock.payload = { operations: { lastResults: [] } };
    await nextTick();
    appStoreMock.payload = { operations: { lastResults: [updateOutcome("rebase")] } };

    await pending;

    expect(gitRebaseOnto).toHaveBeenCalledTimes(1);
  });
});
