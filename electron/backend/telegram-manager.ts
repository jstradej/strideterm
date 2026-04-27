/// <reference types="node" />
/**
 * TelegramManager — forwards strIDEterm alerts to Telegram and processes
 * user replies to dispatch actions (start task, open PR review, etc.).
 *
 * Uses the Telegram Bot API (long-polling getUpdates — no public URL needed).
 *
 * Thread model: every forwarded notification is sent as a Telegram message.
 * User replies to that message using Telegram's native reply feature, or
 * presses an inline button. The manager maps messageId → AlertContext so it
 * can route replies to the correct workspace / PR.
 *
 * Security: the bot token is stored in the credential store (encrypted at
 * rest). The chat ID is validated on connection save so only the configured
 * chat can trigger actions.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Effect, Schedule } from "effect";
import type { CredentialStore } from "./shared/credential-store.js";
import { getLogger } from "./logger.js";
import { runEffect } from "./effect/runtime.js";
import {
  TelegramApiError,
  TelegramAuthError,
  TelegramRateLimitError,
  TelegramNetworkError,
} from "./effect/errors/telegram-errors.js";
import type { TelegramError } from "./effect/errors/telegram-errors.js";
import type { TelegramAuditLogStore } from "./telegram-audit-log-store.js";

const log = getLogger("telegram");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramConnectionConfig {
  id: string;
  label: string;
  botTokenRef: string;
  chatId: string;
  enabled: boolean;
  pollSeconds: number;
  forwardKinds: string[];
  agentCommand?: string;
}

export interface TelegramAlertContext {
  /** Unique strIDEterm alert/notification ID */
  alertId: string;
  /** Workspace the alert belongs to */
  workspaceId: string;
  /** Panel within the workspace */
  panelId: string;
  /** Kind: "completed" | "waiting" | "review" | "error" | "info" | ... */
  kind: string;
  /** PR key if this is an Azure/GitHub PR notification */
  prKey?: string;
  /** Provider: "azure-devops" | "github" */
  provider?: string;
  /** Connection ID for PR reviews */
  connectionId?: string;
  /** Workspace name for display */
  workspaceName?: string;
  /** Panel title for display */
  panelTitle?: string;
}

export interface TelegramAlertPayload {
  alertId?: string;
  workspaceId: string;
  panelId: string;
  workspaceName?: string;
  panelTitle?: string;
  kind: string;
  urgency?: string;
  title: string;
  detail?: string;
  /** For PR-related alerts */
  prKey?: string;
  provider?: string;
  connectionId?: string;
}

interface TelegramCommandEvent {
  type:
    | "start-task"
    | "start-existing-task"
    | "pause-task"
    | "resume-task"
    | "stop-task"
    | "reset-task"
    | "update-task-description"
    | "send-task-file"
    | "screenshot-current"
    | "screenshot-workspace"
    | "open-pr-review"
    | "confirm"
    | "dismiss"
    | "custom-message";
  workspaceId: string;
  panelId: string;
  prKey?: string;
  provider?: string;
  connectionId?: string;
  taskDescription?: string;
  alertId?: string;
  agentCommand?: string;
  /** Chat that triggered this command — runtime uses it for follow-up messages. */
  chatId?: string;
  /** For update-task-description: action to chain after the description is saved. */
  followUp?: "none" | "resume" | "start";
  /** For start-task: create a git worktree for the task (default false). */
  useWorktree?: boolean;
  /** For start-task with useWorktree: branch name for the new worktree. */
  worktreeBranch?: string;
  /** For start-task: explicit cwd override (used when picking an existing worktree). */
  targetCwd?: string;
  /** For send-task-file: relative path inside the task workspace's cwd. */
  filePath?: string;
  /** For send-task-file: how to deliver the file. `auto` picks photo/code-block/document
   *  by extension+size; `document` always uploads as a Telegram document attachment. */
  fileMode?: "auto" | "document";
}

// Minimal Telegram API types
interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  reply_to_message?: { message_id: number };
  from?: { id: number; username?: string; first_name?: string };
}

interface TgCallbackQuery {
  id: string;
  from: { id: number };
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TgSendMessageResult {
  ok: boolean;
  result?: { message_id: number };
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

interface TgGetUpdatesResult {
  ok: boolean;
  result?: TgUpdate[];
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** Minimal workspace info the manager needs for status/task commands */
export interface TelegramWorkspaceInfo {
  id: string;
  name: string;
  cwd: string;
  kind: string;
  /** Active profile owner. Used to scope /task to current profile. */
  profileId?: string;
  /** Free-form notes — used to detect "Worktree of ..." children. */
  notes?: string;
  /** Set when this workspace is a child (review/quickfix/task/worktree subtree). Empty for top-level workspaces. */
  parentWorkspaceId?: string;
  panels: Array<{ id: string; title: string }>;
  task?: { state: string; description: string } | null;
}

// State machine for pending user input
interface PendingRequest {
  type:
    | "task-description"
    | "confirm-action"
    | "workspace-selection"
    | "task-edit-description"
    | "worktree-mode-selection"
    | "worktree-branch-input"
    | "worktree-existing-pick"
    | "file-path-input"
    | "file-mode-selection"
    | "screenshot-mode-selection"
    | "screenshot-workspace-pick";
  workspaceId: string;
  panelId: string;
  alertId?: string;
  createdAt: number;
  /** Carried from the connection that started this request so the user-defined agent command survives the chat-keyed flow */
  agentCommand?: string;
  /** For confirm-action: the command to emit on confirm */
  pendingCmd?: TelegramCommandEvent;
  /** For workspace-selection: ordered list of choices shown to the user */
  workspaceChoices?: TelegramWorkspaceInfo[];
  /** For task-edit-description: what to do after saving the new description */
  followUp?: "none" | "resume" | "start";
  /** For worktree-* steps: accumulating task creation parameters */
  draftTask?: {
    parentWorkspaceId: string;
    parentName: string;
    parentCwd: string;
    useWorktree: boolean;
    worktreeBranch?: string;
    /** When picking an existing worktree, this overrides parentCwd as the task root. */
    targetCwd?: string;
  };
  /** For worktree-existing-pick: list of existing worktree children to choose from */
  worktreeChoices?: TelegramWorkspaceInfo[];
  /** For file-mode-selection: relative path the user typed, awaiting delivery-mode choice */
  pendingFilePath?: string;
}

// ---------------------------------------------------------------------------
// TelegramManager
// ---------------------------------------------------------------------------

const MAX_CONTEXT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CONTEXT_ENTRIES = 500;
const PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FORWARDED_PR_KEYS = 1000;
const TASK_COMMAND_COOLDOWN_MS = 10_000; // /task can fire at most every 10 s per chat
// Server long-poll timeout (seconds). HTTP abort lives at GETUPDATES_HTTP_TIMEOUT_MS,
// which MUST be larger than this value × 1000 so the server's own timeout fires
// first and returns an empty array.
const GETUPDATES_LONG_POLL_SEC = 25;
const GETUPDATES_HTTP_TIMEOUT_MS = 35_000;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

// HTTP retry: 200 ms exponential, max 3 retries; skipped for auth/rate-limit/4xx errors.
const telegramRetry = Schedule.both(Schedule.exponential("200 millis"), Schedule.recurs(3));

// Compact callback action codes (kept short to fit in Telegram's 64 B limit).
type CallbackAction = "s" | "o" | "d" | "c" | "x";
const CALLBACK_ACTION_LABEL: Record<CallbackAction, string> = {
  s: "start-task",
  o: "open-pr-review",
  d: "dismiss",
  c: "confirm",
  x: "cancel",
};

export class TelegramManager extends EventEmitter {
  private credentialStore: CredentialStore;
  private auditLogStore: TelegramAuditLogStore | null;
  private connections: TelegramConnectionConfig[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollOffsets: Map<string, number> = new Map();
  private running: boolean = false;

  /** Maps Telegram message_id → alert context, per connection */
  private contextByMessageId: Map<number, { context: TelegramAlertContext; connectionId: string; at: number }> =
    new Map();

  /** Pending text input requests (awaiting user's next message in chat) */
  private pendingRequests: Map<string, PendingRequest> = new Map(); // chatId → PendingRequest

  /** Bounded LRU of PR keys already forwarded so we don't double-notify */
  private forwardedPrKeys: Map<string, number> = new Map();

  /** Per-chat cooldown for /task (and similar destructive commands) */
  private lastTaskCommandAt: Map<string, number> = new Map();

  /** Runtime-provided getter for current workspace list — used by /status and /task commands */
  private getWorkspaces: (() => TelegramWorkspaceInfo[]) | null = null;

  /** Runtime-provided getter for the active profile id — used by /task to filter candidates */
  private getActiveProfileId: (() => string) | null = null;

  constructor({
    credentialStore,
    auditLogStore = null,
  }: {
    credentialStore: CredentialStore;
    auditLogStore?: TelegramAuditLogStore | null;
  }) {
    super();
    this.credentialStore = credentialStore;
    this.auditLogStore = auditLogStore;
  }

  /** Called by the runtime during setup so TelegramManager can query workspace state */
  setWorkspacesGetter(fn: () => TelegramWorkspaceInfo[]): void {
    this.getWorkspaces = fn;
  }

  /** Called by the runtime so /task can scope candidates to the user's current profile. */
  setActiveProfileGetter(fn: () => string): void {
    this.getActiveProfileId = fn;
  }

  configure(connections: TelegramConnectionConfig[]): void {
    this.connections = connections.filter((c) => c.enabled && c.botTokenRef && c.chatId);
    log.debug("telegram configured", { count: this.connections.length });
  }

  getSnapshot(): { connections: Array<{ id: string; label: string; chatId: string; status: string }> } {
    return {
      connections: this.connections.map((c) => ({
        id: c.id,
        label: c.label,
        chatId: c.chatId,
        status: this.credentialStore.hasSecret(c.botTokenRef) ? "configured" : "missing-token",
      })),
    };
  }

  /** Returns true if a PR has already been forwarded; otherwise records it. */
  hasForwardedPr(prKey: string): boolean {
    return this.forwardedPrKeys.has(prKey);
  }

  markPrForwarded(prKey: string): void {
    this.forwardedPrKeys.set(prKey, Date.now());
    if (this.forwardedPrKeys.size > MAX_FORWARDED_PR_KEYS) {
      // Map iteration order is insertion order — drop the oldest.
      const firstKey = this.forwardedPrKeys.keys().next().value;
      if (firstKey !== undefined) this.forwardedPrKeys.delete(firstKey);
    }
  }

  forgetForwardedPr(prKey: string): void {
    this.forwardedPrKeys.delete(prKey);
  }

  // ---------------------------------------------------------------------------
  // Public: runtime → manager reverse channel
  // ---------------------------------------------------------------------------

  /**
   * Send a plain text notification to a chat. Used by the runtime to confirm
   * follow-up state changes (task started, task paused, ...) so the user
   * gets immediate feedback in Telegram.
   *
   * Markdown V2 formatting is enabled — caller must escape special characters.
   */
  async notifyChat(chatId: string, text: string): Promise<void> {
    const conn = this.connections.find((c) => c.chatId === chatId);
    if (!conn) {
      log.debug("telegram notifyChat: no matching connection", { chatId });
      return;
    }
    const token = this.credentialStore.getSecret(conn.botTokenRef);
    if (!token) {
      log.debug("telegram notifyChat: no token", { chatId });
      return;
    }
    await this._sendText(token, chatId, text, true);
  }

  /**
   * Send a file from a task workspace to the chat in a format-aware way.
   * Caller (runtime) is responsible for path validation and resolution.
   *
   *   - Image extensions → sendPhoto (rendered inline on phone)
   *   - Small text-like files → sendMessage with a fenced code block (and
   *     a language hint based on extension) so the user can read it inline
   *     without opening a download
   *   - Anything else → sendDocument (downloadable attachment, preserves
   *     the original byte content for binary files / large logs)
   *
   * Resolves the absolute path via dynamic imports to avoid hard-wiring
   * Node fs at module scope (keeps the manager portable for future tests).
   */
  async sendFile(opts: {
    chatId: string;
    absolutePath: string;
    relPath: string;
    workspaceName?: string;
    /** `auto` = pick photo/code-block/document by extension+size (default).
     *  `document` = always upload as a Telegram document attachment so the
     *  user can save / forward the original bytes regardless of type. */
    mode?: "auto" | "document";
  }): Promise<void> {
    const conn = this.connections.find((c) => c.chatId === opts.chatId);
    if (!conn) {
      log.warn("telegram sendFile: no matching connection", { chatId: opts.chatId });
      return;
    }
    const token = this.credentialStore.getSecret(conn.botTokenRef);
    if (!token) {
      log.warn("telegram sendFile: no token", { chatId: opts.chatId });
      return;
    }

    const { readFile, stat } = await import("node:fs/promises");
    const path = await import("node:path");
    let buf: Buffer;
    let size: number;
    try {
      const st = await stat(opts.absolutePath);
      if (!st.isFile()) {
        await this._sendText(token, opts.chatId, "⚠️ Path does not exist or is not a file\\.", true);
        return;
      }
      size = st.size;
      buf = await readFile(opts.absolutePath);
    } catch (err) {
      const errMsg = (err as Error).message;
      log.warn("telegram sendFile: read failed", { absolutePath: opts.absolutePath, err: errMsg });
      await this._sendText(
        token,
        opts.chatId,
        `⚠️ Cannot read file: \`${escapeMarkdown(errMsg.slice(0, 200))}\``,
        true,
      );
      return;
    }

    const ext = path.extname(opts.absolutePath).toLowerCase();
    const basename = path.basename(opts.absolutePath);
    const captionHeader = opts.workspaceName
      ? `📂 *${escapeMarkdown(opts.workspaceName)}* › \`${escapeMarkdown(opts.relPath)}\``
      : `📂 \`${escapeMarkdown(opts.relPath)}\``;

    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
    const TEXT_EXTS = new Set([
      ".md",
      ".txt",
      ".log",
      ".json",
      ".yaml",
      ".yml",
      ".toml",
      ".ini",
      ".env",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".vue",
      ".svelte",
      ".py",
      ".rb",
      ".go",
      ".rs",
      ".java",
      ".kt",
      ".swift",
      ".cs",
      ".php",
      ".c",
      ".cc",
      ".cpp",
      ".h",
      ".hpp",
      ".m",
      ".html",
      ".htm",
      ".css",
      ".scss",
      ".sass",
      ".less",
      ".sh",
      ".bash",
      ".zsh",
      ".fish",
      ".ps1",
      ".psm1",
      ".bat",
      ".cmd",
      ".sql",
      ".graphql",
      ".proto",
      ".csv",
      ".xml",
    ]);
    const LANGUAGE_HINT: Record<string, string> = {
      ".ts": "ts",
      ".tsx": "tsx",
      ".js": "js",
      ".jsx": "jsx",
      ".mjs": "js",
      ".cjs": "js",
      ".py": "python",
      ".rb": "ruby",
      ".go": "go",
      ".rs": "rust",
      ".java": "java",
      ".kt": "kotlin",
      ".swift": "swift",
      ".cs": "csharp",
      ".php": "php",
      ".c": "c",
      ".cc": "cpp",
      ".cpp": "cpp",
      ".h": "c",
      ".hpp": "cpp",
      ".html": "html",
      ".htm": "html",
      ".css": "css",
      ".scss": "scss",
      ".sh": "bash",
      ".bash": "bash",
      ".zsh": "bash",
      ".ps1": "powershell",
      ".sql": "sql",
      ".graphql": "graphql",
      ".json": "json",
      ".yaml": "yaml",
      ".yml": "yaml",
      ".toml": "toml",
      ".xml": "xml",
    };

    // sendPhoto caption max is 1024 chars; sendMessage max is 4096; large
    // files always go through sendDocument which has 50MB upper bound.
    const TEXT_INLINE_MAX_BYTES = 3500; // leaves headroom for caption+escapes

    // Forced-document mode bypasses extension-based detection — user
    // explicitly asked for the raw file (so they can save/forward it),
    // not a chat-friendly preview.
    if (opts.mode === "document") {
      await this._sendDocument(token, opts.chatId, buf, basename, captionHeader);
      return;
    }

    if (IMAGE_EXTS.has(ext)) {
      await this._sendPhoto(token, opts.chatId, buf, basename, captionHeader);
      return;
    }

    if (TEXT_EXTS.has(ext) && size <= TEXT_INLINE_MAX_BYTES) {
      const content = buf.toString("utf8");
      const lang = LANGUAGE_HINT[ext] || "";
      // Code-fence escapes: only ` and \ (per MarkdownV2 rules for pre/code).
      const fenced = content.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
      const fence = lang ? `\`\`\`${lang}` : "```";
      const text = `${captionHeader}\n${fence}\n${fenced}\n\`\`\``;
      await this._sendText(token, opts.chatId, text, true);
      return;
    }

    // Fallback: send as document attachment. Caption is small (file metadata).
    await this._sendDocument(token, opts.chatId, buf, basename, captionHeader);
  }

  /**
   * After a task workspace is created from Telegram, ask the user whether to
   * start it now or leave it idle so they can edit TASK.md first. Stores a
   * pending confirm-action that emits `start-existing-task` on confirm.
   */
  async promptStartAfterCreate(opts: {
    chatId: string;
    workspaceId: string;
    description: string;
    parentName: string;
    cwd: string;
  }): Promise<void> {
    const conn = this.connections.find((c) => c.chatId === opts.chatId);
    if (!conn) {
      log.warn("telegram promptStartAfterCreate: no matching connection", { chatId: opts.chatId });
      return;
    }
    const token = this.credentialStore.getSecret(conn.botTokenRef);
    if (!token) {
      log.warn("telegram promptStartAfterCreate: no token", { chatId: opts.chatId });
      return;
    }

    this.pendingRequests.set(opts.chatId, {
      type: "confirm-action",
      workspaceId: opts.workspaceId,
      panelId: "",
      createdAt: Date.now(),
      pendingCmd: {
        type: "start-existing-task",
        workspaceId: opts.workspaceId,
        panelId: "",
      },
    });

    const lines = [
      `✅ Task workspace created in *${escapeMarkdown(opts.parentName)}*\\.`,
      "",
      `📝 _${escapeMarkdown(opts.description.slice(0, 200))}_`,
      `📁 \`${escapeMarkdown(opts.cwd)}\``,
      "",
      "Start now, or leave it IDLE \\(you can edit TASK\\.md and start it manually\\)?",
    ];

    await this._apiCall(token, "sendMessage", {
      chat_id: opts.chatId,
      text: lines.join("\n"),
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "▶️ Start now", callback_data: "c" },
            { text: "⏸ Leave IDLE", callback_data: "x" },
          ],
        ],
      },
    }).catch((err) => {
      log.warn("telegram promptStartAfterCreate send failed", { err: (err as Error).message });
    });
  }

  // ---------------------------------------------------------------------------
  // Public: send alert to all configured Telegram connections
  // ---------------------------------------------------------------------------

  async forwardAlert(payload: TelegramAlertPayload): Promise<void> {
    if (this.connections.length === 0) return;

    for (const conn of this.connections) {
      const forwardKinds = conn.forwardKinds;
      if (forwardKinds.length > 0 && !forwardKinds.includes(payload.kind)) {
        log.trace("telegram alert filtered out by forwardKinds", {
          connectionId: conn.id,
          kind: payload.kind,
        });
        continue;
      }
      await this._sendAlertToConnection(conn, payload).catch((err) => {
        log.warn("telegram send alert failed", { connectionId: conn.id, err: (err as Error).message });
        this._audit({
          chatId: conn.chatId,
          workspaceId: payload.workspaceId,
          operation: "forwardAlert",
          category: "write",
          method: "POST",
          url: "/sendMessage",
          success: false,
          errorMessage: (err as Error).message,
          resourceType: "alert",
          resourceId: payload.alertId || "",
          summary: payload.title,
        });
      });
    }
  }

  private async _sendAlertToConnection(conn: TelegramConnectionConfig, payload: TelegramAlertPayload): Promise<void> {
    const token = this.credentialStore.getSecret(conn.botTokenRef);
    if (!token) {
      log.warn("telegram alert skipped: no token for connection", { connectionId: conn.id });
      return;
    }

    const text = this._buildAlertText(payload);
    const alertId = payload.alertId || randomUUID();
    const ctx: TelegramAlertContext = {
      alertId,
      workspaceId: payload.workspaceId,
      panelId: payload.panelId,
      kind: payload.kind,
      prKey: payload.prKey,
      provider: payload.provider,
      connectionId: payload.connectionId,
      workspaceName: payload.workspaceName,
      panelTitle: payload.panelTitle,
    };
    const keyboard = this._buildKeyboard(payload);

    const result = await this._sendMessage(token, {
      chat_id: conn.chatId,
      text,
      parse_mode: "MarkdownV2",
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });

    if (result.ok && result.result?.message_id) {
      this.contextByMessageId.set(result.result.message_id, {
        context: ctx,
        connectionId: conn.id,
        at: Date.now(),
      });
      this._pruneContextMap();
      log.info("telegram alert sent", {
        messageId: result.result.message_id,
        kind: payload.kind,
        workspaceId: payload.workspaceId,
        connectionId: conn.id,
      });
      this._audit({
        chatId: conn.chatId,
        workspaceId: payload.workspaceId,
        operation: "forwardAlert",
        category: "write",
        method: "POST",
        url: "/sendMessage",
        success: true,
        statusCode: 200,
        resourceType: "alert",
        resourceId: alertId,
        summary: `${payload.kind}: ${payload.title}`,
      });
    } else {
      log.warn("telegram sendMessage failed", { description: result.description, kind: payload.kind });
      this._audit({
        chatId: conn.chatId,
        workspaceId: payload.workspaceId,
        operation: "forwardAlert",
        category: "write",
        method: "POST",
        url: "/sendMessage",
        success: false,
        errorMessage: result.description || "sendMessage returned ok=false",
        resourceType: "alert",
        resourceId: alertId,
        summary: payload.title,
      });
    }
  }

  private _buildAlertText(payload: TelegramAlertPayload): string {
    const icon = this._kindIcon(payload.kind);
    const workspace = payload.workspaceName ? escapeMarkdown(payload.workspaceName) : "";
    const panel = payload.panelTitle ? escapeMarkdown(payload.panelTitle) : "";
    const title = escapeMarkdown(payload.title);
    const rawDetail = payload.detail ? this._humanizeDetail(payload.detail) : "";

    const lines: string[] = [];
    lines.push(`${icon} *${title}*`);
    if (workspace || panel) {
      const loc = [workspace, panel].filter(Boolean).join(" › ");
      lines.push(`📍 ${loc}`);
    }
    if (rawDetail) {
      // Long judge verdicts and task results contain code references like
      // `recept-na-domaci-sunku.md:1` and `(lines 3-11)` that look terrible
      // wrapped in italic — Telegram tries to render the dashes/dots as
      // Markdown and auto-detects file paths as links. For anything longer
      // than a one-liner, render as a fenced code block (preserves spacing,
      // disables auto-linking, monospace makes paths/code legible). Short
      // detail (like `prompt-returned`) stays as italic for visual hierarchy.
      const oneLiner = !rawDetail.includes("\n") && rawDetail.length <= 120;
      if (oneLiner) {
        lines.push(`_${escapeMarkdown(rawDetail)}_`);
      } else {
        // Code-block content needs only ` and \ escaped (per MarkdownV2 spec
        // for pre/code blocks) — far less noise than full escapeMarkdown.
        const codeEscaped = rawDetail.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
        lines.push("```");
        lines.push(codeEscaped);
        lines.push("```");
      }
    }

    // Action hints
    if (payload.kind === "completed" || payload.kind === "waiting") {
      lines.push("");
      lines.push(`_Reply with a task description to start a new task, or press a button below\\._`);
    } else if (payload.kind === "review" || (payload.prKey && payload.provider)) {
      lines.push("");
      lines.push(`_Press "Open Review" to start the code review workspace, or reply to dismiss\\._`);
    }

    return lines.join("\n");
  }

  private _buildKeyboard(payload: TelegramAlertPayload): Array<Array<{ text: string; callback_data: string }>> | null {
    // Callback data is just the action code; full context is looked up via
    // contextByMessageId on the message the button is attached to.
    const { kind, prKey, provider } = payload;

    if (kind === "completed" || kind === "waiting") {
      return [
        [
          { text: "🚀 New Task", callback_data: "s" },
          { text: "✓ Dismiss", callback_data: "d" },
        ],
      ];
    }

    if ((kind === "review" || prKey) && provider) {
      return [
        [
          { text: "🔍 Open Review", callback_data: "o" },
          { text: "✓ Dismiss", callback_data: "d" },
        ],
      ];
    }

    return null;
  }

  private _kindIcon(kind: string): string {
    switch (kind) {
      case "completed":
        return "✅";
      case "waiting":
        return "⏳";
      case "review":
        return "🔍";
      case "error":
        return "❌";
      case "warning":
        return "⚠️";
      case "info":
        return "ℹ️";
      default:
        return "🔔";
    }
  }

  private _humanizeDetail(detail: string): string {
    if (detail.startsWith("rate-limited:")) {
      const rest = detail.slice("rate-limited:".length);
      return `Rate limited${rest ? `: ${rest}` : ""}`;
    }
    return detail;
  }

  // ---------------------------------------------------------------------------
  // Public: detect chats — given just a bot token, find chats the bot has
  // recently received messages in. Lets the user skip the "look up the chat
  // ID manually" step entirely.
  // ---------------------------------------------------------------------------

  async detectChats(opts: { botToken: string }): Promise<{
    botUsername: string;
    chats: Array<{
      chatId: string;
      title: string;
      type: string;
      lastFromUser: string;
      lastText: string;
    }>;
  }> {
    log.info("telegram detectChats");
    // Validate token
    const me = await this._apiCall<{
      ok: boolean;
      result?: { username?: string; first_name?: string };
      description?: string;
    }>(opts.botToken, "getMe", {});
    if (!me.ok) {
      const msg = `Telegram bot token invalid: ${me.description || "unknown error"}`;
      log.warn("telegram detectChats: getMe failed", { description: me.description });
      this._audit({
        operation: "detectChats",
        category: "read",
        method: "POST",
        url: "/getMe",
        success: false,
        errorMessage: msg,
      });
      throw new Error(msg);
    }
    const botUsername = me.result?.username || me.result?.first_name || "unknown";

    // Use offset=-100 so we look back at the most recent updates without
    // consuming the polling cursor (Telegram only marks updates as confirmed
    // when offset > update_id is sent).
    const updates = await this._apiCall<TgGetUpdatesResult>(
      opts.botToken,
      "getUpdates",
      { offset: -100, timeout: 0, limit: 100, allowed_updates: ["message", "channel_post"] },
      { retry: false, httpTimeoutMs: 10_000 },
    );

    if (!updates.ok || !updates.result) {
      log.warn("telegram detectChats: getUpdates returned non-ok", { description: updates.description });
      this._audit({
        operation: "detectChats",
        category: "read",
        method: "POST",
        url: "/getUpdates",
        success: false,
        errorMessage: updates.description || "getUpdates returned ok=false",
      });
      return { botUsername, chats: [] };
    }

    interface ChatLike {
      id: number;
      type?: string;
      title?: string;
      first_name?: string;
      last_name?: string;
      username?: string;
    }
    interface MsgLike {
      chat?: ChatLike;
      from?: { first_name?: string; username?: string; id?: number };
      text?: string;
    }
    const seen = new Map<
      string,
      { chatId: string; title: string; type: string; lastFromUser: string; lastText: string }
    >();

    for (const update of updates.result) {
      const m: MsgLike | undefined = update.message ?? (update as unknown as { channel_post?: MsgLike }).channel_post;
      if (!m?.chat) continue;
      const id = String(m.chat.id);
      if (seen.has(id)) continue;
      const title =
        m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ") || m.chat.username || id;
      seen.set(id, {
        chatId: id,
        title,
        type: m.chat.type || "private",
        lastFromUser: m.from?.first_name || m.from?.username || "",
        lastText: (m.text || "").slice(0, 100),
      });
    }

    const chats = Array.from(seen.values());
    log.info("telegram detectChats: found chats", { count: chats.length, botUsername });
    this._audit({
      operation: "detectChats",
      category: "read",
      method: "POST",
      url: "/getMe+getUpdates",
      success: true,
      userInitiated: true,
      summary: `bot=@${botUsername} chats=${chats.length}`,
    });
    return { botUsername, chats };
  }

  // ---------------------------------------------------------------------------
  // Public: verify bot token + chat ID before saving connection
  // ---------------------------------------------------------------------------

  async verifyConnection(opts: {
    botToken: string;
    chatId: string;
  }): Promise<{ ok: true; botUsername: string; botName: string; chatTitle: string }> {
    log.info("telegram verifyConnection", { chatId: opts.chatId });
    try {
      const meResult = await this._apiCall<{
        ok: boolean;
        result?: { username?: string; first_name?: string };
        description?: string;
      }>(opts.botToken, "getMe", {});

      if (!meResult.ok) {
        const msg = `Telegram bot token invalid: ${meResult.description || "unknown error"}`;
        log.warn("telegram verifyConnection: getMe failed", { description: meResult.description });
        this._audit({
          chatId: opts.chatId,
          operation: "verifyConnection",
          category: "read",
          method: "POST",
          url: "/getMe",
          success: false,
          errorMessage: msg,
        });
        throw new Error(msg);
      }

      const botUsername = meResult.result?.username || meResult.result?.first_name || "unknown";

      // Try sending a test message to verify chat access
      const chatResult = await this._apiCall<{
        ok: boolean;
        result?: { chat?: { title?: string; type?: string }; message_id?: number };
        description?: string;
      }>(opts.botToken, "sendMessage", {
        chat_id: opts.chatId,
        text: escapeMarkdown("✅ strIDEterm connected! Notifications will appear here."),
        parse_mode: "MarkdownV2",
      });

      if (!chatResult.ok) {
        const msg = `Cannot send to chat ${opts.chatId}: ${chatResult.description || "access denied"}`;
        log.warn("telegram verifyConnection: sendMessage failed", { description: chatResult.description });
        this._audit({
          chatId: opts.chatId,
          operation: "verifyConnection",
          category: "write",
          method: "POST",
          url: "/sendMessage",
          success: false,
          errorMessage: msg,
        });
        throw new Error(msg);
      }

      log.info("telegram verifyConnection: success", { botUsername, chatId: opts.chatId });
      this._audit({
        chatId: opts.chatId,
        operation: "verifyConnection",
        category: "read",
        method: "POST",
        url: "/getMe+sendMessage",
        success: true,
        userInitiated: true,
        summary: `bot=@${botUsername}`,
      });

      const chatTitle = String(opts.chatId);
      // The frontend expects { ok, botName }; keep botUsername for backwards compat with any IPC consumer.
      return { ok: true, botUsername, botName: botUsername, chatTitle };
    } catch (err) {
      log.warn("telegram verifyConnection threw", { err: (err as Error).message });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this._scheduleNextPoll();
    log.info("telegram polling started", { connectionCount: this.connections.length });
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.info("telegram polling stopped");
  }

  private _scheduleNextPoll(): void {
    if (!this.running) return;
    const delay = this.connections.length > 0 ? Math.min(...this.connections.map((c) => c.pollSeconds * 1000)) : 30000;
    this.pollTimer = setTimeout(() => {
      this._poll().catch((err) => {
        log.warn("telegram poll error", { err: (err as Error).message });
      });
    }, delay);
  }

  private async _poll(): Promise<void> {
    if (!this.running) return;

    for (const conn of this.connections) {
      await this._pollConnection(conn).catch((err) => {
        log.warn("telegram poll connection error", { connectionId: conn.id, err: (err as Error).message });
      });
    }

    this._scheduleNextPoll();
  }

  private async _pollConnection(conn: TelegramConnectionConfig): Promise<void> {
    const token = this.credentialStore.getSecret(conn.botTokenRef);
    if (!token) {
      log.debug("telegram poll skipped: no token", { connectionId: conn.id });
      return;
    }

    const offset = this.pollOffsets.get(conn.id) ?? 0;

    const result = await this._apiCall<TgGetUpdatesResult>(
      token,
      "getUpdates",
      {
        offset,
        timeout: GETUPDATES_LONG_POLL_SEC,
        limit: 100,
        allowed_updates: ["message", "callback_query"],
      },
      { httpTimeoutMs: GETUPDATES_HTTP_TIMEOUT_MS, retry: false },
    );

    if (!result.ok || !result.result) {
      log.debug("telegram getUpdates returned non-ok", { description: result.description });
      return;
    }

    if (result.result.length > 0) {
      log.debug("telegram getUpdates received", { count: result.result.length, connectionId: conn.id });
    }

    for (const update of result.result) {
      this.pollOffsets.set(conn.id, Math.max(offset, update.update_id + 1));

      if (update.message) {
        await this._handleMessage(update.message, conn, token);
      } else if (update.callback_query) {
        await this._handleCallbackQuery(update.callback_query, conn, token);
      }
    }
  }

  private async _handleMessage(msg: TgMessage, conn: TelegramConnectionConfig, token: string): Promise<void> {
    const chatId = String(msg.chat.id);
    if (chatId !== conn.chatId) {
      log.debug("telegram message ignored: chatId mismatch", { expected: conn.chatId, got: chatId });
      return;
    }

    const text = (msg.text || "").trim();
    if (!text) return;

    log.info("telegram message received", {
      messageId: msg.message_id,
      chatId,
      textPreview: text.slice(0, 80),
      from: msg.from?.username || msg.from?.first_name || msg.from?.id,
    });

    // --- Global commands (handled before pending-state check) ---
    const lower = text.toLowerCase();
    if (lower === "/status" || lower === "status") {
      log.debug("telegram command: /status", { chatId });
      await this._handleStatusCommand(chatId, token);
      return;
    }
    if (lower === "/workspaces" || lower === "workspaces") {
      log.debug("telegram command: /workspaces", { chatId });
      await this._handleWorkspacesCommand(chatId, token);
      return;
    }
    if (lower === "/task" || lower === "task") {
      log.info("telegram command: /task", { chatId });
      await this._handleTaskCommand(chatId, token, conn);
      return;
    }
    if (lower === "/screenshot" || lower === "screenshot") {
      log.info("telegram command: /screenshot", { chatId });
      await this._handleScreenshotCommand(chatId, token);
      return;
    }
    if (lower === "/menu" || lower === "menu" || lower === "/start" || lower === "start") {
      log.info("telegram command: /menu", { chatId });
      await this._handleMenuCommand(chatId, token);
      return;
    }
    if (lower === "/help" || lower === "help") {
      log.debug("telegram command: /help", { chatId });
      await this._sendText(
        token,
        chatId,
        [
          "📖 *strIDEterm bot commands:*",
          "",
          "`/menu` — interactive main menu \\(recommended on mobile\\)",
          "`/status` — show all task agents",
          "`/workspaces` — list workspaces",
          "`/task` — start a new task agent \\(workspace picker\\)",
          "`/screenshot` — capture a screenshot of the strIDEterm window",
          "",
          "Or reply to a specific notification using Telegram Reply and tap the inline buttons\\.",
        ].join("\n"),
        true,
      );
      return;
    }

    // --- Pending-state handler ---
    const pending = this.pendingRequests.get(chatId);
    if (pending && Date.now() - pending.createdAt < PENDING_TIMEOUT_MS) {
      this.pendingRequests.delete(chatId);
      log.debug("telegram pending-state consumed by message", { chatId, type: pending.type });

      if (pending.type === "workspace-selection") {
        // User replied with a number to pick a workspace
        const idx = parseInt(text.trim(), 10) - 1;
        const choices = pending.workspaceChoices || [];
        const chosen = choices[idx];
        if (!chosen) {
          log.info("telegram workspace-selection: invalid choice", { input: text, choiceCount: choices.length });
          await this._sendText(
            token,
            chatId,
            `⚠️ Invalid choice\\. Enter a number 1–${escapeMarkdown(String(choices.length))}\\. Or run /task again\\.`,
          );
          return;
        }
        log.info("telegram workspace-selection: chose workspace, asking for worktree mode", {
          chatId,
          workspaceId: chosen.id,
          workspaceName: chosen.name,
        });
        await this._presentWorktreeModeMenu(token, chatId, chosen, pending.agentCommand);
        return;
      }

      if (pending.type === "worktree-branch-input") {
        // Mobile keyboards love to autocapitalize the first letter and slip
        // in trailing/extra spaces. Normalize to the typical git branch
        // convention before validating so the user doesn't have to fight
        // their phone keyboard. We also tell them what we changed so they
        // can spot accidents (e.g. autocorrect "API" → "ap i").
        const branch = normalizeBranchName(text);
        if (!branch || !/^[a-zA-Z0-9._/-]+$/.test(branch)) {
          await this._sendText(
            token,
            chatId,
            "⚠️ Invalid branch name\\. Use letters, digits, `.` `_` `-` `/` \\(e\\.g\\. `feature/auth-fix`\\)\\.",
            true,
          );
          // Re-arm the same pending so user can try again
          this.pendingRequests.set(chatId, pending);
          return;
        }
        const draft = pending.draftTask;
        if (!draft) {
          log.warn("telegram worktree-branch-input: missing draftTask", { chatId });
          await this._sendText(token, chatId, "⚠️ Internal error — run /task again\\.");
          return;
        }
        log.info("telegram worktree-branch-input: branch received, asking description", {
          chatId,
          workspaceId: draft.parentWorkspaceId,
          rawInput: text,
          normalized: branch,
        });
        this.pendingRequests.set(chatId, {
          type: "task-description",
          workspaceId: draft.parentWorkspaceId,
          panelId: pending.panelId,
          createdAt: Date.now(),
          agentCommand: pending.agentCommand,
          draftTask: { ...draft, useWorktree: true, worktreeBranch: branch },
        });
        const normalizedNote = branch !== text.trim() ? `_\\(normalized from "${escapeMarkdown(text.trim())}"\\)_\n` : "";
        await this._sendText(
          token,
          chatId,
          `🌳 New worktree: *${escapeMarkdown(branch)}*\n${normalizedNote}📁 \`${escapeMarkdown(draft.parentCwd)}/.strideterm/tree/${escapeMarkdown(branch.replace(/\//g, "-"))}\`\n\nType the task description:`,
          true,
        );
        return;
      }

      if (pending.type === "task-description") {
        log.info("telegram task-description: requesting confirmation for start-task", {
          chatId,
          workspaceId: pending.workspaceId,
          panelId: pending.panelId,
          useWorktree: !!pending.draftTask?.useWorktree,
        });
        const draft = pending.draftTask;
        const cmd: TelegramCommandEvent = {
          type: "start-task",
          workspaceId: pending.workspaceId,
          panelId: pending.panelId,
          taskDescription: text,
          alertId: pending.alertId,
          agentCommand: pending.agentCommand || undefined,
          chatId,
          useWorktree: draft?.useWorktree || false,
          worktreeBranch: draft?.worktreeBranch,
          targetCwd: draft?.targetCwd,
        };
        const ws = this.getWorkspaces?.().find((w) => w.id === pending.workspaceId);
        const confirmText = this._buildStartTaskConfirmText(text, ws, draft);
        this.pendingRequests.set(chatId, {
          type: "confirm-action",
          workspaceId: pending.workspaceId,
          panelId: pending.panelId,
          alertId: pending.alertId,
          createdAt: Date.now(),
          pendingCmd: cmd,
        });
        await this._sendConfirmation(token, chatId, confirmText);
        return;
      }

      if (pending.type === "task-edit-description") {
        log.info("telegram task-edit-description: dispatching update", {
          chatId,
          workspaceId: pending.workspaceId,
          followUp: pending.followUp,
          length: text.length,
        });
        const cmd: TelegramCommandEvent = {
          type: "update-task-description",
          workspaceId: pending.workspaceId,
          panelId: pending.panelId,
          taskDescription: text,
          followUp: pending.followUp || "none",
          chatId,
        };
        this._audit({
          chatId,
          workspaceId: pending.workspaceId,
          operation: "updateTaskDescription",
          category: "write",
          method: "REPLY",
          url: "",
          success: true,
          userInitiated: true,
          resourceType: "task",
          resourceId: pending.workspaceId,
          summary: text.slice(0, 200),
        });
        this.emit("command", cmd);
        return;
      }

      if (pending.type === "file-path-input") {
        // _handleMessage rejects empty/whitespace-only text upstream, so by
        // the time we get here `text` is guaranteed non-empty.
        const filePath = text.trim();
        log.info("telegram file-path-input: asking delivery mode", {
          chatId,
          workspaceId: pending.workspaceId,
          filePath,
        });
        // Transition to mode selection: user picks "preview" (image-as-photo,
        // text-as-code-block, big-as-document) or "document" (always real
        // file attachment they can save/forward). This makes the "real file"
        // pathway explicit instead of guessing intent from the extension.
        this.pendingRequests.set(chatId, {
          type: "file-mode-selection",
          workspaceId: pending.workspaceId,
          panelId: pending.panelId,
          createdAt: Date.now(),
          pendingFilePath: filePath,
        });
        await this._apiCall(token, "sendMessage", {
          chat_id: chatId,
          text: `📂 \`${escapeMarkdown(filePath)}\` — *how should I send it?*`,
          parse_mode: "MarkdownV2",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📄 Preview", callback_data: "fm:a" },
                { text: "📥 As file", callback_data: "fm:d" },
              ],
              [{ text: "❌ Cancel", callback_data: "x" }],
            ],
          },
        }).catch((err) => {
          log.warn("telegram file-mode menu send failed", { err: (err as Error).message });
        });
        return;
      }

      if (pending.type === "screenshot-workspace-pick") {
        const idx = parseInt(text.trim(), 10) - 1;
        const choices = pending.workspaceChoices || [];
        const chosen = choices[idx];
        if (!chosen) {
          await this._sendText(
            token,
            chatId,
            `⚠️ Invalid choice\\. Enter a number 1–${escapeMarkdown(String(choices.length))}\\. Or run \`/screenshot\` again\\.`,
            true,
          );
          // Re-arm so user can retry without losing the candidate list.
          this.pendingRequests.set(chatId, pending);
          return;
        }
        log.info("telegram screenshot-workspace-pick: emitting", {
          chatId,
          workspaceId: chosen.id,
          name: chosen.name,
        });
        const cmd: TelegramCommandEvent = {
          type: "screenshot-workspace",
          workspaceId: chosen.id,
          panelId: "",
          chatId,
        };
        this._audit({
          chatId,
          workspaceId: chosen.id,
          operation: "screenshotWorkspace",
          category: "read",
          method: "REPLY",
          url: "",
          success: true,
          userInitiated: true,
          summary: chosen.name,
        });
        this.emit("command", cmd);
        await this._sendText(
          token,
          chatId,
          `📸 Switching to *${escapeMarkdown(chosen.name)}* and capturing screenshot…`,
          true,
        );
        return;
      }
    }

    // --- Reply to a known notification ---
    if (msg.reply_to_message?.message_id) {
      const entry = this.contextByMessageId.get(msg.reply_to_message.message_id);
      if (entry) {
        log.debug("telegram reply to known notification", {
          chatId,
          replyToMessageId: msg.reply_to_message.message_id,
          alertId: entry.context.alertId,
        });
        const ctx = entry.context;
        await this._dispatchTextReply(text, ctx, chatId, token, conn);
        return;
      }
    }

    // Unrecognized message — provide help
    log.debug("telegram message unrecognized", { chatId, textPreview: text.slice(0, 40) });
    await this._sendText(
      token,
      chatId,
      "ℹ️ Reply to a notification, or type /help to list commands\\.",
    );
  }

  // --- Command handlers ---

  private async _handleStatusCommand(chatId: string, token: string): Promise<void> {
    const workspaces = this.getWorkspaces?.() ?? [];
    const taskWs = workspaces.filter((w) => w.kind === "task" && w.task);

    if (taskWs.length === 0) {
      await this._sendText(token, chatId, "📊 No task agents are running\\.");
      return;
    }

    const lines = ["📊 *Task agent status:*", "_Tap a task for actions \\(pause, resume, edit, reset, …\\)_", ""];
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    // Telegram caps inline keyboards around 100 buttons total per message;
    // realistically users won't run more than a handful of tasks at once,
    // but slice defensively so a runaway state can't break the message.
    const VISIBLE = Math.min(taskWs.length, 60);
    for (let i = 0; i < VISIBLE; i++) {
      const ws = taskWs[i];
      const state = ws.task?.state || "unknown";
      const icon = this._taskStateIcon(state);
      lines.push(`${i + 1}\\. ${icon} *${escapeMarkdown(ws.name)}* \\(${escapeMarkdown(state)}\\)`);
      if (ws.cwd) lines.push(`   📁 \`${escapeMarkdown(ws.cwd)}\``);
      if (ws.task?.description) {
        lines.push(`   📝 ${escapeMarkdown(ws.task.description.slice(0, 100))}`);
      }
      buttons.push([{ text: `${icon} ${i + 1}. ${ws.name.slice(0, 32)}`, callback_data: `t:m:${ws.id}` }]);
    }
    if (taskWs.length > VISIBLE) {
      lines.push("");
      lines.push(`_… and ${taskWs.length - VISIBLE} more \\(hidden\\)_`);
    }

    await this._apiCall(token, "sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: buttons },
    }).catch((err) => {
      log.warn("telegram /status send failed", { err: (err as Error).message });
    });
  }

  private async _handleWorkspacesCommand(chatId: string, token: string): Promise<void> {
    const workspaces = this.getWorkspaces?.() ?? [];
    if (workspaces.length === 0) {
      await this._sendText(token, chatId, "🗂 No workspaces are open\\.");
      return;
    }

    const lines = ["🗂 *Workspaces:*", ""];
    for (let i = 0; i < workspaces.length; i++) {
      const ws = workspaces[i];
      const kindLabel = ws.task ? `task: ${ws.task.state}` : ws.kind;
      lines.push(`${i + 1}\\. *${escapeMarkdown(ws.name)}* \\(${escapeMarkdown(kindLabel)}\\)`);
      if (ws.cwd) lines.push(`   📁 \`${escapeMarkdown(ws.cwd)}\``);
    }

    await this._sendText(token, chatId, lines.join("\n"), true);
  }

  private async _handleTaskCommand(chatId: string, token: string, conn: TelegramConnectionConfig): Promise<void> {
    // Rate-limit: prevent rapid-fire /task spam from creating many workspaces.
    const last = this.lastTaskCommandAt.get(chatId) ?? 0;
    const sinceMs = Date.now() - last;
    if (sinceMs < TASK_COMMAND_COOLDOWN_MS) {
      const remaining = Math.ceil((TASK_COMMAND_COOLDOWN_MS - sinceMs) / 1000);
      log.info("telegram /task rate-limited", { chatId, remainingSec: remaining });
      await this._sendText(
        token,
        chatId,
        `⏳ Wait ${escapeMarkdown(String(remaining))}s before starting another /task\\.`,
      );
      return;
    }
    this.lastTaskCommandAt.set(chatId, Date.now());

    const workspaces = this.getWorkspaces?.() ?? [];
    const activeProfile = this.getActiveProfileId?.() || "default";
    // Only TRUE top-level workspaces of the current profile can host a task:
    //  - parentWorkspaceId empty (excludes review/quickfix/task children AND
    //    worktree children, both of which the runtime getter marks)
    //  - kind is a real container (not azure/github/docker/task)
    //  - has a workable cwd
    //  - belongs to the active profile (so the user doesn't accidentally
    //    create a task in another profile they aren't currently viewing)
    const candidates = workspaces.filter(
      (w) =>
        !w.parentWorkspaceId &&
        w.kind !== "azure" &&
        w.kind !== "github" &&
        w.kind !== "docker" &&
        w.kind !== "task" &&
        !!w.cwd &&
        (w.profileId || "default") === activeProfile,
    );

    if (candidates.length === 0) {
      log.info("telegram /task: no candidate workspaces", { chatId, activeProfile });
      await this._sendText(
        token,
        chatId,
        `⚠️ Profile *${escapeMarkdown(activeProfile)}* has no usable workspace\\.`,
        true,
      );
      return;
    }

    const lines = [`🗂 *Pick a workspace for the new task* \\(profile: *${escapeMarkdown(activeProfile)}*\\):`, ""];
    for (let i = 0; i < candidates.length; i++) {
      const ws = candidates[i];
      lines.push(`${i + 1}\\. *${escapeMarkdown(ws.name)}*`);
      if (ws.cwd) lines.push(`   📁 \`${escapeMarkdown(ws.cwd)}\``);
    }
    lines.push("");
    lines.push("Reply with a number \\(e\\.g\\. `1`\\)\\.");

    this.pendingRequests.set(chatId, {
      type: "workspace-selection",
      workspaceId: "",
      panelId: "",
      createdAt: Date.now(),
      agentCommand: conn.agentCommand || undefined,
      workspaceChoices: candidates,
    });

    log.info("telegram /task: presented workspace choices", {
      chatId,
      candidateCount: candidates.length,
      activeProfile,
    });

    await this._sendText(token, chatId, lines.join("\n"), true);
  }

  /**
   * `/screenshot` flow. Two entry points:
   *   - Current → emit `screenshot-current`, runtime captures whatever the
   *     user currently sees in the desktop window
   *   - Pick workspace → present workspace-selection (numbered list);
   *     after pick, emit `screenshot-workspace` so the runtime briefly
   *     activates that workspace, captures, then activates back
   */
  private async _handleScreenshotCommand(chatId: string, token: string): Promise<void> {
    const workspaces = this.getWorkspaces?.() ?? [];
    const activeProfile = this.getActiveProfileId?.() || "default";
    // For screenshots we WANT all workspaces — including children, tasks,
    // PR reviews — because a user might legitimately want a screenshot of
    // any of them. Only filter by active profile to keep the list short.
    const candidates = workspaces.filter((w) => (w.profileId || "default") === activeProfile);

    this.pendingRequests.set(chatId, {
      type: "screenshot-mode-selection",
      workspaceId: "",
      panelId: "",
      createdAt: Date.now(),
      workspaceChoices: candidates,
    });

    await this._apiCall(token, "sendMessage", {
      chat_id: chatId,
      text: "📸 *Screenshot the strIDEterm window* — what should I capture?",
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📸 Current workspace", callback_data: "ss:c" }],
          [{ text: "🗂 Pick another workspace", callback_data: "ss:w" }],
          [{ text: "❌ Cancel", callback_data: "x" }],
        ],
      },
    }).catch((err) => {
      log.warn("telegram /screenshot send failed", { err: (err as Error).message });
    });
  }

  /**
   * `/menu` — interactive hub. Mobile users don't memorise commands; this
   * gives them one-tap access to every other top-level flow. Each button
   * just dispatches to the corresponding command handler so behaviour
   * stays in sync with typed commands.
   *
   * Layout is two-wide where it makes sense (Status+Task as the most
   * common pair, Screenshot+Workspaces as the secondary pair) and a single
   * Help row at the bottom. Telegram renders this nicely on mobile and
   * desktop alike.
   */
  private async _handleMenuCommand(chatId: string, token: string): Promise<void> {
    // Show a small live snapshot in the menu header so the user sees what
    // matters most at a glance without having to drill in.
    const workspaces = this.getWorkspaces?.() ?? [];
    const activeProfile = this.getActiveProfileId?.() || "default";
    const profileWorkspaces = workspaces.filter((w) => (w.profileId || "default") === activeProfile);
    const activeTasks = profileWorkspaces.filter((w) => {
      const s = w.task?.state || "";
      return (
        w.kind === "task" && (s === "running" || s === "evaluating" || s === "judge-evaluating" || s === "refreshing")
      );
    });
    const idleTasks = profileWorkspaces.filter((w) => w.kind === "task" && w.task?.state === "idle");

    const lines = [
      "🤖 *strIDEterm bot — main menu*",
      "",
      `📂 Profile: *${escapeMarkdown(activeProfile)}*`,
      `🔄 Running: *${activeTasks.length}* · ⏸ Idle tasks: *${idleTasks.length}*`,
      "",
      "_Tap a button or type \\`/help\\` for the command list\\._",
    ];

    await this._apiCall(token, "sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📊 Status", callback_data: "mn:status" },
            { text: "🚀 New task", callback_data: "mn:task" },
          ],
          [
            { text: "📸 Screenshot", callback_data: "mn:screenshot" },
            { text: "🗂 Workspaces", callback_data: "mn:workspaces" },
          ],
          [{ text: "❓ Help", callback_data: "mn:help" }],
        ],
      },
    }).catch((err) => {
      log.warn("telegram /menu send failed", { err: (err as Error).message });
    });
  }

  private _buildStartTaskConfirmText(
    taskDescription: string,
    ws?: TelegramWorkspaceInfo,
    draft?: PendingRequest["draftTask"],
  ): string {
    const lines = [`🚀 Create task: _${escapeMarkdown(taskDescription.slice(0, 200))}_`];
    if (ws) {
      lines.push(`\n🗂 Workspace: *${escapeMarkdown(ws.name)}*`);
      if (ws.cwd) lines.push(`📁 Directory: \`${escapeMarkdown(ws.cwd)}\``);
    }
    if (draft?.useWorktree && draft.worktreeBranch) {
      lines.push(`🌳 New worktree: *${escapeMarkdown(draft.worktreeBranch)}*`);
    } else if (draft?.targetCwd) {
      lines.push(`📂 Existing worktree: \`${escapeMarkdown(draft.targetCwd)}\``);
    } else if (draft) {
      lines.push("📁 Runs directly in the parent cwd");
    }
    return lines.join("\n");
  }

  private _taskStateIcon(state: string): string {
    switch (state) {
      case "running":
        return "🔄";
      case "evaluating":
      case "judge-evaluating":
        return "🔍";
      case "completed":
      case "done":
        return "✅";
      case "failed":
        return "❌";
      case "paused":
        return "⏸";
      case "stopped":
        return "⏹";
      default:
        return "⏳";
    }
  }

  private async _dispatchTextReply(
    text: string,
    ctx: TelegramAlertContext,
    chatId: string,
    token: string,
    conn?: TelegramConnectionConfig,
  ): Promise<void> {
    const lower = text.toLowerCase().trim();

    if (lower === "dismiss" || lower === "ok" || lower === "done") {
      const cmd: TelegramCommandEvent = {
        type: "dismiss",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        alertId: ctx.alertId,
        prKey: ctx.prKey,
        provider: ctx.provider,
        chatId,
      };
      log.info("telegram reply: dismiss", { chatId, alertId: ctx.alertId, prKey: ctx.prKey });
      this._audit({
        chatId,
        workspaceId: ctx.workspaceId,
        operation: "dismiss",
        category: "write",
        method: "REPLY",
        url: "",
        success: true,
        userInitiated: true,
        resourceType: "alert",
        resourceId: ctx.alertId,
      });
      this.emit("command", cmd);
      await this._sendText(token, chatId, "✓ Dismissed\\.");
      return;
    }

    if (lower === "review" && ctx.prKey && ctx.provider) {
      const cmd: TelegramCommandEvent = {
        type: "open-pr-review",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        prKey: ctx.prKey,
        provider: ctx.provider,
        connectionId: ctx.connectionId,
        chatId,
      };
      log.info("telegram reply: review (asking confirm)", { chatId, prKey: ctx.prKey, provider: ctx.provider });
      // Require confirmation before opening PR review
      this.pendingRequests.set(chatId, {
        type: "confirm-action",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        createdAt: Date.now(),
        pendingCmd: cmd,
      });
      await this._sendConfirmation(token, chatId, "🔍 Open code review for this PR?");
      return;
    }

    if (ctx.kind === "completed" || ctx.kind === "waiting") {
      // User replied with a task description — require confirmation
      const cmd: TelegramCommandEvent = {
        type: "start-task",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        taskDescription: text,
        alertId: ctx.alertId,
        agentCommand: conn?.agentCommand || undefined,
        chatId,
      };
      log.info("telegram reply: start-task (asking confirm)", {
        chatId,
        workspaceId: ctx.workspaceId,
        descriptionPreview: text.slice(0, 80),
      });
      this.pendingRequests.set(chatId, {
        type: "confirm-action",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        alertId: ctx.alertId,
        createdAt: Date.now(),
        pendingCmd: cmd,
      });
      const ws = this.getWorkspaces?.().find((w) => w.id === ctx.workspaceId);
      await this._sendConfirmation(token, chatId, this._buildStartTaskConfirmText(text, ws));
      return;
    }

    // Generic reply — treat as custom message for extension
    const cmd: TelegramCommandEvent = {
      type: "custom-message",
      workspaceId: ctx.workspaceId,
      panelId: ctx.panelId,
      taskDescription: text,
      chatId,
    };
    log.info("telegram reply: custom-message", {
      chatId,
      workspaceId: ctx.workspaceId,
      textPreview: text.slice(0, 80),
    });
    this._audit({
      chatId,
      workspaceId: ctx.workspaceId,
      operation: "customMessage",
      category: "write",
      method: "REPLY",
      url: "",
      success: true,
      userInitiated: true,
      summary: text.slice(0, 200),
    });
    this.emit("command", cmd);
    await this._sendText(token, chatId, "✓ Message received\\.");
  }

  private async _handleCallbackQuery(
    query: TgCallbackQuery,
    conn: TelegramConnectionConfig,
    token: string,
  ): Promise<void> {
    if (!query.data || !query.message) {
      log.debug("telegram callback ignored: empty data or message");
      return;
    }

    const chatId = String(query.message.chat.id);
    if (chatId !== conn.chatId) {
      log.debug("telegram callback ignored: chatId mismatch");
      return;
    }

    // Acknowledge the button press immediately so Telegram dismisses the spinner.
    await this._apiCall(token, "answerCallbackQuery", { callback_query_id: query.id }, { retry: false }).catch(
      () => {},
    );

    const data = query.data;
    log.info("telegram callback received", {
      chatId,
      messageId: query.message.message_id,
      data: data.slice(0, 16),
    });

    // --- Task-action callbacks (prefixed `t:`) — encoded as `t:<op>:<wsId>` ---
    // Workspace IDs are `workspace-<uuid>` (~46 chars) which fits with prefix
    // inside Telegram's 64-byte callback_data limit.
    if (data.startsWith("t:")) {
      await this._handleTaskActionCallback(data, chatId, token, query.message.message_id);
      return;
    }

    // --- Worktree-mode callbacks (prefixed `m:`) — for /task post-selection ---
    // `m:d` = run directly in parent cwd, `m:n` = new worktree, `m:e` = existing,
    // `m:x:<idx>` = pick existing worktree at choice index.
    if (data.startsWith("m:")) {
      await this._handleWorktreeModeCallback(data, chatId, token, query.message.message_id);
      return;
    }

    // --- File-mode callbacks (prefixed `fm:`) — for the Get File flow ---
    // `fm:a` = auto (photo / code-block / document by extension+size)
    // `fm:d` = always send as document (real downloadable file attachment)
    if (data.startsWith("fm:")) {
      await this._handleFileModeCallback(data, chatId, token, query.message.message_id);
      return;
    }

    // --- Screenshot-mode callbacks (prefixed `ss:`) — for the /screenshot flow ---
    // `ss:c` = capture currently active workspace
    // `ss:w` = present workspace list to pick from (then numbered reply)
    if (data.startsWith("ss:")) {
      await this._handleScreenshotModeCallback(data, chatId, token, query.message.message_id);
      return;
    }

    // --- Main-menu callbacks (prefixed `mn:`) — for /menu hub ---
    // Each button just dispatches to the corresponding command handler.
    if (data.startsWith("mn:")) {
      await this._handleMenuCallback(data, chatId, token, conn);
      return;
    }

    const action = data as CallbackAction;

    if (action === "c") {
      // Confirm a pending action
      const pending = this.pendingRequests.get(chatId);
      if (
        pending &&
        pending.type === "confirm-action" &&
        pending.pendingCmd &&
        Date.now() - pending.createdAt < PENDING_TIMEOUT_MS
      ) {
        this.pendingRequests.delete(chatId);
        const cmdToEmit: TelegramCommandEvent = { ...pending.pendingCmd, chatId };
        log.info("telegram confirm: dispatching", {
          chatId,
          type: cmdToEmit.type,
          workspaceId: cmdToEmit.workspaceId,
        });
        this._audit({
          chatId,
          workspaceId: cmdToEmit.workspaceId,
          operation: cmdToEmit.type,
          category: "write",
          method: "BUTTON",
          url: "",
          success: true,
          userInitiated: true,
          resourceType: cmdToEmit.prKey ? "pullRequest" : "task",
          resourceId: cmdToEmit.prKey || cmdToEmit.alertId || "",
          summary: cmdToEmit.taskDescription?.slice(0, 200) || "",
        });
        this.emit("command", cmdToEmit);
        const confirmMsg = this._buildConfirmAcknowledgment(cmdToEmit);
        await this._answerText(token, chatId, query.message.message_id, confirmMsg);
      } else {
        log.warn("telegram confirm: no pending action", { chatId });
        this.pendingRequests.delete(chatId);
        await this._answerText(token, chatId, query.message.message_id, "⚠️ No pending action to confirm\\.");
      }
      return;
    }

    if (action === "x") {
      // Cancel
      const pending = this.pendingRequests.get(chatId);
      log.info("telegram cancel", { chatId, hadPending: !!pending });
      this.pendingRequests.delete(chatId);
      await this._answerText(token, chatId, query.message.message_id, "❌ Cancelled\\.");
      return;
    }

    // For start-task / open-pr / dismiss buttons, look up the alert context
    // from the message the button is attached to.
    const entry = this.contextByMessageId.get(query.message.message_id);
    if (!entry) {
      log.warn("telegram callback: no context for messageId — alert too old?", {
        messageId: query.message.message_id,
      });
      await this._answerText(
        token,
        chatId,
        query.message.message_id,
        "⚠️ This notification is no longer available \\(too old\\)\\.",
      );
      return;
    }
    const ctx = entry.context;

    if (action === "d") {
      const cmd: TelegramCommandEvent = {
        type: "dismiss",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        alertId: ctx.alertId,
        prKey: ctx.prKey,
        provider: ctx.provider,
        chatId,
      };
      log.info("telegram dismiss button", { chatId, alertId: ctx.alertId, prKey: ctx.prKey });
      this._audit({
        chatId,
        workspaceId: ctx.workspaceId,
        operation: "dismiss",
        category: "write",
        method: "BUTTON",
        url: "",
        success: true,
        userInitiated: true,
        resourceType: ctx.prKey ? "pullRequest" : "alert",
        resourceId: ctx.prKey || ctx.alertId,
      });
      this.emit("command", cmd);
      await this._answerText(token, chatId, query.message.message_id, "✓ Dismissed\\.");
      return;
    }

    if (action === "s") {
      // Ask user for the task description — no confirmation yet.
      this.pendingRequests.set(chatId, {
        type: "task-description",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        createdAt: Date.now(),
        agentCommand: conn.agentCommand || undefined,
      });
      log.info("telegram start-task button: awaiting description", {
        chatId,
        workspaceId: ctx.workspaceId,
      });
      await this._answerText(
        token,
        chatId,
        query.message.message_id,
        "📝 Please describe the next task \\(reply with the description\\):",
      );
      return;
    }

    if (action === "o") {
      if (!ctx.prKey || !ctx.provider) {
        log.warn("telegram open-pr button: context missing prKey/provider", { chatId });
        await this._answerText(token, chatId, query.message.message_id, "⚠️ Notifikace neobsahuje PR informaci\\.");
        return;
      }
      const cmd: TelegramCommandEvent = {
        type: "open-pr-review",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        prKey: ctx.prKey,
        provider: ctx.provider,
        connectionId: ctx.connectionId,
      };
      log.info("telegram open-pr button: asking confirm", {
        chatId,
        prKey: ctx.prKey,
        provider: ctx.provider,
      });
      this.pendingRequests.set(chatId, {
        type: "confirm-action",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        createdAt: Date.now(),
        pendingCmd: cmd,
      });
      await this._sendConfirmation(token, chatId, "🔍 Open code review for this PR?");
      return;
    }

    log.debug("telegram callback: unknown action code", { data: data.slice(0, 16) });
  }

  // ---------------------------------------------------------------------------
  // Task-action callbacks (interactive /status flow)
  // ---------------------------------------------------------------------------

  /**
   * Handle callbacks emitted by the per-task action menu shown after `/status`.
   * Encoding: `t:<op>:<wsId>` where `op` ∈ {m,p,r,o,x,e,c,g,b}.
   *
   *   m → menu (show action buttons for this task)
   *   p → pause (immediate, reversible)
   *   r → resume (immediate)
   *   o → stop (asks confirmation)
   *   x → reset (asks confirmation)
   *   e → edit description (waits for text reply)
   *   c → edit + continue (pause → edit → resume)
   *   g → edit + start (reset → edit → start)
   *   b → back to /status list
   */
  private async _handleTaskActionCallback(
    data: string,
    chatId: string,
    token: string,
    messageId: number,
  ): Promise<void> {
    const parts = data.split(":");
    const op = parts[1] || "";
    const wsId = parts.slice(2).join(":");

    if (op === "b") {
      await this._handleStatusCommand(chatId, token);
      return;
    }
    if (!wsId) {
      log.warn("telegram task callback: missing workspaceId", { data: data.slice(0, 16) });
      await this._answerText(token, chatId, messageId, "⚠️ Invalid callback\\.");
      return;
    }

    const ws = this.getWorkspaces?.().find((w) => w.id === wsId);
    if (!ws || ws.kind !== "task" || !ws.task) {
      log.warn("telegram task callback: workspace not found or not a task", { wsId });
      await this._answerText(token, chatId, messageId, "⚠️ Task no longer exists\\.");
      return;
    }

    if (op === "m") {
      await this._sendTaskActionMenu(chatId, token, ws);
      return;
    }

    const panelId = ws.panels[0]?.id || "";

    // --- Immediate, reversible actions: pause / resume — no confirmation ---
    if (op === "p") {
      this._emitTaskCommand({ type: "pause-task", workspaceId: wsId, panelId, chatId });
      await this._answerText(token, chatId, messageId, "⏸ Pausing…");
      return;
    }
    if (op === "r") {
      this._emitTaskCommand({ type: "resume-task", workspaceId: wsId, panelId, chatId });
      await this._answerText(token, chatId, messageId, "▶️ Resuming…");
      return;
    }

    // --- Destructive actions: stop / reset — require confirmation ---
    if (op === "o") {
      this.pendingRequests.set(chatId, {
        type: "confirm-action",
        workspaceId: wsId,
        panelId,
        createdAt: Date.now(),
        pendingCmd: { type: "stop-task", workspaceId: wsId, panelId },
      });
      await this._sendConfirmation(token, chatId, `⏹ Really stop task *${escapeMarkdown(ws.name)}*?`);
      return;
    }
    if (op === "x") {
      this.pendingRequests.set(chatId, {
        type: "confirm-action",
        workspaceId: wsId,
        panelId,
        createdAt: Date.now(),
        pendingCmd: { type: "reset-task", workspaceId: wsId, panelId },
      });
      await this._sendConfirmation(
        token,
        chatId,
        `🔄 Really reset task *${escapeMarkdown(ws.name)}* to IDLE? Round history will be cleared\\.`,
      );
      return;
    }

    // --- Screenshot of this workspace — emit directly, runtime activates briefly and captures ---
    if (op === "s") {
      const cmd: TelegramCommandEvent = {
        type: "screenshot-workspace",
        workspaceId: wsId,
        panelId,
        chatId,
      };
      this._audit({
        chatId,
        workspaceId: wsId,
        operation: "screenshotWorkspace",
        category: "read",
        method: "BUTTON",
        url: "",
        success: true,
        userInitiated: true,
        summary: ws.name,
      });
      this.emit("command", cmd);
      await this._answerText(
        token,
        chatId,
        messageId,
        `📸 Switching to *${escapeMarkdown(ws.name)}* and capturing screenshot…`,
      );
      return;
    }

    // --- Get file — wait for user to type a relative path ---
    if (op === "f") {
      this.pendingRequests.set(chatId, {
        type: "file-path-input",
        workspaceId: wsId,
        panelId,
        createdAt: Date.now(),
      });
      const cwdHint = ws.cwd ? `\n📁 \`${escapeMarkdown(ws.cwd)}\`` : "";
      await this._sendText(
        token,
        chatId,
        `📂 *${escapeMarkdown(ws.name)}* — type a relative file path${cwdHint}\n\n_E\\.g\\. \`TASK\\.md\` or \`notes\\.md\`_`,
        true,
      );
      return;
    }

    // --- Edit flows: e (just edit), c (edit + continue), g (edit + start) ---
    if (op === "e" || op === "c" || op === "g") {
      const followUp: PendingRequest["followUp"] = op === "e" ? "none" : op === "c" ? "resume" : "start";

      // Edit + Continue is offered from running states. resumeTask only works
      // from paused/completed/failed, so we must pause NOW so that the
      // post-edit `resume` actually flips the state. By the time the user
      // types a reply, the runtime will have processed the synchronous pause.
      const state = ws.task.state || "";
      const isRunning =
        state === "running" || state === "evaluating" || state === "judge-evaluating" || state === "refreshing";
      if (op === "c" && isRunning) {
        this._emitTaskCommand({ type: "pause-task", workspaceId: wsId, panelId, chatId });
      }

      this.pendingRequests.set(chatId, {
        type: "task-edit-description",
        workspaceId: wsId,
        panelId,
        createdAt: Date.now(),
        followUp,
      });
      const followLabel = op === "e" ? "" : op === "c" ? " then resume" : " then reset \\+ start";
      const current = ws.task.description ? `\n\n_Current:_ ${escapeMarkdown(ws.task.description.slice(0, 300))}` : "";
      await this._sendText(
        token,
        chatId,
        `📝 *${escapeMarkdown(ws.name)}* — type the new description${followLabel}:${current}`,
        true,
      );
      return;
    }

    log.debug("telegram task callback: unknown op", { op });
    await this._answerText(token, chatId, messageId, "⚠️ Unknown action\\.");
  }

  // ---------------------------------------------------------------------------
  // Worktree-mode menu (post /task workspace selection)
  // ---------------------------------------------------------------------------

  /**
   * Find existing worktree children of a parent workspace. Worktree children
   * are top-level by state (no parentWorkspaceId on the model itself), but
   * the runtime getter marks them with the synthetic `__worktree__` parent
   * id and they carry `notes: "Worktree of <parent name>"`. We match by name
   * prefix `<parent>/` AND notes prefix to be robust to either signal alone.
   */
  private _findExistingWorktrees(parent: TelegramWorkspaceInfo): TelegramWorkspaceInfo[] {
    const all = this.getWorkspaces?.() ?? [];
    const namePrefix = `${parent.name} / `;
    const notesNeedle = `Worktree of ${parent.name}`;
    return all.filter(
      (w) =>
        w.id !== parent.id && ((w.notes || "").startsWith(notesNeedle) || w.name.startsWith(namePrefix)) && !!w.cwd,
    );
  }

  private async _presentWorktreeModeMenu(
    token: string,
    chatId: string,
    parent: TelegramWorkspaceInfo,
    agentCommand?: string,
  ): Promise<void> {
    const existing = this._findExistingWorktrees(parent);
    const draft: PendingRequest["draftTask"] = {
      parentWorkspaceId: parent.id,
      parentName: parent.name,
      parentCwd: parent.cwd,
      useWorktree: false,
    };

    this.pendingRequests.set(chatId, {
      type: "worktree-mode-selection",
      workspaceId: parent.id,
      panelId: parent.panels[0]?.id || "",
      createdAt: Date.now(),
      agentCommand,
      draftTask: draft,
      worktreeChoices: existing,
    });

    const lines = [
      `🗂 Workspace: *${escapeMarkdown(parent.name)}*`,
      `📁 \`${escapeMarkdown(parent.cwd)}\``,
      "",
      "*Where should the task run?*",
    ];
    const rows: Array<Array<{ text: string; callback_data: string }>> = [
      [{ text: "🌳 New worktree (recommended)", callback_data: "m:n" }],
      [{ text: "📁 Directly in parent cwd", callback_data: "m:d" }],
    ];
    if (existing.length > 0) {
      rows.push([{ text: `📂 Existing worktree (${existing.length})`, callback_data: "m:e" }]);
    }
    rows.push([{ text: "❌ Cancel", callback_data: "x" }]);

    await this._apiCall(token, "sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: rows },
    }).catch((err) => {
      log.warn("telegram worktree-mode menu send failed", { err: (err as Error).message });
    });
  }

  private async _handleWorktreeModeCallback(
    data: string,
    chatId: string,
    token: string,
    messageId: number,
  ): Promise<void> {
    const parts = data.split(":");
    const op = parts[1] || "";
    const arg = parts.slice(2).join(":");

    const pending = this.pendingRequests.get(chatId);
    const acceptedTypes = new Set(["worktree-mode-selection", "worktree-existing-pick"]);
    if (!pending || !acceptedTypes.has(pending.type) || !pending.draftTask) {
      log.debug("telegram worktree-mode callback: no matching pending", { chatId, op });
      await this._answerText(token, chatId, messageId, "⚠️ This option is no longer active\\.");
      return;
    }
    if (Date.now() - pending.createdAt >= PENDING_TIMEOUT_MS) {
      this.pendingRequests.delete(chatId);
      await this._answerText(token, chatId, messageId, "⚠️ Option expired — run `/task` again\\.");
      return;
    }

    const draft = pending.draftTask;

    if (op === "d") {
      // Run directly in parent's cwd — go straight to description input
      this.pendingRequests.set(chatId, {
        type: "task-description",
        workspaceId: draft.parentWorkspaceId,
        panelId: pending.panelId,
        createdAt: Date.now(),
        agentCommand: pending.agentCommand,
        draftTask: { ...draft, useWorktree: false },
      });
      await this._answerText(
        token,
        chatId,
        messageId,
        `📁 Task will run directly in *${escapeMarkdown(draft.parentName)}*\\. Type the task description:`,
      );
      return;
    }

    if (op === "n") {
      // New worktree — ask for branch name
      this.pendingRequests.set(chatId, {
        type: "worktree-branch-input",
        workspaceId: draft.parentWorkspaceId,
        panelId: pending.panelId,
        createdAt: Date.now(),
        agentCommand: pending.agentCommand,
        draftTask: { ...draft, useWorktree: true },
      });
      await this._answerText(token, chatId, messageId, "🌳 Type the new branch name \\(e\\.g\\. `feature/auth-fix`\\):");
      return;
    }

    if (op === "e") {
      // Show list of existing worktrees as inline buttons
      const choices = pending.worktreeChoices || [];
      if (choices.length === 0) {
        await this._answerText(token, chatId, messageId, "⚠️ No existing worktrees found\\.");
        return;
      }
      const rows = choices.slice(0, 30).map((w, i) => {
        const branch = w.name.includes(" / ") ? w.name.split(" / ").slice(1).join(" / ") : w.name;
        return [{ text: `📂 ${branch}`.slice(0, 64), callback_data: `m:x:${i}` }];
      });
      rows.push([{ text: "❌ Cancel", callback_data: "x" }]);
      this.pendingRequests.set(chatId, {
        ...pending,
        type: "worktree-existing-pick",
        createdAt: Date.now(),
      });
      await this._apiCall(token, "sendMessage", {
        chat_id: chatId,
        text: `📂 *Pick an existing worktree* of *${escapeMarkdown(draft.parentName)}*:`,
        parse_mode: "MarkdownV2",
        reply_markup: { inline_keyboard: rows },
      }).catch((err) => {
        log.warn("telegram worktree-existing list send failed", { err: (err as Error).message });
      });
      return;
    }

    if (op === "x") {
      // Existing worktree picked by index
      if (pending.type !== "worktree-existing-pick") {
        await this._answerText(token, chatId, messageId, "⚠️ Wrong state\\.");
        return;
      }
      const idx = parseInt(arg, 10);
      const choices = pending.worktreeChoices || [];
      const chosen = choices[idx];
      if (!chosen) {
        await this._answerText(token, chatId, messageId, "⚠️ Invalid selection\\.");
        return;
      }
      this.pendingRequests.set(chatId, {
        type: "task-description",
        workspaceId: draft.parentWorkspaceId,
        panelId: pending.panelId,
        createdAt: Date.now(),
        agentCommand: pending.agentCommand,
        draftTask: { ...draft, useWorktree: false, targetCwd: chosen.cwd },
      });
      await this._answerText(
        token,
        chatId,
        messageId,
        `📂 Task will run in existing worktree *${escapeMarkdown(chosen.name)}*\\. Type the task description:`,
      );
      return;
    }

    log.debug("telegram worktree-mode callback: unknown op", { op });
    await this._answerText(token, chatId, messageId, "⚠️ Unknown option\\.");
  }

  /**
   * Handle delivery-mode choice for the Get File flow. Emits the
   * `send-task-file` command with the selected mode so the runtime knows
   * whether to honor extension-based auto-detection or force document
   * delivery.
   */
  private async _handleFileModeCallback(data: string, chatId: string, token: string, messageId: number): Promise<void> {
    const op = data.split(":")[1] || "";
    const pending = this.pendingRequests.get(chatId);
    if (!pending || pending.type !== "file-mode-selection" || !pending.pendingFilePath) {
      log.debug("telegram file-mode callback: no matching pending", { chatId, op });
      await this._answerText(token, chatId, messageId, "⚠️ This option is no longer active\\.");
      return;
    }
    if (Date.now() - pending.createdAt >= PENDING_TIMEOUT_MS) {
      this.pendingRequests.delete(chatId);
      await this._answerText(token, chatId, messageId, "⚠️ Option expired\\.");
      return;
    }

    const fileMode: TelegramCommandEvent["fileMode"] = op === "d" ? "document" : "auto";
    this.pendingRequests.delete(chatId);

    const cmd: TelegramCommandEvent = {
      type: "send-task-file",
      workspaceId: pending.workspaceId,
      panelId: pending.panelId,
      filePath: pending.pendingFilePath,
      fileMode,
      chatId,
    };
    this._audit({
      chatId,
      workspaceId: pending.workspaceId,
      operation: "sendTaskFile",
      category: "read",
      method: "BUTTON",
      url: "",
      success: true,
      userInitiated: true,
      resourceType: "file",
      resourceId: pending.pendingFilePath.slice(0, 200),
      summary: `mode=${fileMode}`,
    });
    this.emit("command", cmd);
    await this._answerText(
      token,
      chatId,
      messageId,
      fileMode === "document" ? "📥 Sending as file…" : "📄 Sending preview…",
    );
  }

  /**
   * Handles `/screenshot` mode buttons:
   *   - `ss:c` → capture currently active workspace, send photo back
   *   - `ss:w` → present workspace-pick list; user picks number, then we
   *     emit `screenshot-workspace` so the runtime briefly activates that
   *     workspace, captures, then switches back
   */
  private async _handleScreenshotModeCallback(
    data: string,
    chatId: string,
    token: string,
    messageId: number,
  ): Promise<void> {
    const op = data.split(":")[1] || "";
    const pending = this.pendingRequests.get(chatId);
    if (!pending || pending.type !== "screenshot-mode-selection") {
      log.debug("telegram screenshot-mode callback: no matching pending", { chatId, op });
      await this._answerText(token, chatId, messageId, "⚠️ This option is no longer active\\.");
      return;
    }
    if (Date.now() - pending.createdAt >= PENDING_TIMEOUT_MS) {
      this.pendingRequests.delete(chatId);
      await this._answerText(token, chatId, messageId, "⚠️ Option expired\\.");
      return;
    }

    if (op === "c") {
      this.pendingRequests.delete(chatId);
      const cmd: TelegramCommandEvent = {
        type: "screenshot-current",
        workspaceId: "",
        panelId: "",
        chatId,
      };
      this._audit({
        chatId,
        operation: "screenshotCurrent",
        category: "read",
        method: "BUTTON",
        url: "",
        success: true,
        userInitiated: true,
      });
      this.emit("command", cmd);
      await this._answerText(token, chatId, messageId, "📸 Capturing screenshot…");
      return;
    }

    if (op === "w") {
      const choices = pending.workspaceChoices || [];
      if (choices.length === 0) {
        this.pendingRequests.delete(chatId);
        await this._answerText(token, chatId, messageId, "⚠️ No workspaces in the active profile\\.");
        return;
      }
      // Transition to numbered-pick: user types a number to choose workspace.
      this.pendingRequests.set(chatId, {
        ...pending,
        type: "screenshot-workspace-pick",
        createdAt: Date.now(),
      });
      const lines = ["📸 *Pick a workspace to screenshot:*", ""];
      for (let i = 0; i < choices.length; i++) {
        lines.push(`${i + 1}\\. *${escapeMarkdown(choices[i].name)}*`);
      }
      lines.push("");
      lines.push("Reply with a number \\(e\\.g\\. `1`\\)\\.");
      await this._sendText(token, chatId, lines.join("\n"), true);
      return;
    }

    log.debug("telegram screenshot-mode callback: unknown op", { op });
  }

  /**
   * Dispatches a main-menu (`mn:`) button click to the corresponding
   * command handler. Each button is the same as typing the command —
   * no separate behaviour, single source of truth for each flow.
   */
  private async _handleMenuCallback(
    data: string,
    chatId: string,
    token: string,
    conn: TelegramConnectionConfig,
  ): Promise<void> {
    const op = data.split(":")[1] || "";
    log.info("telegram /menu button clicked", { chatId, op });
    switch (op) {
      case "status":
        await this._handleStatusCommand(chatId, token);
        return;
      case "task":
        await this._handleTaskCommand(chatId, token, conn);
        return;
      case "workspaces":
        await this._handleWorkspacesCommand(chatId, token);
        return;
      case "screenshot":
        await this._handleScreenshotCommand(chatId, token);
        return;
      case "help":
        await this._sendText(
          token,
          chatId,
          [
            "📖 *strIDEterm bot commands:*",
            "",
            "`/menu` — interactive main menu",
            "`/status` — show all task agents",
            "`/workspaces` — list workspaces",
            "`/task` — start a new task agent \\(workspace picker\\)",
            "`/screenshot` — capture a screenshot of the strIDEterm window",
            "",
            "Or reply to a specific notification using Telegram Reply and tap the inline buttons\\.",
          ].join("\n"),
          true,
        );
        return;
      default:
        log.debug("telegram /menu callback: unknown op", { op });
    }
  }

  /**
   * Public entry called from the runtime once a PNG buffer is captured.
   * Sends it via sendPhoto so the user gets an inline preview in chat
   * (and Telegram lets them save/forward the original PNG by tapping it).
   */
  async sendScreenshotPng(chatId: string, png: Buffer, workspaceName: string): Promise<void> {
    const conn = this.connections.find((c) => c.chatId === chatId);
    if (!conn) {
      log.warn("telegram sendScreenshotPng: no matching connection", { chatId });
      return;
    }
    const token = this.credentialStore.getSecret(conn.botTokenRef);
    if (!token) {
      log.warn("telegram sendScreenshotPng: no token", { chatId });
      return;
    }
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const filename = `strideterm-${ts}.png`;
    const caption = workspaceName ? `📸 strIDEterm — *${escapeMarkdown(workspaceName)}*` : "📸 strIDEterm";
    await this._sendPhoto(token, chatId, png, filename, caption);
  }

  private _emitTaskCommand(cmd: TelegramCommandEvent): void {
    this._audit({
      chatId: cmd.chatId,
      workspaceId: cmd.workspaceId,
      operation: cmd.type,
      category: "write",
      method: "BUTTON",
      url: "",
      success: true,
      userInitiated: true,
      resourceType: "task",
      resourceId: cmd.workspaceId,
    });
    this.emit("command", cmd);
  }

  private _buildConfirmAcknowledgment(cmd: TelegramCommandEvent): string {
    switch (cmd.type) {
      case "start-task":
        return `🚀 Creating task:\n_${escapeMarkdown((cmd.taskDescription || "").slice(0, 200))}_`;
      case "start-existing-task":
        return "▶️ Starting task…";
      case "stop-task":
        return "⏹ Stopping task…";
      case "reset-task":
        return "🔄 Resetting task…";
      case "open-pr-review":
        return "🔍 Opening code review workspace…";
      default:
        return "✅ OK\\.";
    }
  }

  private async _sendTaskActionMenu(chatId: string, token: string, ws: TelegramWorkspaceInfo): Promise<void> {
    const state = ws.task?.state || "unknown";
    const icon = this._taskStateIcon(state);
    const isRunning =
      state === "running" || state === "evaluating" || state === "judge-evaluating" || state === "refreshing";
    const isPaused = state === "paused" || state === "completed" || state === "failed";
    const isIdle = state === "idle";

    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    if (isRunning) {
      rows.push([{ text: "⏸ Pause", callback_data: `t:p:${ws.id}` }]);
      rows.push([{ text: "📝⏯ Edit + Continue", callback_data: `t:c:${ws.id}` }]);
      rows.push([{ text: "⏹ Stop", callback_data: `t:o:${ws.id}` }]);
    } else if (isPaused) {
      rows.push([{ text: "▶️ Resume", callback_data: `t:r:${ws.id}` }]);
      rows.push([
        { text: "📝 Edit", callback_data: `t:e:${ws.id}` },
        { text: "📝▶️ Edit + Start", callback_data: `t:g:${ws.id}` },
      ]);
      rows.push([{ text: "🔄 Reset", callback_data: `t:x:${ws.id}` }]);
    } else if (isIdle) {
      rows.push([
        { text: "📝 Edit", callback_data: `t:e:${ws.id}` },
        { text: "📝▶️ Edit + Start", callback_data: `t:g:${ws.id}` },
      ]);
    } else {
      // Unknown state — show a safe subset
      rows.push([
        { text: "▶️ Resume", callback_data: `t:r:${ws.id}` },
        { text: "📝 Edit", callback_data: `t:e:${ws.id}` },
      ]);
      rows.push([{ text: "🔄 Reset", callback_data: `t:x:${ws.id}` }]);
    }

    // "Get file" is available regardless of task state — user might want to
    // see the result of a completed task, peek at TASK.md while running, or
    // grab logs from a failed task.
    rows.push([
      { text: "📂 Get file", callback_data: `t:f:${ws.id}` },
      { text: "📸 Screenshot", callback_data: `t:s:${ws.id}` },
    ]);
    rows.push([{ text: "🔙 Back to /status", callback_data: "t:b:" }]);

    const lines = [`${icon} *${escapeMarkdown(ws.name)}* — \\(${escapeMarkdown(state)}\\)`];
    if (ws.task?.description) {
      lines.push(`📝 ${escapeMarkdown(ws.task.description.slice(0, 200))}`);
    }
    if (ws.cwd) lines.push(`📁 \`${escapeMarkdown(ws.cwd)}\``);

    await this._apiCall(token, "sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: rows },
    }).catch((err) => {
      log.warn("telegram task action menu send failed", { err: (err as Error).message });
    });
  }

  private async _answerText(token: string, chatId: string, replyToMessageId: number, text: string): Promise<void> {
    await this._sendText(token, chatId, text, false, replyToMessageId);
  }

  private async _sendConfirmation(token: string, chatId: string, promptText: string): Promise<void> {
    await this._apiCall(token, "sendMessage", {
      chat_id: chatId,
      text: promptText,
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm", callback_data: "c" },
            { text: "❌ Cancel", callback_data: "x" },
          ],
        ],
      },
    }).catch((err) => {
      log.warn("telegram sendConfirmation failed", { err: (err as Error).message });
    });
  }

  private async _sendText(
    token: string,
    chatId: string,
    text: string,
    useMarkdown = false,
    replyToMessageId?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (useMarkdown) {
      body.parse_mode = "MarkdownV2";
    }
    if (replyToMessageId) {
      body.reply_to_message_id = replyToMessageId;
    }
    await this._sendMessage(token, body).catch((err) => {
      log.warn("telegram sendText failed", { err: (err as Error).message });
    });
  }

  private _sendMessage(token: string, body: Record<string, unknown>): Promise<TgSendMessageResult> {
    return this._apiCall<TgSendMessageResult>(token, "sendMessage", body);
  }

  /**
   * Multipart file upload to Telegram (sendPhoto / sendDocument). Bypasses
   * the JSON path used by sendMessage because Telegram requires
   * multipart/form-data for file uploads.
   *
   * Caption is sent with parse_mode=MarkdownV2 so workspace name and path
   * formatting survive. Telegram caps caption at 1024 chars; we trim
   * defensively to keep within that even after escapes.
   */
  private async _uploadFile(
    token: string,
    method: "sendPhoto" | "sendDocument",
    chatId: string,
    fileField: "photo" | "document",
    buf: Buffer,
    filename: string,
    caption: string,
  ): Promise<void> {
    const fd = new FormData();
    fd.append("chat_id", chatId);
    // Buffer → Blob is fine in Node 18+; FormData accepts it.
    const blob = new Blob([new Uint8Array(buf)]);
    fd.append(fileField, blob, filename);
    if (caption) {
      fd.append("caption", caption.slice(0, 1024));
      fd.append("parse_mode", "MarkdownV2");
    }
    try {
      const url = `https://api.telegram.org/bot${token}/${method}`;
      const response = await fetch(url, {
        method: "POST",
        body: fd,
        signal: AbortSignal.timeout(60_000),
      });
      const json = (await response.json()) as { ok?: boolean; description?: string };
      if (!response.ok || !json.ok) {
        log.warn("telegram file upload failed", {
          method,
          status: response.status,
          description: json.description,
        });
        // Best-effort caption-as-text fallback so the user still sees something
        await this._sendText(
          token,
          chatId,
          `⚠️ ${escapeMarkdown(method)} selhal: \`${escapeMarkdown(json.description?.slice(0, 200) || "unknown")}\``,
          true,
        );
      }
    } catch (err) {
      log.warn("telegram file upload threw", { method, err: (err as Error).message });
      await this._sendText(token, chatId, `⚠️ Could not send file \\(network error\\)\\.`, true);
    }
  }

  private _sendPhoto(token: string, chatId: string, buf: Buffer, filename: string, caption: string): Promise<void> {
    return this._uploadFile(token, "sendPhoto", chatId, "photo", buf, filename, caption);
  }

  private _sendDocument(token: string, chatId: string, buf: Buffer, filename: string, caption: string): Promise<void> {
    return this._uploadFile(token, "sendDocument", chatId, "document", buf, filename, caption);
  }

  // ---------------------------------------------------------------------------
  // Low-level API call (Effect-based with retry, tracing spans, and tagged errors)
  // ---------------------------------------------------------------------------

  private _apiCall<T>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    opts: { httpTimeoutMs?: number; retry?: boolean } = {},
  ): Promise<T> {
    const httpTimeoutMs = opts.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const shouldRetry = opts.retry !== false;

    const fetchEff: Effect.Effect<T, TelegramError> = Effect.gen(function* () {
      const { status, parsed, raw } = yield* Effect.tryPromise({
        try: async () => {
          const url = `https://api.telegram.org/bot${token}/${method}`;
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(httpTimeoutMs),
          });
          const text = await response.text();
          let parsed: {
            ok?: boolean;
            error_code?: number;
            description?: string;
            parameters?: { retry_after?: number };
          };
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = {};
          }
          return { status: response.status, parsed: parsed as T & typeof parsed, raw: text };
        },
        catch: (e) => new TelegramNetworkError({ method, cause: e }),
      });

      // Map Telegram-level errors to tagged errors so retry policy can act on them.
      if (status === 401 || status === 403 || parsed.error_code === 401 || parsed.error_code === 403) {
        return yield* new TelegramAuthError({ method, description: parsed.description || raw.slice(0, 200) });
      }
      if (status === 429 || parsed.error_code === 429) {
        return yield* new TelegramRateLimitError({
          method,
          retryAfterSec: parsed.parameters?.retry_after ?? 1,
          description: parsed.description || raw.slice(0, 200),
        });
      }
      if (status >= 400) {
        // Includes 5xx (retryable) and other 4xx (non-retryable); the retry
        // schedule's `while` clause distinguishes them by statusCode.
        return yield* new TelegramApiError({
          method,
          statusCode: status,
          description: parsed.description || raw.slice(0, 200),
        });
      }

      return parsed as T;
    }).pipe(Effect.withSpan("Telegram.apiCall", { attributes: { method } }));

    const retryable = shouldRetry
      ? Effect.retry(fetchEff, {
          schedule: telegramRetry,
          // Retry only network errors and 5xx — auth, rate-limit, and 4xx fail fast.
          while: (err: TelegramError) =>
            err._tag === "TelegramNetworkError" || (err._tag === "TelegramApiError" && err.statusCode >= 500),
        })
      : fetchEff;

    return runEffect(
      Effect.catch(retryable, (err: TelegramError) => {
        // Translate tagged errors back to plain Errors at the boundary —
        // existing callers use try/catch and rely on Error.message.
        const message = (() => {
          switch (err._tag) {
            case "TelegramAuthError":
              return `Telegram auth failed: ${err.description}`;
            case "TelegramRateLimitError":
              return `Telegram rate limited (retry after ${err.retryAfterSec}s): ${err.description}`;
            case "TelegramApiError":
              return `Telegram API ${err.statusCode}: ${err.description}`;
            case "TelegramNetworkError":
              return `Telegram network error: ${(err.cause as Error)?.message || String(err.cause)}`;
          }
        })();
        log.warn("telegram apiCall failed", { method, tag: err._tag, message });
        return Effect.fail(new Error(message)) as Effect.Effect<T, Error>;
      }),
    ) as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _audit(entry: {
    chatId?: string;
    workspaceId?: string;
    operation: string;
    category: "read" | "write";
    method?: string;
    url?: string;
    statusCode?: number;
    success?: boolean;
    errorMessage?: string;
    durationMs?: number | null;
    resourceType?: string;
    resourceId?: string;
    summary?: string;
    userInitiated?: boolean;
  }): void {
    if (!this.auditLogStore) return;
    try {
      this.auditLogStore.logEntry({
        timestamp: new Date().toISOString(),
        connectionId: "",
        chatId: entry.chatId || "",
        workspaceId: entry.workspaceId || "",
        operation: entry.operation,
        category: entry.category,
        method: entry.method || "POST",
        url: entry.url || "",
        statusCode: entry.statusCode ?? null,
        success: entry.success !== false,
        errorMessage: entry.errorMessage || null,
        durationMs: entry.durationMs ?? null,
        resourceType: entry.resourceType || "",
        resourceId: entry.resourceId || "",
        summary: entry.summary || "",
        userInitiated: entry.userInitiated || false,
      });
    } catch (err) {
      log.warn("telegram audit log failed", { err: (err as Error).message });
    }
  }

  private _pruneContextMap(): void {
    if (this.contextByMessageId.size <= MAX_CONTEXT_ENTRIES) return;
    const cutoff = Date.now() - MAX_CONTEXT_AGE_MS;
    for (const [key, entry] of this.contextByMessageId) {
      if (entry.at < cutoff) {
        this.contextByMessageId.delete(key);
      }
    }
    // If still too large, remove oldest entries
    if (this.contextByMessageId.size > MAX_CONTEXT_ENTRIES) {
      const sorted = [...this.contextByMessageId.entries()].sort((a, b) => a[1].at - b[1].at);
      const toRemove = sorted.slice(0, sorted.length - MAX_CONTEXT_ENTRIES);
      for (const [key] of toRemove) {
        this.contextByMessageId.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape special characters for Telegram MarkdownV2.
 * Ref: https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, (char) => `\\${char}`);
}

/**
 * Normalize a user-typed git branch name from a chat input. Mobile keyboards
 * autocapitalize the first letter, slip in trailing spaces, smart-quote
 * punctuation, and Czech / other-Latin users have diacritics they typed
 * without thinking — none of which git accepts. We:
 *
 *   - NFD-decompose then strip combining marks (`česká` → `ceska`, `větev`
 *     → `vetev`) so Latin diacritics survive in usable form instead of
 *     having their base letters stripped along with the accent
 *   - lowercase everything (git is case-sensitive but lowercase is the de
 *     facto convention; users typing on a phone almost never *want*
 *     `Feature/Auth-Fix`)
 *   - normalize whitespace around `/` BEFORE replacing whitespace with `-`
 *     so `feature  /  auth` becomes `feature/auth` not `feature-/-auth`
 *   - replace runs of whitespace with a single hyphen
 *   - drop any character still outside the branch-allowed alphabet (smart
 *     quotes, emojis, en-dashes — git rejects them outright)
 *   - collapse repeated `-` and `/` and trim leading/trailing separators
 *
 * Returns "" when nothing valid survives, so the caller can re-ask.
 */
export function normalizeBranchName(input: string): string {
  if (!input) return "";
  // NFD splits accented chars into base+combining-mark; the regex strips the
  // marks (Unicode category \p{M}), keeping the base letters intact. This is
  // the standard "strip diacritics" idiom in JS — no transliteration tables.
  let s = input.normalize("NFD").replace(/\p{M}/gu, "");
  s = s.trim().toLowerCase();
  // Normalize whitespace around slashes BEFORE turning whitespace into `-`,
  // otherwise `feature  /  auth` ends up as `feature-/-auth`.
  s = s.replace(/\s*\/\s*/g, "/");
  s = s.replace(/\s+/g, "-");
  // Strip anything still outside the branch-allowed alphabet (smart quotes,
  // emojis, en-dashes — git rejects them outright).
  s = s.replace(/[^a-z0-9._/-]/g, "");
  // Collapse runs of separators, including mixed `-/-` patterns left over
  // from earlier substitutions.
  s = s.replace(/-+/g, "-").replace(/\/+/g, "/");
  s = s.replace(/-+\/-+|-+\/|\/-+/g, "/");
  // Trim leading/trailing `-` `/` `.` (git rejects refs starting/ending with `.` or `/`)
  s = s.replace(/^[-/.]+|[-/.]+$/g, "");
  return s;
}
