import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createStore } from "./store.js";

const createdPaths = [];

async function createTempStatePath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-store-"));
  createdPaths.push(directory);
  return path.join(directory, "strideterm-state.json");
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("store", () => {
  test("serializes concurrent mutations", async () => {
    const store = await createStore(await createTempStatePath());

    await Promise.all([
      store.mutate(async (draft) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        draft.settings.theme = "light";
        draft.settings.remoteAccess.port = 50001;
      }),
      store.mutate(async (draft) => {
        draft.settings.sidebarWidth = 360;
      }),
    ]);

    expect(store.getState().settings.theme).toBe("light");
    expect(store.getState().settings.remoteAccess.port).toBe(50001);
    expect(store.getState().settings.sidebarWidth).toBe(360);
  });
});
