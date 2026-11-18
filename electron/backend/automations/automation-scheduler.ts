import { nextAutomationSlot } from "../../shared/automation-schedule.js";
import type { ScheduleTrigger } from "../../shared/automation.js";
import type { AutomationJournal } from "./automation-journal.js";

const MAX_DELAY = 15 * 60_000;
// Allow ordinary timer jitter while treating a delayed wake as a missed slot.
const TIMER_GRACE_MS = 1_000;
export interface ScheduledAutomation {
  workspaceId: string;
  trigger: ScheduleTrigger;
  catchUp: "skip" | "run-once";
}
export interface AutomationSchedulerOptions {
  journal: AutomationJournal;
  schedules: () => { paused: boolean; entries: ScheduledAutomation[] };
  fire: (workspaceId: string, slot: string, assertCurrent?: () => void) => Promise<void>;
  missed: (workspaceId: string, slot: string, assertCurrent?: () => void) => Promise<void>;
  handledOnce?: (workspaceId: string, slot: string) => Promise<void>;
  error: (workspaceId: string, error: unknown) => void;
  now?: () => number;
}

/** One timer for all schedules, with durable slot tracking in the journal. */
export class AutomationScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private due = new Map<string, string>();
  private definitions = new Map<string, string>();
  private readonly now: () => number;
  private timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private timezoneChanged = false;
  constructor(private readonly options: AutomationSchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Startup and system resume explicitly recover missed slots; ordinary refreshes tolerate timer jitter. */
  refresh(recoverMissed = false): Promise<void> {
    this.queue = this.queue.catch(() => {}).then(() => this.recompute(recoverMissed));
    return this.queue;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.due.clear();
  }

  private async recompute(recoverMissed: boolean): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    this.detectTimezoneChange();
    const { paused, entries } = this.options.schedules();
    if (paused) {
      this.due.clear();
      return;
    }
    const now = this.now();
    const next = new Map<string, string>();
    for (const entry of entries) {
      if (this.stopped) return;
      try {
        const journal = await this.options.journal.read(entry.workspaceId);
        const definition = JSON.stringify(entry.trigger);
        const previousDefinition = this.definitions.get(entry.workspaceId);
        this.definitions.set(entry.workspaceId, definition);
        let slot =
          (previousDefinition && previousDefinition !== definition) ||
          (this.timezoneChanged && entry.trigger.kind === "cron" && !entry.trigger.timezone)
            ? null
            : journal.nextRunAt;
        const once = entry.trigger.kind === "once" ? new Date(entry.trigger.at).toISOString() : null;
        let recoveredOnceSlot: string | null = null;
        if (once) {
          const run = journal.runs.find((item) => item.trigger.type === "schedule" && item.trigger.slot === once);
          if (run && journal.lastFiredSlot !== once) recoveredOnceSlot = once;
          const handled = run || journal.lastFiredSlot === once;
          if (handled && (!run || run.finishedAt)) await this.options.handledOnce?.(entry.workspaceId, once);
          slot = handled ? null : once;
        } else if (!slot) {
          slot = nextAutomationSlot(entry.trigger, new Date(now))?.toISOString() ?? null;
        }
        let persisted = false;
        if (slot && Date.parse(slot) <= now) {
          if (journal.lastFiredSlot !== slot) {
            const isCurrent = () => {
              const live = this.options.schedules();
              return (
                !this.stopped &&
                !live.paused &&
                live.entries.some(
                  (candidate) =>
                    candidate.workspaceId === entry.workspaceId &&
                    JSON.stringify(candidate.trigger) === definition &&
                    (!once || candidate.catchUp === entry.catchUp),
                )
              );
            };
            if (!isCurrent()) continue;
            const firedSlot = slot;
            const nextSlot = nextAutomationSlot(entry.trigger, new Date(now))?.toISOString() ?? null;
            const dispatch =
              (recoverMissed || now - Date.parse(firedSlot) >= TIMER_GRACE_MS) && entry.catchUp === "skip"
                ? this.options.missed
                : this.options.fire;
            if (once) {
              // The callback records the run before launch. Leave this slot available if it cannot reserve a run.
              await dispatch(entry.workspaceId, firedSlot, () => {
                if (!isCurrent()) throw new Error("Automation schedule changed or paused");
              });
            }
            await this.options.journal.update(entry.workspaceId, (state) => {
              state.lastFiredSlot = firedSlot;
              state.nextRunAt = nextSlot;
            });
            persisted = true;
            // The next durable slot still needs a timer if starting or recording this slot fails.
            if (nextSlot) next.set(entry.workspaceId, nextSlot);
            if (!once) await dispatch(entry.workspaceId, firedSlot);
            slot = nextSlot;
          } else {
            slot = nextAutomationSlot(entry.trigger, new Date(now))?.toISOString() ?? null;
          }
        }
        if (!persisted && (slot !== journal.nextRunAt || recoveredOnceSlot)) {
          await this.options.journal.update(entry.workspaceId, (state) => {
            state.nextRunAt = slot;
            if (recoveredOnceSlot) state.lastFiredSlot = recoveredOnceSlot;
          });
        }
        if (slot) next.set(entry.workspaceId, slot);
      } catch (error) {
        this.options.error(entry.workspaceId, error);
      }
    }
    if (this.stopped) return;
    this.timezoneChanged = false;
    this.due = next;
    this.arm();
  }

  private detectTimezoneChange(): void {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.timezoneChanged ||= timezone !== this.timezone;
    this.timezone = timezone;
  }

  private arm(): void {
    if (this.stopped || this.due.size === 0) return;
    const earliest = Math.min(...[...this.due.values()].map((slot) => Date.parse(slot)));
    const delay = Math.max(0, Math.min(MAX_DELAY, earliest - this.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.detectTimezoneChange();
      if (!this.timezoneChanged && [...this.due.values()].every((slot) => Date.parse(slot) > this.now())) {
        this.arm();
        return;
      }
      this.queue = this.queue.catch(() => {}).then(() => this.recompute(false));
    }, delay);
    this.timer.unref?.();
  }
}
