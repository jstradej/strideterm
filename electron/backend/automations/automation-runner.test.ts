import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationState } from "../../shared/automation.js";
import { AutomationJournal } from "./automation-journal.js";
import { AutomationRunner, type AutomationRunnerOptions } from "./automation-runner.js";
import { drainAutomationEventQueue } from "./automation-event-router.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "automation-runner-"));
  dirs.push(cwd);
  const journal = new AutomationJournal(path.join(cwd, "journal"), () => {});
  const automation: AutomationState = {
    parentWorkspaceId: "parent",
    enabled: true,
    trigger: { type: "schedule", kind: "interval", everyMinutes: 5, anchor: "2026-01-01T00:00:00Z" },
    executor: { type: "agent", agent: { providerId: "claude", model: "", skipPermissions: false } },
    prompt: "literal prompt",
    location: "automation",
    policy: { maxRunMinutes: 60, catchUp: "skip", maxRunsPerHour: 6, subjectCooldownMinutes: 10 },
    createdBy: { kind: "desktop" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    enabledAt: "2026-01-01T00:00:00Z",
  };
  const restartAgent = vi.fn<AutomationRunnerOptions["restartAgent"]>(async () => "session");
  const stopSession = vi.fn(async () => {});
  const sessionOutput = vi.fn(() => "");
  const finished = vi.fn();
  const disableForFailures = vi.fn(async () => {});
  const runner = new AutomationRunner({
    journal,
    getWorkspace: () => ({ cwd, automation }),
    isPaused: () => false,
    restartAgent,
    stopSession,
    sessionOutput,
    finished,
    error: (_workspaceId, error) => {
      throw error;
    },
    disableForFailures,
  });
  return { cwd, journal, runner, restartAgent, stopSession, sessionOutput, finished, automation, disableForFailures };
}
describe("automation agent runner", () => {
  it("keeps a silent confirmation screen active until a result or completion hook proves completion", async () => {
    const x = await setup();
    const runId = await x.runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    expect(await x.runner.idle("session", "fallback")).toBe(false);
    expect(x.finished).not.toHaveBeenCalled();
    await x.runner.setDialog("session", true);
    await writeFile(path.join(x.cwd, ".strideterm", "automations", "auto", "runs", runId, "RESULT.md"), "Finished");
    expect(await x.runner.idle("session", "fallback")).toBe(false);
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("awaiting-user");
    await x.runner.setDialog("session", false);
    expect(await x.runner.idle("session", "fallback")).toBe(true);
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("succeeded");
    x.runner.dispose();
  });
  it("persists a bounded readable terminal tail and exit code without removing the exited agent", async () => {
    const x = await setup();
    const runId = await x.runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    x.sessionOutput.mockReturnValue(`${"old output\n".repeat(3000)}\u001b[31mError: authentication failed\u001b[0m`);
    await x.runner.exit("session", 17);
    const reloaded = new AutomationJournal(path.join(x.cwd, "journal"), () => {});
    const run = (await reloaded.read("auto")).runs[0]!;
    expect(run).toMatchObject({ runId, state: "failed", reason: "terminal-exit", exitCode: 17 });
    expect(run.output).toContain("Error: authentication failed");
    expect(run.output).not.toContain("\u001b");
    expect(run.output!.length).toBeLessThanOrEqual(16000);
    expect(x.stopSession).not.toHaveBeenCalled();
  });
  it("times out a run, stops its session, and disables after five failures", async () => {
    const x = await setup();
    x.automation.policy.maxRunMinutes = 1;
    const realSetTimeout = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === 60_000) {
        expire = callback;
        return { unref() {} } as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, delay);
    }) as typeof setTimeout);
    try {
      await x.journal.update("auto", (state) => {
        state.consecutiveFailures = 4;
      });
      const id = await x.runner.fire("auto", { type: "manual" });
      await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
      expect(expire).toBeDefined();
      expire!();
      await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("timed-out"));
      await vi.waitFor(() => expect(x.disableForFailures).toHaveBeenCalledWith("auto"));
      expect(x.stopSession).toHaveBeenCalledWith("session");
      expect((await x.journal.read("auto")).runs[0]).toMatchObject({ runId: id, state: "timed-out" });
    } finally {
      timer.mockRestore();
    }
  });
  it("stops a registered session when its launch fails", async () => {
    const x = await setup();
    const runner = new AutomationRunner({
      journal: x.journal,
      getWorkspace: () => ({ cwd: x.cwd, automation: x.automation }),
      isPaused: () => false,
      restartAgent: async (_workspaceId, _prompt, registerSession) => {
        await registerSession("partially-started-session");
        throw new Error("Prompt injection failed");
      },
      stopSession: x.stopSession,
      finished: x.finished,
      disableForFailures: x.disableForFailures,
      error: vi.fn(),
    });
    await runner.fire("auto", { type: "manual" });
    await vi.waitFor(() => expect(x.finished).toHaveBeenCalledOnce());
    expect((await x.journal.read("auto")).runs[0]).toMatchObject({
      state: "failed",
      reason: "Prompt injection failed",
    });
    expect(x.stopSession).toHaveBeenCalledWith("partially-started-session");
    expect(runner.ownsSession("partially-started-session")).toBe(false);
  });
  it("announces a stopped run even when session cleanup fails", async () => {
    const x = await setup();
    const runId = await x.runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    x.stopSession.mockRejectedValueOnce(new Error("Could not stop session"));
    await expect(x.runner.stop("auto", runId)).rejects.toThrow("Could not stop session");
    expect(x.finished).toHaveBeenCalledWith("auto", expect.objectContaining({ runId, state: "stopped" }));
    expect(x.runner.ownsSession("session")).toBe(false);
  });
  it("keeps the executor reserved until the stopped run releases its session", async () => {
    const x = await setup();
    const runId = await x.runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    let releaseSession!: () => void;
    const stopping = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    x.stopSession.mockReturnValueOnce(stopping);
    const stop = x.runner.stop("auto", runId);
    try {
      await vi.waitFor(() => expect(x.stopSession).toHaveBeenCalledWith("session"));
      await x.journal.update("auto", (state) => state.pendingEvents.push({ subject: "next", events: [{ id: "e" }] }));
      const skippedId = await x.runner.fire("auto", { type: "manual" });
      await expect(x.runner.fire("auto", { type: "event" }, "next")).rejects.toThrow("event remains queued");
      const journal = await x.journal.read("auto");
      expect(journal.runs).toMatchObject([
        { runId, state: "stopped" },
        { runId: skippedId, reason: "overlap" },
      ]);
      expect(journal.pendingEvents).toHaveLength(1);
      expect(x.restartAgent).toHaveBeenCalledOnce();
    } finally {
      releaseSession();
      await stop;
    }
    const nextId = await x.runner.fire("auto", { type: "event" }, "next");
    await vi.waitFor(async () => {
      expect((await x.journal.read("auto")).runs.at(-1)).toMatchObject({ runId: nextId, state: "running" });
    });
    expect(x.runner.ownsSession("session")).toBe(true);
    x.runner.dispose();
  });
  it("announces a failed run even when disabling the automation fails", async () => {
    const x = await setup();
    await x.journal.update("auto", (state) => {
      state.consecutiveFailures = 4;
    });
    const runId = await x.runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    x.disableForFailures.mockRejectedValueOnce(new Error("Could not disable automation"));
    await expect(x.runner.exit("session", 1)).rejects.toThrow("Could not disable automation");
    expect(x.finished).toHaveBeenCalledWith("auto", expect.objectContaining({ runId, state: "failed" }));
  });

  it.each([false, true])(
    "keeps the new run's agent when a stopped launch returns late (finished: %s)",
    async (finished) => {
      const x = await setup();
      let registered!: () => void;
      const firstRegistered = new Promise<void>((resolve) => {
        registered = resolve;
      });
      let resumeRestart!: (sessionId: string) => void;
      const firstRestart = new Promise<string>((resolve) => {
        resumeRestart = resolve;
      });
      x.restartAgent.mockImplementationOnce(async (_id, _prompt, registerSession) => {
        await registerSession("session");
        registered();
        return firstRestart;
      });
      const firstId = await x.runner.fire("auto", { type: "manual" });
      try {
        await firstRegistered;
        await x.runner.stop("auto", firstId);
        const secondId = await x.runner.fire("auto", { type: "manual" });
        await vi.waitFor(async () => {
          expect((await x.journal.read("auto")).runs.at(-1)).toMatchObject({ runId: secondId, state: "running" });
        });
        if (finished) expect(await x.runner.idle("session")).toBe(true);

        const read = vi.spyOn(x.journal, "read");
        resumeRestart("session");
        await vi.waitFor(() => expect(read).toHaveBeenCalledWith("auto"));
        await x.journal.read("auto");
        expect(x.stopSession).toHaveBeenCalledExactlyOnceWith("session");
        expect(x.runner.ownsSession("session")).toBe(!finished);
      } finally {
        resumeRestart("session");
        x.runner.dispose();
      }
    },
  );
  it("owns a session before launch resolves and retains an early permission dialog", async () => {
    const x = await setup();
    let release!: () => void;
    let registered!: () => void;
    const started = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new AutomationRunner({
      journal: x.journal,
      getWorkspace: () => ({ cwd: x.cwd, automation: x.automation }),
      isPaused: () => false,
      restartAgent: async (_workspaceId, _prompt, registerSession) => {
        await registerSession("early-session");
        registered();
        await wait;
        return "early-session";
      },
      stopSession: x.stopSession,
      finished: x.finished,
      disableForFailures: x.disableForFailures,
      error: (_id, error) => {
        throw error;
      },
    });
    await runner.fire("auto", { type: "manual" });
    await started;
    expect(runner.ownsSession("early-session")).toBe(true);
    await runner.setDialog("early-session", true);
    release();
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("awaiting-user"));
    await runner.setDialog("early-session", false);
    expect(await runner.idle("early-session")).toBe(true);
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("succeeded");
  });
  it("completes a turn that ends while session launch is still resolving", async () => {
    const x = await setup();
    let release!: () => void;
    let registered!: () => void;
    const started = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new AutomationRunner({
      journal: x.journal,
      getWorkspace: () => ({ cwd: x.cwd, automation: x.automation }),
      isPaused: () => false,
      restartAgent: async (_workspaceId, _prompt, registerSession) => {
        await registerSession("early-session");
        registered();
        await wait;
        return "early-session";
      },
      stopSession: x.stopSession,
      finished: x.finished,
      disableForFailures: x.disableForFailures,
      error: (_id, error) => {
        throw error;
      },
    });
    await runner.fire("auto", { type: "manual" });
    await started;
    expect(await runner.idle("early-session")).toBe(true);
    const read = vi.spyOn(x.journal, "read");
    release();
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await read.mock.results[0]!.value;
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("succeeded");
    expect(x.stopSession).not.toHaveBeenCalled();
    expect(x.finished).toHaveBeenCalledOnce();
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("succeeded");
  });
  it("tracks a review through terminal exit and records its draft count", async () => {
    const x = await setup();
    x.automation.location = "pr-review";
    const runner = new AutomationRunner({
      journal: x.journal,
      getWorkspace: () => ({ cwd: x.cwd, automation: x.automation }),
      isPaused: () => false,
      restartAgent: x.restartAgent,
      stopSession: x.stopSession,
      finished: x.finished,
      error: (_id, error) => {
        throw error;
      },
      disableForFailures: async () => {},
      review: {
        start: async ({ registerSession }) => {
          await registerSession("review-session", "review-workspace");
        },
        result: () => "2 review drafts created.",
      },
    });
    await x.journal.update("auto", (state) => state.pendingEvents.push({ subject: "pr", events: [{ id: "event" }] }));
    const id = await runner.fire("auto", { type: "event" }, "pr");
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    expect(await runner.idle("review-session")).toBe(true);
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("running");
    await runner.exit("review-session");
    expect((await x.journal.read("auto")).runs[0]).toMatchObject({
      runId: id,
      state: "succeeded",
      reviewWorkspaceId: "review-workspace",
      resultExcerpt: "2 review drafts created.",
    });
  });
  it("does not launch a review after its run is stopped during checkout", async () => {
    const x = await setup();
    x.automation.location = "pr-review";
    let proceed!: () => void;
    const wait = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const spawn = vi.fn();
    const runner = new AutomationRunner({
      journal: x.journal,
      getWorkspace: () => ({ cwd: x.cwd, automation: x.automation }),
      isPaused: () => false,
      restartAgent: x.restartAgent,
      stopSession: x.stopSession,
      finished: x.finished,
      error: (_id, error) => {
        throw error;
      },
      disableForFailures: async () => {},
      review: {
        start: async ({ registerSession, assertActive }) => {
          await wait;
          await assertActive();
          await registerSession("review-session", "review-workspace");
          spawn();
        },
        result: () => undefined,
      },
    });
    await x.journal.update("auto", (state) => state.pendingEvents.push({ subject: "pr", events: [{ id: "event" }] }));
    const id = await runner.fire("auto", { type: "event" }, "pr");
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("starting"));
    await runner.stop("auto", id);
    proceed();
    await vi.waitFor(() => expect(x.finished).toHaveBeenCalledOnce());
    expect(spawn).not.toHaveBeenCalled();
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("stopped");
  });
  it("rechecks the caller's grant before recording or stopping a run", async () => {
    const x = await setup();
    let checks = 0;
    const revoked = () => {
      if (++checks > 1) throw new Error("grant revoked");
    };
    await expect(x.runner.fire("auto", { type: "manual" }, undefined, "key-1234", revoked)).rejects.toThrow(
      "grant revoked",
    );
    expect((await x.journal.read("auto")).runs).toEqual([]);
    const id = await x.runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    checks = 0;
    await expect(x.runner.stop("auto", id, revoked)).rejects.toThrow("grant revoked");
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("running");
    expect(x.stopSession).not.toHaveBeenCalled();
    await x.runner.stop("auto", id);
  });
  it("retains a reserved task workspace when a starting run is interrupted", async () => {
    const x = await setup();
    await x.journal.update("auto", (state) => {
      state.runs.push({
        runId: "run",
        state: "starting",
        trigger: { type: "manual" },
        startedAt: "2026-01-01T00:00:00Z",
        taskWorkspaceId: "task-reserved",
      });
    });
    await x.runner.recover("auto");
    expect((await x.journal.read("auto")).runs[0]).toMatchObject({
      state: "interrupted",
      taskWorkspaceId: "task-reserved",
    });
  });
  it("persists intent before launch, injects a short file reference and handles dialog and idle", async () => {
    const x = await setup();
    const id = await x.runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    expect(x.restartAgent).toHaveBeenCalledWith(
      "auto",
      expect.stringContaining(`/runs/${id}/PROMPT.md`),
      expect.any(Function),
    );
    const dir = path.join(x.cwd, ".strideterm", "automations", "auto", "runs", id);
    expect(await readFile(path.join(dir, "PROMPT.md"), "utf8")).toContain("literal prompt");
    await x.runner.setDialog("session", true);
    expect(await x.runner.idle("session")).toBe(false);
    await x.runner.setDialog("session", true, "sandbox");
    await x.runner.setDialog("session", false);
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("awaiting-user");
    await x.runner.setDialog("session", false, "sandbox");
    await writeFile(path.join(dir, "RESULT.md"), "result");
    expect(await x.runner.idle("session")).toBe(true);
    expect((await x.journal.read("auto")).runs[0]).toMatchObject({ state: "succeeded", resultExcerpt: "result" });
    expect(x.finished).toHaveBeenCalledOnce();
    expect(x.stopSession).not.toHaveBeenCalled();
  });
  it("drains later queued subjects after rate-limited skips without a finished callback", async () => {
    const x = await setup();
    x.automation.policy.maxRunsPerHour = 1;
    await x.journal.update("auto", (state) => {
      const now = new Date().toISOString();
      state.runs.push({
        runId: "previous",
        trigger: { type: "manual" },
        state: "succeeded",
        startedAt: now,
        finishedAt: now,
      });
      state.pendingEvents.push(
        { subject: "first", events: [{ id: "one" }] },
        { subject: "second", events: [{ id: "two" }] },
      );
    });
    const error = vi.fn();
    await drainAutomationEventQueue(x.journal, x.runner, "auto", error);
    const state = await x.journal.read("auto");
    expect(state.pendingEvents).toEqual([]);
    expect(state.runs.filter((run) => run.reason === "rate-limited")).toHaveLength(2);
    expect(x.finished).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it("retains overlapping work and drains it after the active run ends", async () => {
    const x = await setup();
    const active = await x.runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    await x.journal.update("auto", (state) => state.pendingEvents.push({ subject: "next", events: [{ id: "e" }] }));
    const error = vi.fn();
    await drainAutomationEventQueue(x.journal, x.runner, "auto", error);
    expect((await x.journal.read("auto")).pendingEvents).toHaveLength(1);
    await x.runner.stop("auto", active);
    await drainAutomationEventQueue(x.journal, x.runner, "auto", error);
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs.at(-1)?.state).toBe("running"));
    const state = await x.journal.read("auto");
    expect(state.pendingEvents).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    await x.runner.stop("auto", state.runs.at(-1)!.runId);
  });
  it("records a rate-limited subject without consuming the next queued subject", async () => {
    const x = await setup();
    x.automation.policy.maxRunsPerHour = 1;
    await x.journal.update("auto", (state) => {
      const now = new Date().toISOString();
      state.runs.push({
        runId: "previous",
        trigger: { type: "manual" },
        state: "succeeded",
        startedAt: now,
        finishedAt: now,
      });
      state.pendingEvents.push(
        { subject: "first", events: [{ id: "one" }] },
        { subject: "second", events: [{ id: "two" }] },
      );
    });
    const id = await x.runner.fire("auto", { type: "event" }, "first");
    const state = await x.journal.read("auto");
    expect(state.runs.find((run) => run.runId === id)).toMatchObject({ state: "skipped", reason: "rate-limited" });
    expect(state.pendingEvents.map((item) => item.subject)).toEqual(["second"]);
    expect(x.restartAgent).not.toHaveBeenCalled();
  });
  it("records overlap without starting another agent", async () => {
    const x = await setup();
    await x.runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    await x.runner.fire("auto", { type: "schedule", slot: "2026-01-01T00:00:00Z" });
    const runs = (await x.journal.read("auto")).runs;
    expect(runs[1]).toMatchObject({ state: "skipped", reason: "overlap" });
    await x.runner.stop("auto", runs[0]!.runId);
    expect(x.stopSession).toHaveBeenCalledWith("session");
  });
  it("keeps events queued during overlap and claims them together with the run intent", async () => {
    const x = await setup();
    const first = await x.runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    await x.journal.update("auto", (state) => state.pendingEvents.push({ subject: "pr:1", events: [{ id: "evt" }] }));
    await expect(x.runner.fire("auto", { type: "event" }, "pr:1")).rejects.toThrow("remains queued");
    expect((await x.journal.read("auto")).pendingEvents).toHaveLength(1);
    await x.runner.stop("auto", first);
    const second = await x.runner.fire("auto", { type: "event" }, "pr:1");
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs.at(-1)?.state).toBe("running"));
    expect((await x.journal.read("auto")).pendingEvents).toHaveLength(0);
    const eventFile = path.join(x.cwd, ".strideterm", "automations", "auto", "runs", second, "EVENT.json");
    expect(JSON.parse(await readFile(eventFile, "utf8"))).toEqual([{ id: "evt" }]);
    await x.runner.stop("auto", second);
  });
  it("rechecks the definition after waiting for the journal before starting", async () => {
    const x = await setup();
    const originalUpdate = x.journal.update.bind(x.journal);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let enabled = true;
    const journal = Object.create(x.journal) as typeof x.journal;
    journal.update = async (workspaceId, change) => {
      entered();
      await gate;
      return originalUpdate(workspaceId, change);
    };
    const automation = {
      parentWorkspaceId: "parent",
      enabled: true,
      trigger: { type: "schedule", kind: "interval", everyMinutes: 5, anchor: "2026-01-01T00:00:00Z" },
      executor: { type: "agent", agent: { providerId: "claude", model: "", skipPermissions: false } },
      prompt: "x",
      location: "automation",
      policy: { maxRunMinutes: 60, catchUp: "skip", maxRunsPerHour: 6, subjectCooldownMinutes: 10 },
      createdBy: { kind: "desktop" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      enabledAt: "2026-01-01T00:00:00Z",
    } satisfies AutomationState;
    const runner = new AutomationRunner({
      journal,
      getWorkspace: () => ({ cwd: x.cwd, automation: { ...automation, enabled } }),
      isPaused: () => false,
      restartAgent: x.restartAgent,
      stopSession: x.stopSession,
      finished: x.finished,
      error: () => {},
      disableForFailures: async () => {},
    });
    const pending = runner.fire("auto", { type: "manual" });
    await started;
    enabled = false;
    release();
    await expect(pending).rejects.toThrow("unavailable or paused");
    expect(x.restartAgent).not.toHaveBeenCalled();
    expect((await x.journal.read("auto")).runs).toHaveLength(0);
  });
  it("records a task workspace before starting it and completes from task state", async () => {
    const x = await setup();
    const automation: AutomationState = {
      parentWorkspaceId: "root",
      enabled: true,
      trigger: { type: "schedule", kind: "interval", everyMinutes: 5, anchor: "2026-01-01T00:00:00Z" },
      executor: {
        type: "task",
        worker: { providerId: "claude", model: "", skipPermissions: false },
        judge: { providerId: "codex", model: "", skipPermissions: false },
        maxRounds: 3,
      },
      prompt: "do task",
      location: "automation",
      policy: { maxRunMinutes: 60, catchUp: "skip", maxRunsPerHour: 6, subjectCooldownMinutes: 10 },
      createdBy: { kind: "desktop" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      enabledAt: "2026-01-01T00:00:00Z",
    };
    const start = vi.fn(async () => {
      expect((await x.journal.read("auto")).runs[0]).toMatchObject({ taskWorkspaceId: "task-1", state: "running" });
    });
    const create = vi.fn(async () => "task-1");
    const runner = new AutomationRunner({
      journal: x.journal,
      getWorkspace: () => ({ cwd: x.cwd, automation }),
      isPaused: () => false,
      restartAgent: x.restartAgent,
      stopSession: x.stopSession,
      finished: x.finished,
      error: () => {},
      disableForFailures: async () => {},
      task: {
        conflicts: () => false,
        create,
        start,
        pause: async () => {},
        result: () => "pass",
      },
    });
    const runId = await runner.fire("auto", { type: "manual" });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith("auto", `.strideterm/automations/auto/runs/${runId}/PROMPT.md`, runId);
    await runner.onTaskSandboxDialog("task-1", "worker", true);
    await runner.onTaskSandboxDialog("task-1", "judge", true);
    await runner.onTaskState("task-1", "running");
    await runner.onTaskSandboxDialog("task-1", "worker", false);
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("awaiting-user");
    await runner.onTaskSandboxDialog("task-1", "judge", false);
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("running");
    await runner.onTaskState("task-1", "completed");
    expect((await x.journal.read("auto")).runs[0]).toMatchObject({
      state: "succeeded",
      taskWorkspaceId: "task-1",
      resultExcerpt: "pass",
    });
  });
  it("pauses an automation task when stopped", async () => {
    const x = await setup();
    const automation: AutomationState = {
      parentWorkspaceId: "root",
      enabled: true,
      trigger: { type: "schedule", kind: "interval", everyMinutes: 5, anchor: "2026-01-01T00:00:00Z" },
      executor: {
        type: "task",
        worker: { providerId: "claude", model: "", skipPermissions: false },
        judge: { providerId: "codex", model: "", skipPermissions: false },
        maxRounds: 3,
      },
      prompt: "task",
      location: "automation",
      policy: { maxRunMinutes: 60, catchUp: "skip", maxRunsPerHour: 6, subjectCooldownMinutes: 10 },
      createdBy: { kind: "desktop" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      enabledAt: "2026-01-01T00:00:00Z",
    };
    const pause = vi.fn(async () => {});
    const runner = new AutomationRunner({
      journal: x.journal,
      getWorkspace: () => ({ cwd: x.cwd, automation }),
      isPaused: () => false,
      restartAgent: x.restartAgent,
      stopSession: x.stopSession,
      finished: x.finished,
      error: () => {},
      disableForFailures: async () => {},
      task: {
        conflicts: () => false,
        create: async () => "task-1",
        start: async () => {},
        pause,
        result: () => undefined,
      },
    });
    const id = await runner.fire("auto", { type: "manual" });
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    await runner.stop("auto", id);
    expect(pause).toHaveBeenCalledWith("task-1");
    expect((await x.journal.read("auto")).runs[0]?.state).toBe("stopped");
  });
  it("replays a manual idempotency key from the journal without another launch", async () => {
    const x = await setup();
    const [first, second] = await Promise.all([
      x.runner.fire("auto", { type: "manual" }, undefined, "request-123"),
      x.runner.fire("auto", { type: "manual" }, undefined, "request-123"),
    ]);
    expect(first).toBe(second);
    await vi.waitFor(async () => expect((await x.journal.read("auto")).runs[0]?.state).toBe("running"));
    expect(x.restartAgent).toHaveBeenCalledOnce();
    await x.runner.stop("auto", first);
    expect(await x.runner.fire("auto", { type: "manual" }, undefined, "request-123")).toBe(first);
    expect((await x.journal.read("auto")).runs).toHaveLength(1);
  });
});
