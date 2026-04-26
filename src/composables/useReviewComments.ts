import { computed } from "vue";
import type { Ref } from "vue";

const sortOptions = [
  { id: "index", label: "#N" },
  { id: "newest", label: "Newest" },
  { id: "status", label: "Status" },
  { id: "file", label: "File" },
];

/**
 * Extracts comment/thread/draft filtering and sorting logic
 * from AzureReviewPane into a reusable composable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useReviewComments(detail: Ref<any>, reviewBridge: Ref<any>, reviewUi: Ref<any>, pullRequest: Ref<any>) {
  // Comments state
  const allThreads = computed(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: review thread shape is open-ended server JSON
    ((detail.value?.threads || []) as any[]).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: review thread item is open-ended server JSON
      (t: any) => String(t.status || "").toLowerCase() !== "unknown" && !t.isDeleted,
    ),
  );
  const draftComments = computed(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: review comment shape is open-ended server JSON
    ((reviewBridge.value.comments || []) as any[]).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: review comment item is open-ended server JSON
      (c: any) => c.commentKind === "draft" || c.commentKind === "local-comment",
    ),
  );
  const draftMap = computed(() => {
    const map = new Map();
    for (const d of reviewBridge.value.drafts || []) {
      // Skip synced drafts — they're already published as real Azure comments
      if (d.status === "synced") continue;
      const list = map.get(d.commentKey);
      if (list) list.push(d);
      else map.set(d.commentKey, [d]);
    }
    return map;
  });

  // Build threadId -> commentKey mapping for draft lookup
  const threadToCommentKey = computed(() => {
    const map = new Map();
    for (const comment of reviewBridge.value.comments || []) {
      if (comment.remoteThreadId && comment.commentKind !== "local-comment" && comment.commentKind !== "draft") {
        map.set(String(comment.remoteThreadId), comment.commentKey);
      }
    }
    return map;
  });

  // Build commentKey -> displayIndex mapping
  const commentKeyToIndex = computed(() => {
    const map = new Map();
    for (const comment of reviewBridge.value.comments || []) {
      if (comment.displayIndex) map.set(comment.commentKey, comment.displayIndex);
    }
    return map;
  });

  // Build threadId -> displayIndex
  const threadToIndex = computed(() => {
    const map = new Map();
    for (const comment of reviewBridge.value.comments || []) {
      if (comment.displayIndex && comment.remoteThreadId) {
        map.set(String(comment.remoteThreadId), comment.displayIndex);
      }
    }
    return map;
  });

  // Build threadId -> fixStatus (null | 'has-code-changes')
  const threadFixStatus = computed(() => {
    const map = new Map();
    for (const comment of reviewBridge.value.comments || []) {
      if (comment.remoteThreadId && comment.fixStatus) {
        map.set(String(comment.remoteThreadId), { fixStatus: comment.fixStatus, fixSummary: comment.fixSummary || "" });
      }
    }
    return map;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function threadIndex(thread: any): number {
    return threadToIndex.value.get(String(thread.id)) || 0;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function draftsByThread(thread: any): any[] {
    const commentKey = threadToCommentKey.value.get(String(thread.id));
    return commentKey ? draftMap.value.get(commentKey) || [] : [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function draftsByComment(comment: any): any[] {
    return draftMap.value.get(comment.commentKey) || [];
  }

  // Filtering/sorting
  const filter = computed(() => reviewUi.value.commentFilter || "all");
  const sort = computed(() => reviewUi.value.commentSort || "index");
  const sortDir = computed(() => reviewUi.value.commentSortDir || (sort.value === "newest" ? "desc" : "asc"));
  const searchTerm = computed(() => (reviewUi.value.commentSearch || "").toLowerCase().trim());

  const filteredThreads = computed(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let threads: any[] = allThreads.value;
    const myName = pullRequest.value.createdBy?.displayName || "";
    const threadsWithDraft = new Set();
    for (const [threadId] of threadToCommentKey.value) {
      const commentKey = threadToCommentKey.value.get(threadId);
      if (commentKey && draftMap.value.has(commentKey)) threadsWithDraft.add(threadId);
    }

    if (filter.value === "has-draft") {
      threads = threads.filter((t) => threadsWithDraft.has(String(t.id)));
    } else if (filter.value === "active") {
      threads = threads.filter((t) => String(t.status || "").toLowerCase() === "active");
    } else if (filter.value === "fixed") {
      threads = threads.filter((t) => threadFixStatus.value.has(String(t.id)));
    } else if (filter.value === "mine") {
      threads = threads.filter((t) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const authors = ((t.comments || []) as any[]).map((c: any) => c.author?.displayName || "");
        return authors.includes(myName) || threadsWithDraft.has(String(t.id));
      });
    }

    if (searchTerm.value) {
      threads = threads.filter((t) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const texts = [t.filePath || "", ...((t.comments || []) as any[]).map((c: any) => c.content || "")];
        return texts.some((text) => text.toLowerCase().includes(searchTerm.value));
      });
    }

    const dir = sortDir.value === "desc" ? -1 : 1;
    const statusOrder: Record<string, number> = {
      active: 0,
      pending: 1,
      "": 2,
      fixed: 3,
      closed: 4,
      wontfix: 5,
      bydesign: 6,
    };
    if (sort.value === "newest") {
      return [...threads].sort((a, b) => {
        const lastA = (a.comments || []).at(-1)?.publishedDate || "";
        const lastB = (b.comments || []).at(-1)?.publishedDate || "";
        return dir * (lastB || "").localeCompare(lastA || "");
      });
    } else if (sort.value === "status") {
      return [...threads].sort(
        (a, b) =>
          dir *
          ((statusOrder[String(a.status || "").toLowerCase()] ?? 2) -
            (statusOrder[String(b.status || "").toLowerCase()] ?? 2)),
      );
    } else if (sort.value === "file") {
      return [...threads].sort((a, b) => dir * (a.filePath || "").localeCompare(b.filePath || ""));
    }
    return [...threads].sort((a, b) => dir * ((threadIndex(a) || 9999) - (threadIndex(b) || 9999)));
  });

  const filteredDraftComments = computed(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let comments: any[] = draftComments.value;
    if (filter.value === "has-draft") {
      comments = comments.filter((c) => draftMap.value.has(c.commentKey));
    }
    if (searchTerm.value) {
      comments = comments.filter((c) =>
        [c.title || "", c.summary || ""].some((t) => t.toLowerCase().includes(searchTerm.value)),
      );
    }
    const dir = sortDir.value === "desc" ? -1 : 1;
    if (sort.value === "index" || sort.value === "newest") {
      comments = [...comments].sort((a, b) => dir * ((a.displayIndex || 9999) - (b.displayIndex || 9999)));
    }
    return comments;
  });

  const isFiltered = computed(() => filter.value !== "all" || !!searchTerm.value);
  const totalCommentCount = computed(() => allThreads.value.length + draftComments.value.length);
  const activeCommentCount = computed(
    () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (allThreads.value as any[]).filter((t: any) => String(t.status || "").toLowerCase() === "active").length +
      draftComments.value.length,
  );
  const allDrafts = computed(
    () => ((reviewBridge.value.drafts || []) as any[]).filter((d: any) => d.status === "draft"), // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: review draft shape is open-ended server JSON
  );
  const hasClearable = computed(() => allDrafts.value.length > 0 || draftComments.value.length > 0);

  return {
    allThreads,
    draftComments,
    draftMap,
    threadToCommentKey,
    commentKeyToIndex,
    threadToIndex,
    threadFixStatus,
    threadIndex,
    draftsByThread,
    draftsByComment,
    filter,
    sort,
    sortDir,
    searchTerm,
    filteredThreads,
    filteredDraftComments,
    isFiltered,
    totalCommentCount,
    activeCommentCount,
    allDrafts,
    hasClearable,
    sortOptions,
  };
}
