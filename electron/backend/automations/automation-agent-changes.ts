import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { automationAgentChangeSchema, type AutomationAgentChange } from "../../shared/automation-agent-change.js";
import { writeFileAtomic } from "../shared/fs-durable.js";
import type { AutomationState } from "../../shared/automation.js";

export function describeAgentAutomation(definition: AutomationState): string {
  const trigger = definition.trigger;
  const schedule =
    trigger.type === "event"
      ? `${trigger.source}: ${trigger.kinds.join(", ")}`
      : trigger.kind === "interval"
        ? `Every ${trigger.everyMinutes} minutes`
        : trigger.kind === "once"
          ? `Once at ${trigger.at}`
          : `Cron ${trigger.expression}${trigger.timezone ? ` (${trigger.timezone})` : ""}`;
  const executor =
    definition.executor.type === "agent"
      ? definition.executor.agent.providerId
      : `${definition.executor.worker.providerId} / ${definition.executor.judge.providerId}`;
  return `${schedule} · ${executor}`.slice(0, 500);
}

const retentionMs = 24 * 60 * 60 * 1000;
const historySchema = z.array(automationAgentChangeSchema).max(500);

/** Bounded durable notification metadata, kept separately from prompts and event payloads. */
export class AutomationAgentChanges {
  private history: AutomationAgentChange[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}
  async load(): Promise<void> {
    try {
      this.history = historySchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      this.prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private prune(): void {
    const cutoff = this.now() - retentionMs;
    this.history = this.history.filter((change) => Date.parse(change.at) >= cutoff).slice(-500);
  }
  snapshot(): AutomationAgentChange[] {
    this.prune();
    return structuredClone(this.history);
  }
  append(input: Omit<AutomationAgentChange, "changeId" | "at">): Promise<AutomationAgentChange> {
    const change = automationAgentChangeSchema.parse({
      ...input,
      changeId: randomUUID(),
      at: new Date(this.now()).toISOString(),
    });
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        this.prune();
        const next = [...this.history, change].slice(-500);
        await writeFileAtomic(this.file, `${JSON.stringify(next)}\n`);
        this.history = next;
        return change;
      });
    this.queue = operation;
    return operation;
  }
}
