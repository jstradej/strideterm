/// <reference types="node" />
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "./logger.js";
import { writeFileAtomic } from "./shared/fs-durable.js";
import { INTERNAL_MCP_ERROR_CODES } from "../shared/internal-mcp.js";
import {
  OPERATION_LAST_RESULT_TTL_MS,
  type OperationFinished,
  type OperationRunning,
  type OperationStatus,
  type OperationsState,
} from "../shared/operation-events.js";

/**
 * The runtime's one mechanism for an action that can outlive a 30 s request:
 * accept → answer at once with an id → run inside the runtime → one result.
 *
 * Every operation is a JSON file (`<dir>/<operationId>.json`, tmp + rename)
 * written BEFORE the caller is answered, so an accepted request survives a
 * restart. The same file is the idempotency record: it is looked up by
 * (profile, origin workspace, key) and is deleted only together with the
 * workspace the operation created (`removeForWorkspace`), or by an explicit
 * `discard` of an operation that produced nothing. Nothing here expires it —
 * a 24 h replay window of the OUTCOME is a separate, in-payload concern.
 *
 * Task-specific steps and data live in the handler that runs the operation
 * (`intent`, `artifacts`, `step`); the registry only persists and reports them.
 */

export interface OperationRecord {
  operationId: string;
  kind: string;
  /** Effective profile the operation was accepted in; never changes afterwards. */
  profileId: string;
  /** The workspace the request came from; idempotency keys are scoped to (profile, this). */
  originWorkspaceId: string;
  idempotencyKey: string;
  inputHash: string;
  status: OperationStatus;
  step: string;
  /** Reserved up front so a restart can find what a half-finished run created. */
  intent: Record<string, unknown>;
  /** What the run has already created on disk or in state, recorded as it goes. */
  artifacts: Record<string, unknown>;
  /** The workspace this operation created; deleting it deletes this record. */
  workspaceId?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface OperationHandle {
  readonly record: Readonly<OperationRecord>;
  /** Persist a step / artifact change. Throws when the file cannot be written. */
  update(patch: {
    step?: string;
    artifacts?: Record<string, unknown>;
    workspaceId?: string;
    status?: OperationStatus;
  }): Promise<void>;
}

export type OperationRunner = (handle: OperationHandle) => Promise<Record<string, unknown>>;

export type OperationOutcome =
  | { status: "succeeded"; result: Record<string, unknown>; workspaceId?: string }
  | { status: "failed" | "interrupted"; error: { code: string; message: string }; workspaceId?: string };

export class OperationIdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";
  constructor(readonly operationId: string) {
    super("This idempotency key was already used with a different request.");
    this.name = "OperationIdempotencyConflictError";
  }
}

export interface OperationRegistryOptions {
  dir: string;
  log: Logger;
  /** Called once per finished run, after the payload carries it. */
  emitFinished: (event: OperationFinished) => void;
  /** The payload changed (an operation started, advanced or finished). */
  onChange: () => void;
  now?: () => number;
}

export interface AcceptInput {
  kind: string;
  profileId: string;
  originWorkspaceId: string;
  idempotencyKey: string;
  inputHash: string;
  initialStep: string;
  intent: Record<string, unknown>;
}

export interface AcceptResult {
  record: OperationRecord;
  /** True when the key already named this exact request: nothing new was started. */
  replayed: boolean;
}

function keyOf(profileId: string, originWorkspaceId: string, idempotencyKey: string): string {
  return JSON.stringify([profileId, originWorkspaceId, idempotencyKey]);
}

const STABLE_ERROR_CODES: ReadonlySet<string> = new Set(INTERNAL_MCP_ERROR_CODES);

// Raw errno codes (EPERM, ENOENT, ...) are not part of the contract an agent can act on.
function errorOf(err: unknown): { code: string; message: string } {
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  const message = err instanceof Error ? err.message : String(err);
  return { code: STABLE_ERROR_CODES.has(code) ? code : "internal_error", message };
}

function isTerminal(status: OperationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "interrupted";
}

export function createOperationRegistry(options: OperationRegistryOptions) {
  const { dir, log, emitFinished, onChange } = options;
  const now = options.now ?? Date.now;
  const records = new Map<string, OperationRecord>();
  const byKey = new Map<string, string>();
  const running = new Set<string>();
  const removeOnFinish = new Set<string>();

  const fileOf = (operationId: string): string => path.join(dir, `${operationId}.json`);

  async function persist(record: OperationRecord): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(fileOf(record.operationId), `${JSON.stringify(record, null, 2)}\n`);
  }

  function index(record: OperationRecord): void {
    records.set(record.operationId, record);
    byKey.set(keyOf(record.profileId, record.originWorkspaceId, record.idempotencyKey), record.operationId);
  }

  function outcomeOf(record: OperationRecord): OperationFinished | null {
    if (!isTerminal(record.status) || !record.finishedAt) return null;
    const base = {
      operationId: record.operationId,
      kind: record.kind,
      profileId: record.profileId,
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      ...(typeof record.intent.rootPath === "string" ? { rootPath: record.intent.rootPath } : {}),
      finishedAt: record.finishedAt,
    };
    if (record.status === "succeeded") return { ...base, result: record.result ?? {} };
    return { ...base, error: record.error ?? { code: record.status, message: `The operation ${record.status}.` } };
  }

  async function finish(record: OperationRecord, outcome: OperationOutcome): Promise<void> {
    const finishedAt = new Date(now()).toISOString();
    const settled: OperationRecord = {
      ...record,
      ...(outcome.workspaceId ? { workspaceId: outcome.workspaceId } : {}),
      status: outcome.status,
      step: outcome.status === "succeeded" ? "ready" : outcome.status,
      finishedAt,
      updatedAt: finishedAt,
      ...(outcome.status === "succeeded" ? { result: outcome.result } : { error: outcome.error }),
    };
    // The terminal state is persisted from a copy and published to the record, the payload and the event
    // together, so nothing reads "succeeded" while the payload still lists the operation as running.
    try {
      await persist(settled);
    } catch (err) {
      log.error("operation outcome could not be persisted", {
        operationId: record.operationId,
        err: errorOf(err).message,
      });
    }
    Object.assign(record, settled);
    running.delete(record.operationId);
    onChange();
    const event = outcomeOf(record);
    if (event) {
      try {
        emitFinished(event);
      } catch (err) {
        log.error("operation result could not be published", {
          operationId: record.operationId,
          err: errorOf(err).message,
        });
      }
    }
    if (removeOnFinish.delete(record.operationId)) await dropRecord(record);
  }

  async function execute(record: OperationRecord, runner: OperationRunner): Promise<void> {
    const handle: OperationHandle = {
      get record() {
        return record;
      },
      async update(patch) {
        if (patch.step !== undefined) record.step = patch.step;
        if (patch.status !== undefined) record.status = patch.status;
        if (patch.workspaceId !== undefined) record.workspaceId = patch.workspaceId;
        if (patch.artifacts) record.artifacts = { ...record.artifacts, ...patch.artifacts };
        record.updatedAt = new Date(now()).toISOString();
        await persist(record);
        onChange();
      },
    };
    try {
      const result = await runner(handle);
      await finish(record, { status: "succeeded", result });
    } catch (err) {
      const error = errorOf(err);
      log.warn("operation failed", { operationId: record.operationId, kind: record.kind, step: record.step, ...error });
      await finish(record, {
        status: "failed",
        error,
        ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      });
    }
  }

  async function dropRecord(record: OperationRecord): Promise<void> {
    records.delete(record.operationId);
    byKey.delete(keyOf(record.profileId, record.originWorkspaceId, record.idempotencyKey));
    await fs.rm(fileOf(record.operationId), { force: true }).catch((err: unknown) => {
      log.warn("operation record could not be removed", { operationId: record.operationId, err: errorOf(err).message });
    });
    onChange();
  }

  function getRecord(operationId: string, profileId: string): OperationRecord | null {
    const record = records.get(operationId);
    return record && record.profileId === profileId ? record : null;
  }

  return {
    /**
     * Read every persisted operation. One that was still accepted or running
     * when the process ended is handed to `reconcile`, which decides what the
     * evidence says (anything it does not settle becomes `interrupted`).
     */
    async load(reconcile: (record: OperationRecord) => Promise<OperationOutcome>): Promise<void> {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn("operations dir unreadable", { err: errorOf(err).message });
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        let record: OperationRecord;
        try {
          record = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as OperationRecord;
          if (!record?.operationId || !record.kind || !record.profileId) throw new Error("not an operation record");
        } catch (err) {
          log.warn("operation record skipped", { name, err: errorOf(err).message });
          continue;
        }
        index(record);
        if (isTerminal(record.status)) continue;
        let outcome: Awaited<ReturnType<typeof reconcile>>;
        try {
          outcome = await reconcile(record);
        } catch (err) {
          outcome = { status: "interrupted", error: { code: "interrupted", message: errorOf(err).message } };
        }
        await finish(record, outcome);
      }
    },

    async accept(input: AcceptInput, runner: OperationRunner): Promise<AcceptResult> {
      const key = keyOf(input.profileId, input.originWorkspaceId, input.idempotencyKey);
      const existingId = byKey.get(key);
      if (existingId) {
        const existing = records.get(existingId)!;
        if (existing.inputHash !== input.inputHash) throw new OperationIdempotencyConflictError(existingId);
        return { record: existing, replayed: true };
      }
      const stamp = new Date(now()).toISOString();
      const record: OperationRecord = {
        operationId: `op-${randomUUID()}`,
        kind: input.kind,
        profileId: input.profileId,
        originWorkspaceId: input.originWorkspaceId,
        idempotencyKey: input.idempotencyKey,
        inputHash: input.inputHash,
        status: "accepted",
        step: input.initialStep,
        intent: input.intent,
        artifacts: {},
        createdAt: stamp,
        updatedAt: stamp,
      };
      // Indexed before the write so a concurrent retry of the same key finds this record
      // instead of racing to accept a second one.
      index(record);
      running.add(record.operationId);
      try {
        await persist(record);
      } catch (err) {
        records.delete(record.operationId);
        byKey.delete(key);
        running.delete(record.operationId);
        throw err;
      }
      record.status = "running";
      onChange();
      void execute(record, runner);
      return { record, replayed: false };
    },

    get: getRecord,

    /** Any profile's record: for the runtime's own profile check, never for a client. */
    find(operationId: string): OperationRecord | null {
      return records.get(operationId) ?? null;
    },

    /** The operation an idempotency key already names, whatever its state. */
    findByKey(profileId: string, originWorkspaceId: string, idempotencyKey: string): OperationRecord | null {
      const id = byKey.get(keyOf(profileId, originWorkspaceId, idempotencyKey));
      return id ? (records.get(id) ?? null) : null;
    },

    isRunning(operationId: string): boolean {
      return running.has(operationId);
    },

    /** Operations of one profile, newest first. */
    list(profileId: string): OperationRecord[] {
      return [...records.values()]
        .filter((record) => record.profileId === profileId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    /** The payload slice: what runs now and the outcomes of the last 24 h. */
    snapshot(): OperationsState {
      const cutoff = now() - OPERATION_LAST_RESULT_TTL_MS;
      const runningNow: OperationRunning[] = [];
      const lastResults: OperationFinished[] = [];
      for (const record of records.values()) {
        if (!isTerminal(record.status)) {
          runningNow.push({
            operationId: record.operationId,
            kind: record.kind,
            profileId: record.profileId,
            step: record.step,
            ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
            ...(typeof record.intent.rootPath === "string" ? { rootPath: record.intent.rootPath } : {}),
            startedAt: record.createdAt,
          });
          continue;
        }
        const outcome = outcomeOf(record);
        if (outcome && Date.parse(outcome.finishedAt) >= cutoff) lastResults.push(outcome);
      }
      return { running: runningNow, lastResults };
    },

    /** Forget the operations that created `workspaceId`; their idempotency records go with it. */
    async removeForWorkspace(workspaceId: string): Promise<void> {
      for (const record of [...records.values()]) {
        if (record.workspaceId !== workspaceId && record.intent.reservedWorkspaceId !== workspaceId) continue;
        // A running operation owns its record until it settles; it is dropped then instead of living on for good.
        if (isTerminal(record.status)) await dropRecord(record);
        else removeOnFinish.add(record.operationId);
      }
    },

    /** Drop an operation that produced no workspace. Refuses a running one or one that owns a workspace. */
    async discard(operationId: string, profileId: string): Promise<boolean> {
      const record = getRecord(operationId, profileId);
      if (!record || !isTerminal(record.status) || record.workspaceId) return false;
      await dropRecord(record);
      return true;
    },
  };
}

export type OperationRegistry = ReturnType<typeof createOperationRegistry>;
