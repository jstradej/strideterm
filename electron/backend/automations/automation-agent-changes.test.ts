import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AutomationAgentChanges } from "./automation-agent-changes.js";

it("persists only bounded metadata and reloads it for notification replay", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "automation-changes-"));
  try {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const file = path.join(dir, "changes.json");
    const store = new AutomationAgentChanges(file, () => now);
    const action = {
      workspaceId: "auto",
      profileId: "profile",
      workspaceName: "Daily",
      action: "created" as const,
      summary: "Every day; Claude",
    };
    const created = await store.append(action);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([created]);
    const reload = new AutomationAgentChanges(file, () => now);
    await reload.load();
    expect(reload.snapshot()).toEqual([created]);
    now += 25 * 60 * 60 * 1000;
    expect(reload.snapshot()).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
