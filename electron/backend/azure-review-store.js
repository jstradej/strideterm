import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

function createDefaultState() {
  return {
    version: 1,
    trackedPullRequests: {},
    connections: {},
  };
}

async function loadState(filePath) {
  if (!existsSync(filePath)) {
    return createDefaultState();
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      trackedPullRequests: typeof parsed?.trackedPullRequests === "object" && parsed.trackedPullRequests
        ? parsed.trackedPullRequests
        : {},
      connections: typeof parsed?.connections === "object" && parsed.connections
        ? parsed.connections
        : {},
    };
  } catch {
    return createDefaultState();
  }
}

export async function createAzureReviewStore(filePath) {
  let state = await loadState(filePath);
  let pending = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  }

  function enqueue(operation) {
    const next = pending.then(operation, operation);
    pending = next.catch(() => {});
    return next;
  }

  await persist();

  return {
    getState() {
      return state;
    },
    getTrackedPullRequest(key) {
      return key ? state.trackedPullRequests[key] || null : null;
    },
    async upsertTrackedPullRequest(key, patch) {
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
    async deleteTrackedPullRequest(key) {
      if (!key) {
        return;
      }
      return enqueue(async () => {
        delete state.trackedPullRequests[key];
        await persist();
      });
    },
    async upsertConnectionState(connectionId, patch) {
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
