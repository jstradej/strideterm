import { getLogger } from "../logger.js";
import { JiraRequestError } from "./jira-request-error.js";

const log = getLogger("jira");
const QUEUE_FULL_LOG_MS = 30_000;
let lastQueueFullLogAt = 0;

/** A wait that ended before any request existed: nothing was sent, so nothing can have been applied. */
function notSent(message: string): JiraRequestError {
  return new JiraRequestError("network", message, undefined, undefined, { notSent: true });
}

function queueFull(): JiraRequestError {
  const at = Date.now();
  if (at - lastQueueFullLogAt >= QUEUE_FULL_LOG_MS) {
    lastQueueFullLogAt = at;
    log.warn("jira request queue is full; new requests are refused until it drains");
  }
  return new JiraRequestError(
    "rate-limited",
    "Too many Jira requests are waiting (the request queue is full). Try again in a moment.",
    undefined,
    undefined,
    { notSent: true },
  );
}

/** Bounded, fair-enough scheduling for Jira reads and writes. */
export class JiraReadScheduler {
  private activeGlobal = 0;
  private readonly activeByConnection = new Map<string, number>();
  private readonly waiters: Array<{
    connectionId: string;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    deadlineAt: number;
    timer: ReturnType<typeof setTimeout>;
    settled: boolean;
  }> = [];

  constructor(
    private readonly maxGlobal = 8,
    private readonly maxPerConnection = 4,
    private readonly maxQueue = 64,
  ) {}

  acquire(connectionId: string, deadlineAt: number): Promise<() => void> {
    if (Date.now() >= deadlineAt) return Promise.reject(notSent("Jira request deadline exceeded."));
    if (this.canStart(connectionId)) return Promise.resolve(this.take(connectionId));
    if (this.waiters.length >= this.maxQueue) return Promise.reject(queueFull());
    return new Promise((resolve, reject) => {
      const waiter = {
        connectionId,
        resolve,
        reject,
        deadlineAt,
        settled: false,
        timer: setTimeout(
          () => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) this.waiters.splice(index, 1);
            waiter.settled = true;
            reject(notSent("Jira request deadline exceeded while waiting for capacity."));
          },
          Math.max(1, deadlineAt - Date.now()),
        ),
      };
      this.waiters.push(waiter);
    });
  }

  private canStart(connectionId: string): boolean {
    return (
      this.activeGlobal < this.maxGlobal && (this.activeByConnection.get(connectionId) || 0) < this.maxPerConnection
    );
  }

  private take(connectionId: string): () => void {
    this.activeGlobal++;
    this.activeByConnection.set(connectionId, (this.activeByConnection.get(connectionId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
      const remaining = Math.max(0, (this.activeByConnection.get(connectionId) || 1) - 1);
      if (remaining) this.activeByConnection.set(connectionId, remaining);
      else this.activeByConnection.delete(connectionId);
      this.drain();
    };
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length && this.activeGlobal < this.maxGlobal;) {
      const waiter = this.waiters[index];
      if (waiter.settled) {
        this.waiters.splice(index, 1);
        continue;
      }
      if (waiter.deadlineAt <= Date.now()) {
        this.waiters.splice(index, 1);
        waiter.settled = true;
        clearTimeout(waiter.timer);
        waiter.reject(notSent("Jira request deadline exceeded while waiting for capacity."));
        continue;
      }
      if (!this.canStart(waiter.connectionId)) {
        index++;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiter.resolve(this.take(waiter.connectionId));
    }
  }
}

/** Shared by every JiraManager in the desktop process, including IPC and MCP clients. */
export const sharedJiraReadScheduler = new JiraReadScheduler(8, 4, 64);
