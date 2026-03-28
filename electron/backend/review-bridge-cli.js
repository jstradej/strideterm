import fs from "node:fs/promises";
import path from "node:path";
import { createReviewBridgeStore } from "./review-bridge-store.js";

function printHelp() {
  console.log(`review-bridge-cli

Usage:
  node review-bridge-cli.js comments [--pr-key <key>] [--json]
  node review-bridge-cli.js show-comment (--index <n> | --comment-key <key>) [--pr-key <key>] [--json]
  node review-bridge-cli.js create-comment (--body <text> | --body-file <path>) [--title <text>] [--priority <level>] [--author-agent <name>] [--pr-key <key>]
  node review-bridge-cli.js save-draft (--index <n> | --comment-key <key>) (--body <text> | --body-file <path>) [--author-agent <name>] [--pr-key <key>]
  node review-bridge-cli.js queue-draft (--index <n> | --comment-key <key>) [--pr-key <key>]

Environment fallback:
  STRIDETERM_REVIEW_PR_KEY
  STRIDETERM_REVIEW_ROOT
  STRIDETERM_REVIEW_DB
  STRIDETERM_REVIEW_BRIEF_MD
  STRIDETERM_REVIEW_BRIEF_JSON
`);
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }

  return { command, options };
}

function deriveRootPath(options) {
  const explicit = String(options.root || process.env.STRIDETERM_REVIEW_ROOT || "").trim();
  if (explicit) {
    return explicit;
  }

  const databasePath = String(options.db || process.env.STRIDETERM_REVIEW_DB || "").trim();
  if (databasePath) {
    return path.dirname(databasePath);
  }

  throw new Error("Review bridge root path was not provided. Set STRIDETERM_REVIEW_ROOT or STRIDETERM_REVIEW_DB.");
}

function derivePrKey(options) {
  const prKey = String(options["pr-key"] || process.env.STRIDETERM_REVIEW_PR_KEY || "").trim();
  if (!prKey) {
    throw new Error("Pull request key was not provided. Use --pr-key or STRIDETERM_REVIEW_PR_KEY.");
  }
  return prKey;
}

function selectComment(context, options) {
  const comments = context.comments || [];
  const commentKey = String(options["comment-key"] || "").trim();
  if (commentKey) {
    const comment = comments.find((entry) => entry.commentKey === commentKey);
    if (!comment) {
      throw new Error(`Comment '${commentKey}' was not found.`);
    }
    return { comment, index: comments.indexOf(comment) + 1 };
  }

  const indexValue = Number.parseInt(String(options.index || ""), 10);
  if (!Number.isInteger(indexValue) || indexValue < 1 || indexValue > comments.length) {
    throw new Error(`Comment index is required and must be between 1 and ${comments.length || 1}.`);
  }
  return { comment: comments[indexValue - 1], index: indexValue };
}

function buildCommentDetail(context, comment) {
  const threadId = comment.remoteThreadId ?? comment.payload?.threadId ?? null;
  const thread =
    threadId == null ? null : (context.threads || []).find((entry) => Number(entry.id) === Number(threadId)) || null;
  const drafts = (context.drafts || []).filter((entry) => entry.commentKey === comment.commentKey);

  return {
    comment,
    drafts,
    thread: thread
      ? {
          id: thread.id,
          status: thread.status,
          filePath: thread.filePath,
          lineStart: thread.lineStart,
          lineEnd: thread.lineEnd,
          replies: (thread.comments || []).map((reply) => ({
            id: reply.id,
            author: reply.author?.displayName || "Unknown author",
            content: reply.content || "",
          })),
        }
      : null,
  };
}

function printComments(context, asJson = false) {
  const comments = (context.comments || []).map((comment, index) => ({
    index: index + 1,
    commentKey: comment.commentKey,
    commentKind: comment.commentKind,
    title: comment.title,
    status: comment.status,
    priority: comment.priority,
    summary: comment.summary,
  }));

  if (asJson) {
    console.log(JSON.stringify({ prKey: context.prKey, comments }, null, 2));
    return;
  }

  if (!comments.length) {
    console.log("No comments found.");
    return;
  }

  for (const comment of comments) {
    console.log(
      `${comment.index}. ${comment.title} [${comment.status}] (${comment.priority}) {${comment.commentKind}}`,
    );
    console.log(`   ${comment.commentKey}`);
    if (comment.summary) {
      console.log(`   ${comment.summary}`);
    }
  }
}

async function readBody(options) {
  if (typeof options.body === "string") {
    return options.body;
  }
  if (typeof options["body-file"] === "string") {
    return fs.readFile(path.resolve(options["body-file"]), "utf8");
  }
  throw new Error("Draft body is required. Use --body or --body-file.");
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const rootPath = deriveRootPath(options);
  const prKey = derivePrKey(options);
  const store = await createReviewBridgeStore(rootPath);

  try {
    const context = store.getPullRequestContext(prKey);
    if (!context) {
      throw new Error(`Pull request context '${prKey}' was not found.`);
    }

    if (command === "comments") {
      printComments(context, Boolean(options.json));
      return;
    }

    if (command === "show-comment") {
      const { comment, index } = selectComment(context, options);
      const detail = {
        prKey,
        index,
        ...buildCommentDetail(context, comment),
      };
      if (options.json) {
        console.log(JSON.stringify(detail, null, 2));
      } else {
        console.log(`${index}. ${comment.title}`);
        console.log(`Comment key: ${comment.commentKey}`);
        console.log(`Type: ${comment.commentKind}`);
        console.log(`Status: ${comment.status}`);
        console.log(`Priority: ${comment.priority}`);
        console.log(`Summary: ${comment.summary || ""}`);
        if (comment.commentKind === "local-comment" && comment.payload?.questionBody) {
          console.log(`Body: ${comment.payload.questionBody}`);
        }
        if (detail.thread) {
          console.log(`Thread: #${detail.thread.id} ${detail.thread.filePath || ""}`.trim());
          for (const reply of detail.thread.replies) {
            console.log(`- ${reply.author}: ${reply.content}`);
          }
        }
        if (detail.drafts.length) {
          console.log("Drafts:");
          for (const draft of detail.drafts) {
            console.log(`- ${draft.status} ${draft.draftId}`);
          }
        }
      }
      return;
    }

    if (command === "save-draft") {
      const { comment, index } = selectComment(context, options);
      const body = await readBody(options);
      const nextContext = await store.saveDraftResponse({
        prKey,
        commentKey: comment.commentKey,
        body,
        authorAgent: String(options["author-agent"] || process.env.USER || process.env.USERNAME || "agent"),
      });
      const draft = (nextContext?.drafts || []).find((entry) => entry.commentKey === comment.commentKey);
      console.log(
        JSON.stringify(
          {
            ok: true,
            prKey,
            index,
            commentKey: comment.commentKey,
            draftId: draft?.draftId || null,
            status: draft?.status || "draft",
          },
          null,
          2,
        ),
      );
      return;
    }

    if (command === "create-comment") {
      const body = await readBody(options);
      const nextContext = await store.createDraftComment({
        prKey,
        body,
        title: String(options.title || ""),
        priority: String(options.priority || "medium"),
        authorAgent: String(options["author-agent"] || process.env.USER || process.env.USERNAME || "agent"),
      });
      const createdComment = [...(nextContext?.comments || [])]
        .filter((entry) => entry.commentKind === "draft" || entry.commentKind === "local-comment")
        .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))[0];
      console.log(
        JSON.stringify(
          {
            ok: true,
            prKey,
            commentKey: createdComment?.commentKey || null,
            title: createdComment?.title || null,
            status: createdComment?.status || "ready-for-agent",
          },
          null,
          2,
        ),
      );
      return;
    }

    if (command === "queue-draft") {
      const { comment, index } = selectComment(context, options);
      const nextContext = await store.queueDraftResponse({
        prKey,
        commentKey: comment.commentKey,
      });
      const queueItem = (nextContext?.syncQueue || []).find((entry) => entry.commentKey === comment.commentKey) || null;
      console.log(
        JSON.stringify(
          {
            ok: true,
            prKey,
            index,
            commentKey: comment.commentKey,
            queueId: queueItem?.queueId || null,
            status: queueItem?.status || "pending",
          },
          null,
          2,
        ),
      );
      return;
    }

    throw new Error(`Unknown command '${command}'.`);
  } finally {
    await store.close?.();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
