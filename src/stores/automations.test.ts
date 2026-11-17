import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAutomationsStore } from "./automations.js";

vi.mock("./app.js", () => ({ useAppStore: () => ({}) }));

const run = {
  workspaceId: "workspace",
  profileId: "default",
  runId: "d10a3220-1505-4c4c-a19a-92aa6726e911",
  state: "succeeded" as const,
};

describe("automation completion", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("settles a waiting run from the live event", async () => {
    const store = useAutomationsStore();
    const completion = store.waitForRun(run.runId);
    store.acceptRun(run);
    await expect(completion).resolves.toEqual(run);
  });

  it("replays payload completion even before the caller starts waiting", async () => {
    const store = useAutomationsStore();
    store.reconcileRuns([{ ...run, finishedAt: "2026-01-01T00:00:00Z" }]);
    await expect(store.waitForRun(run.runId)).resolves.toEqual(run);
  });
});
