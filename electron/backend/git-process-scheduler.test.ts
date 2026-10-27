import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { GitProcessScheduler } from "./git-process-scheduler.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("GitProcessScheduler", () => {
  it("limits the real subprocess tasks, preserves a foreground slot and advances after failures", async () => {
    const scheduler = new GitProcessScheduler();
    const gates = Array.from({ length: 8 }, gate);
    const started: number[] = [];
    const reads = gates.map((item, index) =>
      scheduler.run(async () => {
        started.push(index);
        await item.promise;
      }, "background"),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    const foreground = scheduler.run(async () => {
      throw new Error("git failed");
    });
    await expect(foreground).rejects.toThrow("git failed");
    expect(scheduler.getStats().peak).toBe(4);
    gates.forEach((item) => item.resolve());
    await Promise.all(reads);
    expect(started).toHaveLength(8);
    expect(scheduler.getStats().queued).toBe(0);
  });

  it("gives a quiet checkout the next slot instead of queueing it behind a busy one", async () => {
    let now = 0;
    const scheduler = new GitProcessScheduler(3, () => now);
    const busy = Array.from({ length: 6 }, gate);
    const started: string[] = [];
    const reads = busy.map((item, index) =>
      scheduler.run(
        async () => {
          started.push(`busy-${index}`);
          await item.promise;
        },
        "background",
        "busy",
      ),
    );
    now = 1000;
    const quiet = scheduler.run(
      async () => {
        started.push("quiet");
      },
      "background",
      "quiet",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["busy-0", "busy-1"]);
    busy[0].resolve();
    await quiet;
    expect(started).toEqual(["busy-0", "busy-1", "quiet"]);
    busy.forEach((item) => item.resolve());
    await Promise.all(reads);
  });

  it("runs a queued task in the async context of its caller, not of the task that freed the slot", async () => {
    const context = new AsyncLocalStorage<string>();
    const scheduler = new GitProcessScheduler(2);
    const first = gate();
    const seen: Array<string | undefined> = [];
    const holder = context.run("holder", () =>
      scheduler.run(async () => {
        await first.promise;
      }, "background"),
    );
    const waiter = context.run("waiter", () =>
      scheduler.run(async () => {
        seen.push(context.getStore());
      }, "background"),
    );
    first.resolve();
    await Promise.all([holder, waiter]);
    expect(seen).toEqual(["waiter"]);
  });

  it("ages queued background work and cancels only background requests on shutdown", async () => {
    let now = 0;
    const scheduler = new GitProcessScheduler(2, () => now);
    const first = gate();
    const second = gate();
    const running = scheduler.run(() => first.promise, "background");
    const busy = scheduler.run(() => second.promise);
    const order: string[] = [];
    const aged = scheduler.run(async () => {
      order.push("background");
    }, "background");
    now = 6000;
    const action = scheduler.run(async () => {
      order.push("foreground");
    });
    first.resolve();
    await running;
    await aged;
    expect(order[0]).toBe("background");
    second.resolve();
    await Promise.all([busy, action]);

    const blocked = gate();
    const hold = scheduler.run(() => blocked.promise, "background");
    const cancelled = scheduler.run(async () => {}, "background");
    scheduler.stopBackground();
    await expect(cancelled).rejects.toThrow("stopped");
    const accepted = scheduler.run(async () => "accepted");
    await expect(accepted).resolves.toBe("accepted");
    blocked.resolve();
    await hold;
  });
});
