import { describe, expect, test } from "vitest";
import { createRecoveryQueue } from "./recovery-queue.js";

/**
 * V6 review, §"P1 — recovery `stale` řeší jen sekvenční, ne skutečný
 * multi-window race".
 *
 * Deterministic, deferred-Promise coverage: every case below controls exactly
 * when each run finishes, so "the second one waited" is proven by observed
 * ordering rather than by a timer.
 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createRecoveryQueue", () => {
  test("two runs for the same key never overlap, and keep their arrival order", async () => {
    const queue = createRecoveryQueue();
    const first = deferred();
    const second = deferred();
    const events: string[] = [];

    const a = queue.run("ws-1", async () => {
      events.push("a:start");
      await first.promise;
      events.push("a:end");
      return "a";
    });
    const b = queue.run("ws-1", async () => {
      events.push("b:start");
      await second.promise;
      events.push("b:end");
      return "b";
    });

    // B has not even started while A holds the key.
    await Promise.resolve();
    expect(events).toEqual(["a:start"]);

    first.resolve();
    expect(await a).toBe("a");
    // B is handed the key one microtask after A settles — never before.
    await Promise.resolve();
    expect(events).toEqual(["a:start", "a:end", "b:start"]);

    second.resolve();
    expect(await b).toBe("b");
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("different keys never wait on each other", async () => {
    const queue = createRecoveryQueue();
    const blocked = deferred();
    const events: string[] = [];

    const slow = queue.run("ws-1", async () => {
      events.push("slow:start");
      await blocked.promise;
      events.push("slow:end");
    });
    const fast = queue.run("ws-2", async () => {
      events.push("fast:start");
      events.push("fast:end");
    });

    await fast;
    expect(events).toEqual(["slow:start", "fast:start", "fast:end"]);

    blocked.resolve();
    await slow;
  });

  test("a rejecting run releases the key and reaches only its own caller", async () => {
    const queue = createRecoveryQueue();
    const boom = deferred();

    const failing = queue.run("ws-1", async () => {
      await boom.promise;
      throw new Error("resume threw");
    });
    const next = queue.run("ws-1", async () => "recovered");

    boom.resolve();
    await expect(failing).rejects.toThrow("resume threw");
    // The queue behind it is not wedged, and the rejection did not leak into it.
    expect(await next).toBe("recovered");
    expect(queue.size).toBe(0);
  });

  test("the map holds one entry while work is queued and empties when it settles", async () => {
    const queue = createRecoveryQueue();
    const gate = deferred();

    expect(queue.size).toBe(0);
    const a = queue.run("ws-1", () => gate.promise);
    const b = queue.run("ws-1", async () => {});
    const c = queue.run("ws-2", async () => {});
    // One entry per KEY, however many requests are queued behind it.
    expect(queue.size).toBe(2);

    gate.resolve();
    await Promise.all([a, b, c]);
    // A microtask for the cleanup `.then` behind the last tail.
    await Promise.resolve();
    expect(queue.size).toBe(0);
  });

  test("a parallel batch over many keys empties the map once everything settles", async () => {
    // V7 review, §"P2 performance/UX": `applyTaskRecovery` now enqueues every
    // requested workspace at once instead of awaiting them one by one, so the
    // map briefly holds one entry per key. It must still drain completely.
    const queue = createRecoveryQueue();
    const gate = deferred();
    const started: string[] = [];

    const batch = Promise.all(
      ["ws-1", "ws-2", "ws-3"].map((key) =>
        queue.run(key, async () => {
          started.push(key);
          if (key === "ws-1") await gate.promise;
          return key;
        }),
      ),
    );

    // Every key got going immediately — the slow one holds only itself.
    await Promise.resolve();
    expect(started).toEqual(["ws-1", "ws-2", "ws-3"]);
    expect(queue.size).toBe(3);

    gate.resolve();
    expect(await batch).toEqual(["ws-1", "ws-2", "ws-3"]);
    await Promise.resolve();
    expect(queue.size).toBe(0);
  });
});
