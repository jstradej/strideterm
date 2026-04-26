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
import type { CredentialStore } from "./shared/credential-store.js";
import { getLogger } from "./logger.js";

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
  type: "start-task" | "open-pr-review" | "confirm" | "dismiss" | "custom-message";
  workspaceId: string;
  panelId: string;
  prKey?: string;
  provider?: string;
  connectionId?: string;
  taskDescription?: string;
  alertId?: string;
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
}

// State machine for pending user input
interface PendingRequest {
  type: "task-description";
  workspaceId: string;
  panelId: string;
  alertId?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// TelegramManager
// ---------------------------------------------------------------------------

const MAX_CONTEXT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CONTEXT_ENTRIES = 500;
const PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class TelegramManager extends EventEmitter {
  private credentialStore: CredentialStore;
  private connections: TelegramConnectionConfig[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollOffset: number = 0;
  private running: boolean = false;

  /** Maps Telegram message_id → alert context, per connection */
  private contextByMessageId: Map<number, { context: TelegramAlertContext; connectionId: string; at: number }> =
    new Map();

  /** Pending text input requests (awaiting user's next message in chat) */
  private pendingRequests: Map<string, PendingRequest> = new Map(); // chatId → PendingRequest

  constructor({ credentialStore }: { credentialStore: CredentialStore }) {
    super();
    this.credentialStore = credentialStore;
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

  // ---------------------------------------------------------------------------
  // Public: send alert to all configured Telegram connections
  // ---------------------------------------------------------------------------

  async forwardAlert(payload: TelegramAlertPayload): Promise<void> {
    if (this.connections.length === 0) return;

    for (const conn of this.connections) {
      const forwardKinds = conn.forwardKinds;
      if (forwardKinds.length > 0 && !forwardKinds.includes(payload.kind)) {
        continue;
      }
      await this._sendAlertToConnection(conn, payload).catch((err) => {
        log.warn("telegram send alert failed", { connectionId: conn.id, err: (err as Error).message });
      });
    }
  }

  private async _sendAlertToConnection(conn: TelegramConnectionConfig, payload: TelegramAlertPayload): Promise<void> {
    const token = this.credentialStore.getSecret(conn.botTokenRef);
    if (!token) return;

    const text = this._buildAlertText(payload);
    const keyboard = this._buildKeyboard(payload);

    const result = await this._apiCall<TgSendMessageResult>(token, "sendMessage", {
      chat_id: conn.chatId,
      text,
      parse_mode: "MarkdownV2",
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });

    if (result.ok && result.result?.message_id) {
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
      this.contextByMessageId.set(result.result.message_id, {
        context: ctx,
        connectionId: conn.id,
        at: Date.now(),
      });
      this._pruneContextMap();
      log.debug("telegram alert sent", { messageId: result.result.message_id, kind: payload.kind });
    } else {
      log.warn("telegram sendMessage failed", { description: result.description });
    }
  }

  private _buildAlertText(payload: TelegramAlertPayload): string {
    const icon = this._kindIcon(payload.kind);
    const workspace = payload.workspaceName ? escapeMarkdown(payload.workspaceName) : "";
    const panel = payload.panelTitle ? escapeMarkdown(payload.panelTitle) : "";
    const title = escapeMarkdown(payload.title);
    const detail = payload.detail ? escapeMarkdown(this._humanizeDetail(payload.detail)) : "";

    const lines: string[] = [];
    lines.push(`${icon} *${title}*`);
    if (workspace || panel) {
      const loc = [workspace, panel].filter(Boolean).join(" › ");
      lines.push(`📍 ${loc}`);
    }
    if (detail) {
      lines.push(`_${detail}_`);
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
    const { kind, prKey, provider, workspaceId, panelId } = payload;

    if (kind === "completed" || kind === "waiting") {
      const data = JSON.stringify({ a: "start-task", w: workspaceId, p: panelId });
      if (data.length <= 64) {
        return [
          [
            { text: "🚀 New Task", callback_data: data },
            {
              text: "✓ Dismiss",
              callback_data: JSON.stringify({ a: "dismiss", w: workspaceId, p: panelId }).slice(0, 64),
            },
          ],
        ];
      }
    }

    if ((kind === "review" || prKey) && provider) {
      const data = JSON.stringify({ a: "open-pr", w: workspaceId, p: panelId, k: prKey, pv: provider });
      if (data.length <= 64) {
        return [
          [
            { text: "🔍 Open Review", callback_data: data },
            {
              text: "✓ Dismiss",
              callback_data: JSON.stringify({ a: "dismiss", w: workspaceId, p: panelId }).slice(0, 64),
            },
          ],
        ];
      }
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
  // Public: verify bot token + chat ID before saving connection
  // ---------------------------------------------------------------------------

  async verifyConnection(opts: {
    botToken: string;
    chatId: string;
  }): Promise<{ botUsername: string; chatTitle: string }> {
    const meResult = await this._apiCall<{
      ok: boolean;
      result?: { username?: string; first_name?: string };
      description?: string;
    }>(opts.botToken, "getMe", {});

    if (!meResult.ok) {
      throw new Error(`Telegram bot token invalid: ${meResult.description || "unknown error"}`);
    }

    const botUsername = meResult.result?.username || meResult.result?.first_name || "unknown";

    // Try sending a test message to verify chat access
    const chatResult = await this._apiCall<{
      ok: boolean;
      result?: { chat?: { title?: string; type?: string }; message_id?: number };
      description?: string;
    }>(opts.botToken, "sendMessage", {
      chat_id: opts.chatId,
      text: escapeMarkdown("✅ strIDEterm connected\\! Notifications will appear here\\."),
      parse_mode: "MarkdownV2",
    });

    if (!chatResult.ok) {
      throw new Error(`Cannot send to chat ${opts.chatId}: ${chatResult.description || "access denied"}`);
    }

    const chatTitle = String(opts.chatId);
    return { botUsername, chatTitle };
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this._scheduleNextPoll();
    log.info("telegram polling started");
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
    const intervalMs = Math.min(...this.connections.map((c) => c.pollSeconds * 1000), 5000);
    const delay = this.connections.length > 0 ? intervalMs : 5000;
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
    if (!token) return;

    const result = await this._apiCall<{
      ok: boolean;
      result?: TgUpdate[];
      description?: string;
    }>(token, "getUpdates", {
      offset: this.pollOffset,
      timeout: 0,
      limit: 100,
      allowed_updates: ["message", "callback_query"],
    });

    if (!result.ok || !result.result) {
      log.debug("telegram getUpdates returned non-ok", { description: result.description });
      return;
    }

    for (const update of result.result) {
      this.pollOffset = Math.max(this.pollOffset, update.update_id + 1);

      if (update.message) {
        await this._handleMessage(update.message, conn, token);
      } else if (update.callback_query) {
        await this._handleCallbackQuery(update.callback_query, conn, token);
      }
    }
  }

  private async _handleMessage(msg: TgMessage, conn: TelegramConnectionConfig, token: string): Promise<void> {
    const chatId = String(msg.chat.id);
    if (chatId !== conn.chatId) return; // only process messages from configured chat

    const text = (msg.text || "").trim();
    if (!text) return;

    log.debug("telegram message received", { messageId: msg.message_id, chatId });

    // Check for pending request (bot is expecting a text reply)
    const pending = this.pendingRequests.get(chatId);
    if (pending && Date.now() - pending.createdAt < PENDING_TIMEOUT_MS) {
      this.pendingRequests.delete(chatId);

      if (pending.type === "task-description") {
        log.info("telegram: dispatching start-task from pending request", {
          workspaceId: pending.workspaceId,
          panelId: pending.panelId,
        });
        const cmd: TelegramCommandEvent = {
          type: "start-task",
          workspaceId: pending.workspaceId,
          panelId: pending.panelId,
          taskDescription: text,
          alertId: pending.alertId,
        };
        this.emit("command", cmd);
        await this._sendText(token, chatId, `🚀 Starting new task:\n_${escapeMarkdown(text.slice(0, 200))}_`, true);
        return;
      }
    }

    // Check if this is a reply to a known notification
    if (msg.reply_to_message?.message_id) {
      const entry = this.contextByMessageId.get(msg.reply_to_message.message_id);
      if (entry) {
        const ctx = entry.context;
        await this._dispatchTextReply(text, ctx, chatId, token);
        return;
      }
    }

    // Unrecognized message — provide help
    await this._sendText(
      token,
      chatId,
      "ℹ️ Reply to a strIDEterm notification to interact with it, or press the inline buttons\\.",
    );
  }

  private async _dispatchTextReply(
    text: string,
    ctx: TelegramAlertContext,
    chatId: string,
    token: string,
  ): Promise<void> {
    const lower = text.toLowerCase().trim();

    if (lower === "dismiss" || lower === "ok" || lower === "done") {
      const cmd: TelegramCommandEvent = {
        type: "dismiss",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        alertId: ctx.alertId,
      };
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
      };
      this.emit("command", cmd);
      await this._sendText(token, chatId, "🔍 Opening code review workspace…");
      return;
    }

    if (ctx.kind === "completed" || ctx.kind === "waiting") {
      // User replied with a task description
      const cmd: TelegramCommandEvent = {
        type: "start-task",
        workspaceId: ctx.workspaceId,
        panelId: ctx.panelId,
        taskDescription: text,
        alertId: ctx.alertId,
      };
      this.emit("command", cmd);
      await this._sendText(token, chatId, `🚀 Starting new task:\n_${escapeMarkdown(text.slice(0, 200))}_`, true);
      return;
    }

    // Generic reply — treat as custom message for extension
    const cmd: TelegramCommandEvent = {
      type: "custom-message",
      workspaceId: ctx.workspaceId,
      panelId: ctx.panelId,
      taskDescription: text,
    };
    this.emit("command", cmd);
    await this._sendText(token, chatId, "✓ Message received\\.");
  }

  private async _handleCallbackQuery(
    query: TgCallbackQuery,
    conn: TelegramConnectionConfig,
    token: string,
  ): Promise<void> {
    if (!query.data || !query.message) return;

    const chatId = String(query.message.chat.id);
    if (chatId !== conn.chatId) return;

    // Acknowledge the button press immediately
    await this._apiCall(token, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});

    let action: Record<string, string>;
    try {
      action = JSON.parse(query.data) as Record<string, string>;
    } catch {
      return;
    }

    const workspaceId = action.w || "";
    const panelId = action.p || "";

    if (action.a === "dismiss") {
      const cmd: TelegramCommandEvent = { type: "dismiss", workspaceId, panelId };
      this.emit("command", cmd);
      await this._answerText(token, chatId, query.message.message_id, "✓ Dismissed\\.");
      return;
    }

    if (action.a === "start-task") {
      // Ask user for the task description
      this.pendingRequests.set(chatId, {
        type: "task-description",
        workspaceId,
        panelId,
        createdAt: Date.now(),
      });
      await this._answerText(
        token,
        chatId,
        query.message.message_id,
        "📝 Please describe the next task \\(reply with the description\\):",
      );
      return;
    }

    if (action.a === "open-pr") {
      const prKey = action.k || "";
      const provider = action.pv || "";
      const cmd: TelegramCommandEvent = {
        type: "open-pr-review",
        workspaceId,
        panelId,
        prKey,
        provider,
      };
      this.emit("command", cmd);
      await this._answerText(token, chatId, query.message.message_id, "🔍 Opening code review workspace…");
      return;
    }
  }

  private async _answerText(token: string, chatId: string, replyToMessageId: number, text: string): Promise<void> {
    await this._sendText(token, chatId, text, false, replyToMessageId);
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
    await this._apiCall(token, "sendMessage", body).catch((err) => {
      log.warn("telegram sendText failed", { err: (err as Error).message });
    });
  }

  // ---------------------------------------------------------------------------
  // Low-level API call
  // ---------------------------------------------------------------------------

  private async _apiCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Telegram API HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return response.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
