import path from "node:path";

const ACTIVE_THREAD_STATUS = new Set(["active", "pending", "unknown"]);
const COMMENT_STATUSES_TO_PRESERVE = new Set([
  "agent-working",
  "draft-ready",
  "needs-human-review",
  "ready-to-sync",
  "synced",
  "conflict",
]);

function safeSegment(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .replaceAll(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^\.+|\.+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

export function collapseText(value) {
  return String(value || "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function isActiveThread(thread) {
  return ACTIVE_THREAD_STATUS.has(String(thread?.status || "").toLowerCase());
}

export function buildCommentTitle(thread) {
  const filePath = String(thread?.filePath || "").trim();
  const line = Number.isInteger(thread?.lineStart) ? `:${thread.lineStart}` : "";
  if (filePath) {
    return `Review thread in ${filePath}${line}`;
  }
  return `Review thread #${thread?.id ?? "unknown"}`;
}

export function buildCommentSummary(thread) {
  const latestComment = [...(thread?.comments || [])]
    .filter((comment) => String(comment?.content || "").trim())
    .sort(
      (left, right) =>
        Date.parse(right?.lastUpdatedDate || right?.publishedDate || 0) -
        Date.parse(left?.lastUpdatedDate || left?.publishedDate || 0),
    )[0];
  return collapseText(latestComment?.content || "") || "Reviewer feedback imported from Azure DevOps.";
}

export function toThreadExport(thread) {
  return {
    id: thread.id,
    status: thread.status || "unknown",
    isDeleted: Boolean(thread.isDeleted),
    filePath: thread.filePath || "",
    lineStart: Number.isInteger(thread.lineStart) ? thread.lineStart : null,
    lineEnd: Number.isInteger(thread.lineEnd) ? thread.lineEnd : null,
    publishedDate: thread.publishedDate || null,
    lastUpdatedDate: thread.lastUpdatedDate || null,
    comments: (thread.comments || []).map((comment) => ({
      id: comment.id,
      parentCommentId: comment.parentCommentId ?? 0,
      content: comment.content || "",
      publishedDate: comment.publishedDate || null,
      lastUpdatedDate: comment.lastUpdatedDate || null,
      commentType: comment.commentType || "text",
      author: {
        id: comment.author?.id || "",
        displayName: comment.author?.displayName || "",
        uniqueName: comment.author?.uniqueName || "",
      },
    })),
  };
}

export function buildPrExportDir(rootPath, summary) {
  return path.join(
    rootPath,
    "exports",
    safeSegment(summary.provider || "azure-devops"),
    safeSegment(summary.connectionId || "connection"),
    safeSegment(summary.repository?.id || summary.repository?.name || "repository"),
    `pr-${safeSegment(summary.pullRequest?.id || "unknown")}`,
  );
}

export function buildCommentStatus(thread, existingStatus) {
  if (!isActiveThread(thread)) {
    return "dismissed";
  }
  if (COMMENT_STATUSES_TO_PRESERVE.has(existingStatus)) {
    return existingStatus;
  }
  return existingStatus || "ready-for-agent";
}

export function buildLocalCommentTitle(body, fallback = "Local review comment") {
  const firstLine = String(body || "")
    .split(/\r?\n/u)
    .map((line) => collapseText(line))
    .find(Boolean);
  return firstLine || fallback;
}

export function buildLocalCommentSummary(body) {
  return collapseText(body || "") || "Local follow-up question for this pull request.";
}

function buildThreadMarkdown(thread) {
  const headerParts = [
    `Thread #${thread.id}`,
    thread.status ? `[${thread.status}]` : "",
    thread.filePath ? `${thread.filePath}${thread.lineStart ? `:${thread.lineStart}` : ""}` : "",
  ].filter(Boolean);
  const body = (thread.comments || [])
    .map((comment) => {
      const author = firstNonEmpty(comment.author?.displayName, comment.author?.uniqueName, "Unknown author");
      const publishedAt = comment.lastUpdatedDate || comment.publishedDate || "";
      return `- ${author}${publishedAt ? ` (${publishedAt})` : ""}: ${collapseText(comment.content || "") || "(empty)"}`;
    })
    .join("\n");
  return `## ${headerParts.join(" ")}\n${body || "- No comments"}\n`;
}

export function buildBriefMarkdown(context) {
  const activeComments = context.comments.filter((comment) => comment.status !== "dismissed");
  const lines = [
    "# Review Brief",
    "",
    "Read comments here, prepare draft responses, and let the review bridge publish approved replies.",
    "When asked to process review comments, inspect the matching thread and changed files, then save or refine drafts only.",
    "",
    `- Provider: ${context.provider}`,
    `- PR Key: ${context.prKey}`,
    `- PR: #${context.pullRequest.id} ${context.pullRequest.title}`,
    `- Repository: ${context.repository.name || context.repository.id}`,
    `- Source -> Target: ${context.pullRequest.sourceRefName} -> ${context.pullRequest.targetRefName}`,
    `- Last Imported: ${context.lastImportedAt || ""}`,
    "",
    "## Active Comments",
  ];

  if (!activeComments.length) {
    lines.push("", "No active review comments.");
  } else {
    for (const comment of activeComments) {
      lines.push(
        "",
        `- ${comment.commentKey}`,
        `  Type: ${comment.commentKind || "answer-question"}`,
        `  Status: ${comment.status}`,
        `  Title: ${comment.title}`,
        `  Summary: ${comment.summary || ""}`,
      );
      if (
        (comment.commentKind === "draft" || comment.commentKind === "local-comment") &&
        comment.payload?.questionBody
      ) {
        lines.push(`  Body: ${collapseText(comment.payload.questionBody)}`);
      }
    }
  }

  lines.push("", "## Threads", "");
  if (!context.threads.length) {
    lines.push("No review threads imported.");
  } else {
    for (const thread of context.threads) {
      lines.push(buildThreadMarkdown(thread));
    }
  }

  lines.push("", "## Changed Files", "");
  if (!context.changedFiles.length) {
    lines.push("No Azure diff metadata imported yet.");
  } else {
    for (const file of context.changedFiles) {
      lines.push(`- ${file.changeType || "edit"} ${file.path || ""}`.trim());
    }
  }

  lines.push("", "## Local Changed Files", "");
  if (!context.localChangedFiles.length) {
    lines.push("No local changes detected.");
  } else {
    for (const file of context.localChangedFiles) {
      lines.push(`- ${file.changeType || "?"} ${file.path || ""}`.trim());
    }
  }

  return `${lines
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

export function buildThreadsMarkdown(context) {
  if (!context.threads.length) {
    return "# Threads\n\nNo review threads imported.\n";
  }
  return `# Threads\n\n${context.threads.map((thread) => buildThreadMarkdown(thread)).join("\n")}`;
}

export function buildDraftsMarkdown(context) {
  const lines = ["# Draft Responses", ""];
  if (!context.drafts.length) {
    lines.push("No draft responses yet.");
  } else {
    for (const draft of context.drafts) {
      lines.push(
        `## ${draft.draftId}`,
        "",
        `- Comment: ${draft.commentKey}`,
        `- Status: ${draft.status}`,
        `- Author: ${draft.authorAgent || ""}`,
        "",
        draft.body || "",
        "",
      );
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

export function buildSyncStatusMarkdown(context) {
  const lines = [
    "# Sync Status",
    "",
    `- Last Imported: ${context.lastImportedAt || ""}`,
    `- Last Seen Activity: ${context.lastSeenActivityAt || ""}`,
    "",
  ];
  if (!context.syncQueue.length) {
    lines.push("No pending sync operations.");
  } else {
    for (const item of context.syncQueue) {
      lines.push(`- ${item.queueId}: ${item.operation} [${item.status}]`);
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

export function buildAgentInstructions(context) {
  return {
    purpose:
      "Read review comments, prepare draft answers, create follow-up draft comments when needed, and never call Azure DevOps directly.",
    mcp: {
      mode: "embedded-review-tab",
      tools: [
        "list_review_comments",
        "get_review_comment",
        "create_review_comment",
        "save_review_draft",
        "queue_review_draft",
      ],
    },
    whenAskedToProcessQuestions: [
      "If the agent is running in a review tab, start with the embedded MCP tools rather than raw SQL or ad-hoc files.",
      "Open the review brief markdown or json for the active PR when you need extra narrative context.",
      "Read active comments with status ready-for-agent, agent-working, draft-ready, or ready-to-sync.",
      "Inspect the matching review thread and changed files before drafting an answer.",
      "If a follow-up is needed and no imported comment exists for it, create a draft comment in the bridge. Always provide filePath and lineNumber so the comment is anchored to the code. Create one comment per finding — never combine multiple findings into a single comment.",
      "Prepare or refine a draft response for each active comment.",
      "Do not post to Azure DevOps directly; save drafts to the bridge and queue them for publishing.",
      "Queue a draft for sync only when the response is ready for review or publishing.",
    ],
    naturalPrompts: [
      "zpracuj review otazky",
      "ukaz prvni otazku",
      "co si myslis o druhe otazce",
      "navrhni odpoved na treti otazku a uloz draft",
      "zaloz novou lokalni otazku k edge case",
    ],
    files: {
      briefMarkdown: context.briefMarkdownPath,
      briefJson: context.briefJsonPath,
      threadsMarkdown: context.threadsMarkdownPath,
      draftsMarkdown: context.draftsMarkdownPath,
      syncStatusMarkdown: context.syncStatusMarkdownPath,
      database: context.databasePath,
      cli: context.cliPath || "",
    },
    env: {
      STRIDETERM_REVIEW_PROVIDER: context.provider || "azure-devops",
      STRIDETERM_REVIEW_PR_KEY: context.prKey,
      STRIDETERM_REVIEW_ROOT: context.rootPath,
      STRIDETERM_REVIEW_DB: context.databasePath,
      STRIDETERM_REVIEW_STORE_DIR: context.exportDir,
      STRIDETERM_REVIEW_EXPORT_DIR: context.exportDir,
      STRIDETERM_REVIEW_BRIEF_MD: context.briefMarkdownPath,
      STRIDETERM_REVIEW_BRIEF_JSON: context.briefJsonPath,
      STRIDETERM_REVIEW_CLI: context.cliPath || "",
    },
  };
}
