import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createDefaultState, normalizeState } from "./default-state.js";
import { getLogger } from "./logger.js";

const log = getLogger("store");

const LOAD_RETRIES = 3;
const RETRY_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Atomic write: write to a temp file first, then rename over the target.
 * This prevents half-written/empty files if the process crashes mid-write.
 */
async function atomicWriteFile(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, filePath);
}

async function loadState(statePath) {
  if (!existsSync(statePath)) {
    log.info("no state file found, creating defaults", { statePath });
    const defaults = createDefaultState();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await atomicWriteFile(statePath, JSON.stringify(defaults, null, 2));
    return { state: defaults, isDefaults: true };
  }

  let lastError;
  for (let attempt = 1; attempt <= LOAD_RETRIES; attempt++) {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      if (!raw.trim()) {
        throw new Error("State file is empty");
      }
      const parsed = JSON.parse(raw);
      if (attempt > 1) {
        log.info("state loaded on retry", { attempt });
      }
      return { state: normalizeState(parsed), isDefaults: false };
    } catch (error) {
      lastError = error;
      log.warn("load attempt failed", { attempt, totalRetries: LOAD_RETRIES, err: error.message });
      if (attempt < LOAD_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  log.error("all load attempts failed", { statePath, retries: LOAD_RETRIES, err: lastError?.message });
  throw new Error(
    `State file at ${statePath} could not be loaded after ${LOAD_RETRIES} attempts. ` +
      "Existing file was left untouched to avoid overwriting user data.",
  );
}

export async function createStore(statePath) {
  const { state: loadedState, isDefaults } = await loadState(statePath);
  let state = loadedState;
  let pending = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await atomicWriteFile(statePath, JSON.stringify(state, null, 2));
  }

  function enqueue(operation) {
    const next = pending.then(operation, operation);
    pending = next.catch((error) => {
      log.error("persist queue error", { err: error.message });
    });
    return next;
  }

  // Only persist on startup when we loaded fresh defaults (new file).
  // Never overwrite an existing config that was successfully loaded.
  if (isDefaults) {
    await persist();
  }

  return {
    getState() {
      return state;
    },
    async replace(nextState) {
      return enqueue(async () => {
        state = normalizeState(nextState);
        await persist();
        return state;
      });
    },
    async mutate(mutator) {
      return enqueue(async () => {
        const draft = structuredClone(state);
        const result = await mutator(draft);
        state = normalizeState(result || draft);
        await persist();
        return state;
      });
    },
    async save() {
      return enqueue(async () => {
        await persist();
        return state;
      });
    },
  };
}
