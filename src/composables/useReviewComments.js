import { computed } from "vue";

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
export function useReviewComments(detail, reviewBridge, reviewUi, pullRequest) {
  // Comments state
  const allThreads = computed(() =>
    (detail.value?.threads || []).filter((t) => String(t.status || "").toLowerCase() !== "unknown" && !t.isDeleted),
  );
  const draftComments = computed(() =>
    (reviewBridge.value.comments || []).filter((c) => c.commentKind === "draft" || c.commentKind === "local-comment"),
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

  function threadIndex(thread) { return threadToIndex.value.get(String(thread.id)) || 0; }
  function draftsByThread(thread) {
    const commentKey = threadToCommentKey.value.get(String(thread.id));
    return commentKey ? (draftMap.value.get(commentKey) || []) : [];
  }
  function draftsByComment(comment) { return draftMap.value.get(comment.commentKey) || []; }

  // Filtering/sorting
  const filter = computed(() => reviewUi.value.commentFilter || "all");
  const sort = computed(() => reviewUi.value.commentSort || "index");
  const sortDir = computed(() => reviewUi.value.commentSortDir || (sort.value === "newest" ? "desc" : "asc"));
  const searchTerm = computed(() => (reviewUi.value.commentSearch || "").toLowerCase().trim());

  const filteredThreads = computed(() => {
    let threads = allThreads.value;
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
        const authors = (t.comments || []).map((c) => c.author?.displayName || "");
        return authors.includes(myName) || threadsWithDraft.has(String(t.id));
      });
    }

    if (searchTerm.value) {
      threads = threads.filter((t) => {
        const texts = [t.filePath || "", ...(t.comments || []).map((c) => c.content || "")];
        return texts.some((text) => text.toLowerCase().includes(searchTerm.value));
      });
    }

    const dir = sortDir.value === "desc" ? -1 : 1;
    const statusOrder = { active: 0, pending: 1, "": 2, fixed: 3, closed: 4, wontfix: 5, bydesign: 6 };
    if (sort.value === "newest") {
      return [...threads].sort((a, b) => {
        const lastA = (a.comments || []).at(-1)?.publishedDate || "";
        const lastB = (b.comments || []).at(-1)?.publishedDate || "";
        return dir * (lastB || "").localeCompare(lastA || "");
      });
    } else if (sort.value === "status") {
      return [...threads].sort((a, b) => dir * ((statusOrder[String(a.status || "").toLowerCase()] ?? 2) - (statusOrder[String(b.status || "").toLowerCase()] ?? 2)));
    } else if (sort.value === "file") {
      return [...threads].sort((a, b) => dir * (a.filePath || "").localeCompare(b.filePath || ""));
    }
    return [...threads].sort((a, b) => dir * ((threadIndex(a) || 9999) - (threadIndex(b) || 9999)));
  });

  const filteredDraftComments = computed(() => {
    let comments = draftComments.value;
    if (filter.value === "has-draft") {
      comments = comments.filter((c) => draftMap.value.has(c.commentKey));
    }
    if (searchTerm.value) {
      comments = comments.filter((c) =>
        [c.title || "", c.summary || ""].some((t) => t.toLowerCase().includes(searchTerm.value)),
      );
    }
    return comments;
  });

  const isFiltered = computed(() => filter.value !== "all" || !!searchTerm.value);
  const totalCommentCount = computed(() => allThreads.value.length + draftComments.value.length);
  const activeCommentCount = computed(() =>
    allThreads.value.filter((t) => String(t.status || "").toLowerCase() === "active").length + draftComments.value.length,
  );
  const allDrafts = computed(() => (reviewBridge.value.drafts || []).filter((d) => d.status === "draft"));
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
