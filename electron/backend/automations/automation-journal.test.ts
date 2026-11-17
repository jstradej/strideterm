import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationJournal } from "./automation-journal.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function create() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "automation-journal-"));
  dirs.push(dir);
  const warn = vi.fn();
  return { dir, warn, journal: new AutomationJournal(dir, warn) };
}
describe("automation journal", () => {
  it("keeps a deleted latest run's session identity until a new run takes over", async () => {
    const { dir, journal } = await create();
    await journal.update("ws", (state) => {
      for (const runId of ["older", "newest"])
        state.runs.push({
          runId,
          sessionId: "ws:agent",
          state: "succeeded",
          trigger: { type: "manual" },
          startedAt: "2026-01-01T00:00:00Z",
        });
    });
    await journal.update("ws", (state) => {
      state.runs = state.runs.filter((run) => run.runId !== "newest");
    });
    const reloaded = new AutomationJournal(dir, () => {});
    expect((await reloaded.read("ws")).latestSessionRuns["ws:agent"]).toBe("newest");
    await reloaded.update("ws", (state) => {
      state.runs.push({
        runId: "next",
        sessionId: "ws:agent",
        state: "running",
        trigger: { type: "manual" },
        startedAt: "2026-01-02T00:00:00Z",
      });
    });
    expect((await journal.read("ws")).latestSessionRuns["ws:agent"]).toBe("next");
  });
  it("serializes concurrent updates and survives a new instance", async () => {
    const { dir, journal } = await create();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        journal.update("ws", (state) => {
          state.seenEventIds.push(String(i));
        }),
      ),
    );
    const reloaded = new AutomationJournal(dir, () => {});
    expect((await reloaded.read("ws")).seenEventIds).toHaveLength(50);
    expect(JSON.parse(await readFile(path.join(dir, "ws.json"), "utf8")).v).toBe(1);
  });
  it("resets a corrupt journal with a warning and bounds retained ids", async () => {
    const { dir, warn, journal } = await create();
    await writeFile(path.join(dir, "ws.json"), "broken");
    expect((await journal.read("ws")).runs).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    await journal.update("ws", (state) => {
      state.seenEventIds = Array.from({ length: 2100 }, (_, i) => String(i));
    });
    const ids = (await journal.read("ws")).seenEventIds;
    expect(ids).toHaveLength(2000);
    expect(ids[0]).toBe("100");
  });
  it("rejects paths outside the journal directory", async () => {
    const { journal } = await create();
    await expect(journal.update("../outside", () => {})).rejects.toThrow("Invalid automation workspace id");
  });
  it("evicts finished history only after it is persisted and keeps an old active run", async () => {
    const { dir } = await create();
    const evicted = vi.fn(async (_workspaceId, runs) => {
      const persisted = JSON.parse(await readFile(path.join(dir, "ws.json"), "utf8"));
      expect(persisted.runs).toHaveLength(100);
      expect(persisted.runs.some((run: { runId: string }) => run.runId === "active")).toBe(true);
      expect(persisted.runs.some((run: { runId: string }) => run.runId === runs[0].runId)).toBe(false);
    });
    const journal = new AutomationJournal(
      dir,
      () => {},
      () => {},
      evicted,
    );
    await journal.update("ws", (state) => {
      state.runs.push({
        runId: "active",
        trigger: { type: "manual" },
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
      });
      for (let index = 0; index < 100; index++)
        state.runs.push({
          runId: `done-${index}`,
          trigger: { type: "manual" },
          state: "succeeded",
          startedAt: "2026-01-01T00:00:00Z",
        });
    });
    expect(evicted).toHaveBeenCalledWith("ws", [expect.objectContaining({ runId: "done-0" })]);
  });
});
