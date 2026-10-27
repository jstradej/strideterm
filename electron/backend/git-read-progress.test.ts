import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIT_READ_BUSY_MESSAGE,
  GIT_READ_QUEUE_LIMIT_MS,
  reportGitReadProgress,
  timedGitRead,
} from "./git-read-progress.js";

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("timedGitRead", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fails a read that makes no progress with its own message", async () => {
    const read = timedGitRead(() => never(), "Git refresh timed out.", 30_000);
    const outcome = expect(read).rejects.toThrow("Git refresh timed out.");
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
  });

  it("keeps a read alive while its commands keep finishing, however long it runs", async () => {
    let finish!: (_result: string) => void;
    const read = timedGitRead(
      async () => {
        for (let step = 0; step < 4; step++) {
          reportGitReadProgress(1);
          await new Promise((resolve) => setTimeout(resolve, 20_000));
          reportGitReadProgress(-1);
          reportGitReadProgress(0);
        }
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
      "Git refresh timed out.",
      30_000,
    );
    await vi.advanceTimersByTimeAsync(80_000);
    finish("done");
    await expect(read).resolves.toBe("done");
  });

  it("waits for queued commands instead of calling the repository unavailable, up to the queue limit", async () => {
    const read = timedGitRead(
      async () => {
        reportGitReadProgress(1);
        return never<string>();
      },
      "Git refresh timed out.",
      30_000,
    );
    let settled = false;
    const outcome = read.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(GIT_READ_QUEUE_LIMIT_MS - 1000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(String(await outcome)).toContain(GIT_READ_BUSY_MESSAGE);
  });

  it("counts progress of a nested read toward the read that contains it", async () => {
    let finish!: (_result: string) => void;
    const read = timedGitRead(
      async () => {
        await timedGitRead(
          async () => {
            for (let step = 0; step < 3; step++) {
              await new Promise((resolve) => setTimeout(resolve, 10_000));
              reportGitReadProgress(0);
            }
          },
          "inner timed out",
          15_000,
        );
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
      "outer timed out",
      20_000,
    );
    await vi.advanceTimersByTimeAsync(35_000);
    finish("done");
    await expect(read).resolves.toBe("done");
  });
});
