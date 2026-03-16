import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createDefaultState, normalizeState } from "./default-state.js";

async function loadState(statePath) {
  if (!existsSync(statePath)) {
    const defaults = createDefaultState();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(defaults, null, 2));
    return defaults;
  }

  try {
    const raw = await fs.readFile(statePath, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    const brokenPath = `${statePath}.broken-${Date.now()}.json`;
    try {
      await fs.rename(statePath, brokenPath);
    } catch {
      // Best effort only. Recovery still proceeds with fresh defaults.
    }

    const defaults = createDefaultState();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

export async function createStore(statePath) {
  let state = await loadState(statePath);
  let pending = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
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
