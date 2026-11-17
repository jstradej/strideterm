import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationJournal } from "./automation-journal.js";
import { AutomationScheduler, type ScheduledAutomation } from "./automation-scheduler.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup(catchUp: "skip" | "run-once" = "skip") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "automation-scheduler-"));
  dirs.push(dir);
  const journal = new AutomationJournal(dir, () => {});
  const fire = vi.fn(async () => {});
  const missed = vi.fn(async () => {});
  let now = Date.parse("2026-01-01T00:00:00Z");
  let paused = false;
  const entries: ScheduledAutomation[] = [
    {
      workspaceId: "one",
      catchUp,
      trigger: { type: "schedule", kind: "interval", anchor: "2026-01-01T00:00:00Z", everyMinutes: 5 },
    },
  ];
  const scheduler = new AutomationScheduler({
    journal,
    fire,
    missed,
    now: () => now,
    schedules: () => ({ paused, entries }),
    error: (_id, error) => {
      throw error;
    },
  });
  return {
    scheduler,
    journal,
    entries,
    fire,
    missed,
    setNow: (value: string) => {
      now = Date.parse(value);
    },
    setPaused: (value: boolean) => {
      paused = value;
    },
  };
}
describe("automation scheduler", () => {
  it("tolerates an ordinary refresh just after a slot is due", async () => {
    const x = await setup();
    await x.scheduler.refresh();
    x.setNow("2026-01-01T00:05:00.100Z");
    await x.scheduler.refresh();
    await x.scheduler.refresh();
    expect(x.fire).toHaveBeenCalledExactlyOnceWith("one", "2026-01-01T00:05:00.000Z");
    expect(x.missed).not.toHaveBeenCalled();
    x.scheduler.stop();
  });
  it("still recovers a just-missed slot explicitly on startup or system resume", async () => {
    const x = await setup();
    await x.scheduler.refresh();
    x.setNow("2026-01-01T00:05:00.100Z");
    await x.scheduler.refresh(true);
    expect(x.missed).toHaveBeenCalledOnce();
    expect(x.fire).not.toHaveBeenCalled();
    x.scheduler.stop();
  });
  it("records a missed slot once and honors global pause", async () => {
    const x = await setup();
    await x.scheduler.refresh();
    expect((await x.journal.read("one")).nextRunAt).toBe("2026-01-01T00:05:00.000Z");
    x.setPaused(true);
    await x.scheduler.refresh();
    x.setNow("2026-01-01T00:20:00Z");
    await x.scheduler.refresh();
    expect(x.missed).not.toHaveBeenCalled();
    x.setPaused(false);
    await x.scheduler.refresh();
    await x.scheduler.refresh();
    expect(x.missed).toHaveBeenCalledOnce();
    expect(x.fire).not.toHaveBeenCalled();
    expect((await x.journal.read("one")).nextRunAt).toBe("2026-01-01T00:25:00.000Z");
    x.scheduler.stop();
  });
  it("skips a delayed timer without a resume callback", async () => {
    const callbacks: Array<() => void> = [];
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callbacks.push(callback);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      const x = await setup();
      await x.scheduler.refresh();
      x.setNow("2026-01-01T00:05:02Z");
      callbacks[0]!();
      await x.scheduler.refresh();
      expect(x.fire).not.toHaveBeenCalled();
      expect(x.missed).toHaveBeenCalledOnce();
      x.scheduler.stop();
    } finally {
      timer.mockRestore();
      clear.mockRestore();
    }
  });
  it.each(["fire", "missed"] as const)("keeps the next slot armed when %s rejects", async (callback) => {
    const x = await setup(callback === "fire" ? "run-once" : "skip");
    const error = vi.fn();
    const scheduler = new AutomationScheduler({
      journal: x.journal,
      schedules: () => ({ paused: false, entries: x.entries }),
      now: () => Date.parse("2026-01-01T00:10:00Z"),
      fire: x.fire,
      missed: x.missed,
      error,
    });
    await x.journal.update("one", (state) => {
      state.nextRunAt = "2026-01-01T00:05:00.000Z";
    });
    const failure = new Error("Slot callback failed");
    x[callback].mockRejectedValueOnce(failure);
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      await scheduler.refresh();
      expect(error).toHaveBeenCalledWith("one", failure);
      expect((await x.journal.read("one")).nextRunAt).toBe("2026-01-01T00:15:00.000Z");
      expect(timer).toHaveBeenCalledOnce();
      expect(timer).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);
    } finally {
      scheduler.stop();
      timer.mockRestore();
    }
  });
  it("does not arm a timer when no schedules are enabled", async () => {
    const x = await setup();
    const scheduler = new AutomationScheduler({
      journal: x.journal,
      schedules: () => ({ paused: false, entries: [] }),
      fire: x.fire,
      missed: x.missed,
      error: (_id, error) => {
        throw error;
      },
    });
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      await scheduler.refresh();
      expect(timer).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
      timer.mockRestore();
    }
  });
  it("rearms instead of firing a slot twice when the wall clock moves backwards", async () => {
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
      callbacks.push(callback);
      delays.push(delay ?? 0);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      const x = await setup("run-once");
      await x.scheduler.refresh();
      x.setNow("2026-01-01T00:05:00Z");
      callbacks[0]!();
      await x.scheduler.refresh();
      expect(x.fire).toHaveBeenCalledOnce();
      x.setNow("2026-01-01T00:02:00Z");
      callbacks.at(-1)!();
      expect(x.fire).toHaveBeenCalledOnce();
      expect(delays.at(-1)).toBe(8 * 60_000);
      x.scheduler.stop();
    } finally {
      timer.mockRestore();
      clear.mockRestore();
    }
  });
  it("uses one timer for many schedules and does no journal I/O on an early wake", async () => {
    const callbacks: Array<() => void> = [];
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callbacks.push(callback);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const dir = await mkdtemp(path.join(os.tmpdir(), "automation-many-"));
    dirs.push(dir);
    const journal = new AutomationJournal(dir, () => {});
    const read = vi.spyOn(journal, "read");
    let paused = false;
    const scheduler = new AutomationScheduler({
      journal,
      schedules: () => ({
        paused,
        entries: Array.from({ length: 30 }, (_, i) => ({
          workspaceId: `job-${i}`,
          catchUp: "skip" as const,
          trigger: {
            type: "schedule" as const,
            kind: "interval" as const,
            everyMinutes: 60,
            anchor: "2026-01-01T00:00:00Z",
          },
        })),
      }),
      now: () => Date.parse("2026-01-01T00:00:00Z"),
      fire: async () => {},
      missed: async () => {},
      error: (_id, error) => {
        throw error;
      },
    });
    try {
      await scheduler.refresh();
      expect(timer).toHaveBeenCalledTimes(1);
      read.mockClear();
      callbacks[0]!();
      expect(read).not.toHaveBeenCalled();
      expect(timer).toHaveBeenCalledTimes(2);
      paused = true;
      await scheduler.refresh();
      expect(timer).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.stop();
      timer.mockRestore();
      clear.mockRestore();
    }
  });
  it.each(["wake", "resume"])("recalculates a default-zone cron on %s after a timezone change", async (source) => {
    const previousTz = process.env.TZ;
    const callbacks: Array<() => void> = [];
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callbacks.push(callback);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    process.env.TZ = "UTC";
    const dir = await mkdtemp(path.join(os.tmpdir(), "automation-timezone-"));
    dirs.push(dir);
    const journal = new AutomationJournal(dir, () => {});
    const scheduler = new AutomationScheduler({
      journal,
      schedules: () => ({
        paused: false,
        entries: [
          {
            workspaceId: "cron",
            catchUp: "skip",
            trigger: { type: "schedule", kind: "cron", expression: "0 9 * * *" },
          },
        ],
      }),
      now: () => Date.parse("2026-01-01T00:00:00Z"),
      fire: async () => {},
      missed: async () => {},
      error: (_id, error) => {
        throw error;
      },
    });
    try {
      await scheduler.refresh();
      expect((await journal.read("cron")).nextRunAt).toBe("2026-01-01T09:00:00.000Z");
      process.env.TZ = "America/New_York";
      if (source === "wake") callbacks[0]!();
      await scheduler.refresh();
      expect((await journal.read("cron")).nextRunAt).toBe("2026-01-01T14:00:00.000Z");
    } finally {
      scheduler.stop();
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
      timer.mockRestore();
      clear.mockRestore();
    }
  });
  it("runs one missed slot when configured to catch up", async () => {
    const x = await setup("run-once");
    await x.scheduler.refresh();
    x.setNow("2026-01-01T00:30:00Z");
    await x.scheduler.refresh();
    await x.scheduler.refresh();
    expect(x.fire).toHaveBeenCalledOnce();
    expect((await x.journal.read("one")).lastFiredSlot).toBe("2026-01-01T00:05:00.000Z");
    x.scheduler.stop();
  });
});
