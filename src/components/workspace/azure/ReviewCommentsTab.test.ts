/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.3: the
 * delete-all-drafts, delete-draft, resolve-thread, reactivate-thread, and
 * delete-comment handlers were try/finally with no catch, so a rejected
 * call silently reset the busy flag with zero user-visible feedback. All
 * five now go through notifications.runWithToast.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const reviewBridgeDeleteAllDrafts = vi.fn();
const deleteReviewBridgeDraft = vi.fn();
const azureResolveThread = vi.fn();
const azureReactivateThread = vi.fn();
const deleteReviewBridgeComment = vi.fn();
const saveReviewBridgeDraft = vi.fn();
const queueReviewBridgeDraft = vi.fn();
const openDialog = vi.fn();
const closeDialog = vi.fn();
const createReviewBridgeDraftComment = vi.fn();

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({
    reviewBridgeDeleteAllDrafts,
    deleteReviewBridgeDraft,
    azureResolveThread,
    azureReactivateThread,
    deleteReviewBridgeComment,
    saveReviewBridgeDraft,
    queueReviewBridgeDraft,
    openDialog,
    closeDialog,
    createReviewBridgeDraftComment,
  }),
}));
vi.mock("../../../stores/git-ui.js", () => ({
  useGitUiStore: () => ({
    reviewSetCommentFilter: vi.fn(),
    reviewSetCommentSort: vi.fn(),
    reviewSetCommentSearch: vi.fn(),
  }),
}));

import ReviewCommentsTab from "./ReviewCommentsTab.vue";
import { useNotificationStore } from "../../../stores/notifications.js";
import { azureThreadStatusSchema } from "../../../../electron/backend/ipc-schemas.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseProps(overrides: Record<string, any> = {}) {
  return {
    prKey: "pr-1",
    workspaceId: "ws-1",
    filteredThreads: [],
    filteredDraftComments: [],
    draftsByThread: () => [],
    draftsByComment: () => [],
    threadIndex: () => null,
    threadToCommentKey: new Map(),
    threadFixStatus: new Map(),
    filter: "all",
    sort: "date",
    sortDir: "desc",
    searchTerm: "",
    isFiltered: false,
    allDrafts: [],
    hasClearable: true,
    sortOptions: [{ id: "date", label: "Date" }],
    totalCommentCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  reviewBridgeDeleteAllDrafts.mockClear();
  deleteReviewBridgeDraft.mockClear();
  azureResolveThread.mockClear();
  azureReactivateThread.mockClear();
  deleteReviewBridgeComment.mockClear();
  saveReviewBridgeDraft.mockReset();
  queueReviewBridgeDraft.mockReset();
  openDialog.mockReset();
  closeDialog.mockReset();
  createReviewBridgeDraftComment.mockReset();
});

// Regression: Resolve / Reactivate sent String(threadId), and the main
// process's azureThreadStatusSchema (threadId: z.number()) refused it before
// any request to Azure DevOps. The fixtures above used `id: "t1"`, which Azure
// never returns, so the string went unnoticed; hold the payload to the schema.
describe("ReviewCommentsTab — thread status payload matches the IPC contract", () => {
  test.each([
    ["Resolve", "active", azureResolveThread, "fixed"],
    ["Reactivate", "closed", azureReactivateThread, "active"],
  ] as const)("%s sends a numeric threadId azureThreadStatusSchema accepts", async (label, status, action, target) => {
    action.mockResolvedValueOnce(undefined);
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({ filteredThreads: [{ id: 42, status, comments: [] }] }),
    });
    await wrapper
      .findAll("button")
      .find((b) => b.text() === label)!
      .trigger("click");
    await flushPromises();

    const [prKey, threadId] = action.mock.calls[0];
    expect(threadId).toBe(42);
    expect(azureThreadStatusSchema.safeParse({ prKey, threadId, status: target }).success).toBe(true);
  });
});

// Regression: New comment and Reply fired the create without awaiting it and
// closed the dialog straight away, so a refused draft vanished with the text
// the user had typed and no message.
describe("ReviewCommentsTab — new comment / reply dialogs wait for the draft", () => {
  async function openDialogFrom(label: string, threads: unknown[] = []) {
    const wrapper = mount(ReviewCommentsTab, { props: baseProps({ filteredThreads: threads }) });
    await wrapper
      .findAll("button")
      .find((b) => b.text() === label)!
      .trigger("click");
    return openDialog.mock.calls.at(-1)?.[1] as { onSubmit: (body: string) => Promise<void> };
  }

  test("New comment: a refused draft keeps the dialog open and shows a toast", async () => {
    createReviewBridgeDraftComment.mockRejectedValueOnce(new Error("body: Too small"));
    const dialog = await openDialogFrom("New comment");
    await dialog.onSubmit("text");

    expect(closeDialog).not.toHaveBeenCalled();
    expect(useNotificationStore().sessions[0]?.events[0]?.title).toBe("Create draft failed");
  });

  test("New comment: closes only after the draft was created", async () => {
    createReviewBridgeDraftComment.mockResolvedValueOnce(undefined);
    const dialog = await openDialogFrom("New comment");
    await dialog.onSubmit("text");

    expect(createReviewBridgeDraftComment).toHaveBeenCalledWith({
      prKey: "pr-1",
      body: "text",
      authorAgent: "human",
      autoQueue: true,
    });
    expect(closeDialog).toHaveBeenCalledOnce();
  });

  test("Reply: a refused draft keeps the dialog open, success closes it", async () => {
    const threads = [{ id: 42, status: "active", comments: [] }];
    createReviewBridgeDraftComment.mockRejectedValueOnce(new Error("locked"));
    const dialog = await openDialogFrom("Reply", threads);
    await dialog.onSubmit("reply");
    expect(closeDialog).not.toHaveBeenCalled();

    createReviewBridgeDraftComment.mockResolvedValueOnce(undefined);
    await dialog.onSubmit("reply");
    expect(createReviewBridgeDraftComment).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 42 }));
    expect(closeDialog).toHaveBeenCalledOnce();
  });
});

describe("ReviewCommentsTab — draft/thread/comment mutations surface failures instead of silently succeeding", () => {
  test("editing a draft queues by commentKey and closes only after both save and queue succeed", async () => {
    saveReviewBridgeDraft.mockResolvedValue(undefined);
    queueReviewBridgeDraft.mockResolvedValue(undefined);
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({
        filteredDraftComments: [{ commentKey: "local-1", displayIndex: 1, status: "draft" }],
        draftsByComment: () => [{ draftId: "draft-1", status: "draft", body: "before" }],
      }),
    });

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Edit")!
      .trigger("click");
    const dialogOptions = openDialog.mock.calls.at(-1)?.[1] as { onSubmit: (body: string) => Promise<void> };
    await dialogOptions.onSubmit("after");

    expect(saveReviewBridgeDraft).toHaveBeenCalledWith({
      prKey: "pr-1",
      commentKey: "local-1",
      body: "after",
      authorAgent: "human",
    });
    expect(queueReviewBridgeDraft).toHaveBeenCalledWith("pr-1", undefined, "local-1");
    expect(closeDialog).toHaveBeenCalledOnce();
  });

  test("keeps the editor open and reports queue failure after a successful save", async () => {
    saveReviewBridgeDraft.mockResolvedValue(undefined);
    queueReviewBridgeDraft.mockRejectedValueOnce(new Error("IPC queue validation failed"));
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({
        filteredDraftComments: [{ commentKey: "local-1", displayIndex: 1, status: "draft" }],
        draftsByComment: () => [{ draftId: "draft-1", status: "draft", body: "before" }],
      }),
    });

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Edit")!
      .trigger("click");
    const dialogOptions = openDialog.mock.calls.at(-1)?.[1] as { onSubmit: (body: string) => Promise<void> };
    await dialogOptions.onSubmit("after");

    expect(queueReviewBridgeDraft).toHaveBeenCalledWith("pr-1", undefined, "local-1");
    expect(closeDialog).not.toHaveBeenCalled();
    expect(useNotificationStore().sessions[0]?.events[0]?.title).toBe("Save draft failed");
  });

  test("handleDeleteAllDrafts: rejection is caught and surfaced as a toast, busy resets", async () => {
    reviewBridgeDeleteAllDrafts.mockRejectedValueOnce(new Error("locked"));
    const wrapper = mount(ReviewCommentsTab, { props: baseProps() });
    const deleteAllBtn = wrapper.findAll("button").find((b) => b.text().includes("Delete all drafts"))!;
    await deleteAllBtn.trigger("click");
    await flushPromises();

    expect(reviewBridgeDeleteAllDrafts).toHaveBeenCalledWith("pr-1");
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Delete all drafts failed");
    expect(deleteAllBtn.attributes("disabled")).toBeUndefined();
  });

  test("handleDeleteDraft: rejection is caught and surfaced as a toast, busy resets", async () => {
    deleteReviewBridgeDraft.mockRejectedValueOnce(new Error("network down"));
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({
        filteredThreads: [{ id: "t1", status: "active", comments: [] }],
        draftsByThread: () => [{ draftId: "d1", status: "queued", body: "reply" }],
      }),
    });
    const deleteBtn = wrapper.findAll("button").find((b) => b.text() === "Delete")!;
    await deleteBtn.trigger("click");
    await flushPromises();

    expect(deleteReviewBridgeDraft).toHaveBeenCalledWith("pr-1", "d1");
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Delete draft failed");
    expect(deleteBtn.attributes("disabled")).toBeUndefined();
  });

  test("handleResolveThread: rejection is caught and surfaced as a toast, busy resets", async () => {
    azureResolveThread.mockRejectedValueOnce(new Error("network down"));
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({ filteredThreads: [{ id: 7, status: "active", comments: [] }] }),
    });
    const resolveBtn = wrapper.findAll("button").find((b) => b.text() === "Resolve")!;
    await resolveBtn.trigger("click");
    await flushPromises();

    expect(azureResolveThread).toHaveBeenCalledWith("pr-1", 7);
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Resolve thread failed");
    expect(resolveBtn.attributes("disabled")).toBeUndefined();
  });

  test("handleReactivateThread: rejection is caught and surfaced as a toast, busy resets", async () => {
    azureReactivateThread.mockRejectedValueOnce(new Error("network down"));
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({ filteredThreads: [{ id: 7, status: "closed", comments: [] }] }),
    });
    const reactivateBtn = wrapper.findAll("button").find((b) => b.text() === "Reactivate")!;
    await reactivateBtn.trigger("click");
    await flushPromises();

    expect(azureReactivateThread).toHaveBeenCalledWith("pr-1", 7);
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Reactivate thread failed");
    expect(reactivateBtn.attributes("disabled")).toBeUndefined();
  });

  test("handleDeleteComment: rejection is caught and surfaced as a toast, busy resets", async () => {
    deleteReviewBridgeComment.mockRejectedValueOnce(new Error("network down"));
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({
        filteredDraftComments: [{ commentKey: "c1", displayIndex: 1, status: "draft" }],
      }),
    });
    const deleteBtn = wrapper.findAll("button").find((b) => b.text() === "Delete")!;
    await deleteBtn.trigger("click");
    await flushPromises();

    expect(deleteReviewBridgeComment).toHaveBeenCalledWith("pr-1", "c1");
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Delete comment failed");
    expect(deleteBtn.attributes("disabled")).toBeUndefined();
  });
});

/**
 * formatRelativeTime() (which wraps the shared formatRelativeUntil) is
 * rendered both for the thread header's timestamp and per-comment — this
 * exercises it through the real component template, covering the recent
 * relative-time branch and this component's own 2-week "Xw ago" fallback.
 * No fake timers: mirrors azurePipelineFormat.test.ts's isoAgo(ms) helper
 * against the real Date.now() at test-run time.
 */
describe("ReviewCommentsTab — formatRelativeTime relative/fallback rendering", () => {
  function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
  }

  test("renders the recent-branch relative text for a comment under 14 days old", async () => {
    const publishedDate = isoAgo(5 * 60_000);
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({
        filteredThreads: [
          {
            id: "t1",
            status: "active",
            comments: [{ id: "c1", publishedDate, author: { displayName: "Alice" }, content: "hi" }],
          },
        ],
      }),
    });
    await flushPromises();

    const dates = wrapper.findAll(".review-comment__date");
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates) expect(d.text()).toBe("5m ago");
  });

  test("renders the 'Xw ago' fallback for a comment past the 14-day threshold", async () => {
    const publishedDate = isoAgo(20 * 86_400_000);
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({
        filteredThreads: [
          {
            id: "t1",
            status: "active",
            comments: [{ id: "c1", publishedDate, author: { displayName: "Alice" }, content: "hi" }],
          },
        ],
      }),
    });
    await flushPromises();

    const dates = wrapper.findAll(".review-comment__date");
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates) expect(d.text()).toBe("2w ago");
  });
});

describe("ReviewCommentsTab — comment location navigation", () => {
  test("emits the file, line, and side when its location link is activated", async () => {
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({
        filteredThreads: [
          {
            id: "t-location",
            status: "active",
            filePath: "src/example.ts",
            lineStart: 24,
            lineSide: "old",
            comments: [],
          },
        ],
      }),
    });

    await wrapper.get(".review-comment-file--link").trigger("click");

    expect(wrapper.emitted("open-location")?.[0]).toEqual([
      { filePath: "src/example.ts", line: 24, side: "old", stale: false, annotationId: "thread:t-location" },
    ]);
  });

  test("shows and opens the stored location for a queued standalone draft comment", async () => {
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({
        filteredDraftComments: [
          {
            commentKey: "local-location",
            displayIndex: 9,
            status: "ready-to-sync",
            payload: { filePath: "src/components/example.ts", lineNumber: 37 },
          },
        ],
        draftsByComment: () => [
          {
            draftId: "draft-location",
            status: "ready-to-sync",
            body: "Check this changed line",
            authorAgent: "claude",
          },
        ],
      }),
    });

    const locationLink = wrapper.get(".review-comment-file--link");
    expect(locationLink.text()).toBe("src/components/example.ts:37");
    await locationLink.trigger("click");

    expect(wrapper.emitted("open-location")?.[0]).toEqual([
      {
        filePath: "src/components/example.ts",
        line: 37,
        side: "new",
        stale: false,
        annotationId: "draft:local-location",
      },
    ]);
  });

  test("labels a standalone draft with no stored file path as a PR-level comment", () => {
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({ filteredDraftComments: [{ commentKey: "general", displayIndex: 3, payload: {} }] }),
    });

    expect(wrapper.text()).toContain("PR-level comment · no file location");
  });
});
