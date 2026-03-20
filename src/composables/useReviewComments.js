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
  const localComments = computed(() =>
    (reviewBridge.value.comments || []).filter((c) => c.commentKind === "local-comment"),
  );
  const draftMap = computed(() => new Map((reviewBridge.value.drafts || []).map((d) => [d.commentKey, d])));

  // Build threadId -> commentKey mapping for draft lookup
  const threadToCommentKey = computed(() => {
    const map = new Map();
    for (const comment of reviewBridge.value.comments || []) {
      if (comment.commentKind !== "local-comment" && comment.remoteThreadId) {
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

  function threadIndex(thread) { return threadToIndex.value.get(String(thread.id)) || 0; }
  function draftByThread(thread) {
    const commentKey = threadToCommentKey.value.get(String(thread.id));
    return commentKey ? draftMap.value.get(commentKey) : null;
  }
  function draftByComment(comment) { return draftMap.value.get(comment.commentKey) || null; }

  // Filtering/sorting
  const filter = computed(() => reviewUi.value.commentFilter || "all");
  const sort = computed(() => reviewUi.value.commentSort || "index");
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

    const statusOrder = { active: 0, pending: 1, "": 2, fixed: 3, closed: 4, wontfix: 5, bydesign: 6 };
    if (sort.value === "newest") {
      return [...threads].sort((a, b) => {
        const lastA = (a.comments || []).at(-1)?.publishedDate || "";
        const lastB = (b.comments || []).at(-1)?.publishedDate || "";
        return (lastB || "").localeCompare(lastA || "");
      });
    } else if (sort.value === "status") {
      return [...threads].sort((a, b) => (statusOrder[String(a.status || "").toLowerCase()] ?? 2) - (statusOrder[String(b.status || "").toLowerCase()] ?? 2));
    } else if (sort.value === "file") {
      return [...threads].sort((a, b) => (a.filePath || "").localeCompare(b.filePath || ""));
    }
    return [...threads].sort((a, b) => (threadIndex(a) || 9999) - (threadIndex(b) || 9999));
  });

  const filteredLocalComments = computed(() => {
    let comments = localComments.value;
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
  const totalCommentCount = computed(() => allThreads.value.length + localComments.value.length);
  const allDrafts = computed(() => (reviewBridge.value.drafts || []).filter((d) => d.status === "draft"));
  const hasClearable = computed(() => allDrafts.value.length > 0 || localComments.value.length > 0);

  return {
    allThreads,
    localComments,
    draftMap,
    threadToCommentKey,
    commentKeyToIndex,
    threadToIndex,
    threadIndex,
    draftByThread,
    draftByComment,
    filter,
    sort,
    searchTerm,
    filteredThreads,
    filteredLocalComments,
    isFiltered,
    totalCommentCount,
    allDrafts,
    hasClearable,
    sortOptions,
  };
}
