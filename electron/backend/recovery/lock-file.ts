/// <reference types="node" />
/**
 * Runtime lock file — detects unclean shutdowns (crashes).
 *
 * Written on startup, deleted synchronously in before-quit.
 * If the lock exists on the next startup and the recorded PID is no
 * longer the same process (dead or PID-reused), we treat it as a crash.
 */
import fs from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getLogger } from "../logger.js";
import type { RuntimeLock } from "./types.js";

const execFileAsync = promisify(execFile);
const log = getLogger("recovery:lock-file");

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, filePath);
}

/** Returns the process start time in epoch ms, or null if not determinable. */
async function getProcessStartTime(pid: number): Promise<number | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime | Select-Object -ExpandProperty ToUniversalTime | ForEach-Object { $_.Subtract([datetime]::UnixEpoch).TotalMilliseconds }`,
        ],
        { timeout: 5000 },
      );
      const ms = parseFloat(stdout.trim());
      return isNaN(ms) ? null : Math.round(ms);
    }
    // Linux: /proc/<pid>/stat field 22 (starttime in clock ticks since boot)
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.split(" ");
      // field 22 (0-indexed: 21) = starttime in jiffies
      const jiffies = parseInt(fields[21] ?? "0", 10);
      const uptimeRaw = await fs.readFile("/proc/uptime", "utf8");
      const uptimeSec = parseFloat(uptimeRaw.split(" ")[0] ?? "0");
      const clockTicks = 100; // SC_CLK_TCK, almost always 100 on Linux
      const bootMs = Date.now() - uptimeSec * 1000;
      return Math.round(bootMs + (jiffies / clockTicks) * 1000);
    }
    // macOS / BSD
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5000 });
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

/** Returns true if the PID is alive AND its start-time matches the lock. */
async function isLockOwnerAlive(lock: RuntimeLock): Promise<boolean> {
  try {
    process.kill(lock.pid, 0); // throws if dead on Unix; noop on Windows for dead procs
  } catch {
    return false; // definitely dead
  }

  // PID alive — check start time to detect PID reuse
  const startTime = await getProcessStartTime(lock.pid);
  if (startTime === null) {
    // Can't determine start time — assume alive to avoid false positives
    return true;
  }
  // Allow 2 s drift (clock resolution differences between ps/powershell and Date.now)
  return Math.abs(startTime - lock.startedAt) < 2000;
}

/** Our own start time (cached on first call). */
let _ownStartMs: number | null = null;
async function getOwnStartTime(): Promise<number> {
  if (_ownStartMs !== null) return _ownStartMs;
  const t = await getProcessStartTime(process.pid);
  _ownStartMs = t ?? Date.now();
  return _ownStartMs;
}

export async function writeLockFile(lockPath: string): Promise<void> {
  const startedAt = await getOwnStartTime();
  const lock: RuntimeLock = { pid: process.pid, startedAt, execPath: process.execPath };
  await atomicWrite(lockPath, JSON.stringify(lock));
  log.info("runtime lock written", { pid: lock.pid, lockPath });
}

/** Synchronous delete — safe to call from before-quit. */
export function clearLockFileSync(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
    log.info("runtime lock cleared", { lockPath });
  } catch (err) {
    log.warn("failed to clear runtime lock", { lockPath, err: (err as Error).message });
  }
}

export type LockStatus =
  | "no-lock" // clean start
  | "live-owner" // another instance is running
  | "stale-crash"; // previous owner is dead → crash detected

export async function checkLockFile(lockPath: string): Promise<LockStatus> {
  if (!existsSync(lockPath)) return "no-lock";

  let lock: RuntimeLock;
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    lock = JSON.parse(raw) as RuntimeLock;
    if (!lock.pid || typeof lock.startedAt !== "number") throw new Error("malformed");
  } catch {
    log.warn("runtime lock corrupt — treating as stale crash", { lockPath });
    return "stale-crash";
  }

  const alive = await isLockOwnerAlive(lock);
  if (alive) {
    log.info("runtime lock: live owner found", { pid: lock.pid });
    return "live-owner";
  }

  log.info("runtime lock: owner dead — crash detected", { pid: lock.pid });
  return "stale-crash";
}
