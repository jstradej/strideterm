/// <reference types="node" />
// Worker-thread side of the main-process freeze watchdog. Runs OFF the main
// thread so it keeps ticking when the main event loop is blocked — which is
// exactly the condition it exists to diagnose. It must not depend on winston
// (whose transports flush via the main loop); findings go straight to a
// dedicated file with appendFileSync.
import { workerData } from "node:worker_threads";
import { appendFileSync } from "node:fs";
import inspector from "node:inspector";

interface WatchdogWorkerData {
  /** 1-slot Int32 heartbeat counter, incremented by the main thread. */
  sab: SharedArrayBuffer;
  /** File to append findings to (outside winston). */
  logPath: string;
  /** Main-thread silence that counts as a stall. */
  stallThresholdMs: number;
  /** How often this worker samples the heartbeat. */
  checkIntervalMs: number;
}

const { sab, logPath, stallThresholdMs, checkIntervalMs } = workerData as WatchdogWorkerData;
const heartbeat = new Int32Array(sab);

function writeLine(message: string): void {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Best-effort — a diagnostics failure must never take the worker down.
  }
}

/**
 * Capture the main thread's JS stack via the inspector protocol.
 * Debugger.pause uses a V8 interrupt, so it breaks even inside a running
 * (infinite) JS loop. If the main thread is stuck in a *native* synchronous
 * call (sync fs, conpty binding, ...) the pause can't land until that call
 * returns — the fallback timeout below records that distinction, which is
 * itself diagnostic.
 */
function captureMainThreadStack(): void {
  let session: inspector.Session | null = null;
  let captured = false;
  try {
    session = new inspector.Session();
    session.connectToMainThread();
    session.on("Debugger.paused", (msg) => {
      captured = true;
      const frames = msg.params.callFrames.map(
        (f) =>
          `    at ${f.functionName || "<anonymous>"} (${f.url}:${f.location.lineNumber + 1}:${(f.location.columnNumber ?? 0) + 1})`,
      );
      writeLine(`main-thread JS stack at stall:\n${frames.join("\n")}`);
      try {
        session?.post("Debugger.resume");
      } catch {
        /* ignore */
      }
      try {
        session?.disconnect();
      } catch {
        /* ignore */
      }
    });
    session.post("Debugger.enable");
    session.post("Debugger.pause");
    setTimeout(() => {
      if (!captured) {
        writeLine(
          "no JS stack obtainable within 2000ms — main thread likely blocked in a native/synchronous call (sync fs, pty binding, ...) rather than a JS loop",
        );
        try {
          session?.disconnect();
        } catch {
          /* ignore */
        }
      }
    }, 2000);
  } catch (err) {
    writeLine(`stack capture failed: ${(err as Error)?.message || err}`);
    try {
      session?.disconnect();
    } catch {
      /* ignore */
    }
  }
}

let lastCounter = Atomics.load(heartbeat, 0);
let lastChangeAt = Date.now();
let lastTickAt = Date.now();
let stallReported = false;
let stallStartedAt = 0;

setInterval(() => {
  const now = Date.now();
  const workerGap = now - lastTickAt;
  lastTickAt = now;

  const counter = Atomics.load(heartbeat, 0);
  if (counter !== lastCounter) {
    if (stallReported) {
      writeLine(`main thread recovered after ${now - stallStartedAt}ms`);
      stallReported = false;
    }
    lastCounter = counter;
    lastChangeAt = now;
    return;
  }

  // System suspend wakes both threads at once: our own tick gap is just as
  // large as the heartbeat silence. Don't report sleep as a freeze.
  if (workerGap > stallThresholdMs) {
    lastChangeAt = now;
    return;
  }

  const stalledFor = now - lastChangeAt;
  if (stalledFor >= stallThresholdMs && !stallReported) {
    stallReported = true;
    stallStartedAt = lastChangeAt;
    writeLine(`main thread event loop stalled for ${stalledFor}ms (pid ${process.pid}) — capturing stack`);
    captureMainThreadStack();
  }
}, checkIntervalMs);
