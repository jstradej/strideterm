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

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({
    reviewBridgeDeleteAllDrafts,
    deleteReviewBridgeDraft,
    azureResolveThread,
    azureReactivateThread,
    deleteReviewBridgeComment,
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
    createReviewBridgeDraftComment: vi.fn(),
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
});

describe("ReviewCommentsTab — draft/thread/comment mutations surface failures instead of silently succeeding", () => {
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
      props: baseProps({ filteredThreads: [{ id: "t1", status: "active", comments: [] }] }),
    });
    const resolveBtn = wrapper.findAll("button").find((b) => b.text() === "Resolve")!;
    await resolveBtn.trigger("click");
    await flushPromises();

    expect(azureResolveThread).toHaveBeenCalledWith("pr-1", "t1");
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Resolve thread failed");
    expect(resolveBtn.attributes("disabled")).toBeUndefined();
  });

  test("handleReactivateThread: rejection is caught and surfaced as a toast, busy resets", async () => {
    azureReactivateThread.mockRejectedValueOnce(new Error("network down"));
    const wrapper = mount(ReviewCommentsTab, {
      props: baseProps({ filteredThreads: [{ id: "t1", status: "closed", comments: [] }] }),
    });
    const reactivateBtn = wrapper.findAll("button").find((b) => b.text() === "Reactivate")!;
    await reactivateBtn.trigger("click");
    await flushPromises();

    expect(azureReactivateThread).toHaveBeenCalledWith("pr-1", "t1");
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
