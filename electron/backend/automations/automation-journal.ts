import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../shared/fs-durable.js";

const runStateSchema = z.enum([
  "starting",
  "running",
  "awaiting-user",
  "succeeded",
  "failed",
  "timed-out",
  "stopped",
  "interrupted",
  "skipped",
]);
const runSchema = z
  .object({
    runId: z.string(),
    idempotencyKey: z.string().optional(),
    trigger: z
      .object({
        type: z.enum(["schedule", "event", "manual"]),
        slot: z.string().optional(),
        eventIds: z.array(z.string()).optional(),
      })
      .strict(),
    state: runStateSchema,
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    reason: z.string().optional(),
    resultExcerpt: z.string().optional(),
    resultMissing: z.boolean().optional(),
    subject: z.string().optional(),
    sessionId: z.string().optional(),
    exitCode: z.number().int().optional(),
    output: z.string().max(16000).optional(),
    outputFormat: z.literal("screen").optional(),
    taskWorkspaceId: z.string().optional(),
    reviewWorkspaceId: z.string().optional(),
  })
  .strict();
export type AutomationRunRecord = z.infer<typeof runSchema>;
/** Terminal tails are fetched on demand, rather than repeated in every state broadcast. */
export function automationRunSummary({
  output: _output,
  outputFormat: _outputFormat,
  ...run
}: AutomationRunRecord): Omit<AutomationRunRecord, "output" | "outputFormat"> {
  return run;
}

const pendingEventSchema = z.object({ subject: z.string(), events: z.array(z.unknown()) }).strict();
const journalSchema = z
  .object({
    v: z.literal(1),
    nextRunAt: z.string().nullable(),
    lastFiredSlot: z.string().nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    runs: z.array(runSchema).max(100),
    latestSessionRuns: z.record(z.string(), z.string()).default({}),
    pendingEvents: z.array(pendingEventSchema).max(20),
    seenEventIds: z.array(z.string()).max(2000),
  })
  .strict();
export type AutomationJournalState = z.infer<typeof journalSchema>;

function emptyJournal(): AutomationJournalState {
  return {
    v: 1,
    nextRunAt: null,
    lastFiredSlot: null,
    consecutiveFailures: 0,
    runs: [],
    latestSessionRuns: {},
    pendingEvents: [],
    seenEventIds: [],
  };
}

/** Durable, per-workspace journal. Every read-modify-write is serialized with all others for that workspace. */
export class AutomationJournal {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, AutomationJournalState>();
  constructor(
    private readonly directory: string,
    private readonly warn: (message: string) => void,
    private readonly onChange: () => void = () => {},
    private readonly onEvict: (workspaceId: string, runs: AutomationRunRecord[]) => Promise<void> = async () => {},
    private readonly onTransition: (workspaceId: string, run: AutomationRunRecord) => void = () => {},
  ) {}

  peek(workspaceId: string): AutomationJournalState | undefined {
    const state = this.cache.get(workspaceId);
    return state ? structuredClone(state) : undefined;
  }

  private file(workspaceId: string): string {
    if (!/^[A-Za-z0-9_-]+$/u.test(workspaceId)) throw new Error("Invalid automation workspace id");
    return path.join(this.directory, `${workspaceId}.json`);
  }

  private async load(workspaceId: string): Promise<AutomationJournalState> {
    let contents: string;
    try {
      contents = await readFile(this.file(workspaceId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyJournal();
      throw error;
    }
    try {
      return journalSchema.parse(JSON.parse(contents));
    } catch {
      this.warn(`Invalid automation journal for ${workspaceId}; resetting`);
      return emptyJournal();
    }
  }

  private enqueue<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(workspaceId, current);
    void current
      .finally(() => {
        if (this.queues.get(workspaceId) === current) this.queues.delete(workspaceId);
      })
      .catch(() => {});
    return current;
  }

  read(workspaceId: string): Promise<AutomationJournalState> {
    return this.enqueue(workspaceId, async () => {
      const state = await this.load(workspaceId);
      this.cache.set(workspaceId, structuredClone(state));
      return state;
    });
  }

  update<T>(workspaceId: string, change: (state: AutomationJournalState) => T): Promise<T> {
    return this.enqueue(workspaceId, async () => {
      const state = await this.load(workspaceId);
      const previousStates = new Map(state.runs.map((run) => [run.runId, run.state]));
      const previousSessions = new Map(state.runs.map((run) => [run.runId, run.sessionId]));
      const inferredLatest = Object.fromEntries(
        state.runs.filter((run) => run.sessionId).map((run) => [run.sessionId!, run.runId]),
      );
      state.latestSessionRuns = { ...inferredLatest, ...state.latestSessionRuns };
      const result = change(state);
      for (const run of state.runs) {
        if (run.sessionId && previousSessions.get(run.runId) !== run.sessionId)
          state.latestSessionRuns[run.sessionId] = run.runId;
      }
      const evicted: AutomationRunRecord[] = [];
      while (state.runs.length > 100) {
        const index = state.runs.findIndex((run) => !["starting", "running", "awaiting-user"].includes(run.state));
        if (index < 0) throw new Error("Too many active automation runs");
        evicted.push(state.runs.splice(index, 1)[0]!);
      }
      state.pendingEvents = state.pendingEvents.slice(-20);
      const referencedSessions = new Set(state.runs.map((run) => run.sessionId));
      for (const sessionId of Object.keys(state.latestSessionRuns))
        if (!referencedSessions.has(sessionId)) delete state.latestSessionRuns[sessionId];
      state.seenEventIds = state.seenEventIds.slice(-2000);
      const checked = journalSchema.parse(state);
      await mkdir(this.directory, { recursive: true });
      await writeFileAtomic(this.file(workspaceId), `${JSON.stringify(checked)}\n`);
      this.cache.set(workspaceId, structuredClone(checked));
      for (const run of checked.runs)
        if (previousStates.get(run.runId) !== run.state) this.onTransition(workspaceId, run);
      this.onChange();
      if (evicted.length) {
        try {
          await this.onEvict(workspaceId, evicted);
        } catch {
          this.warn(`Could not remove old automation run files for ${workspaceId}`);
        }
      }
      return result;
    });
  }

  remove(workspaceId: string): Promise<void> {
    return this.enqueue(workspaceId, async () => {
      await rm(this.file(workspaceId), { force: true });
      this.cache.delete(workspaceId);
      this.onChange();
    });
  }
}
