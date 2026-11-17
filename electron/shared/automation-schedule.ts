import { Cron, CronPattern } from "croner";
import type { ScheduleTrigger } from "./automation.js";

/** Return the next slot strictly after `after`, without creating a timer. */
export function nextAutomationSlot(trigger: ScheduleTrigger, after: Date): Date | null {
  const now = after.getTime();
  if (!Number.isFinite(now)) throw new Error("Invalid reference time");
  if (trigger.kind === "once") {
    const at = new Date(trigger.at);
    return at.getTime() > now ? at : null;
  }
  if (trigger.kind === "interval") {
    if (!Number.isInteger(trigger.everyMinutes) || trigger.everyMinutes < 5) {
      throw new Error("Automation intervals must be at least five minutes");
    }
    const anchor = new Date(trigger.anchor).getTime();
    if (!Number.isFinite(anchor)) throw new Error("Invalid interval anchor");
    const interval = trigger.everyMinutes * 60_000;
    const slots = Math.max(0, Math.floor((now - anchor) / interval) + 1);
    return new Date(anchor + slots * interval);
  }
  const cron = new Cron(trigger.expression, {
    mode: "5-part",
    timezone: trigger.timezone,
    paused: true,
  });
  return cron.nextRun(after);
}

/** Validate a five-field expression and ensure no possible time-of-day slots are less than five minutes apart. */
export function isValidAutomationCron(expression: string, timezone?: string): boolean {
  try {
    if (expression.trim().split(/\s+/u).length !== 5) return false;
    // CronPattern is the same parser used for the next-slot calculation.
    const pattern = new CronPattern(expression, timezone, { mode: "5-part" });
    if (timezone) new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    const slots: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      if (!pattern.hour[hour]) continue;
      for (let minute = 0; minute < 60; minute++) {
        if (pattern.minute[minute]) slots.push(hour * 60 + minute);
      }
    }
    for (let i = 1; i < slots.length; i++) {
      if (slots[i]! - slots[i - 1]! < 5) return false;
    }
    // A boundary across midnight can only be unsafe if both end hours are selected.
    if (slots.length > 1 && slots[0]! + 1440 - slots[slots.length - 1]! < 5) return false;
    return slots.length > 0;
  } catch {
    return false;
  }
}
