import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// vi.hoisted ensures mockExec is created before the module factory runs.
const mockExec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ exec: mockExec }));

import { execCommand } from "./agent-task-exec.js";

// Minimal mock child process — mirrors docker-log-streamer.test.ts's MockChild.
class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

let mockChild: MockChild;

beforeEach(() => {
  mockChild = new MockChild();
  mockExec.mockReturnValue(mockChild);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("execCommand", () => {
  test("clears the hard-timeout timer once the child closes first", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const promise = execCommand("echo hi", "/tmp", 1000);
    mockChild.emit("close", 0);
    const result = await promise;

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    // The race's losing hard-timeout timer must be cancelled once the child
    // branch wins — otherwise it dangles for timeoutMs + 5000ms.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(mockChild.killed).toBe(false);
  });

  test("kills the child process when the hard timeout fires first", async () => {
    vi.useFakeTimers();
    try {
      const promise = execCommand("sleep 999", "/tmp", 1000);
      // Child never closes (hung process) — advance past timeoutMs + 5000.
      await vi.advanceTimersByTimeAsync(1000 + 5000 + 1);
      const result = await promise;

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("timed out");
      expect(mockChild.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
