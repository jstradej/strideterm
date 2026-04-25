/// <reference types="node" />
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

interface TrackedPullRequest {
  key: string;
  [key: string]: unknown;
}

interface ConnectionState {
  connectionId: string;
  [key: string]: unknown;
}

interface AzureReviewState {
  version: number;
  trackedPullRequests: Record<string, TrackedPullRequest>;
  connections: Record<string, ConnectionState>;
}

function createDefaultState(): AzureReviewState {
  return {
    version: 1,
    trackedPullRequests: {},
    connections: {},
  };
}

async function loadState(filePath: string): Promise<AzureReviewState> {
  if (!existsSync(filePath)) {
    return createDefaultState();
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { trackedPullRequests?: unknown; connections?: unknown };
    return {
      version: 1,
      trackedPullRequests:
        typeof parsed?.trackedPullRequests === "object" && parsed.trackedPullRequests ? parsed.trackedPullRequests as Record<string, TrackedPullRequest> : {},
      connections: typeof parsed?.connections === "object" && parsed.connections ? parsed.connections as Record<string, ConnectionState> : {},
    };
  } catch {
    return createDefaultState();
  }
}

export async function createAzureReviewStore(filePath: string) {
  const state = await loadState(filePath);
  let pending: Promise<unknown> = Promise.resolve();

  async function persist(): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.then(operation, operation) as Promise<T>;
    pending = next.catch(() => {});
    return next;
  }

  await persist();

  return {
    getState(): AzureReviewState {
      return state;
    },
    getTrackedPullRequest(key: string | undefined | null): TrackedPullRequest | null {
      return key ? state.trackedPullRequests[key] || null : null;
    },
    async upsertTrackedPullRequest(key: string, patch: Record<string, unknown>): Promise<TrackedPullRequest> {
      if (!key) {
        throw new Error("Tracked pull request key is required.");
      }
      return enqueue(async () => {
        state.trackedPullRequests[key] = {
          ...(state.trackedPullRequests[key] || {}),
          ...patch,
          key,
        };
        await persist();
        return state.trackedPullRequests[key];
      });
    },
    async deleteTrackedPullRequest(key: string | undefined | null): Promise<void> {
      if (!key) {
        return;
      }
      return enqueue(async () => {
        delete state.trackedPullRequests[key];
        await persist();
      });
    },
    async upsertConnectionState(connectionId: string, patch: Record<string, unknown>): Promise<ConnectionState> {
      if (!connectionId) {
        throw new Error("Connection id is required.");
      }
      return enqueue(async () => {
        state.connections[connectionId] = {
          ...(state.connections[connectionId] || {}),
          ...patch,
          connectionId,
        };
        await persist();
        return state.connections[connectionId];
      });
    },
  };
}
