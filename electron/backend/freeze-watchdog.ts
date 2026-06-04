/// <reference types="node" />
// Main-thread side of the freeze watchdog. Bumps a shared heartbeat counter
// from the main event loop; a worker thread (freeze-watchdog-worker.ts)
// watches the counter and, when it stops moving, writes a report — including
// the main thread's JS stack — to logs/freeze-watchdog.log. Added after a
// full main-process freeze during a workspace switch left zero diagnostics
// (winston flushes via the very loop that was blocked).
import { Worker } from "node:worker_threads";
import path from "node:path";
import { getLogger, getLogDir } from "./logger.js";

const log = getLogger("freeze-watchdog");

const HEARTBEAT_INTERVAL_MS = 250;
const STALL_THRESHOLD_MS = 2000;
const CHECK_INTERVAL_MS = 500;

/**
 * Start the watchdog. Returns a stop function. Fail-soft: if the worker
 * can't start (e.g. worker_threads quirks inside asar), the app runs
 * without the watchdog rather than not at all.
 */
export function startFreezeWatchdog(): () => void {
  try {
    const sab = new SharedArrayBuffer(4);
    const heartbeat = new Int32Array(sab);
    const logPath = path.join(getLogDir(), "freeze-watchdog.log");
    const worker = new Worker(new URL("./freeze-watchdog-worker.js", import.meta.url), {
      workerData: {
        sab,
        logPath,
        stallThresholdMs: STALL_THRESHOLD_MS,
        checkIntervalMs: CHECK_INTERVAL_MS,
      },
    });
    // Neither the worker nor the heartbeat timer may hold the process open.
    worker.unref();
    worker.on("error", (err) => {
      log.warn("freeze watchdog worker error", { err: (err as Error)?.message });
    });
    const timer = setInterval(() => {
      Atomics.add(heartbeat, 0, 1);
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref();
    log.info("freeze watchdog started", { logPath, stallThresholdMs: STALL_THRESHOLD_MS });
    return () => {
      clearInterval(timer);
      void worker.terminate();
    };
  } catch (err) {
    log.warn("freeze watchdog unavailable", { err: (err as Error)?.message });
    return () => {};
  }
}
