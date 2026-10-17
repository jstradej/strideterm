import { randomUUID } from "node:crypto";

export const REVIEW_GIT_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_OPERATIONS = 500;

export type ReviewGitOperationState = "running" | "succeeded" | "failed";

export interface ReviewGitOperationRecord {
  operationId: string;
  profileId: string;
  workspaceId: string;
  kind: string;
  /** Caller-supplied key; the same key returns the same operation instead of starting another. */
  idempotencyKey: string;
  state: ReviewGitOperationState;
  startedAt: string;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
}

export type ReviewGitOperationLookup =
  { found: true; operation: ReviewGitOperationRecord } | { found: false; reason: "unknown" | "expired" };

export interface StartOperationInput {
  profileId: string;
  workspaceId: string;
  kind: string;
  idempotencyKey?: string;
  run: () => Promise<unknown>;
}

export interface ReviewGitOperationRegistry {
  start(input: StartOperationInput): { operation: ReviewGitOperationRecord; reused: boolean };
  get(operationId: string, scope: { profileId: string; workspaceId?: string }): ReviewGitOperationLookup;
  listForProfile(profileId: string): ReviewGitOperationRecord[];
  running(profileId: string): ReviewGitOperationRecord[];
  idle(): Promise<void>;
}

/**
 * Bounded, in-memory record of started Git operations. A started operation is
 * not tied to its caller: it keeps running when the capability that started it
 * is revoked or the agent disconnects, and its outcome stays queryable by id
 * for 24 hours — after which a lookup says so explicitly instead of guessing.
 */
export function createReviewGitOperationRegistry({
  now = () => Date.now(),
  onChange,
}: {
  now?: () => number;
  onChange?: (operation: ReviewGitOperationRecord) => void;
} = {}): ReviewGitOperationRegistry {
  const operations = new Map<string, ReviewGitOperationRecord>();
  const byKey = new Map<string, string>();
  const expired = new Set<string>();
  const inFlight = new Set<Promise<void>>();

  function prune(): void {
    const cutoff = now() - REVIEW_GIT_OPERATION_RETENTION_MS;
    for (const [id, record] of operations) {
      if (record.state === "running") continue;
      const finished = record.finishedAt ? Date.parse(record.finishedAt) : 0;
      if (finished < cutoff || operations.size > MAX_OPERATIONS) {
        operations.delete(id);
        if (record.idempotencyKey) byKey.delete(keyOf(record.profileId, record.workspaceId, record.idempotencyKey));
        expired.add(id);
        if (expired.size > MAX_OPERATIONS * 4) {
          const oldest = expired.values().next().value;
          if (oldest) expired.delete(oldest);
        }
      }
    }
  }

  function keyOf(profileId: string, workspaceId: string, key: string): string {
    return `${profileId}\u0000${workspaceId}\u0000${key}`;
  }

  return {
    start({ profileId, workspaceId, kind, idempotencyKey = "", run }) {
      prune();
      if (idempotencyKey) {
        const existingId = byKey.get(keyOf(profileId, workspaceId, idempotencyKey));
        const existing = existingId ? operations.get(existingId) : undefined;
        if (existing) return { operation: existing, reused: true };
      }
      const record: ReviewGitOperationRecord = {
        operationId: randomUUID(),
        profileId,
        workspaceId,
        kind,
        idempotencyKey,
        state: "running",
        startedAt: new Date(now()).toISOString(),
        finishedAt: null,
        result: null,
        error: null,
      };
      operations.set(record.operationId, record);
      if (idempotencyKey) byKey.set(keyOf(profileId, workspaceId, idempotencyKey), record.operationId);
      onChange?.(record);

      const settle = (patch: Partial<ReviewGitOperationRecord>) => {
        Object.assign(record, patch, { finishedAt: new Date(now()).toISOString() });
        onChange?.(record);
      };
      const task = Promise.resolve()
        .then(run)
        .then(
          (result) => settle({ state: "succeeded", result }),
          (error: unknown) =>
            settle({ state: "failed", error: error instanceof Error ? error.message : String(error) }),
        )
        .finally(() => {
          inFlight.delete(task);
        });
      inFlight.add(task);
      return { operation: record, reused: false };
    },

    get(operationId, scope) {
      prune();
      const record = operations.get(operationId);
      if (!record) return { found: false, reason: expired.has(operationId) ? "expired" : "unknown" };
      if (record.profileId !== scope.profileId) return { found: false, reason: "unknown" };
      if (scope.workspaceId && record.workspaceId !== scope.workspaceId) return { found: false, reason: "unknown" };
      return { found: true, operation: record };
    },

    listForProfile(profileId) {
      prune();
      return [...operations.values()].filter((record) => record.profileId === profileId);
    },

    running(profileId) {
      return [...operations.values()].filter((record) => record.profileId === profileId && record.state === "running");
    },

    async idle() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
}
