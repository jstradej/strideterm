import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildAgentInstructions,
  buildBriefMarkdown,
  buildDraftsMarkdown,
  buildLocalCommentSummary,
  buildLocalCommentTitle,
  buildPrExportDir,
  buildSyncStatusMarkdown,
  buildCommentStatus,
  buildCommentSummary,
  buildCommentTitle,
  buildThreadsMarkdown,
  collapseText,
  firstNonEmpty,
  isActiveThread,
  toThreadExport,
} from "./review-bridge-format.js";

function toJson(value) {
  return JSON.stringify(value ?? null);
}

function fromJson(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function createReviewBridgeStore(rootPath) {
  const normalizedRoot = path.resolve(rootPath);
  await fs.mkdir(normalizedRoot, { recursive: true });
  await fs.mkdir(path.join(normalizedRoot, "exports"), { recursive: true });
  await fs.mkdir(path.join(normalizedRoot, "logs"), { recursive: true });

  const databasePath = path.join(normalizedRoot, "review-bridge.db");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS pull_requests (
      pr_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      workspace_id TEXT DEFAULT '',
      review_workspace_id TEXT DEFAULT '',
      repository_id TEXT NOT NULL,
      repository_name TEXT DEFAULT '',
      project_id TEXT DEFAULT '',
      project_name TEXT DEFAULT '',
      pull_request_id INTEGER NOT NULL,
      title TEXT DEFAULT '',
      source_ref TEXT DEFAULT '',
      target_ref TEXT DEFAULT '',
      status TEXT DEFAULT '',
      role TEXT DEFAULT '',
      remote_updated_at TEXT DEFAULT NULL,
      last_seen_activity_at TEXT DEFAULT NULL,
      last_imported_at TEXT DEFAULT NULL,
      export_dir TEXT DEFAULT '',
      changed_files_json TEXT DEFAULT '[]',
      local_changed_files_json TEXT DEFAULT '[]',
      payload_json TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS review_threads (
      pr_key TEXT NOT NULL,
      remote_thread_id INTEGER NOT NULL,
      status TEXT DEFAULT '',
      is_deleted INTEGER DEFAULT 0,
      file_path TEXT DEFAULT '',
      line_start INTEGER DEFAULT NULL,
      line_end INTEGER DEFAULT NULL,
      published_at TEXT DEFAULT NULL,
      updated_at TEXT DEFAULT NULL,
      payload_json TEXT DEFAULT '{}',
      PRIMARY KEY (pr_key, remote_thread_id)
    );

    CREATE TABLE IF NOT EXISTS review_comments (
      comment_key TEXT PRIMARY KEY,
      pr_key TEXT NOT NULL,
      remote_thread_id INTEGER DEFAULT NULL,
      comment_kind TEXT DEFAULT 'answer-question',
      display_index INTEGER DEFAULT NULL,
      title TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      status TEXT DEFAULT 'ready-for-agent',
      priority TEXT DEFAULT 'medium',
      assigned_agent TEXT DEFAULT '',
      last_remote_hash TEXT DEFAULT '',
      last_local_hash TEXT DEFAULT '',
      created_at TEXT DEFAULT NULL,
      updated_at TEXT DEFAULT NULL,
      payload_json TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS draft_responses (
      draft_id TEXT PRIMARY KEY,
      comment_key TEXT NOT NULL,
      pr_key TEXT NOT NULL,
      body TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      author_agent TEXT DEFAULT '',
      confidence REAL DEFAULT NULL,
      needs_human_approval INTEGER DEFAULT 1,
      created_at TEXT DEFAULT NULL,
      updated_at TEXT DEFAULT NULL,
      payload_json TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS agent_notes (
      note_id TEXT PRIMARY KEY,
      comment_key TEXT DEFAULT '',
      pr_key TEXT NOT NULL,
      author_agent TEXT DEFAULT '',
      body TEXT DEFAULT '',
      created_at TEXT DEFAULT NULL,
      updated_at TEXT DEFAULT NULL,
      payload_json TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS agent_prompts (
      prompt_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      template TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      queue_id TEXT PRIMARY KEY,
      pr_key TEXT NOT NULL,
      comment_key TEXT DEFAULT '',
      operation TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_error TEXT DEFAULT '',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT NULL,
      updated_at TEXT DEFAULT NULL
    );
  `);

  // Migration: detect old schema (review_tasks exists) and rename tables accordingly
  // If review_tasks exists, the old review_comments table holds thread comments and
  // must be renamed to thread_comments before review_tasks becomes review_comments.
  try {
    db.prepare("SELECT 1 FROM review_tasks LIMIT 0").get();
    // Old schema detected — rename thread-level review_comments → thread_comments
    try {
      db.exec("ALTER TABLE review_comments RENAME TO thread_comments");
    } catch {
      // Table already renamed or doesn't exist
    }
    // Rename review_tasks → review_comments
    try {
      db.exec("ALTER TABLE review_tasks RENAME TO review_comments");
    } catch {
      // Table already renamed or doesn't exist
    }
  } catch {
    // review_tasks doesn't exist — either fresh DB or already migrated
  }

  // Ensure thread_comments table exists (for fresh DBs where there was nothing to rename)
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_comments (
      pr_key TEXT NOT NULL,
      remote_thread_id INTEGER NOT NULL,
      remote_comment_id INTEGER NOT NULL,
      parent_remote_comment_id INTEGER DEFAULT 0,
      author_kind TEXT DEFAULT '',
      author_label TEXT DEFAULT '',
      body_markdown TEXT DEFAULT '',
      body_plain TEXT DEFAULT '',
      direction TEXT DEFAULT 'inbound',
      created_at TEXT DEFAULT NULL,
      updated_at TEXT DEFAULT NULL,
      payload_json TEXT DEFAULT '{}',
      PRIMARY KEY (pr_key, remote_thread_id, remote_comment_id)
    )
  `);

  // Migration: rename task_key → comment_key in review_comments
  try {
    db.exec("ALTER TABLE review_comments RENAME COLUMN task_key TO comment_key");
  } catch {
    // Column already renamed or doesn't exist
  }

  // Migration: rename task_kind → comment_kind in review_comments
  try {
    db.exec("ALTER TABLE review_comments RENAME COLUMN task_kind TO comment_kind");
  } catch {
    // Column already renamed or doesn't exist
  }

  // Migration: rename task_key → comment_key in draft_responses
  try {
    db.exec("ALTER TABLE draft_responses RENAME COLUMN task_key TO comment_key");
  } catch {
    // Column already renamed or doesn't exist
  }

  // Migration: rename task_key → comment_key in sync_queue
  try {
    db.exec("ALTER TABLE sync_queue RENAME COLUMN task_key TO comment_key");
  } catch {
    // Column already renamed or doesn't exist
  }

  // Migration: rename task_key → comment_key in agent_notes
  try {
    db.exec("ALTER TABLE agent_notes RENAME COLUMN task_key TO comment_key");
  } catch {
    // Column already renamed or doesn't exist
  }

  // Migration: add display_index column if missing (existing DBs)
  try {
    db.exec("ALTER TABLE review_comments ADD COLUMN display_index INTEGER DEFAULT NULL");
  } catch {
    // Column already exists
  }

  // Backfill display_index for existing rows that don't have one
  db.exec(`
    UPDATE review_comments SET display_index = (
      SELECT COUNT(*) FROM review_comments AS t2
      WHERE t2.pr_key = review_comments.pr_key
        AND t2.rowid <= review_comments.rowid
    ) WHERE display_index IS NULL
  `);

  let closed = false;
  let pending = Promise.resolve();

  const statements = {
    upsertPullRequest: db.prepare(`
      INSERT INTO pull_requests (
        pr_key, provider, connection_id, workspace_id, review_workspace_id, repository_id, repository_name,
        project_id, project_name, pull_request_id, title, source_ref, target_ref, status, role,
        remote_updated_at, last_seen_activity_at, last_imported_at, export_dir, changed_files_json,
        local_changed_files_json, payload_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(pr_key) DO UPDATE SET
        provider = excluded.provider,
        connection_id = excluded.connection_id,
        workspace_id = excluded.workspace_id,
        review_workspace_id = excluded.review_workspace_id,
        repository_id = excluded.repository_id,
        repository_name = excluded.repository_name,
        project_id = excluded.project_id,
        project_name = excluded.project_name,
        pull_request_id = excluded.pull_request_id,
        title = excluded.title,
        source_ref = excluded.source_ref,
        target_ref = excluded.target_ref,
        status = excluded.status,
        role = excluded.role,
        remote_updated_at = excluded.remote_updated_at,
        last_seen_activity_at = excluded.last_seen_activity_at,
        last_imported_at = excluded.last_imported_at,
        export_dir = excluded.export_dir,
        changed_files_json = excluded.changed_files_json,
        local_changed_files_json = excluded.local_changed_files_json,
        payload_json = excluded.payload_json
    `),
    deleteThreadsForPr: db.prepare("DELETE FROM review_threads WHERE pr_key = ?"),
    deleteThreadCommentsForPr: db.prepare("DELETE FROM thread_comments WHERE pr_key = ?"),
    insertThread: db.prepare(`
      INSERT INTO review_threads (
        pr_key, remote_thread_id, status, is_deleted, file_path, line_start, line_end, published_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertThreadComment: db.prepare(`
      INSERT INTO thread_comments (
        pr_key, remote_thread_id, remote_comment_id, parent_remote_comment_id, author_kind, author_label,
        body_markdown, body_plain, direction, created_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    selectCommentStatusesByPr: db.prepare(`
      SELECT comment_key, remote_thread_id, status FROM review_comments WHERE pr_key = ?
    `),
    selectCommentByKey: db.prepare(`
      SELECT * FROM review_comments WHERE comment_key = ?
    `),
    selectCommentByThread: db.prepare(`
      SELECT * FROM review_comments WHERE pr_key = ? AND remote_thread_id = ?
    `),
    upsertComment: db.prepare(`
      INSERT INTO review_comments (
        comment_key, pr_key, remote_thread_id, comment_kind, display_index, title, summary, status, priority, assigned_agent,
        last_remote_hash, last_local_hash, created_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(comment_key) DO UPDATE SET
        pr_key = excluded.pr_key,
        remote_thread_id = excluded.remote_thread_id,
        comment_kind = excluded.comment_kind,
        title = excluded.title,
        summary = excluded.summary,
        status = excluded.status,
        priority = excluded.priority,
        assigned_agent = COALESCE(NULLIF(review_comments.assigned_agent, ''), excluded.assigned_agent),
        last_remote_hash = excluded.last_remote_hash,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `),
    dismissAllCommentsForPr: db.prepare(`
      UPDATE review_comments
      SET status = 'dismissed', updated_at = ?
      WHERE pr_key = ? AND remote_thread_id IS NOT NULL
    `),
    markSeen: db.prepare(`
      UPDATE pull_requests
      SET last_seen_activity_at = ?
      WHERE pr_key = ?
    `),
    upsertDraft: db.prepare(`
      INSERT INTO draft_responses (
        draft_id, comment_key, pr_key, body, status, author_agent, confidence, needs_human_approval,
        created_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id) DO UPDATE SET
        comment_key = excluded.comment_key,
        pr_key = excluded.pr_key,
        body = excluded.body,
        status = excluded.status,
        author_agent = excluded.author_agent,
        confidence = excluded.confidence,
        needs_human_approval = excluded.needs_human_approval,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `),
    selectDraftById: db.prepare(`
      SELECT * FROM draft_responses WHERE draft_id = ?
    `),
    selectLatestDraftByComment: db.prepare(`
      SELECT * FROM draft_responses WHERE comment_key = ? ORDER BY updated_at DESC, draft_id DESC LIMIT 1
    `),
    upsertQueueItem: db.prepare(`
      INSERT INTO sync_queue (
        queue_id, pr_key, comment_key, operation, status, attempts, last_error, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(queue_id) DO UPDATE SET
        pr_key = excluded.pr_key,
        comment_key = excluded.comment_key,
        operation = excluded.operation,
        status = excluded.status,
        last_error = excluded.last_error,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `),
    selectPendingQueueByPr: db.prepare(`
      SELECT * FROM sync_queue
      WHERE pr_key = ? AND status IN ('pending', 'failed')
      ORDER BY created_at ASC, queue_id ASC
    `),
    updateQueueState: db.prepare(`
      UPDATE sync_queue
      SET status = ?, attempts = ?, last_error = ?, payload_json = ?, updated_at = ?
      WHERE queue_id = ?
    `),
    updateDraftState: db.prepare(`
      UPDATE draft_responses
      SET status = ?, updated_at = ?, payload_json = ?
      WHERE draft_id = ?
    `),
    updateCommentState: db.prepare(`
      UPDATE review_comments
      SET status = ?, updated_at = ?
      WHERE comment_key = ?
    `),
    deleteDraftById: db.prepare(`
      DELETE FROM draft_responses WHERE draft_id = ?
    `),
    deleteQueueByDraft: db.prepare(`
      DELETE FROM sync_queue WHERE payload_json LIKE ?
    `),
    deleteCommentByKey: db.prepare(`
      DELETE FROM review_comments WHERE comment_key = ?
    `),
    upsertAgentPrompt: db.prepare(`
      INSERT INTO agent_prompts (prompt_id, title, description, template, sort_order, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prompt_id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        template = excluded.template,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `),
    selectAllAgentPrompts: db.prepare(`
      SELECT * FROM agent_prompts ORDER BY sort_order ASC, created_at ASC
    `),
    deleteAgentPrompt: db.prepare(`
      DELETE FROM agent_prompts WHERE prompt_id = ?
    `),
    deleteAllAgentPrompts: db.prepare(`
      DELETE FROM agent_prompts
    `),
    deleteDraftsByComment: db.prepare(`
      DELETE FROM draft_responses WHERE comment_key = ?
    `),
    deleteQueueByComment: db.prepare(`
      DELETE FROM sync_queue WHERE comment_key = ?
    `),
    selectPullRequestContext: db.prepare(`
      SELECT * FROM pull_requests WHERE pr_key = ?
    `),
    selectThreadsForPr: db.prepare(`
      SELECT * FROM review_threads WHERE pr_key = ? ORDER BY COALESCE(updated_at, published_at, '') DESC, remote_thread_id DESC
    `),
    selectThreadCommentsForPr: db.prepare(`
      SELECT * FROM thread_comments WHERE pr_key = ? ORDER BY remote_thread_id ASC, created_at ASC, remote_comment_id ASC
    `),
    selectCommentsForPr: db.prepare(`
      SELECT * FROM review_comments WHERE pr_key = ? ORDER BY display_index ASC, created_at ASC, comment_key ASC
    `),
    nextDisplayIndex: db.prepare(`
      SELECT COALESCE(MAX(display_index), 0) + 1 AS next_index FROM review_comments WHERE pr_key = ?
    `),
    selectDraftsForPr: db.prepare(`
      SELECT * FROM draft_responses WHERE pr_key = ? ORDER BY updated_at DESC, draft_id DESC
    `),
    selectQueueForPr: db.prepare(`
      SELECT * FROM sync_queue WHERE pr_key = ? ORDER BY created_at ASC, queue_id ASC
    `),
  };

  function enqueue(operation) {
    const next = pending.then(operation, operation);
    pending = next.catch(() => {});
    return next;
  }

  function ensureOpen() {
    if (closed) {
      throw new Error("Review bridge store is already closed.");
    }
  }

  function buildDismissMissingCommentsSql(threadIds) {
    return `
      UPDATE review_comments
      SET status = 'dismissed', updated_at = ?
      WHERE pr_key = ? AND remote_thread_id IS NOT NULL AND remote_thread_id NOT IN (${threadIds.map(() => "?").join(", ")})
    `;
  }

  function readContext(prKey) {
    const prRow = statements.selectPullRequestContext.get(prKey);
    if (!prRow) {
      return null;
    }

    const threads = statements.selectThreadsForPr.all(prKey).map((threadRow) => ({
      id: threadRow.remote_thread_id,
      status: threadRow.status || "unknown",
      isDeleted: Boolean(threadRow.is_deleted),
      filePath: threadRow.file_path || "",
      lineStart: Number.isInteger(threadRow.line_start) ? threadRow.line_start : null,
      lineEnd: Number.isInteger(threadRow.line_end) ? threadRow.line_end : null,
      publishedDate: threadRow.published_at || null,
      lastUpdatedDate: threadRow.updated_at || null,
      comments: [],
    }));
    const threadMap = new Map(threads.map((thread) => [thread.id, thread]));
    for (const commentRow of statements.selectThreadCommentsForPr.all(prKey)) {
      const thread = threadMap.get(commentRow.remote_thread_id);
      if (!thread) {
        continue;
      }
      thread.comments.push({
        id: commentRow.remote_comment_id,
        parentCommentId: commentRow.parent_remote_comment_id ?? 0,
        content: commentRow.body_markdown || "",
        publishedDate: commentRow.created_at || null,
        lastUpdatedDate: commentRow.updated_at || null,
        commentType: "text",
        author: {
          id: "",
          displayName: commentRow.author_label || "",
          uniqueName: "",
        },
      });
    }

    const comments = statements.selectCommentsForPr.all(prKey).map((row) => ({
      commentKey: row.comment_key,
      prKey: row.pr_key,
      remoteThreadId: Number.isInteger(row.remote_thread_id) ? row.remote_thread_id : null,
      commentKind: row.comment_kind || "answer-question",
      displayIndex: row.display_index || 0,
      title: row.title || "",
      summary: row.summary || "",
      status: row.status || "ready-for-agent",
      priority: row.priority || "medium",
      assignedAgent: row.assigned_agent || "",
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      payload: fromJson(row.payload_json, {}),
    }));
    const drafts = statements.selectDraftsForPr.all(prKey).map((row) => ({
      draftId: row.draft_id,
      commentKey: row.comment_key,
      status: row.status || "draft",
      body: row.body || "",
      authorAgent: row.author_agent || "",
      confidence: row.confidence,
      needsHumanApproval: Boolean(row.needs_human_approval),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      payload: fromJson(row.payload_json, {}),
    }));
    const syncQueue = statements.selectQueueForPr.all(prKey).map((row) => ({
      queueId: row.queue_id,
      commentKey: row.comment_key,
      operation: row.operation || "",
      status: row.status || "pending",
      attempts: row.attempts || 0,
      lastError: row.last_error || "",
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      payload: fromJson(row.payload_json, {}),
    }));
    const exportDir = prRow.export_dir || buildPrExportDir(normalizedRoot, {
      provider: prRow.provider,
      connectionId: prRow.connection_id,
      repository: { id: prRow.repository_id, name: prRow.repository_name },
      pullRequest: { id: prRow.pull_request_id },
    });

    const context = {
      provider: prRow.provider || "azure-devops",
      prKey,
      databasePath,
      rootPath: normalizedRoot,
      exportDir,
      briefMarkdownPath: path.join(exportDir, "agent-brief.md"),
      briefJsonPath: path.join(exportDir, "agent-brief.json"),
      threadsMarkdownPath: path.join(exportDir, "threads.md"),
      draftsMarkdownPath: path.join(exportDir, "drafts.md"),
      syncStatusMarkdownPath: path.join(exportDir, "sync-status.md"),
      connectionId: prRow.connection_id || "",
      repositoryId: prRow.repository_id || "",
      pullRequestId: prRow.pull_request_id,
      workspaceId: prRow.workspace_id || "",
      reviewWorkspaceId: prRow.review_workspace_id || "",
      project: {
        id: prRow.project_id || "",
        name: prRow.project_name || "",
      },
      repository: {
        id: prRow.repository_id || "",
        name: prRow.repository_name || "",
      },
      pullRequest: {
        id: prRow.pull_request_id,
        title: prRow.title || "",
        sourceRefName: prRow.source_ref || "",
        targetRefName: prRow.target_ref || "",
        status: prRow.status || "",
      },
      role: prRow.role || "",
      lastImportedAt: prRow.last_imported_at || null,
      lastSeenActivityAt: prRow.last_seen_activity_at || null,
      changedFiles: fromJson(prRow.changed_files_json, []),
      localChangedFiles: fromJson(prRow.local_changed_files_json, []),
      payload: fromJson(prRow.payload_json, {}),
      threads,
      comments,
      drafts,
      syncQueue,
    };
    return {
      ...context,
      agentInstructions: buildAgentInstructions(context),
    };
  }

  const signalPath = path.join(normalizedRoot, ".bridge-signal");

  async function writeExports(context) {
    await fs.mkdir(context.exportDir, { recursive: true });
    const enrichedContext = {
      ...context,
      agentInstructions: buildAgentInstructions(context),
    };
    await Promise.all([
      fs.writeFile(path.join(context.exportDir, "meta.json"), JSON.stringify({
        provider: context.provider,
        prKey: context.prKey,
        connectionId: context.connectionId,
        repositoryId: context.repositoryId,
        pullRequestId: context.pullRequestId,
        lastImportedAt: context.lastImportedAt,
      }, null, 2)),
      fs.writeFile(context.briefJsonPath, JSON.stringify(enrichedContext, null, 2)),
      fs.writeFile(context.briefMarkdownPath, buildBriefMarkdown(context)),
      fs.writeFile(context.threadsMarkdownPath, buildThreadsMarkdown(context)),
      fs.writeFile(context.draftsMarkdownPath, buildDraftsMarkdown(context)),
      fs.writeFile(context.syncStatusMarkdownPath, buildSyncStatusMarkdown(context)),
    ]);
    // Signal file for instant change notification to the runtime
    await fs.writeFile(signalPath, Date.now().toString()).catch(() => {});
  }

  function resolveCommentRow({ prKey, commentKey, threadId }) {
    if (commentKey) {
      return statements.selectCommentByKey.get(commentKey) || null;
    }
    if (prKey && Number.isInteger(Number(threadId))) {
      return statements.selectCommentByThread.get(prKey, Number(threadId)) || null;
    }
    return null;
  }

  return {
    getRootPath() {
      return normalizedRoot;
    },
    getDatabasePath() {
      return databasePath;
    },
    getPullRequestContext(prKey) {
      if (closed || !prKey) {
        return null;
      }
      return readContext(prKey);
    },
    async syncPullRequest(summary) {
      ensureOpen();
      if (!summary?.prKey) {
        throw new Error("Pull request summary with prKey is required.");
      }
      return enqueue(async () => {
        const now = new Date().toISOString();
        const threads = (summary.threads || []).map((thread) => toThreadExport(thread));
        const exportDir = buildPrExportDir(normalizedRoot, {
          provider: summary.provider || "azure-devops",
          connectionId: summary.connectionId,
          repository: summary.repository,
          pullRequest: summary.pullRequest,
        });
        const existingCommentStatuses = new Map(
          statements.selectCommentStatusesByPr.all(summary.prKey).map((row) => [String(row.remote_thread_id), row.status || ""]),
        );

        try {
          db.exec("BEGIN IMMEDIATE TRANSACTION");
          statements.upsertPullRequest.run(
            summary.prKey,
            summary.provider || "azure-devops",
            summary.connectionId || "",
            summary.existingWorkspaceId || "",
            summary.reviewWorkspaceId || "",
            summary.repository?.id || "",
            summary.repository?.name || "",
            summary.project?.id || "",
            summary.project?.name || "",
            Number(summary.pullRequest?.id || 0),
            summary.pullRequest?.title || "",
            summary.pullRequest?.sourceRefName || "",
            summary.pullRequest?.targetRefName || "",
            summary.pullRequest?.status || "",
            summary.role || "",
            summary.lastRemoteActivityAt || null,
            summary.lastSeenActivityAt || null,
            now,
            exportDir,
            toJson(summary.changedFiles || []),
            toJson(summary.localChangedFiles || []),
            toJson({
              webUrl: summary.pullRequest?.webUrl || summary.pullRequest?.url || "",
              attentionReason: summary.attentionReason || "",
              myVote: summary.myVote ?? 0,
              checks: summary.checks || null,
              mergeStatus: summary.pullRequest?.mergeStatus || "",
              creationDate: summary.pullRequest?.creationDate || null,
              author: summary.author || null,
              reviewerSummary: summary.reviewerSummary || null,
            }),
          );
          statements.deleteThreadCommentsForPr.run(summary.prKey);
          statements.deleteThreadsForPr.run(summary.prKey);

          const activeThreadIds = [];
          for (const thread of threads) {
            statements.insertThread.run(
              summary.prKey,
              Number(thread.id || 0),
              thread.status || "unknown",
              Number(Boolean(thread.isDeleted)),
              thread.filePath || "",
              Number.isInteger(thread.lineStart) ? thread.lineStart : null,
              Number.isInteger(thread.lineEnd) ? thread.lineEnd : null,
              thread.publishedDate || null,
              thread.lastUpdatedDate || null,
              toJson({}),
            );

            if (thread.id != null) {
              activeThreadIds.push(Number(thread.id));
            }

            for (const comment of (thread.comments || [])) {
              statements.insertThreadComment.run(
                summary.prKey,
                Number(thread.id || 0),
                Number(comment.id || 0),
                Number(comment.parentCommentId ?? 0),
                "remote",
                firstNonEmpty(comment.author?.displayName, comment.author?.uniqueName, "Unknown author"),
                comment.content || "",
                collapseText(comment.content || ""),
                "inbound",
                comment.publishedDate || null,
                comment.lastUpdatedDate || null,
                toJson({ commentType: comment.commentType || "text" }),
              );
            }

            const commentKey = `${summary.prKey}:thread:${thread.id}`;
            const existingStatus = existingCommentStatuses.get(String(thread.id)) || "";
            const commentStatus = buildCommentStatus(thread, existingStatus);
            const commentPayload = {
              threadId: thread.id,
              filePath: thread.filePath || "",
              lineStart: Number.isInteger(thread.lineStart) ? thread.lineStart : null,
              lineEnd: Number.isInteger(thread.lineEnd) ? thread.lineEnd : null,
            };
            // Preserve existing display_index or assign next available
            const existingComment = statements.selectCommentByKey.get(commentKey);
            const displayIndex = existingComment?.display_index ?? statements.nextDisplayIndex.get(summary.prKey).next_index;
            statements.upsertComment.run(
              commentKey,
              summary.prKey,
              Number(thread.id || 0),
              "answer-question",
              displayIndex,
              buildCommentTitle(thread),
              buildCommentSummary(thread),
              commentStatus,
              isActiveThread(thread) ? "high" : "low",
              "",
              `${summary.lastRemoteActivityAt || ""}:${thread.lastUpdatedDate || thread.publishedDate || ""}`,
              "",
              now,
              now,
              toJson(commentPayload),
            );
          }

          if (activeThreadIds.length) {
            db.prepare(buildDismissMissingCommentsSql(activeThreadIds)).run(now, summary.prKey, ...activeThreadIds);
          } else {
            statements.dismissAllCommentsForPr.run(now, summary.prKey);
          }

          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {}
          throw error;
        }

        const context = readContext(summary.prKey);
        if (context) {
          await writeExports(context);
        }
        return context;
      });
    },
    async markPullRequestSeen(prKey, lastSeenActivityAt) {
      ensureOpen();
      if (!prKey) {
        throw new Error("Pull request key is required.");
      }
      return enqueue(async () => {
        statements.markSeen.run(lastSeenActivityAt || new Date().toISOString(), prKey);
        const context = readContext(prKey);
        if (context) {
          await writeExports(context);
        }
        return context;
      });
    },
    async createLocalComment({
      prKey,
      body = "",
      title = "",
      filePath = "",
      lineNumber = null,
      priority = "medium",
      authorAgent = "",
    } = {}) {
      ensureOpen();
      if (!prKey) {
        throw new Error("Pull request key is required.");
      }
      if (!String(body || "").trim()) {
        throw new Error("Local question body is required.");
      }
      return enqueue(async () => {
        const now = new Date().toISOString();
        const commentKey = `${prKey}:local:${randomUUID()}`;
        const normalizedBody = String(body || "").trim();
        const normalizedFilePath = String(filePath || "").trim();
        const normalizedLine = Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : null;
        const commentPayload = {
          source: "local-comment",
          authorAgent: String(authorAgent || ""),
          questionBody: normalizedBody,
          ...(normalizedFilePath ? { filePath: normalizedFilePath } : {}),
          ...(normalizedLine ? { lineNumber: normalizedLine } : {}),
        };

        const locationPrefix = normalizedFilePath
          ? `${normalizedFilePath}${normalizedLine ? `:${normalizedLine}` : ""}`
          : "";
        const autoTitle = String(title || "").trim()
          || (locationPrefix ? `${locationPrefix} — ${buildLocalCommentTitle(normalizedBody)}` : buildLocalCommentTitle(normalizedBody));

        const draftId = `${commentKey}:draft`;
        const draftPayload = { threadId: null, source: "local-bridge" };

        try {
          db.exec("BEGIN IMMEDIATE TRANSACTION");
          const displayIndex = statements.nextDisplayIndex.get(prKey).next_index;
          statements.upsertComment.run(
            commentKey,
            prKey,
            null,
            "local-comment",
            displayIndex,
            autoTitle,
            buildLocalCommentSummary(normalizedBody),
            "draft-ready",
            String(priority || "medium"),
            "",
            "",
            "",
            now,
            now,
            toJson(commentPayload),
          );
          statements.upsertDraft.run(
            draftId,
            commentKey,
            prKey,
            normalizedBody,
            "draft",
            String(authorAgent || ""),
            null,
            1,
            now,
            now,
            toJson(draftPayload),
          );
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {}
          throw error;
        }

        const context = readContext(prKey);
        if (context) {
          await writeExports(context);
        }
        return context;
      });
    },
    async saveDraftResponse({
      prKey,
      commentKey = "",
      threadId = null,
      body = "",
      authorAgent = "",
      confidence = null,
      needsHumanApproval = true,
    } = {}) {
      ensureOpen();
      if (!prKey) {
        throw new Error("Pull request key is required.");
      }
      return enqueue(async () => {
        const commentRow = resolveCommentRow({ prKey, commentKey, threadId });
        if (!commentRow) {
          throw new Error("Review comment was not found for this pull request.");
        }
        const now = new Date().toISOString();
        const resolvedCommentKey = commentRow.comment_key;
        const existingDraft = statements.selectLatestDraftByComment.get(resolvedCommentKey) || null;
        const draftId = existingDraft?.draft_id || `${resolvedCommentKey}:draft`;
        const draftPayload = {
          threadId: Number.isInteger(commentRow.remote_thread_id) ? commentRow.remote_thread_id : null,
          source: "local-bridge",
        };

        try {
          db.exec("BEGIN IMMEDIATE TRANSACTION");
          statements.upsertDraft.run(
            draftId,
            resolvedCommentKey,
            prKey,
            String(body || ""),
            "draft",
            String(authorAgent || ""),
            confidence == null ? null : Number(confidence),
            needsHumanApproval ? 1 : 0,
            existingDraft?.created_at || now,
            now,
            toJson(draftPayload),
          );
          statements.updateCommentState.run("draft-ready", now, resolvedCommentKey);
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {}
          throw error;
        }

        const context = readContext(prKey);
        if (context) {
          await writeExports(context);
        }
        return context;
      });
    },
    async queueDraftResponse({ prKey, draftId = "", commentKey = "", threadId = null } = {}) {
      ensureOpen();
      if (!prKey) {
        throw new Error("Pull request key is required.");
      }
      return enqueue(async () => {
        const commentRow = resolveCommentRow({ prKey, commentKey, threadId });
        const resolvedDraft = draftId
          ? statements.selectDraftById.get(draftId)
          : (commentRow ? statements.selectLatestDraftByComment.get(commentRow.comment_key) : null);
        if (!resolvedDraft) {
          throw new Error("Draft response was not found.");
        }

        const now = new Date().toISOString();
        const queueId = `sync:${resolvedDraft.draft_id}`;
        try {
          db.exec("BEGIN IMMEDIATE TRANSACTION");
          statements.upsertQueueItem.run(
            queueId,
            prKey,
            resolvedDraft.comment_key,
            "publish-comment",
            "pending",
            0,
            "",
            toJson({ draftId: resolvedDraft.draft_id }),
            now,
            now,
          );
          statements.updateDraftState.run("ready-to-sync", now, resolvedDraft.payload_json || "{}", resolvedDraft.draft_id);
          statements.updateCommentState.run("ready-to-sync", now, resolvedDraft.comment_key);
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {}
          throw error;
        }

        const context = readContext(prKey);
        if (context) {
          await writeExports(context);
        }
        return context;
      });
    },
    async deleteComment({ prKey, commentKey }) {
      ensureOpen();
      if (!prKey || !commentKey) {
        throw new Error("prKey and commentKey are required.");
      }
      return enqueue(async () => {
        try {
          db.exec("BEGIN IMMEDIATE TRANSACTION");
          statements.deleteDraftsByComment.run(commentKey);
          statements.deleteQueueByComment.run(commentKey);
          statements.deleteCommentByKey.run(commentKey);
          db.exec("COMMIT");
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch {}
          throw error;
        }
        const context = readContext(prKey);
        if (context) {
          await writeExports(context);
        }
        return context;
      });
    },
    async deleteDraft({ prKey, draftId }) {
      ensureOpen();
      if (!prKey || !draftId) {
        throw new Error("prKey and draftId are required.");
      }
      return enqueue(async () => {
        try {
          db.exec("BEGIN IMMEDIATE TRANSACTION");
          statements.deleteDraftById.run(draftId);
          statements.deleteQueueByDraft.run(`%${draftId.replace(/%/g, "").replace(/_/g, "")}%`);
          db.exec("COMMIT");
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch {}
          throw error;
        }
        const context = readContext(prKey);
        if (context) {
          await writeExports(context);
        }
        return context;
      });
    },
    getAgentPrompts() {
      if (closed) return [];
      const rows = statements.selectAllAgentPrompts.all();
      if (!rows.length) {
        this.seedDefaultAgentPrompts();
        return statements.selectAllAgentPrompts.all().map((r) => ({
          promptId: r.prompt_id, title: r.title, description: r.description,
          template: r.template, sortOrder: r.sort_order, isDefault: Boolean(r.is_default),
        }));
      }
      return rows.map((r) => ({
        promptId: r.prompt_id, title: r.title, description: r.description,
        template: r.template, sortOrder: r.sort_order, isDefault: Boolean(r.is_default),
      }));
    },
    saveAgentPrompt({ promptId, title, description, template, sortOrder = 0 }) {
      ensureOpen();
      const now = new Date().toISOString();
      const id = promptId || `prompt-${Date.now()}`;
      statements.upsertAgentPrompt.run(id, title, description || "", template, sortOrder, 0, now, now);
      return this.getAgentPrompts();
    },
    deleteAgentPrompt(promptId) {
      ensureOpen();
      statements.deleteAgentPrompt.run(promptId);
      return this.getAgentPrompts();
    },
    seedDefaultAgentPrompts() {
      ensureOpen();
      const now = new Date().toISOString();
      const defaults = [
        { id: "full-review", title: "Full code review", description: "Review the PR changes (not the entire codebase)", sort: 0, template: `Review this PR as an experienced code reviewer.\n\n1. Read the review brief to understand the PR purpose and scope.\n2. Use list_review_comments to see existing threads — do not duplicate what is already flagged.\n3. Inspect ONLY the changed files and changed lines in this PR. Do NOT review unchanged code — focus on the diff.\n4. For each changed file, evaluate the CHANGES for:\n   - Correctness: bugs, logic errors, null/undefined issues, off-by-one, missing error handling\n   - Security: injection (SQL, XSS, command), auth bypass, sensitive data exposure, insecure deserialization\n   - Performance: N+1 queries, missing indexes, unnecessary allocations, resource leaks\n   - Design: does the change fit the existing architecture? any coupling or cohesion concerns?\n   - Completeness: are there missing edge cases, untested paths, or incomplete migrations?\n5. For existing comments that need a reply, use save_review_draft.\n6. For new findings, create a SEPARATE create_review_comment for EACH issue.\n\nRules:\n- ONE finding per comment. Never combine multiple issues.\n- Always provide filePath and lineNumber pointing to the specific changed line.\n- Start the body with severity: **CRITICAL:**, **MAJOR:**, or **MINOR:**\n- Explain WHY it is a problem, not just what. Show the impact.\n- Suggest a concrete fix with a code snippet when possible.\n- Use \`code\` for identifiers, \`\`\`lang for blocks.\n- Skip nitpicks and style-only issues unless they hurt readability significantly.\n\nDo NOT queue any drafts — let me review them first.` },
        { id: "quick-summary", title: "Quick summary", description: "High-level overview of the PR changes", sort: 1, template: `Read the review brief and summarize the PR changes:\n1. What was changed, in which files, and roughly how many lines\n2. Why it was likely changed (infer from commit messages and code context)\n3. Key risks — what could break, what assumptions are made\n4. Is the change complete or are there missing pieces (e.g. no tests, partial migration)?\n5. Any existing review comments worth noting?\n\nUse list_review_comments to check what reviewers have already flagged.\nKeep it concise — 5-10 lines max. Focus on the diff, not the entire codebase.` },
        { id: "write-comment", title: "Write a review comment", description: "Create a targeted comment about a specific concern", sort: 2, template: `Write a review comment about [DESCRIBE YOUR CONCERN].\n\nUse create_review_comment to create a new comment, or save_review_draft to reply to an existing one.\nAlways provide filePath and lineNumber so the comment is anchored to the exact code location.\n\nFormat for Azure DevOps:\n- Start with severity: **CRITICAL:**, **MAJOR:**, or **MINOR:**\n- Explain the issue clearly\n- Suggest a fix with a code snippet if applicable\n- Use \`backticks\` for code references\n\nSave it as a local draft for my review.` },
        { id: "process-comments", title: "Respond to review comments (as PR author)", description: "Read reviewer comments and draft replies — agree, push back, or propose alternatives", sort: 3, template: `You are the PR author responding to review feedback.\n\n1. Use list_review_comments to see all comment threads.\n2. For each comment with status "active" or "ready-for-agent":\n   a. Use get_review_comment to read the full thread, code context, and any existing replies.\n   b. Analyze the reviewer's concern against the actual changed code.\n   c. Decide one of:\n      - **Agree & fix**: "Good catch. I'll fix this." + explain briefly what you'll change.\n      - **Agree & defer**: "Valid point, but out of scope for this PR. I'll track it as a follow-up."\n      - **Push back**: Explain why the current implementation is correct or intentional. Cite specific code, design decisions, or constraints.\n      - **Propose alternative**: "I see the concern. Instead of X, how about Y?" + provide a concrete code suggestion.\n   d. Use save_review_draft to write the reply.\n3. Be respectful but direct. Don't blindly agree — if the reviewer is wrong, explain why with evidence from the code.\n4. Keep replies concise. Reviewers appreciate short, actionable responses.\n\nDo NOT queue any drafts — let me review them first.` },
        { id: "security-scan", title: "Security & correctness scan", description: "Focused security and bug analysis of changed code", sort: 4, template: `Analyze ONLY the changed lines in this PR for:\n\n**Security (check every input path in the diff):**\n- SQL injection, XSS, command injection, SSRF\n- Authentication/authorization bypass or weakening\n- Sensitive data exposure (passwords, API keys, PII in logs or error messages)\n- Insecure deserialization, path traversal, open redirects\n- Hardcoded credentials or secrets\n\n**Correctness (check every logic change in the diff):**\n- Null/undefined handling, type mismatches\n- Race conditions, concurrency issues, deadlocks\n- Resource leaks (unclosed connections, streams, file handles)\n- Edge cases and boundary conditions\n- Error handling: are exceptions caught and handled, or silently swallowed?\n\nDo NOT review unchanged code. Only flag issues introduced or exposed by this PR's changes.\n\nCreate a SEPARATE create_review_comment for EACH finding. Always provide filePath and lineNumber.\nDo NOT queue any drafts — let me review them first.` },
        { id: "suggest-improvements", title: "Suggest improvements", description: "Code quality and best practice suggestions", sort: 5, template: `Review this PR for improvement opportunities:\n- Better naming for variables, methods, classes\n- Cleaner abstractions or design patterns\n- Missing or inadequate tests\n- Documentation gaps\n- Simpler implementations\n\nCreate a SEPARATE create_review_comment for each suggestion — never combine multiple suggestions into one comment. Always provide filePath and lineNumber so the suggestion is anchored to the exact code location. Frame them constructively.\nDo NOT queue any drafts — let me review them first.` },
        { id: "create-note", title: "Create a review comment", description: "Add a review comment with a draft", sort: 6, template: `Use create_review_comment to create a new review comment: "[YOUR QUESTION OR NOTE]"\n\nAlways provide filePath and lineNumber to anchor the comment to the code.\nA draft is auto-created so you can edit and queue it for publishing to Azure DevOps.` },
      ];
      for (const d of defaults) {
        statements.upsertAgentPrompt.run(d.id, d.title, d.description, d.template, d.sort, 1, now, now);
      }
    },
    async syncPendingDrafts(prKey, publishDraft) {
      ensureOpen();
      if (!prKey) {
        throw new Error("Pull request key is required.");
      }
      if (typeof publishDraft !== "function") {
        throw new Error("publishDraft callback is required.");
      }
      return enqueue(async () => {
        const pendingEntries = statements.selectPendingQueueByPr.all(prKey);
        for (const queueEntry of pendingEntries) {
          const now = new Date().toISOString();
          const queuePayload = fromJson(queueEntry.payload_json, {});
          const draftRow = statements.selectDraftById.get(queuePayload.draftId || "");
          const commentRow = queueEntry.comment_key ? statements.selectCommentByKey.get(queueEntry.comment_key) : null;
          const context = readContext(prKey);
          const thread = context?.threads.find((entry) => entry.id === commentRow?.remote_thread_id) || null;
          const parentCommentId = Number((thread?.comments || []).at(-1)?.id || 0);
          if (!draftRow || !commentRow) {
            statements.updateQueueState.run("failed", Number(queueEntry.attempts || 0) + 1, "Draft or comment is missing.", queueEntry.payload_json || "{}", now, queueEntry.queue_id);
            continue;
          }

          const publishInput = {
            prKey,
            queueId: queueEntry.queue_id,
            draftId: draftRow.draft_id,
            commentKey: commentRow.comment_key,
            body: draftRow.body || "",
            remoteThreadId: Number.isInteger(commentRow.remote_thread_id) ? commentRow.remote_thread_id : null,
            parentCommentId,
            comment: fromJson(commentRow.payload_json, {}),
            draft: fromJson(draftRow.payload_json, {}),
          };

          statements.updateQueueState.run("processing", Number(queueEntry.attempts || 0) + 1, "", queueEntry.payload_json || "{}", now, queueEntry.queue_id);
          try {
            const publishResult = await publishDraft(publishInput);
            const payloadJson = toJson({
              ...(queuePayload || {}),
              publishResult: publishResult || {},
            });
            const syncedAt = new Date().toISOString();
            try {
              db.exec("BEGIN IMMEDIATE TRANSACTION");
              statements.updateQueueState.run("synced", Number(queueEntry.attempts || 0) + 1, "", payloadJson, syncedAt, queueEntry.queue_id);
              statements.updateDraftState.run("synced", syncedAt, payloadJson, draftRow.draft_id);
              statements.updateCommentState.run("synced", syncedAt, commentRow.comment_key);
              db.exec("COMMIT");
            } catch (error) {
              try {
                db.exec("ROLLBACK");
              } catch {}
              throw error;
            }
          } catch (error) {
            const failedAt = new Date().toISOString();
            const message = error instanceof Error ? error.message : String(error || "Sync failed.");
            try {
              db.exec("BEGIN IMMEDIATE TRANSACTION");
              statements.updateQueueState.run("failed", Number(queueEntry.attempts || 0) + 1, message, queueEntry.payload_json || "{}", failedAt, queueEntry.queue_id);
              statements.updateDraftState.run("failed", failedAt, draftRow.payload_json || "{}", draftRow.draft_id);
              statements.updateCommentState.run("conflict", failedAt, commentRow.comment_key);
              db.exec("COMMIT");
            } catch (transactionError) {
              try {
                db.exec("ROLLBACK");
              } catch {}
              throw transactionError;
            }
          }
        }

        const context = readContext(prKey);
        if (context) {
          await writeExports(context);
        }
        return context;
      });
    },
    getSignalPath() {
      return signalPath;
    },
    getDataVersion() {
      if (closed) return 0;
      try {
        return db.prepare("PRAGMA data_version").get().data_version;
      } catch {
        return 0;
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      db.close();
    },
  };
}
