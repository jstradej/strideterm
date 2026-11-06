import { describe, expect, it, vi } from "vitest";
import { JiraReadScheduler } from "./jira-read-scheduler.js";

describe("JiraReadScheduler", () => {
  it("bounds global and per-connection permits and releases each permit once", async () => {
    const scheduler = new JiraReadScheduler(2, 1, 2);
    const releaseA = await scheduler.acquire("a", Date.now() + 1000);
    const releaseB = await scheduler.acquire("b", Date.now() + 1000);
    const queuedA = scheduler.acquire("a", Date.now() + 1000);
    releaseA();
    releaseA();
    const releaseA2 = await queuedA;
    releaseB();
    releaseA2();
    const next = await scheduler.acquire("a", Date.now() + 1000);
    next();
  });

  it("removes a waiter when its absolute deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new JiraReadScheduler(1, 1, 1);
      const held = await scheduler.acquire("a", Date.now() + 1000);
      const waiting = scheduler.acquire("a", Date.now() + 25);
      const overCapacity = scheduler.acquire("b", Date.now() + 1000);
      await expect(overCapacity).rejects.toThrow("queue is full");
      const rejected = expect(waiting).rejects.toThrow("deadline exceeded while waiting");
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      held();
      const recovered = await scheduler.acquire("b", Date.now() + 1000);
      recovered();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not grant a permit to a waiter whose deadline passed before draining", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new JiraReadScheduler(1, 1, 1);
      const held = await scheduler.acquire("a", Date.now() + 1000);
      const waiting = scheduler.acquire("b", Date.now() + 10);
      const rejected = expect(waiting).rejects.toThrow("deadline exceeded while waiting");
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      held();
      const next = await scheduler.acquire("b", Date.now() + 1000);
      next();
    } finally {
      vi.useRealTimers();
    }
  });
});
