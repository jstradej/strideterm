import { createHash, randomUUID } from "node:crypto";
import { getLogger } from "../logger.js";
import {
  applyJiraCommentAttribution,
  type JiraAttributionNames,
  type JiraCommentAttribution,
} from "../../shared/jira-comment-attribution.js";
import { errorCauseCode, JiraRequestError } from "./jira-request-error.js";
import {
  JiraWriteJournal,
  JiraWriteJournalError,
  jiraWriteFingerprint,
  type JiraWriteJournalEntry,
  type JiraWriteMetadata,
  type JiraWriteReconciliation,
} from "./jira-write-journal.js";

const log = getLogger("jira");

/** A refusal whose message was written by this module and is meant for the user as it stands. */
export class JiraWriteSafetyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JiraWriteSafetyError";
  }
}

/** Statuses after which Jira has certainly not applied the write. */
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429]);

export interface JiraWriteFailureClass {
  /** `rejected`: Jira answered and did not apply it. `not-sent`: nothing left this machine. `unknown`: it may have been applied. */
  kind: "rejected" | "not-sent" | "unknown";
  code: string;
  statusCode?: number;
  retryAfterMs?: number;
  causeCode?: string;
  detail?: string;
}

/** Decides by the failure's own facts (status, whether it was sent), never by comparing message text. */
export function classifyJiraWriteFailure(error: unknown): JiraWriteFailureClass {
  if (!(error instanceof JiraRequestError)) return { kind: "unknown", code: "provider-error" };
  const base = {
    code: error.code,
    ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(errorCauseCode(error.cause) ? { causeCode: errorCauseCode(error.cause) } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
  };
  if (error.notSent) return { kind: "not-sent", ...base };
  if (error.statusCode !== undefined && REJECTED_STATUSES.has(error.statusCode)) return { kind: "rejected", ...base };
  return { kind: "unknown", ...base };
}

/** The journal's `safeCode` for a classified failure: the code, plus the status when Jira answered. */
export function jiraWriteFailureSafeCode(failure: JiraWriteFailureClass): string {
  if (failure.kind === "not-sent") return `not-sent:${failure.code}`.slice(0, 60);
  if (failure.code === "provider-error") return "provider-error";
  return failure.statusCode !== undefined ? `${failure.code}:${failure.statusCode}` : failure.code;
}

function describeJournalFailure(error: unknown): string {
  let text = "";
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error) text += ` | ${current.message}`;
    current = (current as { cause?: unknown }).cause;
  }
  if (/encrypted storage is required|secure storage/i.test(text))
    return "Jira write safety needs secure storage (the operating system's credential store), which is not available. No Jira request was sent.";
  if (/journal storage is invalid/i.test(text))
    return "The saved Jira write history is unreadable, so writes are blocked to stay safe. No Jira request was sent.";
  return "Jira write intent could not be persisted; no Jira request was sent.";
}

export interface JiraWriteAuditContext {
  profileId: string;
  requester: string;
  apiActor: string;
  actor?: { kind: "cloud"; accountId: string } | { kind: "data-center"; name: string };
  /** Read from the current state each time; only technical-account comments use it. */
  commentAttribution?: { setting: JiraCommentAttribution; names: JiraAttributionNames };
}

export interface JiraWriteIssue {
  connectionId: string;
  issueId: string;
  issueKey: string;
}
export type JiraWriteIdentity = { kind: "cloud"; accountId: string } | { kind: "data-center"; name: string };
export interface JiraTransitionOption {
  id: string;
  name: string;
  requiredFields?: Array<{
    id: string;
    name: string;
    type: string;
    required?: boolean;
    supported?: boolean;
    allowedValues?: Array<{ value: string; label: string }>;
  }>;
  to?: string;
}
export interface JiraAttachmentUpload {
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}
export interface JiraWriteConfirmation {
  token: string;
  intent: string;
  preview: string;
}

type Action =
  | { kind: "transition"; issue: JiraWriteIssue; transitionId: string; fields: Record<string, unknown> }
  | { kind: "comment"; issue: JiraWriteIssue; body: string; postedBody: string }
  | { kind: "worklog"; issue: JiraWriteIssue; seconds: number; started: string; comment: string }
  | { kind: "remote-link"; issue: JiraWriteIssue; url: string; title: string; globalId: string }
  | { kind: "assign"; issue: JiraWriteIssue; target: JiraAssignTarget };

/** `id` is a Cloud account id or a Data Center user name; the connection decides which. */
export type JiraAssignTarget = { kind: "user"; id: string } | { kind: "unassigned" };
export type JiraAssignRequest =
  { kind: "user"; id: string; displayName?: string } | { kind: "me" } | { kind: "unassigned" };

/** Process-local, single-use confirmations bind explicit user intent to exact write parameters. */
export class JiraWriteSafety {
  private confirmations = new Map<string, { action: Action; intent: string; preview: string; expiresAt: number }>();
  constructor(
    private readonly hooks: {
      listTransitions(issue: JiraWriteIssue): Promise<JiraTransitionOption[]>;
      transition(issue: JiraWriteIssue, transitionId: string, fields: Record<string, unknown>): Promise<unknown>;
      addComment(issue: JiraWriteIssue, body: string): Promise<unknown>;
      addRemoteLink(issue: JiraWriteIssue, data: { url: string; title: string; globalId: string }): Promise<unknown>;
      addWorklog(
        issue: JiraWriteIssue,
        data: { timeSpentSeconds: number; started: string; comment?: string },
      ): Promise<unknown>;
      assign?(issue: JiraWriteIssue, target: JiraAssignTarget): Promise<unknown>;
      currentAssignee?(issue: JiraWriteIssue): Promise<{ id: string; displayName: string }>;
      /** The user's own Jira identity on this connection, when one was chosen and verified. */
      resolveMe?(connectionId: string): Promise<(JiraWriteIdentity & { displayName?: string }) | undefined>;
      uploadAttachment?(issue: JiraWriteIssue, file: JiraAttachmentUpload): Promise<unknown>;
      countAttachmentsLike?(issue: JiraWriteIssue, match: { nameHash: string; size: number }): Promise<number>;
      getMyself(connectionId: string): Promise<JiraWriteIdentity>;
      canWorklog(connectionId: string, issue: JiraWriteIssue): Promise<boolean>;
      journal?: JiraWriteJournal;
      getAuditContext?(issue: JiraWriteIssue): Promise<JiraWriteAuditContext>;
      freshIssueState?(issue: JiraWriteIssue): Promise<{ status: string; updated: string }>;
      reconcile?(entry: JiraWriteJournalEntry): Promise<JiraWriteReconciliation | "unknown">;
    },
  ) {}

  async getHistory(profileId: string, filter: { connectionId?: string; issueId?: string; limit?: number } = {}) {
    if (!this.hooks.journal) throw new JiraWriteSafetyError("Jira write journal is unavailable.");
    return this.hooks.journal.list({ profileId, ...filter });
  }

  async reconcileWrite(profileId: string, id: string) {
    const journal = this.requireJournal();
    const entry = await journal.get(id);
    if (!entry || entry.profileId !== profileId) throw new JiraWriteSafetyError("Jira write record was not found.");
    if (entry.state !== "unknown" && entry.state !== "pending")
      throw new JiraWriteSafetyError("This Jira write does not need reconciliation.");
    if (!this.hooks.reconcile) throw new JiraWriteSafetyError("Jira write reconciliation is unavailable.");
    const outcome: JiraWriteReconciliation = await this.hooks
      .reconcile(entry)
      .then((result) => (result === "unknown" ? "unresolved" : result))
      .catch((error: unknown): JiraWriteReconciliation => {
        log.warn("jira write reconciliation could not reach Jira; the write stays unresolved", {
          journalId: id,
          connectionId: entry.connectionId,
          issueKey: entry.issueKey,
          op: entry.kind,
          code: error instanceof JiraRequestError ? error.code : "provider-error",
          ...(error instanceof JiraRequestError && error.statusCode !== undefined
            ? { statusCode: error.statusCode }
            : {}),
        });
        return "unresolved";
      });
    const updated = await journal.markReconciled(entry.id, outcome);
    return { journalId: id, status: updated.state, outcome };
  }

  async previewTransition(
    issue: JiraWriteIssue,
    transitionId: string,
    intent: string,
    fields: Record<string, unknown> = {},
  ): Promise<JiraWriteConfirmation> {
    this.requireIntent(intent);
    // Always fetch immediately before preview; execute fetches again before the write.
    const transitions = await this.hooks.listTransitions(issue);
    const selected = transitions.find((item) => item.id === transitionId);
    if (!selected) throw new JiraWriteSafetyError("That Jira transition is no longer available.");
    const unsupportedRequired = (selected.requiredFields || []).filter(
      (field) => field.required !== false && field.supported === false,
    );
    if (unsupportedRequired.length)
      throw new JiraWriteSafetyError(
        `Jira requires unsupported fields: ${unsupportedRequired.map((field) => field.name).join(", ")}.`,
      );
    const allowed = new Set(
      (selected.requiredFields || []).filter((field) => field.supported !== false).map((field) => field.id),
    );
    const unsupported = Object.keys(fields).filter((id) => !allowed.has(id));
    if (unsupported.length)
      throw new JiraWriteSafetyError(`Unsupported Jira transition fields: ${unsupported.join(", ")}.`);
    const missing = (selected.requiredFields || []).filter(
      (field) => field.required !== false && (fields[field.id] == null || fields[field.id] === ""),
    );
    if (missing.length)
      throw new JiraWriteSafetyError(
        `Required Jira transition fields are missing: ${missing.map((field) => field.name).join(", ")}.`,
      );
    return this.confirm(
      { kind: "transition", issue, transitionId, fields },
      intent,
      `Transition ${issue.issueKey} to ${selected.name}${Object.keys(fields).length ? `\nFields: ${JSON.stringify(fields)}` : ""}`,
    );
  }

  async executeTransition(
    issue: JiraWriteIssue,
    transitionId: string,
    confirmation: JiraWriteConfirmation,
    fields: Record<string, unknown> = {},
  ): Promise<unknown> {
    const action: Action = { kind: "transition", issue, transitionId, fields };
    this.consume(action, confirmation);
    const transitions = await this.hooks.listTransitions(issue);
    const selected = transitions.find((item) => item.id === transitionId);
    if (!selected) throw new JiraWriteSafetyError("That Jira transition is no longer available.");
    const unsupportedRequired = (selected.requiredFields || []).filter(
      (field) => field.required !== false && field.supported === false,
    );
    if (unsupportedRequired.length)
      throw new JiraWriteSafetyError(
        `Jira requires unsupported fields: ${unsupportedRequired.map((field) => field.name).join(", ")}.`,
      );
    const allowed = new Set(
      (selected.requiredFields || []).filter((field) => field.supported !== false).map((field) => field.id),
    );
    const unsupported = Object.keys(fields).filter((id) => !allowed.has(id));
    if (unsupported.length)
      throw new JiraWriteSafetyError(`Unsupported Jira transition fields: ${unsupported.join(", ")}.`);
    const missing = (selected.requiredFields || []).filter(
      (field) => field.required !== false && (fields[field.id] == null || fields[field.id] === ""),
    );
    if (missing.length)
      throw new JiraWriteSafetyError(
        `Required Jira transition fields are missing: ${missing.map((field) => field.name).join(", ")}.`,
      );
    const before = this.hooks.freshIssueState
      ? await this.hooks.freshIssueState(issue)
      : { status: "Unknown", updated: "" };
    const metadata: JiraWriteMetadata = {
      kind: "transition",
      transitionId,
      targetStatus: selected.to || selected.name,
      beforeStatus: before.status,
      beforeUpdatedAt: before.updated,
    };
    return this.durableWrite(issue, "transition", { transitionId, fields }, metadata, () =>
      this.hooks.transition(issue, transitionId, fields),
    );
  }

  async previewComment(
    issue: JiraWriteIssue,
    body: string,
    intent: string,
    accountPurpose: "personal" | "technical",
  ): Promise<JiraWriteConfirmation> {
    this.requireIntent(intent);
    this.requireBody(body);
    const audit = await this.auditContext(issue);
    const postedBody =
      accountPurpose === "technical" && audit.commentAttribution
        ? applyJiraCommentAttribution(body, audit.commentAttribution.setting, audit.commentAttribution.names)
        : body;
    return this.confirm({ kind: "comment", issue, body, postedBody }, intent, postedBody);
  }

  async executeComment(issue: JiraWriteIssue, body: string, confirmation: JiraWriteConfirmation): Promise<unknown> {
    const saved = this.confirmations.get(confirmation?.token)?.action;
    if (!saved || saved.kind !== "comment")
      throw new JiraWriteSafetyError("Explicit confirmation is missing, expired, or does not match this Jira write.");
    const action: Action = { kind: "comment", issue, body, postedBody: saved.postedBody };
    this.consume(action, confirmation);
    const postedAt = Date.now();
    return this.durableWrite(
      issue,
      "comment",
      { body: saved.postedBody },
      { kind: "comment", bodyHash: hashWriteText(normalizeWriteText(saved.postedBody)), submittedAt: postedAt },
      () => this.hooks.addComment(issue, saved.postedBody),
    );
  }

  async previewWorklog(
    issue: JiraWriteIssue,
    input: { seconds: number; started: string; comment?: string },
    intent: string,
    accountPurpose: "personal" | "technical",
    verifiedIdentity?: JiraWriteIdentity,
  ): Promise<JiraWriteConfirmation> {
    this.requireIntent(intent);
    if (accountPurpose !== "personal") throw new JiraWriteSafetyError("Worklogs require a personal Jira account.");
    if (!verifiedIdentity) throw new JiraWriteSafetyError("Verify the personal Jira account before logging work.");
    const current = await this.hooks.getMyself(issue.connectionId);
    if (!sameIdentity(current, verifiedIdentity))
      throw new JiraWriteSafetyError("The current Jira user no longer matches the verified personal account.");
    if (!(await this.hooks.canWorklog(issue.connectionId, issue)))
      throw new JiraWriteSafetyError("This Jira account cannot log work on this issue.");
    if (!Number.isInteger(input.seconds) || input.seconds <= 0)
      throw new JiraWriteSafetyError("Worklog duration must be positive whole seconds.");
    if (!Number.isFinite(Date.parse(input.started))) throw new JiraWriteSafetyError("Worklog start time is invalid.");
    const action: Action = {
      kind: "worklog",
      issue,
      seconds: input.seconds,
      started: input.started,
      comment: input.comment || "",
    };
    return this.confirm(
      action,
      intent,
      `Log ${input.seconds} seconds on ${issue.issueKey}${input.comment ? `\n${input.comment}` : ""}`,
    );
  }

  async executeWorklog(
    issue: JiraWriteIssue,
    input: { seconds: number; started: string; comment?: string },
    confirmation: JiraWriteConfirmation,
    accountPurpose: "personal" | "technical",
    verifiedIdentity?: JiraWriteIdentity,
  ): Promise<unknown> {
    const action: Action = {
      kind: "worklog",
      issue,
      seconds: input.seconds,
      started: input.started,
      comment: input.comment || "",
    };
    this.consume(action, confirmation);
    if (accountPurpose !== "personal" || !verifiedIdentity)
      throw new JiraWriteSafetyError("Worklogs require a verified personal Jira account.");
    const current = await this.hooks.getMyself(issue.connectionId);
    if (!sameIdentity(current, verifiedIdentity))
      throw new JiraWriteSafetyError("The current Jira user no longer matches the verified personal account.");
    if (!(await this.hooks.canWorklog(issue.connectionId, issue)))
      throw new JiraWriteSafetyError("This Jira account cannot log work on this issue.");
    const started = input.started;
    const comment = input.comment || "";
    const postedAt = Date.now();
    return this.durableWrite(
      issue,
      "worklog",
      { seconds: input.seconds, started, comment },
      {
        kind: "worklog",
        fingerprint: jiraWriteFingerprint({ seconds: input.seconds, started, comment: normalizeWriteText(comment) }),
        submittedAt: postedAt,
        seconds: input.seconds,
        started,
        commentHash: hashWriteText(normalizeWriteText(comment)),
      },
      () =>
        this.hooks.addWorklog(issue, {
          timeSpentSeconds: input.seconds,
          started: input.started,
          ...(input.comment ? { comment: input.comment } : {}),
        }),
    );
  }

  previewRemoteLink(
    issue: JiraWriteIssue,
    input: { url: string; title: string; globalId: string },
    intent: string,
  ): JiraWriteConfirmation {
    this.requireIntent(intent);
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new JiraWriteSafetyError("Remote link URL is invalid.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !input.title.trim() ||
      input.title.length > 500 ||
      !input.globalId.trim() ||
      input.globalId.length > 1000
    )
      throw new JiraWriteSafetyError("Remote link URL, title, or global id is invalid.");
    const action: Action = {
      kind: "remote-link",
      issue,
      url: url.toString(),
      title: input.title.trim(),
      globalId: input.globalId,
    };
    return this.confirm(action, intent, `Add link to ${issue.issueKey}: ${action.title}\n${action.url}`);
  }

  async executeRemoteLink(
    issue: JiraWriteIssue,
    input: { url: string; title: string; globalId: string },
    confirmation: JiraWriteConfirmation,
  ): Promise<unknown> {
    const action: Action = {
      kind: "remote-link",
      issue,
      url: new URL(input.url).toString(),
      title: input.title.trim(),
      globalId: input.globalId,
    };
    this.consume(action, confirmation);
    return this.durableWrite(
      issue,
      "remote-link",
      { url: action.url, title: action.title, globalId: action.globalId },
      { kind: "remote-link", globalId: action.globalId, submittedAt: Date.now() },
      () => this.hooks.addRemoteLink(issue, { url: action.url, title: action.title, globalId: action.globalId }),
    );
  }

  async previewAssign(issue: JiraWriteIssue, input: JiraAssignRequest, intent: string): Promise<JiraWriteConfirmation> {
    this.requireIntent(intent);
    const { target, meName } = await this.resolveAssignTarget(issue, input);
    const current = await this.requireAssignHooks().currentAssignee(issue);
    if (assigneeId(target) === current.id)
      throw new JiraWriteSafetyError(
        target.kind === "user" ? "The issue is already assigned to that user." : "The issue is already unassigned.",
      );
    const who =
      target.kind === "unassigned"
        ? "nobody"
        : (input.kind === "user" && input.displayName?.trim()) ||
          (input.kind === "me" ? (meName ? `${meName} (you)` : "you") : target.id);
    return this.confirm(
      { kind: "assign", issue, target },
      intent,
      `${target.kind === "unassigned" ? `Unassign ${issue.issueKey}` : `Assign ${issue.issueKey} to ${who}`}
Currently: ${current.displayName || "Unassigned"}`,
    );
  }

  async executeAssign(
    issue: JiraWriteIssue,
    input: JiraAssignRequest,
    confirmation: JiraWriteConfirmation,
  ): Promise<unknown> {
    const { target } = await this.resolveAssignTarget(issue, input);
    this.consume({ kind: "assign", issue, target }, confirmation);
    const hooks = this.requireAssignHooks();
    const before = await hooks.currentAssignee(issue);
    if (assigneeId(target) === before.id)
      throw new JiraWriteSafetyError(
        target.kind === "user" ? "The issue is already assigned to that user." : "The issue is already unassigned.",
      );
    return this.durableWrite(
      issue,
      "assign",
      { target: assigneeId(target), before: before.id },
      { kind: "assign", target: assigneeId(target), beforeAssignee: before.id, submittedAt: Date.now() },
      () => hooks.assign(issue, target),
    );
  }

  /** Upload is confirmed by the user choosing the file; the journal is what stops a retry after a timeout from duplicating it. */
  async uploadAttachment(issue: JiraWriteIssue, file: JiraAttachmentUpload): Promise<unknown> {
    if (!this.hooks.uploadAttachment || !this.hooks.countAttachmentsLike)
      throw new JiraWriteSafetyError("Jira attachment upload is unavailable.");
    const nameHash = hashWriteText(file.fileName);
    const size = file.bytes.byteLength;
    const contentHash = createHash("sha256").update(file.bytes).digest("hex");
    const beforeCount = await this.hooks.countAttachmentsLike(issue, { nameHash, size });
    return this.durableWrite(
      issue,
      "attachment",
      { nameHash, size, contentHash },
      { kind: "attachment", nameHash, size, beforeCount, submittedAt: Date.now() },
      () => this.hooks.uploadAttachment!(issue, file),
    );
  }

  private requireAssignHooks(): {
    assign(issue: JiraWriteIssue, target: JiraAssignTarget): Promise<unknown>;
    currentAssignee(issue: JiraWriteIssue): Promise<{ id: string; displayName: string }>;
  } {
    const { assign, currentAssignee } = this.hooks;
    if (!assign || !currentAssignee) throw new JiraWriteSafetyError("Assigning Jira issues is unavailable.");
    return {
      assign: (issue, target) => assign.call(this.hooks, issue, target),
      currentAssignee: (issue) => currentAssignee.call(this.hooks, issue),
    };
  }

  private async resolveAssignTarget(
    issue: JiraWriteIssue,
    input: JiraAssignRequest,
  ): Promise<{ target: JiraAssignTarget; meName?: string }> {
    if (input.kind === "unassigned") return { target: { kind: "unassigned" } };
    if (input.kind === "me") {
      const me = await this.hooks.resolveMe?.(issue.connectionId);
      if (!me) throw new JiraWriteSafetyError("Choose and verify your Jira identity on this connection first.");
      return {
        target: { kind: "user", id: me.kind === "cloud" ? me.accountId : me.name },
        ...(me.displayName ? { meName: me.displayName } : {}),
      };
    }
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (!id || id.length > 255) throw new JiraWriteSafetyError("Jira user identifier is invalid.");
    return { target: { kind: "user", id } };
  }

  private confirm(action: Action, intent: string, preview: string): JiraWriteConfirmation {
    for (const [token, item] of this.confirmations) if (item.expiresAt <= Date.now()) this.confirmations.delete(token);
    while (this.confirmations.size >= 256) {
      const oldest = this.confirmations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.confirmations.delete(oldest);
    }
    const token = randomUUID();
    this.confirmations.set(token, { action, intent, preview, expiresAt: Date.now() + 5 * 60_000 });
    return { token, intent, preview };
  }
  private consume(action: Action, confirmation: JiraWriteConfirmation): void {
    const saved = this.confirmations.get(confirmation?.token);
    if (
      !saved ||
      saved.intent !== confirmation.intent ||
      saved.preview !== confirmation.preview ||
      saved.expiresAt <= Date.now() ||
      saved.intent.trim() !== saved.intent ||
      JSON.stringify(saved.action) !== JSON.stringify(action)
    ) {
      throw new JiraWriteSafetyError("Explicit confirmation is missing, expired, or does not match this Jira write.");
    }
    this.confirmations.delete(confirmation.token);
  }
  private requireIntent(intent: string): void {
    if (typeof intent !== "string" || intent.trim().length < 8 || intent.length > 500)
      throw new JiraWriteSafetyError("Provide an explicit confirmation intent (at least 8 characters).");
  }
  private requireBody(body: string): void {
    if (!body.trim() || body.length > 32_000)
      throw new JiraWriteSafetyError("Jira comment must contain 1 to 32000 characters.");
  }

  private requireJournal(): JiraWriteJournal {
    if (!this.hooks.journal || !this.hooks.getAuditContext)
      throw new JiraWriteSafetyError("Durable Jira write safety is not configured.");
    return this.hooks.journal;
  }

  private async auditContext(issue: JiraWriteIssue): Promise<JiraWriteAuditContext> {
    this.requireJournal();
    const value = await this.hooks.getAuditContext!(issue);
    const clean = (text: string) =>
      text
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, 200);
    if (!value.profileId?.trim() || !value.requester?.trim() || !value.apiActor?.trim())
      throw new JiraWriteSafetyError("Trusted Jira write attribution is unavailable.");
    return {
      ...value,
      profileId: clean(value.profileId),
      requester: clean(value.requester),
      apiActor: clean(value.apiActor),
    };
  }

  private async durableWrite(
    issue: JiraWriteIssue,
    kind: JiraWriteJournalEntry["kind"],
    action: unknown,
    metadata: JiraWriteMetadata,
    post: () => Promise<unknown>,
  ): Promise<unknown> {
    const journal = this.requireJournal();
    const audit = await this.auditContext(issue);
    const fingerprint = jiraWriteFingerprint({ kind, action });
    let entry: JiraWriteJournalEntry;
    try {
      entry = await journal.begin({
        profileId: audit.profileId,
        connectionId: issue.connectionId,
        issueId: issue.issueId,
        issueKey: issue.issueKey,
        kind,
        fingerprint,
        requester: audit.requester,
        apiActor: audit.apiActor,
        metadata,
      });
    } catch (error) {
      const journalError = error instanceof JiraWriteJournalError ? error : undefined;
      log.warn("jira write was not started", {
        op: kind,
        connectionId: issue.connectionId,
        issueKey: issue.issueKey,
        code: journalError?.code ?? "journal-unavailable",
      });
      if (journalError?.code === "blocked")
        throw new JiraWriteSafetyError(
          "This Jira write is already recorded or unresolved. Reconcile it before proceeding.",
          {
            cause: error,
          },
        );
      if (journalError?.code === "full") throw new JiraWriteSafetyError(journalError.message, { cause: error });
      throw new JiraWriteSafetyError(describeJournalFailure(error), { cause: error });
    }
    const logFields = { op: kind, connectionId: issue.connectionId, issueKey: issue.issueKey, journalId: entry.id };
    try {
      await post();
    } catch (error) {
      throw await this.recordFailure(journal, entry.id, logFields, error);
    }
    try {
      await journal.markSucceeded(entry.id);
    } catch (error) {
      log.warn("jira write succeeded but its journal entry could not be finished", {
        ...logFields,
        code: error instanceof JiraWriteJournalError ? error.code : "journal-unavailable",
      });
      throw Object.assign(
        new JiraWriteSafetyError(
          "Jira accepted this write, but its record could not be saved. Check the issue before repeating it.",
          { cause: error },
        ),
        { code: "jira-write-unknown", journalId: entry.id, status: "unknown" },
      );
    }
    log.info("jira write succeeded", logFields);
    return { status: "succeeded", journalId: entry.id };
  }

  /** Classifies the failure, settles the journal entry accordingly, logs one line and returns the error to throw. */
  private async recordFailure(
    journal: JiraWriteJournal,
    journalId: string,
    logFields: { op: string; connectionId: string; issueKey: string; journalId: string },
    error: unknown,
  ): Promise<Error> {
    const failure = classifyJiraWriteFailure(error);
    const safeCode = jiraWriteFailureSafeCode(failure);
    try {
      if (failure.kind === "not-sent") await journal.markFailed(journalId, safeCode);
      else if (failure.kind === "rejected") await journal.markReconciled(journalId, "not-applied", safeCode);
      else await journal.markUnknown(journalId, safeCode);
    } catch (journalError) {
      log.warn("jira write outcome could not be recorded; the entry stays unresolved until reconciled", {
        ...logFields,
        outcome: failure.kind,
        journalCode: journalError instanceof JiraWriteJournalError ? journalError.code : "journal-unavailable",
      });
    }
    log.warn("jira write did not complete", {
      ...logFields,
      outcome: failure.kind,
      code: failure.code,
      ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}),
      ...(failure.causeCode ? { cause: failure.causeCode } : {}),
    });
    const status = failure.statusCode;
    const common = {
      journalId,
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      ...(status !== undefined ? { statusCode: status } : {}),
    };
    if (failure.kind === "unknown")
      return Object.assign(
        new JiraWriteSafetyError("Jira may have accepted this write. Reconcile it before retrying.", { cause: error }),
        { code: "jira-write-unknown", status: "unknown", ...common },
      );
    if (failure.kind === "not-sent")
      return Object.assign(
        new JiraWriteSafetyError(
          `${(error as Error).message} Nothing was sent to Jira, so you can retry once that is fixed.`.slice(0, 500),
          { cause: error },
        ),
        { code: failure.code, status: "failed", ...common },
      );
    if (status === 400 || status === 409 || status === 422)
      return Object.assign(
        new JiraWriteSafetyError(
          `Jira rejected this write (${status}).${failure.detail ? ` ${failure.detail}` : " Review the request before making changes."}`.slice(
            0,
            500,
          ),
          { cause: error },
        ),
        {
          code: "jira-write-rejected",
          status: "failed",
          ...(failure.detail ? { detail: failure.detail } : {}),
          ...common,
        },
      );
    const text =
      status === 401
        ? "Your Jira sign-in has expired. The write was not applied; sign in again, then retry."
        : status === 403
          ? "This Jira account is not allowed to make that change. Nothing was changed."
          : status === 404
            ? "Jira could not find that issue or resource. Nothing was changed."
            : `Jira is rate limiting requests. Nothing was changed${failure.retryAfterMs ? `; retry in about ${Math.ceil(failure.retryAfterMs / 1000)} s` : ""}.`;
    return Object.assign(new JiraWriteSafetyError(text, { cause: error }), {
      code: failure.code,
      status: "failed",
      ...common,
    });
  }
}

function normalizeWriteText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

export function jiraWriteNameHash(value: string): string {
  return hashWriteText(value);
}

function hashWriteText(value: string): string {
  return createHash("sha256").update(normalizeWriteText(value)).digest("hex");
}

function assigneeId(target: JiraAssignTarget): string {
  return target.kind === "user" ? target.id : "";
}

function sameIdentity(a: JiraWriteIdentity, b: JiraWriteIdentity): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "cloud"
      ? a.accountId === (b as Extract<JiraWriteIdentity, { kind: "cloud" }>).accountId
      : a.name === (b as Extract<JiraWriteIdentity, { kind: "data-center" }>).name)
  );
}
