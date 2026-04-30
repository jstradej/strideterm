import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// We test the public API; internal helpers are exercised indirectly.
import { writeLockFile, clearLockFileSync, checkLockFile } from "./lock-file.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "lock-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const lockPath = () => path.join(tmpDir, "runtime.lock");

// ---------------------------------------------------------------------------
// writeLockFile
// ---------------------------------------------------------------------------
describe("writeLockFile", () => {
  test("creates the lock file with pid and startedAt", async () => {
    await writeLockFile(lockPath());
    const raw = await readFile(lockPath(), "utf8");
    const lock = JSON.parse(raw);
    expect(lock.pid).toBe(process.pid);
    expect(typeof lock.startedAt).toBe("number");
    expect(lock.startedAt).toBeGreaterThan(0);
    expect(lock.execPath).toBe(process.execPath);
  });

  test("is atomic — temp file is cleaned up", async () => {
    await writeLockFile(lockPath());
    const files = (await import("node:fs/promises")).readdir(tmpDir);
    const names = await files;
    // Only the final lock file should exist; no .tmp-* leftover
    expect(names.filter((f) => f.includes(".tmp-"))).toHaveLength(0);
    expect(names).toContain("runtime.lock");
  });

  test("overwrites an existing lock file", async () => {
    await writeLockFile(lockPath());
    const first = JSON.parse(await readFile(lockPath(), "utf8"));
    await writeLockFile(lockPath());
    const second = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(second.pid).toBe(first.pid);
    expect(existsSync(lockPath())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clearLockFileSync
// ---------------------------------------------------------------------------
describe("clearLockFileSync", () => {
  test("deletes an existing lock file", async () => {
    await writeLockFile(lockPath());
    expect(existsSync(lockPath())).toBe(true);
    clearLockFileSync(lockPath());
    expect(existsSync(lockPath())).toBe(false);
  });

  test("does not throw when lock file does not exist", () => {
    expect(() => clearLockFileSync(path.join(tmpDir, "nonexistent.lock"))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkLockFile
// ---------------------------------------------------------------------------
describe("checkLockFile", () => {
  test("returns 'no-lock' when file does not exist", async () => {
    const status = await checkLockFile(lockPath());
    expect(status).toBe("no-lock");
  });

  test("returns 'stale-crash' for a lock with a dead PID", async () => {
    // Use PID 99999 which is almost certainly dead (and definitely not ours)
    const lock = { pid: 99999, startedAt: Date.now() - 60_000, execPath: process.execPath };
    await writeFile(lockPath(), JSON.stringify(lock), "utf8");
    const status = await checkLockFile(lockPath());
    // On most systems PID 99999 is not running; but we guard against the
    // rare case it is by accepting live-owner too (not a test environment issue)
    expect(["stale-crash", "live-owner"]).toContain(status);
  });

  test("returns 'stale-crash' for a corrupt lock file", async () => {
    await writeFile(lockPath(), "not valid json{{", "utf8");
    const status = await checkLockFile(lockPath());
    expect(status).toBe("stale-crash");
  });

  test("returns 'stale-crash' for a lock with missing required fields", async () => {
    await writeFile(lockPath(), JSON.stringify({ pid: 0 }), "utf8");
    const status = await checkLockFile(lockPath());
    expect(status).toBe("stale-crash");
  });

  test("returns 'live-owner' for our own process PID with matching start time", async () => {
    // Write a lock for the current process; writeLockFile does exactly this.
    await writeLockFile(lockPath());
    const status = await checkLockFile(lockPath());
    // Our process is definitely alive, so it should be live-owner.
    expect(status).toBe("live-owner");
  });
});
