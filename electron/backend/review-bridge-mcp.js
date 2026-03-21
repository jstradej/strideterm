import fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createReviewBridgeStore } from "./review-bridge-store.js";

function readContextOrThrow(store, prKey) {
  const context = store.getPullRequestContext?.(prKey);
  if (!context) {
    throw new Error(`Review bridge context was not found for ${prKey}.`);
  }
  return context;
}

function serializeComment(comment) {
  return {
    index: comment.displayIndex || 0,
    commentKey: comment.commentKey,
    commentKind: comment.commentKind || "answer-question",
    status: comment.status || "ready-for-agent",
    priority: comment.priority || "medium",
    title: comment.title || "",
    summary: comment.summary || "",
    remoteThreadId: Number.isInteger(comment.remoteThreadId) ? comment.remoteThreadId : null,
    payload: comment.payload || {},
  };
}

function serializeDraft(draft) {
  return {
    draftId: draft.draftId,
    commentKey: draft.commentKey,
    status: draft.status || "draft",
    authorAgent: draft.authorAgent || "",
    body: draft.body || "",
    needsHumanApproval: Boolean(draft.needsHumanApproval),
    confidence: draft.confidence ?? null,
    updatedAt: draft.updatedAt || null,
  };
}

function getActiveComments(context) {
  return (context.comments || []).filter((comment) => comment.status !== "dismissed");
}

function formatCommentList(context) {
  const draftsMap = new Map((context.drafts || []).map((d) => [d.commentKey, d]));
  const activeComments = getActiveComments(context)
    .map((comment) => serializeComment(comment));

  if (!activeComments.length) {
    return {
      text: `No active review comments are available for ${context.prKey}.`,
      comments: [],
    };
  }

  const text = [
    `Active review comments for ${context.prKey}:`,
    ...activeComments.map((comment) => {
      const parts = [
        `#${comment.index}.`,
        comment.title || comment.commentKey,
        `[${comment.commentKind}]`,
        `[${comment.status}]`,
      ];
      if (comment.remoteThreadId != null) {
        parts.push(`thread ${comment.remoteThreadId}`);
      }
      if (comment.summary) {
        parts.push(`- ${comment.summary}`);
      }
      const draft = draftsMap.get(comment.commentKey);
      if (draft) {
        const preview = String(draft.body || "").replace(/\s+/gu, " ").trim();
        parts.push(`| DRAFT (${draft.status}): ${preview.length > 120 ? preview.slice(0, 120) + "..." : preview}`);
      }
      return parts.join(" ");
    }),
  ].join("\n");

  return { text, comments: activeComments };
}

function resolveComment(context, { index = null, commentKey = "" } = {}) {
  const activeComments = getActiveComments(context);
  if (commentKey) {
    const comment = activeComments.find((entry) => entry.commentKey === commentKey) || null;
    if (!comment) {
      throw new Error(`Review comment ${commentKey} was not found.`);
    }
    return { comment };
  }

  const commentIndex = Number(index);
  const comment = activeComments.find((entry) => entry.displayIndex === commentIndex);
  if (!comment) {
    throw new Error(`Review comment #${index} was not found.`);
  }
  return { comment };
}

function formatCommentDetail(context, selection) {
  const comment = serializeComment(selection.comment);
  const thread = comment.remoteThreadId != null
    ? context.threads.find((entry) => entry.id === comment.remoteThreadId) || null
    : null;
  const latestDraft = context.drafts.find((entry) => entry.commentKey === comment.commentKey) || null;

  const lines = [
    `Comment #${comment.index}: ${comment.title || comment.commentKey}`,
    `- Kind: ${comment.commentKind}`,
    `- Status: ${comment.status}`,
    `- Priority: ${comment.priority}`,
  ];
  if (comment.remoteThreadId != null) {
    lines.push(`- Remote thread: ${comment.remoteThreadId}`);
  }
  if (comment.summary) {
    lines.push(`- Summary: ${comment.summary}`);
  }
  if (comment.payload?.questionBody) {
    lines.push(`- Local question: ${comment.payload.questionBody}`);
  }
  if (thread) {
    lines.push(`- Thread status: ${thread.status}`);
    if (thread.filePath) {
      lines.push(`- File: ${thread.filePath}${thread.lineStart ? `:${thread.lineStart}` : ""}`);
    }
    if (thread.comments?.length) {
      lines.push("- Replies:");
      for (const reply of thread.comments) {
        const author = reply.author?.displayName || reply.author?.uniqueName || "Unknown author";
        lines.push(`  - ${author}: ${String(reply.content || "").replace(/\s+/gu, " ").trim() || "(empty)"}`);
      }
    }
  }
  if (latestDraft) {
    lines.push(`- Latest draft status: ${latestDraft.status}`);
  }

  return {
    text: lines.join("\n"),
    comment,
    thread,
    latestDraft: latestDraft ? serializeDraft(latestDraft) : null,
  };
}

function toolResult(text, structuredContent) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent,
  };
}

export function createReviewBridgeMcpHandlers({ store, prKey }) {
  return {
    listReviewComments() {
      const context = readContextOrThrow(store, prKey);
      const { text, comments } = formatCommentList(context);
      return toolResult(text, {
        prKey: context.prKey,
        comments,
      });
    },
    getReviewComment({ index = null, commentKey = "" } = {}) {
      const context = readContextOrThrow(store, prKey);
      const selection = resolveComment(context, { index, commentKey });
      const detail = formatCommentDetail(context, selection);
      return toolResult(detail.text, {
        prKey: context.prKey,
        ...detail,
      });
    },
    async createDraftComment({ body, title = "", filePath = "", lineNumber = null, priority = "medium", authorAgent = "" }) {
      const context = await store.createDraftComment({
        prKey,
        body,
        title,
        filePath,
        lineNumber,
        priority,
        authorAgent,
        autoQueue: true,
      });
      const latestComment = [...(context?.comments || [])]
        .filter((comment) => (comment.commentKind === "draft" || comment.commentKind === "local-comment") && comment.payload?.questionBody === body)
        .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0))[0] || null;
      const comment = latestComment && latestComment.displayIndex ? serializeComment(latestComment) : null;
      const latestDraft = comment ? (context?.drafts || []).find((d) => d.commentKey === latestComment.commentKey) || null : null;
      return toolResult(
        comment
          ? `Created draft comment ${comment.index}. ${comment.title}`
          : "Created draft comment.",
        {
          prKey,
          comment,
          draft: latestDraft ? serializeDraft(latestDraft) : null,
        },
      );
    },
    async saveReviewDraft({
      index = null,
      commentKey = "",
      body,
      authorAgent = "",
      confidence = null,
      needsHumanApproval = true,
    }) {
      const baseContext = readContextOrThrow(store, prKey);
      const selection = resolveComment(baseContext, { index, commentKey });
      const context = await store.saveDraftResponse({
        prKey,
        commentKey: selection.comment.commentKey,
        body,
        authorAgent,
        confidence,
        needsHumanApproval,
      });
      const latestDraft = context?.drafts.find((entry) => entry.commentKey === selection.comment.commentKey) || null;
      return toolResult(
        `Saved draft for comment ${selection.comment.displayIndex}.`,
        {
          prKey,
          comment: serializeComment(selection.comment),
          draft: latestDraft ? serializeDraft(latestDraft) : null,
        },
      );
    },
    async queueReviewDraft({ index = null, commentKey = "" }) {
      const contextBefore = readContextOrThrow(store, prKey);
      const selection = resolveComment(contextBefore, { index, commentKey });
      const context = await store.queueDraftResponse({
        prKey,
        commentKey: selection.comment.commentKey,
      });
      const latestDraft = context?.drafts.find((entry) => entry.commentKey === selection.comment.commentKey) || null;
      return toolResult(
        `Queued draft for comment ${selection.comment.displayIndex}.`,
        {
          prKey,
          comment: serializeComment(selection.comment),
          draft: latestDraft ? serializeDraft(latestDraft) : null,
        },
      );
    },
    async replyWithCodeChanges({ index = null, commentKey = "", body = "", authorAgent = "" }) {
      const baseContext = readContextOrThrow(store, prKey);
      const selection = resolveComment(baseContext, { index, commentKey });
      const context = await store.replyWithCodeChanges({
        prKey,
        commentKey: selection.comment.commentKey,
        body,
        authorAgent,
        autoQueue: true,
      });
      const latestDraft = context?.drafts.find((entry) => entry.commentKey === selection.comment.commentKey) || null;
      return toolResult(
        `Queued reply for comment #${selection.comment.displayIndex}: ${body}`,
        {
          prKey,
          comment: serializeComment(selection.comment),
          draft: latestDraft ? serializeDraft(latestDraft) : null,
          hasCodeChanges: true,
        },
      );
    },
  };
}

export function parseReviewBridgeMcpArgs(argv = process.argv.slice(1)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  if (!args.includes("--review-bridge-mcp")) {
    return null;
  }

  function readFlag(flag) {
    const index = args.indexOf(flag);
    if (index < 0 || index + 1 >= args.length) {
      return "";
    }
    return String(args[index + 1] || "").trim();
  }

  return {
    rootPath: readFlag("--review-root"),
    prKey: readFlag("--review-pr-key"),
  };
}

export async function runReviewBridgeMcpServer({ rootPath, prKey }) {
  if (!rootPath) {
    throw new Error("Missing --review-root for review bridge MCP mode.");
  }
  if (!prKey) {
    throw new Error("Missing --review-pr-key for review bridge MCP mode.");
  }

  const store = await createReviewBridgeStore(rootPath);
  const handlers = createReviewBridgeMcpHandlers({ store, prKey });
  const server = new McpServer({
    name: "strideterm-review-bridge",
    version: "1.0.0",
  });

  server.registerResource("review-brief", "review://brief", {
    title: "Review Brief",
    description: "Current PR review brief exported by strIDEterm.",
    mimeType: "text/markdown",
  }, async () => {
    const context = readContextOrThrow(store, prKey);
    const text = await fs.readFile(context.briefMarkdownPath, "utf8").catch(() => "");
    return {
      contents: [
        {
          uri: "review://brief",
          text,
        },
      ],
    };
  });

  server.registerPrompt("process-review-comments", {
    title: "Process Review Comments",
    description: "Guide the agent to process review comments in order with the review bridge tools.",
  }, async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `Review the PR comments for ${prKey}.`,
            "1. Start with list_review_comments to see all comment threads and their current status.",
            "2. For each comment that needs attention (status: ready-for-agent), use get_review_comment to read the full thread with code context.",
            "3. Write thoughtful draft replies with save_review_draft. Focus on actionable, specific feedback.",
            "4. If you discover issues not covered by existing comments, create new ones with create_review_comment.",
            "5. When your drafts are ready for the user to review, queue them with queue_review_draft.",
            "Do not publish to Azure DevOps directly — the user controls when drafts are published.",
          ].join("\n"),
        },
      },
    ],
  }));

  server.registerTool("list_review_comments", {
    title: "List Review Comments",
    description: "List all review comment threads for the current PR with their status, priority, and draft previews. Each comment has a stable #N index you can reference in other tools. Start here to see what needs your attention.",
  }, async () => handlers.listReviewComments());

  server.registerTool("get_review_comment", {
    title: "Get Review Comment",
    description: "Get full details for a specific review comment by its #N index or key. Returns the comment thread with all replies, file context, code snippet, and your current draft if one exists. Use the index number shown in list_review_comments.",
    inputSchema: {
      index: z.number().int().positive().optional().describe("1-based comment index from list_review_comments."),
      commentKey: z.string().optional().describe("Exact comment key when you already know it."),
    },
  }, async (input) => handlers.getReviewComment(input));

  server.registerTool("create_review_comment", {
    title: "Create Local Comment",
    description: "Create a new local comment with an auto-created draft for follow-up questions or observations. The draft can be edited and queued for publishing to Azure DevOps. Use this when you discover something worth noting that isn't covered by existing threads. IMPORTANT: Create one comment per finding — do not combine multiple findings into a single comment. Always provide filePath and lineNumber so the comment is anchored to the right location in the code.",
    inputSchema: {
      body: z.string().min(1).describe("Body of the new local comment."),
      title: z.string().optional().describe("Optional short title for the comment."),
      filePath: z.string().optional().describe("Relative file path the comment refers to, e.g. 'src/app/service.cs'. Always provide this for file-specific comments."),
      lineNumber: z.number().int().positive().optional().describe("Line number in the file the comment refers to."),
      priority: z.enum(["low", "medium", "high"]).optional().describe("Priority for the local comment."),
      authorAgent: z.string().optional().describe("Agent label such as claude or codex."),
    },
  }, async (input) => handlers.createDraftComment(input));

  server.registerTool("save_review_draft", {
    title: "Save Review Draft",
    description: "Save or replace a local draft reply for a review comment. The draft stays local until explicitly queued and published. Use the #N index from list_review_comments to specify which comment to reply to. The user can review, edit, or delete your draft before publishing.",
    inputSchema: {
      index: z.number().int().positive().optional().describe("1-based comment index from list_review_comments."),
      commentKey: z.string().optional().describe("Exact comment key when you already know it."),
      body: z.string().min(1).describe("Draft reply body to store locally."),
      authorAgent: z.string().optional().describe("Agent label such as claude or codex."),
      confidence: z.number().min(0).max(1).optional().describe("Optional confidence score from 0 to 1."),
      needsHumanApproval: z.boolean().optional().describe("Whether the draft still needs a human review before sync."),
    },
  }, async (input) => handlers.saveReviewDraft(input));

  server.registerTool("queue_review_draft", {
    title: "Queue Review Draft",
    description: "Queue a saved draft for publishing to Azure DevOps. Once queued, the user can publish it with the 'Publish queued drafts' button in the UI. Only queue drafts that are ready — the user can also queue them manually.",
    inputSchema: {
      index: z.number().int().positive().optional().describe("1-based comment index from list_review_comments."),
      commentKey: z.string().optional().describe("Exact comment key when you already know it."),
    },
  }, async (input) => handlers.queueReviewDraft(input));

  server.registerTool("reply_with_code_changes", {
    title: "Reply to Review Comment After Code Changes",
    description: "Reply to a review comment after you have made code changes that address it. "
      + "Write your reply as you would respond to the reviewer — e.g. "
      + "'Good catch. Added a null guard in parseInput() and a test case for null input.' "
      + "This creates a queued reply that will be published to Azure DevOps when the user pushes. "
      + "You do NOT need to call save_review_draft or queue_review_draft separately — this tool handles both. "
      + "Only call this when you actually changed code for this comment. "
      + "For text-only replies without code changes, use save_review_draft instead.",
    inputSchema: {
      index: z.number().int().positive().optional().describe("1-based comment index from list_review_comments."),
      commentKey: z.string().optional().describe("Exact comment key when you already know it."),
      body: z.string().min(1).describe(
        "Your reply to the reviewer. This is the full text that will appear on the Azure DevOps thread. "
        + "Describe what you changed and why. Write naturally as a response to the reviewer's comment.",
      ),
      authorAgent: z.string().optional().describe("Agent label such as claude or codex."),
    },
  }, async (input) => handlers.replyWithCodeChanges(input));

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
    await new Promise((resolve, reject) => {
      process.stdin.on("end", resolve);
      process.stdin.on("close", resolve);
      process.stdin.on("error", reject);
    });
  } finally {
    await server.close().catch(() => {});
    if (typeof store.close === "function") {
      await store.close().catch(() => {});
    }
  }
}
