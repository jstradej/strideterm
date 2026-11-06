import { createHash, randomUUID } from "node:crypto";
import { JIRA_WRITE_SAFE_CODE_PATTERN } from "../../shared/jira-error-codes.js";
import { getLogger } from "../logger.js";

const log = getLogger("jira");

export type JiraWriteKind = "transition" | "comment" | "worklog" | "remote-link" | "assign" | "attachment";
export type JiraWriteState = "pending" | "succeeded" | "failed" | "unknown" | "reconciled";
export type JiraWriteReconciliation = "applied" | "not-applied" | "unresolved";

export type JiraWriteMetadata =
  | {
      kind: "transition";
      transitionId: string;
      targetStatus: string;
      beforeStatus: string;
      beforeUpdatedAt: string;
    }
  | { kind: "comment"; bodyHash: string; submittedAt: number }
  | { kind: "worklog"; fingerprint: string; submittedAt: number; seconds: number; started: string; commentHash: string }
  | { kind: "remote-link"; globalId: string; submittedAt: number }
  | { kind: "assign"; target: string; beforeAssignee: string; submittedAt: number }
  | { kind: "attachment"; nameHash: string; size: number; beforeCount: number; submittedAt: number };

/** Kinds that set a state rather than append something: doing the same again later is legitimate, only an unresolved attempt blocks. */
const REPEATABLE_KINDS: ReadonlySet<JiraWriteKind> = new Set(["assign", "attachment", "transition", "remote-link"]);

/** Appends (comment, worklog) only block an identical resend this long after they succeeded: a double click, not next week. */
const APPEND_DUPLICATE_WINDOW_MS = 2 * 60_000;

/** Durable local audit metadata. Deliberately contains no issue/comment body, token, or free-form intent. */
export interface JiraWriteJournalEntry {
  id: string;
  profileId: string;
  connectionId: string;
  issueId: string;
  issueKey: string;
  kind: JiraWriteKind;
  fingerprint: string;
  requester: string;
  apiActor: string;
  createdAt: number;
  updatedAt: number;
  state: JiraWriteState;
  reconciliation?: JiraWriteReconciliation;
  /** `interrupted`, `provider-error`, `reconcile-incomplete`, or `<code>[:<status>]` / `not-sent:<code>`. */
  safeCode?: string;
  metadata: JiraWriteMetadata;
}

export interface JiraWriteJournalState {
  version: 1;
  entries: JiraWriteJournalEntry[];
}

export interface JiraWriteJournalStore {
  load(): Promise<JiraWriteJournalState | undefined>;
  save(state: JiraWriteJournalState): Promise<void>;
}

export interface JiraWriteJournalOptions {
  store: JiraWriteJournalStore;
  now?: () => number;
  maxEntries?: number;
  retentionMs?: number;
}

export class JiraWriteJournalError extends Error {
  constructor(
    readonly code: "blocked" | "full" | "invalid" | "persistence-failed",
    readonly entry?: JiraWriteJournalEntry,
    options?: { cause?: unknown },
  ) {
    super(
      code === "blocked"
        ? "An identical Jira write is pending, unknown, or already recorded. Reconcile it before proceeding."
        : code === "full"
          ? "The Jira write journal is full of unresolved operations; reconcile or clear completed history before writing."
          : "The Jira write journal is unavailable; no Jira write was attempted.",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "JiraWriteJournalError";
  }
}

/**
 * Bounded durable write journal. Store failures fail closed before a POST. Any
 * interrupted pending record is promoted to unknown on load, requiring remote
 * reconciliation before the same action can be attempted again.
 */
export class JiraWriteJournal {
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private state?: JiraWriteJournalState;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: JiraWriteJournalOptions) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 500;
    this.retentionMs = options.retentionMs ?? 90 * 24 * 60 * 60_000;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 5000)
      throw new JiraWriteJournalError("invalid");
    if (!Number.isFinite(this.retentionMs) || this.retentionMs < 60_000) throw new JiraWriteJournalError("invalid");
  }

  async begin(
    entry: Omit<JiraWriteJournalEntry, "id" | "createdAt" | "updatedAt" | "state" | "reconciliation">,
  ): Promise<JiraWriteJournalEntry> {
    return this.serial(async () => {
      const state = clone(await this.getState());
      const now = this.now();
      const duplicate = state.entries.find(
        (item) =>
          item.profileId === entry.profileId &&
          item.connectionId === entry.connectionId &&
          item.issueId === entry.issueId &&
          item.fingerprint === entry.fingerprint &&
          (item.state === "pending" ||
            item.state === "unknown" ||
            (!REPEATABLE_KINDS.has(entry.kind) &&
              now - item.updatedAt < APPEND_DUPLICATE_WINDOW_MS &&
              (item.state === "succeeded" || (item.state === "reconciled" && item.reconciliation === "applied")))),
      );
      if (duplicate) throw new JiraWriteJournalError("blocked", clone(duplicate));
      this.makeRoom(state);
      const created: JiraWriteJournalEntry = {
        ...sanitizeEntry(entry),
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        state: "pending",
      };
      state.entries.push(created);
      await this.persist(state);
      return clone(created);
    });
  }

  async markSucceeded(id: string): Promise<JiraWriteJournalEntry> {
    return this.update(id, (entry) => {
      entry.state = "succeeded";
      delete entry.safeCode;
      delete entry.reconciliation;
    });
  }

  async markFailed(id: string, safeCode?: string): Promise<JiraWriteJournalEntry> {
    return this.update(id, (entry) => {
      entry.state = "failed";
      if (safeCode) entry.safeCode = safeCode;
      else delete entry.safeCode;
      delete entry.reconciliation;
    });
  }

  async markPendingUnknown(safeCode = "interrupted"): Promise<void> {
    return this.serial(async () => {
      const state = clone(await this.getState());
      let changed = false;
      for (const entry of state.entries)
        if (entry.state === "pending") {
          entry.state = "unknown";
          entry.safeCode = safeCode;
          entry.updatedAt = this.now();
          changed = true;
        }
      if (changed) await this.persist(state);
    });
  }

  async markUnknown(id: string, safeCode = "provider-error"): Promise<JiraWriteJournalEntry> {
    return this.update(id, (entry) => {
      entry.state = "unknown";
      entry.safeCode = safeCode;
      delete entry.reconciliation;
    });
  }

  async markReconciled(
    id: string,
    outcome: JiraWriteReconciliation,
    safeCode?: string,
  ): Promise<JiraWriteJournalEntry> {
    return this.update(id, (entry) => {
      if (entry.state !== "unknown" && entry.state !== "pending")
        throw new JiraWriteJournalError("invalid", clone(entry));
      entry.state = outcome === "unresolved" ? "unknown" : "reconciled";
      entry.reconciliation = outcome;
      if (outcome === "unresolved") entry.safeCode = "reconcile-incomplete";
      else if (safeCode) entry.safeCode = safeCode;
      else delete entry.safeCode;
    });
  }

  async get(id: string): Promise<JiraWriteJournalEntry | undefined> {
    const state = await this.serial(() => this.getState());
    const found = state.entries.find((entry) => entry.id === id);
    return found ? clone(found) : undefined;
  }

  async list(filter: {
    profileId: string;
    connectionId?: string;
    issueId?: string;
    limit?: number;
  }): Promise<JiraWriteJournalEntry[]> {
    const state = await this.serial(() => this.getState());
    const limit = Math.max(1, Math.min(200, Math.trunc(filter.limit || 100)));
    return state.entries
      .filter(
        (entry) =>
          entry.profileId === filter.profileId &&
          (!filter.connectionId || entry.connectionId === filter.connectionId) &&
          (!filter.issueId || entry.issueId === filter.issueId),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(clone);
  }

  /** Every entry of this journal, whatever its profile (a journal file belongs to one profile). */
  async exportAll(): Promise<JiraWriteJournalEntry[]> {
    const state = await this.serial(() => this.getState());
    return state.entries.map(clone);
  }

  /**
   * Takes over entries that belonged to another profile (a deleted one), re-attributed to `profileId`, in one
   * persisted step. Entries already present by id are not duplicated; unresolved ones are never trimmed to make room.
   */
  async absorb(entries: JiraWriteJournalEntry[], profileId: string): Promise<number> {
    return this.serial(async () => {
      const state = await this.getState();
      const known = new Set(state.entries.map((entry) => entry.id));
      const incoming = entries.filter((entry) => !known.has(entry.id)).map((entry) => ({ ...clone(entry), profileId }));
      if (!incoming.length) return 0;
      const next = { ...state, entries: [...state.entries, ...incoming] };
      while (next.entries.length > this.maxEntries) {
        const index = next.entries.findIndex(
          (entry) =>
            entry.state === "failed" ||
            entry.state === "succeeded" ||
            (entry.state === "reconciled" && entry.reconciliation !== "unresolved"),
        );
        if (index < 0) throw new JiraWriteJournalError("full");
        next.entries.splice(index, 1);
      }
      validateState(next, this.maxEntries);
      await this.persist(next);
      return incoming.length;
    });
  }

  private async update(id: string, change: (entry: JiraWriteJournalEntry) => void): Promise<JiraWriteJournalEntry> {
    return this.serial(async () => {
      const state = clone(await this.getState());
      const entry = state.entries.find((item) => item.id === id);
      if (!entry) throw new JiraWriteJournalError("invalid");
      change(entry);
      entry.updatedAt = this.now();
      await this.persist(state);
      return clone(entry);
    });
  }

  private async getState(): Promise<JiraWriteJournalState> {
    if (this.state) return this.state;
    try {
      const loaded = await this.options.store.load();
      const state = loaded ?? { version: 1 as const, entries: [] };
      validateState(state, this.maxEntries);
      let promoted = 0;
      for (const entry of state.entries) {
        if (entry.state === "pending") {
          entry.state = "unknown";
          entry.safeCode = "interrupted";
          entry.updatedAt = this.now();
          promoted += 1;
        }
      }
      this.state = state;
      if (promoted > 0) {
        log.warn("jira write journal found interrupted writes; they need reconciling before they can be repeated", {
          count: promoted,
        });
        await this.persist(state);
      }
      return state;
    } catch (error) {
      if (error instanceof JiraWriteJournalError) throw error;
      log.warn("jira write journal could not be loaded; writes stay blocked", {
        err: error instanceof Error ? error.name : "error",
      });
      throw new JiraWriteJournalError("persistence-failed", undefined, { cause: error });
    }
  }

  private async persist(state: JiraWriteJournalState): Promise<void> {
    try {
      await this.options.store.save(clone(state));
      this.state = state;
    } catch (error) {
      throw new JiraWriteJournalError("persistence-failed", undefined, { cause: error });
    }
  }

  private makeRoom(state: JiraWriteJournalState): void {
    const cutoff = this.now() - this.retentionMs;
    state.entries = state.entries.filter(
      (entry) =>
        entry.createdAt >= cutoff ||
        entry.state === "pending" ||
        entry.state === "unknown" ||
        (entry.state === "reconciled" && entry.reconciliation === "unresolved"),
    );
    while (state.entries.length >= this.maxEntries) {
      const index = state.entries.findIndex(
        (entry) =>
          entry.state === "failed" ||
          entry.state === "succeeded" ||
          (entry.state === "reconciled" &&
            (entry.reconciliation === "not-applied" || entry.reconciliation === "applied")),
      );
      if (index < 0) throw new JiraWriteJournalError("full");
      state.entries.splice(index, 1);
    }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export function jiraWriteFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function validateState(value: unknown, maxEntries: number): asserts value is JiraWriteJournalState {
  if (!value || typeof value !== "object") throw new JiraWriteJournalError("invalid");
  const state = value as JiraWriteJournalState;
  if (
    !hasExactKeys(state, ["version", "entries"]) ||
    state.version !== 1 ||
    !Array.isArray(state.entries) ||
    state.entries.length > maxEntries
  )
    throw new JiraWriteJournalError("invalid");
  for (const entry of state.entries) assertSafeEntry(entry);
}

function sanitizeEntry(
  entry: Omit<JiraWriteJournalEntry, "id" | "createdAt" | "updatedAt" | "state" | "reconciliation">,
): typeof entry {
  const clean = {
    profileId: safeText(entry.profileId, 128),
    connectionId: safeText(entry.connectionId, 128),
    issueId: safeText(entry.issueId, 128),
    issueKey: safeText(entry.issueKey, 128),
    kind: entry.kind,
    fingerprint: entry.fingerprint,
    requester: safeText(entry.requester, 200),
    apiActor: safeText(entry.apiActor, 200),
    ...(entry.safeCode ? { safeCode: entry.safeCode } : {}),
    metadata: clone(entry.metadata),
  };
  assertSafeEntry({
    ...clean,
    id: "pending",
    createdAt: 0,
    updatedAt: 0,
    state: "pending",
  } as JiraWriteJournalEntry);
  return clean;
}

function assertSafeEntry(entry: unknown): asserts entry is JiraWriteJournalEntry {
  if (!entry || typeof entry !== "object") throw new JiraWriteJournalError("invalid");
  const item = entry as JiraWriteJournalEntry;
  if (
    !hasExactKeys(item, [
      "id",
      "profileId",
      "connectionId",
      "issueId",
      "issueKey",
      "kind",
      "fingerprint",
      "requester",
      "apiActor",
      "createdAt",
      "updatedAt",
      "state",
      "metadata",
      ...(item.reconciliation !== undefined ? ["reconciliation"] : []),
      ...(item.safeCode !== undefined ? ["safeCode"] : []),
    ]) ||
    typeof item.id !== "string" ||
    !item.id ||
    typeof item.profileId !== "string" ||
    !item.profileId ||
    typeof item.connectionId !== "string" ||
    !item.connectionId ||
    typeof item.issueId !== "string" ||
    !item.issueId ||
    typeof item.issueKey !== "string" ||
    !item.issueKey ||
    !["transition", "comment", "worklog", "remote-link", "assign", "attachment"].includes(item.kind) ||
    !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
    typeof item.requester !== "string" ||
    item.requester.length > 200 ||
    typeof item.apiActor !== "string" ||
    item.apiActor.length > 200 ||
    !Number.isFinite(item.createdAt) ||
    !Number.isFinite(item.updatedAt) ||
    !["pending", "succeeded", "failed", "unknown", "reconciled"].includes(item.state) ||
    (item.reconciliation !== undefined && !["applied", "not-applied", "unresolved"].includes(item.reconciliation)) ||
    (item.safeCode !== undefined &&
      (typeof item.safeCode !== "string" || !JIRA_WRITE_SAFE_CODE_PATTERN.test(item.safeCode)))
  )
    throw new JiraWriteJournalError("invalid");

  const metadata = item.metadata as unknown as Record<string, unknown> | undefined;
  if (!metadata || metadata.kind !== item.kind) throw new JiraWriteJournalError("invalid");
  if (item.kind === "transition") {
    const m = metadata as Extract<JiraWriteMetadata, { kind: "transition" }>;
    if (
      !hasExactKeys(metadata, ["kind", "transitionId", "targetStatus", "beforeStatus", "beforeUpdatedAt"]) ||
      typeof m.transitionId !== "string" ||
      !m.transitionId ||
      m.transitionId.length > 128 ||
      typeof m.targetStatus !== "string" ||
      m.targetStatus.length > 500 ||
      typeof m.beforeStatus !== "string" ||
      m.beforeStatus.length > 500 ||
      typeof m.beforeUpdatedAt !== "string" ||
      m.beforeUpdatedAt.length > 64
    )
      throw new JiraWriteJournalError("invalid");
  } else if (item.kind === "comment") {
    const m = metadata as Extract<JiraWriteMetadata, { kind: "comment" }>;
    if (
      !hasExactKeys(metadata, ["kind", "bodyHash", "submittedAt"]) ||
      typeof m.bodyHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(m.bodyHash) ||
      !Number.isFinite(m.submittedAt)
    )
      throw new JiraWriteJournalError("invalid");
  } else if (item.kind === "worklog") {
    const m = metadata as Extract<JiraWriteMetadata, { kind: "worklog" }>;
    if (
      !hasExactKeys(metadata, ["kind", "fingerprint", "submittedAt", "seconds", "started", "commentHash"]) ||
      typeof m.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(m.fingerprint) ||
      !Number.isFinite(m.submittedAt) ||
      !Number.isInteger(m.seconds) ||
      m.seconds <= 0 ||
      typeof m.started !== "string" ||
      m.started.length > 64 ||
      typeof m.commentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(m.commentHash)
    )
      throw new JiraWriteJournalError("invalid");
  } else if (item.kind === "assign") {
    const m = metadata as Extract<JiraWriteMetadata, { kind: "assign" }>;
    if (
      !hasExactKeys(metadata, ["kind", "target", "beforeAssignee", "submittedAt"]) ||
      typeof m.target !== "string" ||
      m.target.length > 255 ||
      typeof m.beforeAssignee !== "string" ||
      m.beforeAssignee.length > 255 ||
      !Number.isFinite(m.submittedAt)
    )
      throw new JiraWriteJournalError("invalid");
  } else if (item.kind === "attachment") {
    const m = metadata as Extract<JiraWriteMetadata, { kind: "attachment" }>;
    if (
      !hasExactKeys(metadata, ["kind", "nameHash", "size", "beforeCount", "submittedAt"]) ||
      typeof m.nameHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(m.nameHash) ||
      !Number.isSafeInteger(m.size) ||
      m.size < 0 ||
      !Number.isSafeInteger(m.beforeCount) ||
      m.beforeCount < 0 ||
      !Number.isFinite(m.submittedAt)
    )
      throw new JiraWriteJournalError("invalid");
  } else {
    const m = metadata as Extract<JiraWriteMetadata, { kind: "remote-link" }>;
    if (
      !hasExactKeys(metadata, ["kind", "globalId", "submittedAt"]) ||
      typeof m.globalId !== "string" ||
      !m.globalId ||
      m.globalId.length > 1000 ||
      !Number.isFinite(m.submittedAt)
    )
      throw new JiraWriteJournalError("invalid");
  }
}

function hasExactKeys(value: object, allowed: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function safeText(value: string, maxLength: number): string {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
