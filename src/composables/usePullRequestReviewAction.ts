import { ref } from "vue";
import type { OperationFinished } from "../../electron/shared/operation-events.js";
import type { StartPullRequestReviewInput } from "../../electron/shared/pull-request-review.js";
import type { Transport } from "../transport.js";

const STORAGE_KEY = "strideterm-pr-review-starts-v1";
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const RECORD_LIMIT = 200;

interface ReviewStartRecord extends StartPullRequestReviewInput {
  operationId?: string;
  workspaceId?: string;
  outcome?: OperationFinished;
  error?: string;
  profileId: string;
  headSha: string;
  updatedAt: number;
}

type ReviewStartRecords = Record<string, ReviewStartRecord>;

function loadRecords(): ReviewStartRecords {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const now = Date.now();
    const entries: Array<[string, ReviewStartRecord]> = [];
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Partial<ReviewStartRecord>;
      if (
        (record.provider === "azure-devops" || record.provider === "github") &&
        typeof record.prKey === "string" &&
        typeof record.idempotencyKey === "string" &&
        typeof record.profileId === "string" &&
        typeof record.headSha === "string" &&
        typeof record.updatedAt === "number" &&
        (record.outcome === undefined ||
          (typeof record.outcome === "object" && record.outcome !== null && record.outcome.kind === "review.start")) &&
        now - record.updatedAt < RECORD_TTL_MS
      ) {
        entries.push([key, record as ReviewStartRecord]);
      }
    }
    return Object.fromEntries(entries.slice(-RECORD_LIMIT)) as ReviewStartRecords;
  } catch {
    return {};
  }
}

const records = ref<ReviewStartRecords>(loadRecords());
const inFlight = ref<string[]>([]);

function saveRecords(): void {
  const now = Date.now();
  records.value = Object.fromEntries(
    Object.entries(records.value)
      .filter(([, record]) => now - record.updatedAt < RECORD_TTL_MS)
      .slice(-RECORD_LIMIT),
  );
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.value));
  } catch {
    // The in-memory state still protects retries for this renderer lifetime.
  }
}

export interface PullRequestReviewTarget {
  provider?: unknown;
  prKey?: unknown;
  kind?: unknown;
  draftState?: unknown;
  reviewActionKind?: unknown;
  profileId?: unknown;
  headSha?: unknown;
}

export function isStartReviewTarget(target: PullRequestReviewTarget | null | undefined): boolean {
  return (
    (target?.provider === "azure-devops" || target?.provider === "github") &&
    typeof target.prKey === "string" &&
    target.prKey.length > 0 &&
    target.draftState === "ready" &&
    (target.reviewActionKind === "pr-new" ||
      target.reviewActionKind === "pr-ready" ||
      target.kind === "pr-new" ||
      target.kind === "pr-ready")
  );
}

export function pullRequestReviewIdentity(target: PullRequestReviewTarget): string {
  return `${String(target.profileId || "default")}|${String(target.provider || "")}:${String(target.prKey || "")}:${String(target.headSha || "")}`;
}

export function usePullRequestReviewAction() {
  const isStarting = (target: PullRequestReviewTarget): boolean =>
    inFlight.value.includes(pullRequestReviewIdentity(target));

  const recordFor = (target: PullRequestReviewTarget): ReviewStartRecord | undefined => {
    const record = records.value[pullRequestReviewIdentity(target)];
    return record && Date.now() - record.updatedAt < RECORD_TTL_MS ? record : undefined;
  };

  const start = async (
    target: PullRequestReviewTarget,
    api: Pick<Transport, "startPullRequestReview"> | null,
  ): Promise<ReviewStartRecord | null> => {
    if (!isStartReviewTarget(target) || !api?.startPullRequestReview) return null;
    const identity = pullRequestReviewIdentity(target);
    if (inFlight.value.includes(identity)) return records.value[identity] || null;
    const found = records.value[identity];
    const existing = found && Date.now() - found.updatedAt < RECORD_TTL_MS ? found : undefined;
    if (existing?.operationId) return existing;

    const record: ReviewStartRecord = existing || {
      provider: target.provider as StartPullRequestReviewInput["provider"],
      prKey: String(target.prKey),
      idempotencyKey: crypto.randomUUID(),
      profileId: typeof target.profileId === "string" && target.profileId ? target.profileId : "default",
      headSha: typeof target.headSha === "string" ? target.headSha : "",
      updatedAt: Date.now(),
    };
    records.value = Object.fromEntries(
      [...Object.entries(records.value).filter(([key]) => key !== identity), [identity, record]].slice(-RECORD_LIMIT),
    );
    saveRecords();
    inFlight.value = [...inFlight.value, identity];
    try {
      const result = await api.startPullRequestReview({
        provider: record.provider,
        prKey: record.prKey,
        idempotencyKey: record.idempotencyKey,
      });
      const accepted = {
        ...record,
        operationId: result.operationId,
        outcome: result.outcome,
        error: undefined,
        updatedAt: Date.now(),
      };
      records.value = { ...records.value, [identity]: accepted };
      saveRecords();
      return accepted;
    } catch (error) {
      const failed = {
        ...record,
        error: (error as Error)?.message || String(error || "Could not start review."),
        updatedAt: Date.now(),
      };
      records.value = { ...records.value, [identity]: failed };
      saveRecords();
      throw error;
    } finally {
      inFlight.value = inFlight.value.filter((entry) => entry !== identity);
    }
  };

  const reconcileFinished = (operation: {
    operationId: string;
    kind: string;
    result?: Record<string, unknown>;
    error?: { message: string };
    workspaceId?: string;
  }): ReviewStartRecord | null => {
    if (operation.kind !== "review.start") return null;
    const entry = Object.entries(records.value).find(([, record]) => record.operationId === operation.operationId);
    if (!entry) return null;
    const [identity, record] = entry;
    if (operation.result) {
      const workspaceId = (operation.result.workspaceId as string | undefined) || operation.workspaceId;
      if (record.outcome?.operationId === operation.operationId && record.workspaceId === workspaceId) return record;
      records.value = {
        ...records.value,
        [identity]: {
          ...record,
          workspaceId,
          outcome: operation as OperationFinished,
          updatedAt: Date.now(),
        },
      };
      saveRecords();
      return records.value[identity];
    }
    records.value = {
      ...records.value,
      [identity]: {
        ...record,
        operationId: undefined,
        outcome: operation as OperationFinished,
        idempotencyKey: crypto.randomUUID(),
        error: operation.error?.message || "The review agent could not be started.",
        updatedAt: Date.now(),
      },
    };
    saveRecords();
    return null;
  };

  const markNavigated = (operationId: string): void => {
    const entry = Object.entries(records.value).find(([, record]) => record.operationId === operationId);
    if (!entry) return;
    const [identity] = entry;
    delete records.value[identity];
    records.value = { ...records.value };
    saveRecords();
  };

  return { records, isStarting, recordFor, start, reconcileFinished, markNavigated };
}
