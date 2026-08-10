import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { AgentTaskRunner, sessionIdFor } from "./agent-task-runner.js";
import { readVerificationRecord } from "./agent-task-files.js";
import {
  CONTEXT_FILE,
  HANDOFF_FILE,
  PROMPT_FILE,
  TASK_FILE,
  VERDICT_FILE,
  VERIFICATION_FILE,
  WORK_LOCK_FILE,
  taskDir,
} from "./agent-task-utils.js";

// The companion/capture prompts are always > FILE_PROMPT_THRESHOLD chars, so
// #injectPrompt always writes them to PROMPT.md and injects a short pointer
// instead of the raw text — read the file to see what was actually sent.
async function readLastPrompt(cwd: string, taskId: string): Promise<string> {
  return fs.readFile(path.join(taskDir(cwd, taskId), PROMPT_FILE), "utf8");
}

// Resolves whichever the injection actually did: a short direct paste, or a
// "Read PROMPT.md and follow it" pointer for text over FILE_PROMPT_THRESHOLD.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readInjectedText(deps: any, sessionId: string, cwd: string, taskId: string): Promise<string> {
  const texts = deps.written
    .filter((w: { sessionId: string; data: string }) => w.sessionId === sessionId && w.data !== "\r")
    .map((w: { data: string }) => w.data);
  const last = texts[texts.length - 1] || "";
  if (last.includes(PROMPT_FILE)) {
    return fs.readFile(path.join(taskDir(cwd, taskId), PROMPT_FILE), "utf8");
  }
  return last;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

// A nudge is not delivered when `judgeNudged` flips — #injectPrompt resolves
// only after the trailing Enter, submitDelayMs later, and the verdict handler
// holds its re-entrancy guard until then. A real follow-up idle for a session
// can only arrive after delivery (it IS the agent's next turn), so tests firing
// one synthetically have to wait for the same thing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForDelivery(deps: any, sessionId: string): Promise<void> {
  await waitFor(() => {
    const last = deps.written[deps.written.length - 1];
    return last?.sessionId === sessionId && last?.data === "\r";
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockDeps(workspaces: any[] = []): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const written: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alerts: any[] = [];
  let broadcastCount = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeToSession: vi.fn((sessionId: any, data: any) => written.push({ sessionId, data })),
    getState: () => ({ workspaces, activeProfileId: "default" }),
    broadcastState: vi.fn(() => broadcastCount++),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raiseAlert: vi.fn((alert: any) => alerts.push(alert)),
    restartSession: vi.fn(async () => {}),
    isSessionBusy: vi.fn(() => false),
    isSessionHookCapable: vi.fn(() => false),
    isAgentDroppedToShell: vi.fn(() => false),
    written,
    alerts,
    get broadcastCount() {
      return broadcastCount;
    },
  };
}

// A plain (non-task) workspace hosting the "existing live conversation" —
// exactly what a companion loop attaches to.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createSourceWorkspace(overrides: any = {}): any {
  return {
    id: overrides.id || "workspace-source",
    name: "Source workspace",
    icon: "",
    color: "#123456",
    kind: "manual",
    source: "manual",
    pluginId: "",
    cwd: overrides.cwd || "/tmp/source-project",
    gitRoots: [],
    activeRootPath: "",
    notes: "",
    profileId: overrides.profileId || "default",
    connectionId: "",
    activePanelId: "panel-source",
    activeViewId: null,
    splitLayout: null,
    splitViewIds: [],
    starred: false,
    review: null,
    quickfix: null,
    panels: [{ id: "panel-source", title: "Claude", command: "claude", shell: true, cwd: overrides.panelCwd }],
    task: null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function setupAttached(overrides: any = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-companion-"));
  const source = createSourceWorkspace({ cwd: tmp, ...overrides.source });
  const runner = new AgentTaskRunner();
  const companionWorkspace = runner.createCompanionTaskWorkspace({
    state: { workspaces: [source] },
    workerWorkspaceId: source.id,
    workerPanelId: source.panels[0].id,
    companionRole: overrides.role || "reviewer",
    companionProvider: overrides.companionProvider || { providerId: "codex", model: "gpt-5.5" },
    focus: overrides.focus,
    maxRounds: overrides.maxRounds || 5,
  });
  const deps = createMockDeps([source, companionWorkspace]);
  runner.init(deps);
  await runner.writeCompanionFiles(tmp, companionWorkspace.task);
  return { tmp, source, runner, deps, companionWorkspace };
}

async function cleanup(tmp: string): Promise<void> {
  await fs.rm(tmp, { recursive: true, force: true });
}

// Attached task at "running", round 2, WORK_LOCK present — the state right
// after a "continue" verdict sent the Primary back to work. Shared by the
// round-review verification gate tests and the rate-limit lifecycle tests
// below, both of which need a Primary "mid-round" to probe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reachRunningRoundTwo(): Promise<any> {
  const setup = await setupAttached();
  const { tmp, runner, companionWorkspace } = setup;
  const dir = taskDir(tmp, companionWorkspace.task.taskId);
  await fs.mkdir(dir, { recursive: true });
  const ctx =
    "# Objective\nX\n\n# Confirmed requirements\nX\n\n# Acceptance criteria\nX\n\n# Constraints\nX\n\n# Decisions already made\nX\n\n# Explicit non-goals\nX\n\n# Open questions or ambiguities\nX\n";
  const handoff =
    "# Current state\nX\n\n# Work already completed\nX\n\n# Work in progress\nX\n\n# Files and commits touched\nX\n\n# Verification already run\nX\n\n# External or destructive side effects already performed\nX\n\n# Known blockers\nX\n\n# Recommended next step\nX\n";
  await fs.writeFile(path.join(dir, CONTEXT_FILE), ctx, "utf8");
  await fs.writeFile(path.join(dir, HANDOFF_FILE), handoff, "utf8");
  companionWorkspace.task.state = "brief-ready";
  await runner.startTask(companionWorkspace.id);
  await fs.writeFile(
    path.join(dir, VERDICT_FILE),
    JSON.stringify({
      schemaVersion: 1,
      role: "reviewer",
      phase: "baseline",
      round: 1,
      evaluationAttempt: companionWorkspace.task.companionEvaluationAttempt,
      verdict: "continue",
      reason: "fix it",
      // Deliberately "missing" (not "not-required") — the baseline review has
      // no code changes yet either way, but "not-required" would set
      // task.verificationNotRequired and short-circuit every gate test below.
      // Reviewer always expects a real record.
      verificationReview: { recordStatus: "missing", evidenceReviewed: [], workerActionsRequired: [] },
      roleAnalysis: {
        type: "reviewer",
        requirementAudit: [{ requirement: "R1", status: "missing", evidence: [] }],
      },
      blockingFindings: [
        { id: "REQ-1", title: "x", category: "requirements", evidence: ["x"], impact: "x", requiredAction: "x" },
      ],
      advisories: [],
      questions: [],
    }),
    "utf8",
  );
  const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
  runner.onAgentIdle(judgeSessionId, "test");
  await waitFor(() => companionWorkspace.task.state === "running" && companionWorkspace.task.currentRound === 2);
  return setup;
}

// A real round-2 VERIFICATION.md the runner has actually read, then a
// round-review evaluation in flight. This is the ONLY state a reviewer/critic
// "complete" can be accepted from: the runtime completion floor checks the
// verdict's recordStatus claim against the record the runner itself handed to
// the evaluation, so a baseline (handed nothing) can never sign off.
const FRESH_VERIFICATION_ROUND_2 =
  "# Verification\n\nEvaluation target: 2\nRecorded at: now\n\n## Commands\n\n### V-1\nCommand: `npm test`\nResult: PASS\nExit code: 0\n";

// Stand-in for the Primary writing its own record. The freshness gate rejects
// anything whose mtime does not strictly beat the baseline the runner stamped
// when it sent the round out; a real Primary answers a round later, a test
// answers within the same millisecond. One timer tick restores that ordering
// without making the assertion itself timing-dependent.
async function writePrimaryRecord(dir: string, content: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 2));
  await fs.writeFile(path.join(dir, VERIFICATION_FILE), content, "utf8");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reachRoundReviewWithEvidence(): Promise<any> {
  const setup = await reachRunningRoundTwo();
  const { tmp, runner, companionWorkspace } = setup;
  const dir = taskDir(tmp, companionWorkspace.task.taskId);
  await writePrimaryRecord(dir, FRESH_VERIFICATION_ROUND_2);
  await fs.rm(path.join(dir, WORK_LOCK_FILE), { force: true });
  runner.onAgentIdle(sessionIdFor(companionWorkspace, "worker"), "test");
  await waitFor(
    () =>
      companionWorkspace.task.state === "judge-evaluating" && companionWorkspace.task.companionPhase === "round-review",
  );
  return setup;
}

describe("AgentTaskRunner — attached mode (Companion loop)", () => {
  describe("sessionIdFor", () => {
    test("standard task: worker and judge both resolve within the task workspace", () => {
      const runner = new AgentTaskRunner();
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "x",
        cwd: "/tmp/p",
        parentWorkspaceId: "",
      });
      expect(sessionIdFor(ws, "worker")).toBe(`${ws.id}:${ws.task.workerPanelId}`);
      expect(sessionIdFor(ws, "judge")).toBe(`${ws.id}:${ws.task.judgePanelId}`);
    });

    test("attached task: worker resolves to the EXTERNAL source session, judge stays local", async () => {
      const { tmp, source, companionWorkspace } = await setupAttached();
      try {
        expect(sessionIdFor(companionWorkspace, "worker")).toBe(`${source.id}:${source.panels[0].id}`);
        expect(sessionIdFor(companionWorkspace, "judge")).toBe(
          `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`,
        );
      } finally {
        await cleanup(tmp);
      }
    });
  });

  describe("createCompanionTaskWorkspace", () => {
    test("has only Dashboard + Companion panels, no Worker panel", async () => {
      const { tmp, companionWorkspace } = await setupAttached();
      try {
        expect(companionWorkspace.panels).toHaveLength(2);
        expect(companionWorkspace.panels[0].command).toBe("__task-dashboard__");
        expect(companionWorkspace.panels[1].id).toBe(companionWorkspace.task.judgePanelId);
        expect(companionWorkspace.task.mode).toBe("attached");
        expect(companionWorkspace.task.judgeExecutionPolicy).toBe("inspect-only");
        expect(companionWorkspace.task.state).toBe("idle");
        expect(companionWorkspace.task.showerInterval).toBe(0);
      } finally {
        await cleanup(tmp);
      }
    });

    test("effective cwd prefers the source PANEL's cwd over the workspace cwd", () => {
      const runner = new AgentTaskRunner();
      const source = createSourceWorkspace({ cwd: "/tmp/workspace-cwd", panelCwd: "/tmp/panel-cwd" });
      const companionWorkspace = runner.createCompanionTaskWorkspace({
        state: { workspaces: [source] },
        workerWorkspaceId: source.id,
        workerPanelId: source.panels[0].id,
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "x" },
      });
      expect(companionWorkspace.cwd).toBe("/tmp/panel-cwd");
    });

    test("never persists skipPermissions:true for the companion provider, even if the caller passed it", async () => {
      const { tmp, companionWorkspace } = await setupAttached({
        companionProvider: { providerId: "codex", model: "gpt-5.5", skipPermissions: true },
      });
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((companionWorkspace.task.judgeProviderConfig as any).skipPermissions).toBe(false);
        expect(companionWorkspace.panels[1].command).not.toContain("dangerously-bypass-approvals-and-sandbox");
      } finally {
        await cleanup(tmp);
      }
    });

    test("throws a readable error when the source workspace/panel doesn't exist", () => {
      const runner = new AgentTaskRunner();
      expect(() =>
        runner.createCompanionTaskWorkspace({
          state: { workspaces: [] },
          workerWorkspaceId: "missing-ws",
          workerPanelId: "missing-panel",
          companionRole: "reviewer",
          companionProvider: { providerId: "codex", model: "x" },
        }),
      ).toThrow(/source workspace not found/i);
    });

    test("stores the optional focus and companion role", async () => {
      const { tmp, companionWorkspace } = await setupAttached({ role: "critic", focus: "Watch for data loss." });
      try {
        expect(companionWorkspace.task.companionRole).toBe("critic");
        expect(companionWorkspace.task.companionFocus).toBe("Watch for data loss.");
      } finally {
        await cleanup(tmp);
      }
    });
  });

  describe("resolveTaskBinding (via onAgentIdle/onUserInput routing)", () => {
    test("routes the external Primary session's idle event to the attached task, not the normal user pipeline", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id); // idle -> capturing-context
        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        const handled = runner.onAgentIdle(sourceSessionId, "test");
        expect(handled).toBe(true);
        expect(deps.written.some((w: { sessionId: string }) => w.sessionId === sourceSessionId)).toBe(true);
      } finally {
        await cleanup(tmp);
      }
    });

    test("an unrelated session id is not claimed by the attached task", async () => {
      const { tmp, runner } = await setupAttached();
      try {
        const handled = runner.onAgentIdle("workspace-unrelated:panel-unrelated", "test");
        expect(handled).toBe(false);
      } finally {
        await cleanup(tmp);
      }
    });

    test("routes the external Primary session's UserPromptSubmit through the binding resolver too — not just onAgentIdle", async () => {
      // Regression: onUserPromptSubmit used to re-derive workspaceId inline
      // via #findTaskWorkspace instead of #resolveTaskBinding, so it always
      // missed the attached fallback (the Primary's workspaceId is the
      // SOURCE workspace, never a task workspace). That meant
      // #resolveSubmitWaiters(sessionId) was never reached for the Primary,
      // so every verified prompt injection into it would burn through its
      // full retry budget (extra "\r" keystrokes into the live conversation)
      // before timing out, even though the prompt was submitted correctly.
      const { tmp, source, runner } = await setupAttached();
      try {
        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        const handled = runner.onUserPromptSubmit(sourceSessionId);
        expect(handled).toBe(true);
      } finally {
        await cleanup(tmp);
      }
    });
  });

  describe("capture (capturing-context -> brief-ready)", () => {
    test("Start on idle injects the capture prompt into the EXTERNAL Primary session, never the Companion panel", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await setupAttached();
      try {
        const ok = await runner.startTask(companionWorkspace.id);
        expect(ok).toBe(true);
        expect(companionWorkspace.task.state).toBe("capturing-context");
        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        expect(deps.written.some((w: { sessionId: string }) => w.sessionId === sourceSessionId)).toBe(true);
        const promptContent = await readLastPrompt(tmp, companionWorkspace.task.taskId);
        expect(promptContent).toContain("CONTEXT CAPTURE ONLY");
        expect(promptContent).not.toContain("/clear");
      } finally {
        await cleanup(tmp);
      }
    });

    test("incomplete capture nudges once, then pauses with an actionable alert on the next incomplete idle", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        const sourceSessionId = `${source.id}:${source.panels[0].id}`;

        // First idle: capture files don't exist yet -> nudge, stay capturing.
        runner.onAgentIdle(sourceSessionId, "test");
        await waitFor(() => deps.written.length >= 2);
        expect(companionWorkspace.task.state).toBe("capturing-context");

        // Second idle, still incomplete -> pause.
        runner.onAgentIdle(sourceSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "paused");
        expect(deps.alerts.some((a: { kind: string }) => a.kind !== "completed")).toBe(true);
      } finally {
        await cleanup(tmp);
      }
    });

    const validContext = `# Objective\nDo the thing.\n\n# Confirmed requirements\nReq 1.\n\n# Acceptance criteria\nCriteria.\n\n# Constraints\nNone.\n\n# Decisions already made\nNone.\n\n# Explicit non-goals\nNone.\n\n# Open questions or ambiguities\nNone.\n`;
    const validHandoff = `# Current state\nIn progress.\n\n# Work already completed\nSome work.\n\n# Work in progress\nMore work.\n\n# Files and commits touched\nfile.ts\n\n# Verification already run\nnpm test\n\n# External or destructive side effects already performed\nNone.\n\n# Known blockers\nNone.\n\n# Recommended next step\nKeep going.\n`;

    test("valid CONTEXT.md + HANDOFF.md moves the task to brief-ready", async () => {
      const { tmp, source, runner, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await fs.writeFile(path.join(dir, CONTEXT_FILE), validContext, "utf8");
        await fs.writeFile(path.join(dir, HANDOFF_FILE), validHandoff, "utf8");

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        runner.onAgentIdle(sourceSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "brief-ready");
      } finally {
        await cleanup(tmp);
      }
    });

    // Nothing deletes CONTEXT.md/HANDOFF.md, so before captureStartedAt existed
    // a Reset & Retry re-accepted the previous attempt's capture on the very
    // first Primary idle — the user reviewed a "fresh" brief that was actually
    // the stale one.
    test("after Reset, the previous attempt's capture files are not accepted as a new capture", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await fs.writeFile(path.join(dir, CONTEXT_FILE), validContext, "utf8");
        await fs.writeFile(path.join(dir, HANDOFF_FILE), validHandoff, "utf8");
        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        runner.onAgentIdle(sourceSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "brief-ready");

        // Reset & Retry, then Start again — the old capture is still on disk.
        expect(await runner.resetTask(companionWorkspace.id)).toBe(true);
        expect(companionWorkspace.task.captureStartedAt).toBeUndefined();
        // Guarantee clock separation between the old files' mtime and the new
        // captureStartedAt — the comparison is millisecond-granular.
        await new Promise((r) => setTimeout(r, 20));
        await runner.startTask(companionWorkspace.id);
        expect(companionWorkspace.task.state).toBe("capturing-context");
        expect(companionWorkspace.task.captureStartedAt).toBeTruthy();

        // The Primary goes idle without rewriting anything: the leftover files
        // must be treated as an unfinished capture (nudge), not a finished one.
        const writesBefore = deps.written.length;
        runner.onAgentIdle(sourceSessionId, "test");
        await waitFor(() => companionWorkspace.task.captureNudged === true);
        expect(companionWorkspace.task.state).toBe("capturing-context");
        // Injection writes the text and the Enter keystroke separately.
        const nudge = deps.written
          .slice(writesBefore)
          .map((w: { data: string }) => w.data)
          .join("");
        expect(nudge).toContain("left over from an earlier capture");

        // Once the Primary actually rewrites them, capture completes normally.
        await fs.writeFile(path.join(dir, CONTEXT_FILE), validContext, "utf8");
        await fs.writeFile(path.join(dir, HANDOFF_FILE), validHandoff, "utf8");
        runner.onAgentIdle(sourceSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "brief-ready");
      } finally {
        await cleanup(tmp);
      }
    });

    test("watcher backstop moves capturing-context to brief-ready with no idle hook at all (plan §8.3)", async () => {
      const prevGrace = AgentTaskRunner.WATCH_VERDICT_GRACE_MS;
      AgentTaskRunner.WATCH_VERDICT_GRACE_MS = 50; // short grace for the test
      const { tmp, runner, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        expect(companionWorkspace.task.state).toBe("capturing-context");
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        // Write both files but never fire onAgentIdle — only the fs.watch
        // backstop (not a hook) can rescue this, exactly like the missed
        // idle-hook scenario the existing verdict.json watcher test covers.
        await fs.writeFile(path.join(dir, CONTEXT_FILE), validContext, "utf8");
        await fs.writeFile(path.join(dir, HANDOFF_FILE), validHandoff, "utf8");

        await waitFor(() => companionWorkspace.task.state === "brief-ready", { timeoutMs: 8000 });
      } finally {
        AgentTaskRunner.WATCH_VERDICT_GRACE_MS = prevGrace;
        await cleanup(tmp);
      }
    });
  });

  describe("baseline evaluation", () => {
    const validContext =
      "# Objective\nX\n\n# Confirmed requirements\nX\n\n# Acceptance criteria\nX\n\n# Constraints\nX\n\n# Decisions already made\nX\n\n# Explicit non-goals\nX\n\n# Open questions or ambiguities\nX\n";
    const validHandoff =
      "# Current state\nX\n\n# Work already completed\nX\n\n# Work in progress\nX\n\n# Files and commits touched\nX\n\n# Verification already run\nX\n\n# External or destructive side effects already performed\nX\n\n# Known blockers\nX\n\n# Recommended next step\nX\n";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function reachBriefReady(runner: any, tmp: string, task: any) {
      const dir = taskDir(tmp, task.taskId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, CONTEXT_FILE), validContext, "utf8");
      await fs.writeFile(path.join(dir, HANDOFF_FILE), validHandoff, "utf8");
    }

    test("Start from brief-ready ignores WORK_LOCK/TODO gating and requests round-1 baseline review", async () => {
      const { tmp, deps, runner, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        await reachBriefReady(runner, tmp, companionWorkspace.task);
        companionWorkspace.task.state = "brief-ready";

        const ok = await runner.startTask(companionWorkspace.id);
        expect(ok).toBe(true);
        expect(companionWorkspace.task.currentRound).toBe(1);
        expect(companionWorkspace.task.state).toBe("judge-evaluating");
        expect(companionWorkspace.task.companionPhase).toBe("baseline");

        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        expect(deps.written.some((w: { sessionId: string }) => w.sessionId === judgeSessionId)).toBe(true);
        const promptContent = await readLastPrompt(tmp, companionWorkspace.task.taskId);
        expect(promptContent).toContain("PHASE: baseline");
        expect(promptContent).toContain("ROLE POLICY — REVIEWER");
      } finally {
        await cleanup(tmp);
      }
    });

    // An attached task's in-memory description is always empty, and manual brief
    // edits / appended clarifications only ever land on disk — so a cached copy
    // quoted an EMPTY brief to the evaluator.
    test("the evaluation prompt quotes TASK.md as it is on disk right now, not a cached description", async () => {
      const { tmp, runner, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        await reachBriefReady(runner, tmp, companionWorkspace.task);
        companionWorkspace.task.state = "brief-ready";

        // Stand in for a manual brief edit / an appended user clarification.
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await fs.writeFile(
          path.join(dir, TASK_FILE),
          "# Companion focus\n\nOriginal focus.\n\n## User clarification (2026-01-01T00:00:00.000Z)\n\nAnswers Q-1:\n\nShip the smaller variant.\n",
          "utf8",
        );
        expect(companionWorkspace.task.description).toBe("");

        await runner.startTask(companionWorkspace.id);
        const promptContent = await readLastPrompt(tmp, companionWorkspace.task.taskId);
        expect(promptContent).toContain("Ship the smaller variant.");
        expect(promptContent).toContain("Original focus.");
        expect(promptContent).not.toContain("(empty)");
      } finally {
        await cleanup(tmp);
      }
    });
  });

  describe("companion verdict handling", () => {
    async function startBaseline(overrides: Record<string, unknown> = {}) {
      const setup = await setupAttached(overrides);
      const { tmp, runner, companionWorkspace } = setup;
      const dir = taskDir(tmp, companionWorkspace.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      const ctx =
        "# Objective\nX\n\n# Confirmed requirements\nX\n\n# Acceptance criteria\nX\n\n# Constraints\nX\n\n# Decisions already made\nX\n\n# Explicit non-goals\nX\n\n# Open questions or ambiguities\nX\n";
      const handoff =
        "# Current state\nX\n\n# Work already completed\nX\n\n# Work in progress\nX\n\n# Files and commits touched\nX\n\n# Verification already run\nX\n\n# External or destructive side effects already performed\nX\n\n# Known blockers\nX\n\n# Recommended next step\nX\n";
      await fs.writeFile(path.join(dir, CONTEXT_FILE), ctx, "utf8");
      await fs.writeFile(path.join(dir, HANDOFF_FILE), handoff, "utf8");
      companionWorkspace.task.state = "brief-ready";
      await runner.startTask(companionWorkspace.id);
      return setup;
    }

    // A verdict only counts as the answer to the evaluation in flight if it
    // echoes the evaluationAttempt the runner handed out — phase+round repeat
    // within a round, so that number is the actual identity. Stamped from live
    // task state here; a test that wants a deliberately stale verdict passes
    // its own evaluationAttempt.
    function writeVerdict(dir: string, task: Record<string, unknown>, verdict: Record<string, unknown>) {
      const body =
        "evaluationAttempt" in verdict ? verdict : { ...verdict, evaluationAttempt: task.companionEvaluationAttempt };
      return fs.writeFile(path.join(dir, VERDICT_FILE), JSON.stringify(body), "utf8");
    }

    const baseReviewerVerdict = {
      schemaVersion: 1,
      role: "reviewer",
      phase: "baseline",
      round: 1,
      verificationReview: { recordStatus: "not-required", evidenceReviewed: [], workerActionsRequired: [] },
      roleAnalysis: {
        type: "reviewer",
        requirementAudit: [{ requirement: "R1", status: "verified", evidence: ["file.ts:1"] }],
      },
      advisories: [],
    };

    // A "complete" the runner can actually back: round-review over a
    // VERIFICATION.md the runner itself read as fresh.
    const completeRoundTwoVerdict = {
      ...baseReviewerVerdict,
      phase: "round-review",
      round: 2,
      verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
      verdict: "complete",
      reason: "All good.",
      blockingFindings: [],
      questions: [],
    };

    // Completion floor, runtime half. The schema only constrains what the
    // Companion CLAIMS in verificationReview.recordStatus — at baseline the
    // runner hands it no record at all, so "fresh" there is pure assertion and
    // the task used to complete on it.
    describe("completion floor — claimed evidence is checked against what the runner provided", () => {
      test("a baseline reviewer 'complete' claiming fresh evidence does not complete the task", async () => {
        const { tmp, source, runner, deps, companionWorkspace } = await startBaseline();
        try {
          const dir = taskDir(tmp, companionWorkspace.task.taskId);
          await writeVerdict(dir, companionWorkspace.task, {
            ...baseReviewerVerdict,
            verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
            verdict: "complete",
            reason: "All good.",
            blockingFindings: [],
            questions: [],
          });

          const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
          runner.onAgentIdle(judgeSessionId, "test");
          await waitFor(() => companionWorkspace.task.state === "running");

          expect(companionWorkspace.task.state).not.toBe("completed");
          // Not a review finding: the round is not consumed and WORK_LOCK is
          // back, with a template tagged for the round we stayed in.
          expect(companionWorkspace.task.currentRound).toBe(1);
          await expect(fs.access(path.join(dir, WORK_LOCK_FILE))).resolves.toBeUndefined();
          expect(await fs.readFile(path.join(dir, VERIFICATION_FILE), "utf8")).toContain("Evaluation target: 1");

          const sourceSessionId = `${source.id}:${source.panels[0].id}`;
          const injected = await readInjectedText(deps, sourceSessionId, tmp, companionWorkspace.task.taskId);
          expect(injected).toContain(VERIFICATION_FILE);
          expect(injected).toContain("Evaluation target: 1");
        } finally {
          await cleanup(tmp);
        }
      });

      test("the Primary's record then lets the very same 'complete' through on round-review", async () => {
        const { tmp, runner, companionWorkspace } = await reachRoundReviewWithEvidence();
        try {
          const dir = taskDir(tmp, companionWorkspace.task.taskId);
          expect(companionWorkspace.task.companionEvidence?.status).toBe("fresh");
          await writeVerdict(dir, companionWorkspace.task, completeRoundTwoVerdict);
          runner.onAgentIdle(sessionIdFor(companionWorkspace, "judge"), "test");
          await waitFor(() => companionWorkspace.task.state === "completed");
        } finally {
          await cleanup(tmp);
        }
      });

      test("planner is exempt — it completes over the plan document with no record at all", async () => {
        const { tmp, runner, companionWorkspace } = await startBaseline({ role: "planner" });
        try {
          const dir = taskDir(tmp, companionWorkspace.task.taskId);
          await writeVerdict(dir, companionWorkspace.task, {
            schemaVersion: 1,
            role: "planner",
            phase: "baseline",
            round: 1,
            verdict: "complete",
            reason: "The plan is implementable.",
            verificationReview: { recordStatus: "not-required", evidenceReviewed: [], workerActionsRequired: [] },
            roleAnalysis: {
              type: "planner",
              planDocument: "plan.md",
              problemFrame: "x",
              userBenefitAssessment: "x",
              assumptions: [],
              decisions: [],
              coverageAudit: [{ area: "scope", status: "complete", evidence: "x" }],
              openQuestions: [],
            },
            blockingFindings: [],
            advisories: [],
            questions: [],
          });

          runner.onAgentIdle(sessionIdFor(companionWorkspace, "judge"), "test");
          await waitFor(() => companionWorkspace.task.state === "completed");
        } finally {
          await cleanup(tmp);
        }
      });
    });

    test("complete verdict marks the task completed and never sends a stop signal to Primary", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await reachRoundReviewWithEvidence();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, completeRoundTwoVerdict);

        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "completed");

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        // No Ctrl+C / "task has ended" message ever gets sent to the
        // externally-owned Primary — that would be an unwanted intrusion.
        expect(
          deps.written.some(
            (w: { sessionId: string; data: string }) => w.sessionId === sourceSessionId && w.data === "\x03",
          ),
        ).toBe(false);
      } finally {
        await cleanup(tmp);
      }
    });

    // Judge round-4 finding (item 69): the Dashboard "Send back" control had
    // no attached branch and injected the standard buildUserFeedbackPrompt
    // (Worker/judge vocabulary, no VERIFICATION.md mention) into the
    // externally-owned Primary.
    test("rejectTaskVerdict on a completed attached task sends companion-aware feedback to the Primary", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await reachRoundReviewWithEvidence();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, completeRoundTwoVerdict);

        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "completed");

        const roundBefore = companionWorkspace.task.currentRound;
        const ok = await runner.rejectTaskVerdict(companionWorkspace.id, "The retry logic still isn't idempotent.");
        expect(ok).toBe(true);
        expect(companionWorkspace.task.state).toBe("running");
        expect(companionWorkspace.task.currentRound).toBe(roundBefore + 1);

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        const injected = await readInjectedText(deps, sourceSessionId, tmp, companionWorkspace.task.taskId);
        expect(injected).toContain("The retry logic still isn't idempotent.");
        expect(injected).toContain("Reviewer companion");
        expect(injected).toContain(VERIFICATION_FILE);
        expect(injected).not.toContain("Worker");
      } finally {
        await cleanup(tmp);
      }
    });

    // Send back mutates round bookkeeping (round number, max-round ceiling, a
    // fresh chip, the stored instructions) BEFORE it can know the injection
    // reached the Primary — the prompt quotes "Round N/M". A failed delivery
    // used to restore only `state`, so the round stayed consumed and the retry
    // skipped one.
    test("a failed Send back leaves the verdict exactly as it stood, and the retry consumes only one round", async () => {
      const { tmp, runner, deps, companionWorkspace } = await reachRoundReviewWithEvidence();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, completeRoundTwoVerdict);
        runner.onAgentIdle(sessionIdFor(companionWorkspace, "judge"), "test");
        await waitFor(() => companionWorkspace.task.state === "completed");

        const task = companionWorkspace.task;
        const before = {
          round: task.currentRound,
          maxRounds: task.maxRounds,
          instructions: task.lastJudgeInstructions,
          finishedAt: task.finishedAt,
          feedbackAt: task.companionLastFeedbackAt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          chips: (task.rounds as any[]).length,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          lastChipAction: (task.rounds as any[])[(task.rounds as any[]).length - 1].action,
        };

        deps.writeToSession.mockImplementationOnce(() => {
          throw new Error("PTY is gone");
        });
        expect(await runner.rejectTaskVerdict(companionWorkspace.id, "Retry logic still isn't idempotent.")).toBe(
          false,
        );

        expect(task.state).toBe("completed");
        expect(task.currentRound).toBe(before.round);
        expect(task.maxRounds).toBe(before.maxRounds);
        expect(task.lastJudgeInstructions).toBe(before.instructions);
        expect(task.finishedAt).toBe(before.finishedAt);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((task.rounds as any[]).length).toBe(before.chips);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((task.rounds as any[])[before.chips - 1].action).toBe(before.lastChipAction);
        // The round-2 evidence the completion was signed off against is still
        // there — a send-back that never landed must not blank it with a
        // template for a round the Primary was never asked to work on.
        expect(await fs.readFile(path.join(dir, VERIFICATION_FILE), "utf8")).toContain("npm test");
        expect(task.companionLastFeedbackAt).toBe(before.feedbackAt);

        // Retrying goes through and advances exactly one round.
        expect(await runner.rejectTaskVerdict(companionWorkspace.id, "Retry logic still isn't idempotent.")).toBe(true);
        expect(task.state).toBe("running");
        expect(task.currentRound).toBe(before.round + 1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((task.rounds as any[]).length).toBe(before.chips + 1);
      } finally {
        await cleanup(tmp);
      }
    });

    // Send back re-opens a round exactly like a companion "continue" does, so
    // it owes Primary the same two artifacts — without them the next
    // round-review gates on a record still tagged for the round the user just
    // re-opened, and burns a nudge cycle before any review happens.
    test("Send back on an attached task hands Primary a VERIFICATION.md template for the new round and a fresh freshness baseline", async () => {
      const { tmp, runner, companionWorkspace } = await reachRoundReviewWithEvidence();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, completeRoundTwoVerdict);
        runner.onAgentIdle(sessionIdFor(companionWorkspace, "judge"), "test");
        await waitFor(() => companionWorkspace.task.state === "completed");
        const feedbackBefore = companionWorkspace.task.companionLastFeedbackAt;

        expect(await runner.rejectTaskVerdict(companionWorkspace.id, "Add the missing rollback test.")).toBe(true);
        expect(companionWorkspace.task.currentRound).toBe(3);

        const verification = await fs.readFile(path.join(dir, VERIFICATION_FILE), "utf8");
        expect(verification).toContain("Evaluation target: 3");
        expect(companionWorkspace.task.companionLastFeedbackAt).not.toBe(feedbackBefore);

        // The template itself must not pass as round 3's evidence — asserted on
        // the reader's actual verdict, not on the timestamps it derives it from.
        const templateOnly = await readVerificationRecord(tmp, companionWorkspace.task.taskId, {
          expectedRound: 3,
          sinceIso: companionWorkspace.task.companionLastFeedbackAt,
        });
        expect(templateOnly.status).not.toBe("fresh");

        // What Primary writes over it afterwards does.
        await writePrimaryRecord(
          dir,
          "# Verification\n\nEvaluation target: 3\nRecorded at: now\n\n## Commands\n\n### V-1\nCommand: `npm test`\nResult: PASS\nExit code: 0\n",
        );
        const realRecord = await readVerificationRecord(tmp, companionWorkspace.task.taskId, {
          expectedRound: 3,
          sinceIso: companionWorkspace.task.companionLastFeedbackAt,
        });
        expect(realRecord.status).toBe("fresh");
      } finally {
        await cleanup(tmp);
      }
    });

    // The template overwrites whatever record is on disk, so it has to be there
    // before the Primary can start writing the next one — a template landing
    // behind the prompt would silently erase the record it just asked for.
    test("Send back stages the VERIFICATION.md template BEFORE the prompt reaches the Primary", async () => {
      const { tmp, runner, deps, companionWorkspace } = await reachRoundReviewWithEvidence();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, completeRoundTwoVerdict);
        runner.onAgentIdle(sessionIdFor(companionWorkspace, "judge"), "test");
        await waitFor(() => companionWorkspace.task.state === "completed");

        let verificationAtInjection = "";
        const passthrough = deps.writeToSession.getMockImplementation();
        deps.writeToSession.mockImplementationOnce((sessionId: string, data: string) => {
          verificationAtInjection = readFileSync(path.join(dir, VERIFICATION_FILE), "utf8");
          return passthrough?.(sessionId, data);
        });

        expect(await runner.rejectTaskVerdict(companionWorkspace.id, "Add the missing rollback test.")).toBe(true);
        expect(verificationAtInjection).toContain("Evaluation target: 3");
      } finally {
        await cleanup(tmp);
      }
    });

    // The dialog leaves its "Send back" button live for the whole request, so a
    // double click delivers two calls in the same tick. The reopenable-state
    // check does not serialize them — `state` only flips to "running" after the
    // work-lock recreate awaits — so both used to start a round, both stage a
    // template, and a rollback of one could land on top of the other's
    // successfully delivered send.
    test("two concurrent Send backs open exactly one round and inject the Primary once", async () => {
      const { tmp, runner, deps, companionWorkspace } = await reachRoundReviewWithEvidence();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, completeRoundTwoVerdict);
        runner.onAgentIdle(sessionIdFor(companionWorkspace, "judge"), "test");
        await waitFor(() => companionWorkspace.task.state === "completed");

        const task = companionWorkspace.task;
        const roundBefore = task.currentRound;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chipsBefore = (task.rounds as any[]).length;
        const sourceSessionId = sessionIdFor(companionWorkspace, "worker");
        // One trailing Enter per delivered injection.
        const submits = () =>
          deps.written.filter(
            (w: { sessionId: string; data: string }) => w.sessionId === sourceSessionId && w.data === "\r",
          ).length;
        const submitsBefore = submits();

        const results = await Promise.all([
          runner.rejectTaskVerdict(companionWorkspace.id, "Retry logic still isn't idempotent."),
          runner.rejectTaskVerdict(companionWorkspace.id, "Retry logic still isn't idempotent."),
        ]);

        expect(results.filter(Boolean)).toHaveLength(1);
        expect(task.state).toBe("running");
        expect(task.currentRound).toBe(roundBefore + 1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((task.rounds as any[]).length).toBe(chipsBefore + 1);
        expect(submits() - submitsBefore).toBe(1);
        expect(await fs.readFile(path.join(dir, VERIFICATION_FILE), "utf8")).toContain("Evaluation target: 3");
      } finally {
        await cleanup(tmp);
      }
    });

    test("continue verdict recreates WORK_LOCK, writes a VERIFICATION.md template for the next round, and feeds back into the SAME external session", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await startBaseline();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, {
          ...baseReviewerVerdict,
          verdict: "continue",
          reason: "Missing tests.",
          blockingFindings: [
            {
              id: "REQ-1",
              title: "No tests",
              category: "tests",
              evidence: ["grep found nothing"],
              impact: "risk",
              requiredAction: "add tests",
            },
          ],
          questions: [],
        });

        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "running");

        expect(companionWorkspace.task.currentRound).toBe(2);
        await expect(fs.access(path.join(dir, WORK_LOCK_FILE))).resolves.toBeUndefined();
        const verificationContent = await fs.readFile(path.join(dir, VERIFICATION_FILE), "utf8");
        expect(verificationContent).toContain("Evaluation target: 2");

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        expect(deps.written.some((w: { sessionId: string }) => w.sessionId === sourceSessionId)).toBe(true);
        const promptContent = await readLastPrompt(tmp, companionWorkspace.task.taskId);
        expect(promptContent).toContain("REQUIRED BLOCKING FINDINGS");
        expect(promptContent).toContain("REQ-1");
      } finally {
        await cleanup(tmp);
      }
    });

    // Two idle signals for the same verdict (hook + OSC 133, or hook + the
    // watcher backstop) used to both pass the `state === "judge-evaluating"`
    // check, because the state only changes several awaits into the handler —
    // so the same round got injected into the Primary twice and the round
    // counter jumped by two.
    test("two idle signals over one continue verdict advance exactly one round and inject once", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await startBaseline();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, {
          ...baseReviewerVerdict,
          verdict: "continue",
          reason: "Missing tests.",
          blockingFindings: [
            {
              id: "REQ-1",
              title: "No tests",
              category: "tests",
              evidence: ["grep found nothing"],
              impact: "risk",
              requiredAction: "add tests",
            },
          ],
          questions: [],
        });

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        const primaryPrompts = () =>
          deps.written.filter(
            (w: { sessionId: string; data: string }) => w.sessionId === sourceSessionId && w.data !== "\r",
          ).length;
        const injectedBefore = primaryPrompts();

        const judgeSessionId = sessionIdFor(companionWorkspace, "judge");
        runner.onAgentIdle(judgeSessionId, "test");
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "running");
        // Let a second handler, if one ever started, run to completion.
        await new Promise((r) => setTimeout(r, 50));

        expect(companionWorkspace.task.currentRound).toBe(2);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chips = companionWorkspace.task.rounds as any[];
        expect(chips).toHaveLength(2);
        expect(primaryPrompts() - injectedBefore).toBe(1);
      } finally {
        await cleanup(tmp);
      }
    });

    test("continue verdict never sends /clear to the externally-owned Primary session (plan §8.6)", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await startBaseline();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, {
          ...baseReviewerVerdict,
          verdict: "continue",
          reason: "Missing tests.",
          blockingFindings: [
            {
              id: "REQ-1",
              title: "No tests",
              category: "tests",
              evidence: ["grep found nothing"],
              impact: "risk",
              requiredAction: "add tests",
            },
          ],
          questions: [],
        });

        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "running");

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        expect(
          deps.written.some(
            (w: { sessionId: string; data: string }) => w.sessionId === sourceSessionId && w.data === "/clear",
          ),
        ).toBe(false);
      } finally {
        await cleanup(tmp);
      }
    });

    test("a blocking finding ID seen in 3 rounds is flagged for the Dashboard's 'Pause and review' hint, without the runner changing the verdict (plan §4.15)", async () => {
      const { tmp, runner, companionWorkspace } = await startBaseline();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        const task = companionWorkspace.task;

        // Simulate two already-finished rounds that both saw the same
        // unresolved blocker, then let a real round-3 verdict (same ID) land.
        task.rounds = [
          {
            round: 1,
            startedAt: "",
            checks: [],
            judgeVerdict: "continue",
            judgeReason: "",
            action: "completed",
            companionFindingIds: ["REQ-1"],
          },
          {
            round: 2,
            startedAt: "",
            checks: [],
            judgeVerdict: "continue",
            judgeReason: "",
            action: "completed",
            companionFindingIds: ["REQ-1"],
          },
          { round: 3, startedAt: "", checks: [], judgeVerdict: null, judgeReason: "", action: "running" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any;
        task.currentRound = 3;
        task.companionPhase = "round-review";

        await writeVerdict(dir, companionWorkspace.task, {
          ...baseReviewerVerdict,
          phase: "round-review",
          round: 3,
          verdict: "continue",
          reason: "Still missing tests.",
          blockingFindings: [
            {
              id: "REQ-1",
              title: "No tests",
              category: "tests",
              evidence: ["still nothing"],
              impact: "risk",
              requiredAction: "add tests",
            },
          ],
          questions: [],
        });

        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.currentRound === 4);

        // Advisory hint only — the verdict itself is still "continue" as written.
        expect(companionWorkspace.task.repeatedBlockingFindingIds).toEqual(["REQ-1"]);
      } finally {
        await cleanup(tmp);
      }
    });

    test("needs-input verdict pauses at awaiting-user without consuming a round, and answerCompanionTask resumes the same round", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await startBaseline();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, {
          ...baseReviewerVerdict,
          verdict: "needs-input",
          reason: "Need a product decision.",
          blockingFindings: [],
          questions: [{ id: "Q-1", question: "Which option?", whyNeeded: "Two valid designs." }],
        });

        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "awaiting-user");
        expect(companionWorkspace.task.currentRound).toBe(1);
        expect(companionWorkspace.task.pendingQuestions).toHaveLength(1);

        const ok = await runner.answerCompanionTask(companionWorkspace.id, ["Q-1"], "Go with option B.");
        expect(ok).toBe(true);
        expect(companionWorkspace.task.state).toBe("running");
        expect(companionWorkspace.task.currentRound).toBe(1); // same round, not consumed

        const taskMd = await fs.readFile(path.join(dir, TASK_FILE), "utf8");
        expect(taskMd).toContain("User clarification");
        expect(taskMd).toContain("Go with option B.");

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        expect(deps.written.some((w: { sessionId: string }) => w.sessionId === sourceSessionId)).toBe(true);
        const promptContent = await readLastPrompt(tmp, companionWorkspace.task.taskId);
        expect(promptContent).toContain("Go with option B.");
      } finally {
        await cleanup(tmp);
      }
    });

    test("answering writes a VERIFICATION.md template for the SAME round and marks the round user-answered", async () => {
      const { tmp, runner, companionWorkspace } = await startBaseline();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, {
          ...baseReviewerVerdict,
          verdict: "needs-input",
          reason: "Need a product decision.",
          blockingFindings: [],
          questions: [{ id: "Q-1", question: "Which option?", whyNeeded: "Two valid designs." }],
        });
        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "awaiting-user");

        expect(await runner.answerCompanionTask(companionWorkspace.id, ["Q-1"], "Go with option B.")).toBe(true);

        // The "continue" path hands Primary a template for round+1; the answer
        // path stays in the same round, so its template must say round 1 — or
        // the freshness gate rejects whatever Primary writes.
        const verification = await fs.readFile(path.join(dir, VERIFICATION_FILE), "utf8");
        expect(verification).toContain("Evaluation target: 1");
        const promptContent = await readLastPrompt(tmp, companionWorkspace.task.taskId);
        expect(promptContent).toContain("Evaluation target: 1");

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rounds = companionWorkspace.task.rounds as any[];
        expect(rounds[rounds.length - 1].action).toBe("user-answered");
      } finally {
        await cleanup(tmp);
      }
    });

    // Answering resumes the round, and the Dashboard only renders questions in
    // "awaiting-user" — so a partial answer used to leave Q-2 pending with no
    // surface left to answer it on. It must be refused outright instead.
    test("a partial answer is refused; the round stays awaiting-user with every question intact", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await startBaseline();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, {
          ...baseReviewerVerdict,
          verdict: "needs-input",
          reason: "Two open decisions.",
          blockingFindings: [],
          questions: [
            { id: "Q-1", question: "Which option?", whyNeeded: "Two valid designs." },
            { id: "Q-2", question: "Which default?", whyNeeded: "Affects migration." },
          ],
        });
        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "awaiting-user");
        expect(companionWorkspace.task.pendingQuestions).toHaveLength(2);

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        const writesBefore = deps.written.filter((w: { sessionId: string }) => w.sessionId === sourceSessionId).length;

        expect(await runner.answerCompanionTask(companionWorkspace.id, ["Q-1"], "Go with option B.")).toBe(false);

        expect(companionWorkspace.task.state).toBe("awaiting-user");
        expect(companionWorkspace.task.pendingQuestions).toHaveLength(2);
        // Nothing reached the Primary and TASK.md was not touched.
        expect(deps.written.filter((w: { sessionId: string }) => w.sessionId === sourceSessionId).length).toBe(
          writesBefore,
        );
        const taskMd = await fs.readFile(path.join(dir, TASK_FILE), "utf8");
        expect(taskMd).not.toContain("User clarification");

        // Covering both IDs is accepted and clears the queue.
        expect(
          await runner.answerCompanionTask(companionWorkspace.id, ["Q-1", "Q-2"], "B, and keep the default."),
        ).toBe(true);
        expect(companionWorkspace.task.state).toBe("running");
        expect(companionWorkspace.task.pendingQuestions).toHaveLength(0);
      } finally {
        await cleanup(tmp);
      }
    });

    test("a failed answer injection leaves the question answerable instead of stranding awaiting-user", async () => {
      const { tmp, runner, deps, companionWorkspace } = await startBaseline();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, {
          ...baseReviewerVerdict,
          verdict: "needs-input",
          reason: "Need a product decision.",
          blockingFindings: [],
          questions: [{ id: "Q-1", question: "Which option?", whyNeeded: "Two valid designs." }],
        });
        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "awaiting-user");

        deps.writeToSession.mockImplementationOnce(() => {
          throw new Error("PTY is gone");
        });
        expect(await runner.answerCompanionTask(companionWorkspace.id, ["Q-1"], "Go with option B.")).toBe(false);

        // Still answerable: the question is intact and the state is unchanged.
        expect(companionWorkspace.task.state).toBe("awaiting-user");
        expect(companionWorkspace.task.pendingQuestions).toHaveLength(1);

        // Retrying succeeds and does not duplicate the clarification section.
        expect(await runner.answerCompanionTask(companionWorkspace.id, ["Q-1"], "Go with option B.")).toBe(true);
        expect(companionWorkspace.task.state).toBe("running");
        const taskMd = await fs.readFile(path.join(dir, TASK_FILE), "utf8");
        expect(taskMd.match(/## User clarification/g)).toHaveLength(1);
      } finally {
        await cleanup(tmp);
      }
    });

    test("planner verdict can never be needs-input at the schema level (rejected as invalid, nudged for repair)", async () => {
      const { tmp, runner, companionWorkspace } = await startBaseline({ role: "planner" });
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, {
          schemaVersion: 1,
          role: "planner",
          phase: "baseline",
          round: 1,
          verdict: "needs-input",
          reason: "x",
          verificationReview: { recordStatus: "not-required", evidenceReviewed: [], workerActionsRequired: [] },
          roleAnalysis: {
            type: "planner",
            planDocument: "plan.md",
            problemFrame: "x",
            userBenefitAssessment: "x",
            assumptions: [],
            decisions: [],
            coverageAudit: [{ area: "scope", status: "complete", evidence: "x" }],
            openQuestions: [],
          },
          blockingFindings: [],
          advisories: [],
          questions: [{ id: "Q-1", question: "x", whyNeeded: "x" }],
        });

        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        // Invalid per the cross-field schema (planner + needs-input) -> a
        // repair nudge is sent, the task must NOT silently complete/continue.
        await waitFor(() => companionWorkspace.task.judgeNudged === true);
        expect(companionWorkspace.task.state).toBe("judge-evaluating");
      } finally {
        await cleanup(tmp);
      }
    });

    // role+phase+round do NOT identify an evaluation: a needs-input answer and
    // a withheld completion both re-evaluate the same phase and round. The
    // runner therefore hands out a monotonic evaluationAttempt and requires it
    // back.
    describe("evaluation identity — the same phase+round evaluated twice", () => {
      // needs-input on the baseline, answered, Primary records evidence, and the
      // SECOND evaluation of round 1 is now in flight. The round chip still
      // carries the first evaluation's "needs-input" verdict.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function reachSecondEvaluationOfRoundOne(): Promise<any> {
        const setup = await startBaseline();
        const { tmp, runner, companionWorkspace } = setup;
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await writeVerdict(dir, companionWorkspace.task, {
          ...baseReviewerVerdict,
          verdict: "needs-input",
          reason: "Need a product decision.",
          blockingFindings: [],
          questions: [{ id: "Q-1", question: "Which option?", whyNeeded: "Two valid designs." }],
        });
        runner.onAgentIdle(sessionIdFor(companionWorkspace, "judge"), "test");
        await waitFor(() => companionWorkspace.task.state === "awaiting-user");
        const firstAttempt = companionWorkspace.task.companionEvaluationAttempt as number;
        expect(await runner.answerCompanionTask(companionWorkspace.id, ["Q-1"], "Go with option B.")).toBe(true);

        // Primary answers the question, records round-1 evidence and signals done.
        await writePrimaryRecord(
          dir,
          "# Verification\n\nEvaluation target: 1\nRecorded at: now\n\n## Commands\n\n### V-1\nCommand: `npm test`\nResult: PASS\nExit code: 0\n",
        );
        await fs.rm(path.join(dir, WORK_LOCK_FILE), { force: true });
        runner.onAgentIdle(sessionIdFor(companionWorkspace, "worker"), "test");
        await waitFor(
          () =>
            companionWorkspace.task.state === "judge-evaluating" &&
            companionWorkspace.task.companionPhase === "round-review",
        );
        // Same round, new evaluation — and the chip still says "needs-input".
        expect(companionWorkspace.task.currentRound).toBe(1);
        expect(companionWorkspace.task.companionEvaluationAttempt).toBe(firstAttempt + 1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chips = companionWorkspace.task.rounds as any[];
        expect(chips[chips.length - 1].judgeVerdict).toBe("needs-input");
        return setup;
      }

      // The watcher backstop used to treat the chip's leftover judgeVerdict as
      // "already processed", so a missed idle hook on the second evaluation of a
      // round left the task stuck in judge-evaluating with nothing to rescue it.
      test("the watcher backstop still handles the verdict when the idle hook never arrives", async () => {
        const prevGrace = AgentTaskRunner.WATCH_VERDICT_GRACE_MS;
        AgentTaskRunner.WATCH_VERDICT_GRACE_MS = 50;
        const { tmp, runner, companionWorkspace } = await reachSecondEvaluationOfRoundOne();
        try {
          const dir = taskDir(tmp, companionWorkspace.task.taskId);
          // No onAgentIdle for the Companion at all — only fs.watch can move this.
          await writeVerdict(dir, companionWorkspace.task, {
            ...baseReviewerVerdict,
            phase: "round-review",
            verdict: "continue",
            reason: "Still missing the rollback test.",
            blockingFindings: [
              {
                id: "REQ-2",
                title: "No rollback test",
                category: "tests",
                evidence: ["x"],
                impact: "x",
                requiredAction: "x",
              },
            ],
            questions: [],
          });

          await waitFor(
            () => companionWorkspace.task.state === "running" && companionWorkspace.task.currentRound === 2,
            { timeoutMs: 8000 },
          );
          expect(runner).toBeDefined();
        } finally {
          AgentTaskRunner.WATCH_VERDICT_GRACE_MS = prevGrace;
          await cleanup(tmp);
        }
      });

      // The dangerous half: the previous attempt's turn writes its verdict late,
      // after the runner already cleared the file and asked for a new
      // evaluation. Every other identity field matches, so without the attempt
      // this "complete" was processed as the answer to the new request — signing
      // the task off on a review that never saw the new evidence.
      test("a verdict from the previous attempt is rejected as stale, not processed", async () => {
        const { tmp, runner, deps, companionWorkspace } = await reachSecondEvaluationOfRoundOne();
        try {
          const dir = taskDir(tmp, companionWorkspace.task.taskId);
          const currentAttempt = companionWorkspace.task.companionEvaluationAttempt;
          expect(companionWorkspace.task.companionEvidence?.status).toBe("fresh");
          await writeVerdict(dir, companionWorkspace.task, {
            ...baseReviewerVerdict,
            phase: "round-review",
            evaluationAttempt: currentAttempt - 1,
            verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
            verdict: "complete",
            reason: "All good.",
            blockingFindings: [],
            questions: [],
          });

          runner.onAgentIdle(sessionIdFor(companionWorkspace, "judge"), "test");
          await waitFor(() => companionWorkspace.task.judgeNudged === true);
          await waitForDelivery(deps, sessionIdFor(companionWorkspace, "judge"));
          expect(companionWorkspace.task.state).toBe("judge-evaluating");

          const nudge = await readInjectedText(
            deps,
            sessionIdFor(companionWorkspace, "judge"),
            tmp,
            companionWorkspace.task.taskId,
          );
          expect(nudge).toContain(`evaluationAttempt ${currentAttempt}`);

          // Rewriting it for the evaluation actually in flight is accepted.
          await writeVerdict(dir, companionWorkspace.task, {
            ...baseReviewerVerdict,
            phase: "round-review",
            verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
            verdict: "complete",
            reason: "All good.",
            blockingFindings: [],
            questions: [],
          });
          runner.onAgentIdle(sessionIdFor(companionWorkspace, "judge"), "test");
          await waitFor(() => companionWorkspace.task.state === "completed");
        } finally {
          await cleanup(tmp);
        }
      });

      test("Reset keeps the attempt counter so the previous run's verdict cannot answer the new one", async () => {
        const { tmp, runner, companionWorkspace } = await reachSecondEvaluationOfRoundOne();
        try {
          const attemptBefore = companionWorkspace.task.companionEvaluationAttempt;
          companionWorkspace.task.state = "paused";
          expect(await runner.resetTask(companionWorkspace.id)).toBe(true);
          expect(companionWorkspace.task.companionEvaluationAttempt).toBe(attemptBefore);
          expect(companionWorkspace.task.companionVerdictHandledAttempt).toBeUndefined();
        } finally {
          await cleanup(tmp);
        }
      });
    });

    test("missing verdict nudges once, then pauses without ever synthesizing feedback to Primary", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await startBaseline();
      try {
        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.judgeNudged === true);
        await waitForDelivery(deps, judgeSessionId);
        expect(companionWorkspace.task.state).toBe("judge-evaluating");

        runner.onAgentIdle(judgeSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "paused");

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        expect(deps.written.some((w: { sessionId: string }) => w.sessionId === sourceSessionId)).toBe(false);
      } finally {
        await cleanup(tmp);
      }
    });

    // idle_prompt and notification are not turn boundaries: a pass started by
    // one reads the verdict and returns without nudging when it isn't there.
    // The hook:stop landing behind it — the signal that WOULD act — used to be
    // discarded by the re-entrancy guard, leaving the task in judge-evaluating
    // with no event left to come.
    test("a hook:stop arriving during an idle_prompt pass is replayed, not dropped", async () => {
      const { tmp, runner, deps, companionWorkspace } = await startBaseline();
      try {
        const judgeSessionId = sessionIdFor(companionWorkspace, "judge");
        runner.onAgentIdle(judgeSessionId, "hook:idle_prompt");
        runner.onAgentIdle(judgeSessionId, "hook:stop");

        await waitFor(() => companionWorkspace.task.judgeNudged === true);
        await waitForDelivery(deps, judgeSessionId);
        expect(companionWorkspace.task.state).toBe("judge-evaluating");
      } finally {
        await cleanup(tmp);
      }
    });

    // Coalescing only upgrades — it must not replay a signal of equal
    // authority. A second hook:stop behind the nudge the first one just sent
    // would read as "still nothing after the nudge" and pause the task on its
    // own duplicate.
    test("a duplicate hook:stop during the same pass is still dropped and does not pause the task", async () => {
      const { tmp, runner, deps, companionWorkspace } = await startBaseline();
      try {
        const judgeSessionId = sessionIdFor(companionWorkspace, "judge");
        runner.onAgentIdle(judgeSessionId, "hook:stop");
        runner.onAgentIdle(judgeSessionId, "hook:stop");

        await waitFor(() => companionWorkspace.task.judgeNudged === true);
        await waitForDelivery(deps, judgeSessionId);
        // Long enough for a replay to have read the (still missing) verdict.
        await new Promise((r) => setTimeout(r, 50));
        expect(companionWorkspace.task.state).toBe("judge-evaluating");
      } finally {
        await cleanup(tmp);
      }
    });

    describe("judge permission-prompt -> policy violation", () => {
      test("a permission_prompt notification while the Companion evaluates pauses the task as a policy violation", async () => {
        const { tmp, runner, companionWorkspace } = await startBaseline();
        try {
          const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
          const consumed = runner.onHookEvent({
            sessionId: judgeSessionId,
            hook: "Notification",
            subtype: "permission_prompt",
          });

          expect(consumed).toBe(true);
          expect(companionWorkspace.task.state).toBe("paused");
          expect(companionWorkspace.task.pausedFromState).toBe("judge-evaluating");
          expect(companionWorkspace.task.judgePolicyViolation).toBe(true);
        } finally {
          await cleanup(tmp);
        }
      });

      test("does not read verdict.json or nudge/inject anything — it pauses instead of proceeding", async () => {
        const { tmp, deps, runner, companionWorkspace } = await startBaseline();
        try {
          const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
          const writesBefore = deps.written.length;

          runner.onHookEvent({ sessionId: judgeSessionId, hook: "Notification", subtype: "permission_prompt" });

          expect(companionWorkspace.task.state).toBe("paused");
          expect(deps.written.length).toBe(writesBefore);
          expect(deps.alerts.length).toBeGreaterThan(0);
          expect(deps.alerts[deps.alerts.length - 1].detail).toContain("permission prompt");
        } finally {
          await cleanup(tmp);
        }
      });

      test("resuming clears judgePolicyViolation and goes back to judge-evaluating", async () => {
        const { tmp, runner, companionWorkspace } = await startBaseline();
        try {
          const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
          runner.onHookEvent({ sessionId: judgeSessionId, hook: "Notification", subtype: "permission_prompt" });
          expect(companionWorkspace.task.state).toBe("paused");

          const resumed = runner.resumeTask(companionWorkspace.id);

          expect(resumed).toBe(true);
          expect(companionWorkspace.task.state).toBe("judge-evaluating");
          expect(companionWorkspace.task.judgePolicyViolation).toBe(false);
        } finally {
          await cleanup(tmp);
        }
      });

      test("a permission_prompt on the Primary (worker role) session is not treated as a judge policy violation", async () => {
        const { tmp, source, runner, companionWorkspace } = await startBaseline();
        try {
          const primarySessionId = `${source.id}:${source.panels[0].id}`;
          const consumed = runner.onHookEvent({
            sessionId: primarySessionId,
            hook: "Notification",
            subtype: "permission_prompt",
          });

          // Falls through to the normal idle-hook path instead — the
          // Primary keeps its own permission mode (plan §10); only the
          // inspect-only Judge/Companion is held to the violation contract.
          expect(consumed).toBe(true);
          expect(companionWorkspace.task.judgePolicyViolation).toBeFalsy();
          expect(companionWorkspace.task.state).toBe("judge-evaluating");
        } finally {
          await cleanup(tmp);
        }
      });
    });
  });

  describe("round-review verification gate", () => {
    test("WORK_LOCK still present: stays running, no Companion request", async () => {
      const { tmp, runner, companionWorkspace } = await reachRunningRoundTwo();
      try {
        const sourceSessionId = sessionIdFor(companionWorkspace, "worker");
        runner.onAgentIdle(sourceSessionId, "test");
        // Goes running -> evaluating -> (WORK_LOCK present) -> running; give
        // the async WORK_LOCK check time to settle before asserting.
        await new Promise((r) => setTimeout(r, 100));
        expect(companionWorkspace.task.state).toBe("running");
        expect(companionWorkspace.task.companionPhase).not.toBe("round-review");
      } finally {
        await cleanup(tmp);
      }
    });

    test("WORK_LOCK absent but VERIFICATION.md missing: nudges Primary directly, never spawns the Companion", async () => {
      const { tmp, runner, deps, companionWorkspace } = await reachRunningRoundTwo();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await fs.rm(path.join(dir, WORK_LOCK_FILE), { force: true });
        // A "continue" verdict always leaves a freshly-templated
        // VERIFICATION.md behind for the next round — remove it too so this
        // test actually exercises the "missing" branch of the gate.
        await fs.rm(path.join(dir, VERIFICATION_FILE), { force: true });

        const sourceSessionId = sessionIdFor(companionWorkspace, "worker");
        runner.onAgentIdle(sourceSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "running");

        // WORK_LOCK must have been recreated (protocol issue, not done yet).
        await expect(fs.access(path.join(dir, WORK_LOCK_FILE))).resolves.toBeUndefined();
        const nudgeText = await readInjectedText(deps, sourceSessionId, tmp, companionWorkspace.task.taskId);
        expect(nudgeText).toContain(VERIFICATION_FILE);
        expect(companionWorkspace.task.companionPhase).not.toBe("round-review"); // Companion never requested
      } finally {
        await cleanup(tmp);
      }
    });

    // The template the "continue" path leaves behind satisfies every structural
    // rule the reader checks, so if it also beat the freshness baseline it would
    // sail through as this round's evidence and hand the completion floor an
    // empty record to sign off against.
    test("WORK_LOCK absent with only the runner's own template left behind: nudges Primary, never spawns the Companion", async () => {
      const { tmp, runner, deps, companionWorkspace } = await reachRunningRoundTwo();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        // Untouched — exactly what the "continue" verdict wrote for round 2.
        const template = await fs.readFile(path.join(dir, VERIFICATION_FILE), "utf8");
        expect(template).toContain("Evaluation target: 2");

        const record = await readVerificationRecord(tmp, companionWorkspace.task.taskId, {
          expectedRound: 2,
          sinceIso: companionWorkspace.task.companionLastFeedbackAt,
        });
        expect(record.status).not.toBe("fresh");

        await fs.rm(path.join(dir, WORK_LOCK_FILE), { force: true });
        const sourceSessionId = sessionIdFor(companionWorkspace, "worker");
        runner.onAgentIdle(sourceSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "running");

        await expect(fs.access(path.join(dir, WORK_LOCK_FILE))).resolves.toBeUndefined();
        expect(await readInjectedText(deps, sourceSessionId, tmp, companionWorkspace.task.taskId)).toContain(
          VERIFICATION_FILE,
        );
        expect(companionWorkspace.task.companionPhase).not.toBe("round-review");
      } finally {
        await cleanup(tmp);
      }
    });

    test("WORK_LOCK absent and VERIFICATION.md fresh: requests a round-review Companion evaluation", async () => {
      const { tmp, runner, deps, companionWorkspace } = await reachRunningRoundTwo();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await fs.rm(path.join(dir, WORK_LOCK_FILE), { force: true });
        await writePrimaryRecord(
          dir,
          "# Verification\n\nEvaluation target: 2\nRecorded at: now\n\n## Commands\n\n### V-1\nCommand: `npm test`\nResult: PASS\n",
        );

        const sourceSessionId = sessionIdFor(companionWorkspace, "worker");
        runner.onAgentIdle(sourceSessionId, "test");
        await waitFor(() => companionWorkspace.task.state === "judge-evaluating");
        expect(companionWorkspace.task.companionPhase).toBe("round-review");

        const judgeSessionId = sessionIdFor(companionWorkspace, "judge");
        expect(deps.written.some((w: { sessionId: string }) => w.sessionId === judgeSessionId)).toBe(true);
        const promptContent = await readLastPrompt(tmp, companionWorkspace.task.taskId);
        expect(promptContent).toContain("PHASE: round-review");
      } finally {
        await cleanup(tmp);
      }
    });
  });

  // Judge round 2 findings 64/65: the rate-limit lifecycle paths (judge resume,
  // Primary WORK_LOCK override) were not mode-aware and could drive an attached
  // task through the legacy verdict parser / standard project-check pipeline.
  describe("rate-limit lifecycle paths (attached mode, plan §6/§8.4)", () => {
    async function startBaseline(overrides: Record<string, unknown> = {}) {
      const setup = await setupAttached(overrides);
      const { tmp, runner, companionWorkspace } = setup;
      const dir = taskDir(tmp, companionWorkspace.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      const ctx =
        "# Objective\nX\n\n# Confirmed requirements\nX\n\n# Acceptance criteria\nX\n\n# Constraints\nX\n\n# Decisions already made\nX\n\n# Explicit non-goals\nX\n\n# Open questions or ambiguities\nX\n";
      const handoff =
        "# Current state\nX\n\n# Work already completed\nX\n\n# Work in progress\nX\n\n# Files and commits touched\nX\n\n# Verification already run\nX\n\n# External or destructive side effects already performed\nX\n\n# Known blockers\nX\n\n# Recommended next step\nX\n";
      await fs.writeFile(path.join(dir, CONTEXT_FILE), ctx, "utf8");
      await fs.writeFile(path.join(dir, HANDOFF_FILE), handoff, "utf8");
      companionWorkspace.task.state = "brief-ready";
      await runner.startTask(companionWorkspace.id);
      return setup;
    }

    test("judge rate-limit resume with a valid needs-input verdict on disk goes through the companion handler, not the legacy judge parser", async () => {
      const prevMargin = AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS;
      AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = 30; // fire the scheduled resume fast
      const { tmp, runner, companionWorkspace } = await startBaseline();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        await fs.writeFile(
          path.join(dir, VERDICT_FILE),
          JSON.stringify({
            schemaVersion: 1,
            role: "reviewer",
            phase: "baseline",
            round: 1,
            evaluationAttempt: companionWorkspace.task.companionEvaluationAttempt,
            verdict: "needs-input",
            reason: "Need a product decision.",
            verificationReview: { recordStatus: "not-required", evidenceReviewed: [], workerActionsRequired: [] },
            roleAnalysis: {
              type: "reviewer",
              requirementAudit: [{ requirement: "R1", status: "unclear", evidence: [] }],
            },
            blockingFindings: [],
            advisories: [],
            questions: [{ id: "Q-1", question: "Which option?", whyNeeded: "Two valid designs." }],
          }),
          "utf8",
        );

        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onAgentRateLimited(
          judgeSessionId,
          { resetAt: new Date(Date.now() + 10), needsConfirm: true, providerHint: "claude" },
          "test",
        );

        // The legacy verdictSchema rejects "needs-input" and would synthesize
        // a fake "continue", driving #handleJudgeVerdict's continue branch:
        // recreate WORK_LOCK, bump the round, re-prompt the Primary with
        // buildJudgeFeedbackPrompt. None of that may happen for an attached
        // task — it must reach awaiting-user with the round untouched instead.
        await waitFor(() => companionWorkspace.task.state === "awaiting-user", { timeoutMs: 4000 });
        expect(companionWorkspace.task.currentRound).toBe(1);
        expect(companionWorkspace.task.pendingQuestions).toHaveLength(1);
        await expect(fs.access(path.join(dir, WORK_LOCK_FILE))).rejects.toThrow();
      } finally {
        AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = prevMargin;
        await cleanup(tmp);
      }
    });

    test("Primary rate-limit WORK_LOCK override runs the companion round-review gate, not the standard judge pipeline", async () => {
      const prevProbe = AgentTaskRunner.PERIODIC_WORK_LOCK_PROBE_MS;
      AgentTaskRunner.PERIODIC_WORK_LOCK_PROBE_MS = 30; // fire the periodic probe fast
      const { tmp, runner, deps, companionWorkspace } = await reachRunningRoundTwo();
      try {
        const dir = taskDir(tmp, companionWorkspace.task.taskId);
        // Reset the write log: reaching round 2 already exercised the round-1
        // baseline companion evaluation, which legitimately wrote into the
        // judge session — only writes from this test's rate-limit sequence
        // matter for the assertions below.
        deps.written.length = 0;
        // Primary finished (WORK_LOCK gone) and hasn't recorded VERIFICATION.md
        // yet — but this happens WHILE the Primary is rate-limited, so no
        // onAgentIdle ever fires; only the periodic WORK_LOCK probe can notice.
        await fs.rm(path.join(dir, WORK_LOCK_FILE), { force: true });
        await fs.rm(path.join(dir, VERIFICATION_FILE), { force: true });

        const sourceSessionId = sessionIdFor(companionWorkspace, "worker");
        runner.onWorkerRateLimited(
          sourceSessionId,
          { resetAt: new Date(Date.now() + 10 * 60_000), needsConfirm: true, providerHint: "claude" },
          "test",
        );
        expect(companionWorkspace.task.rateLimitedUntil).toBeTruthy();

        // Standard-path #evaluateWorkerBody would run project checks, clear
        // the companion verdict, /clear the Companion session, and inject the
        // legacy buildJudgePrompt — landing in "judge-evaluating". The
        // attached-safe gate instead nudges the Primary about VERIFICATION.md
        // and stays "running", exactly like the round-review gate tests above.
        await waitFor(() => !companionWorkspace.task.rateLimitedUntil, { timeoutMs: 4000 });
        await waitFor(() => companionWorkspace.task.state === "running", { timeoutMs: 4000 });
        expect(companionWorkspace.task.companionPhase).not.toBe("round-review");

        await expect(fs.access(path.join(dir, WORK_LOCK_FILE))).resolves.toBeUndefined();
        const nudgeText = await readInjectedText(deps, sourceSessionId, tmp, companionWorkspace.task.taskId);
        expect(nudgeText).toContain(VERIFICATION_FILE);

        const judgeSessionId = sessionIdFor(companionWorkspace, "judge");
        expect(deps.written.some((w: { sessionId: string }) => w.sessionId === judgeSessionId)).toBe(false);
      } finally {
        AgentTaskRunner.PERIODIC_WORK_LOCK_PROBE_MS = prevProbe;
        await cleanup(tmp);
      }
    });

    // Judge round 3 finding, item 67 (blocker): #resumeFromRateLimit had no
    // task.mode === "attached" branch, so a CLI-exit rate limit on the
    // Primary (Codex/Gemini/Copilot — needsConfirm:false) would call
    // #restartSession on the externally-owned session once the reset window
    // expired, killing the user's live conversation (plan §8.6).
    test("CLI-exit rate-limit resume on the Primary never restarts the externally-owned session — pauses with an Open Primary alert instead", async () => {
      const prevMargin = AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS;
      AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = 30; // fire the scheduled resume fast
      const { tmp, runner, deps, companionWorkspace } = await reachRunningRoundTwo();
      try {
        const sourceSessionId = sessionIdFor(companionWorkspace, "worker");
        runner.onWorkerRateLimited(
          sourceSessionId,
          { resetAt: new Date(Date.now() + 10), needsConfirm: false, providerHint: "codex" },
          "test",
        );
        expect(companionWorkspace.task.rateLimitedUntil).toBeTruthy();

        await waitFor(() => companionWorkspace.task.state === "paused", { timeoutMs: 4000 });
        expect(companionWorkspace.task.pausedFromState).toBe("running");
        expect(deps.restartSession).not.toHaveBeenCalledWith(sourceSessionId);
        expect(deps.alerts.length).toBeGreaterThan(0);
        expect(deps.alerts[deps.alerts.length - 1].detail).toContain("Open Primary");
      } finally {
        AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = prevMargin;
        await cleanup(tmp);
      }
    });
  });

  describe("reset / resend / pause invariants", () => {
    test("Reset never sends /clear to the externally-owned Primary session", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        companionWorkspace.task.pausedFromState = "capturing-context";
        companionWorkspace.task.state = "paused";

        const ok = await runner.resetTask(companionWorkspace.id);
        expect(ok).toBe(true);
        expect(companionWorkspace.task.needsContextClear).toBeFalsy();

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        expect(
          deps.written.some(
            (w: { sessionId: string; data: string }) => w.sessionId === sourceSessionId && w.data === "/clear",
          ),
        ).toBe(false);
      } finally {
        await cleanup(tmp);
      }
    });

    test("resendLastInstruction('worker') targets the external Primary session, not the Companion panel", async () => {
      const { tmp, source, runner, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        const ok = await runner.resendLastInstruction(companionWorkspace.id, "worker");
        expect(ok).toBe(true);
        // resendLastInstruction resolves via the same #lastInjected map keyed
        // by sessionIdFor — proving it targets the source session id.
        expect(sessionIdFor(companionWorkspace, "worker")).toBe(sourceSessionId);
      } finally {
        await cleanup(tmp);
      }
    });

    test("Pause is accepted while capturing-context", async () => {
      const { tmp, runner, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        expect(companionWorkspace.task.state).toBe("capturing-context");
        const ok = runner.pauseTask(companionWorkspace.id);
        expect(ok).toBe(true);
        expect(companionWorkspace.task.state).toBe("paused");
        expect(companionWorkspace.task.pausedFromState).toBe("capturing-context");
      } finally {
        await cleanup(tmp);
      }
    });
  });

  // Judge round-5 note (§13 backend matrix item 30, not counted as a finding
  // since the behavior is already implemented mode-aware — but flagged as
  // untested): the Primary's PTY exiting mid-loop must pause the task with
  // Primary-specific wording, the same guard standard tasks already have a
  // dedicated onSessionExit test for.
  describe("onSessionExit (attached mode — Primary PTY exit)", () => {
    test("Primary session exit pauses the task with Primary-specific alert text, not the standard Worker wording", async () => {
      const { tmp, source, runner, deps, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        expect(companionWorkspace.task.state).toBe("capturing-context");
        companionWorkspace.task.pausedFromState = "judge-evaluating"; // stale value from before

        const sourceSessionId = `${source.id}:${source.panels[0].id}`;
        runner.onSessionExit(sourceSessionId);

        expect(companionWorkspace.task.state).toBe("paused");
        expect(companionWorkspace.task.pausedFromState).toBe("");
        const alert = deps.alerts[deps.alerts.length - 1];
        expect(alert.detail).toContain("Primary conversation exited");
        expect(alert.detail).not.toContain("Worker session exited");
      } finally {
        await cleanup(tmp);
      }
    });

    test("Companion panel exit never pauses the task", async () => {
      const { tmp, runner, companionWorkspace } = await setupAttached();
      try {
        await runner.startTask(companionWorkspace.id);
        const judgeSessionId = `${companionWorkspace.id}:${companionWorkspace.task.judgePanelId}`;
        runner.onSessionExit(judgeSessionId);
        expect(companionWorkspace.task.state).toBe("capturing-context");
      } finally {
        await cleanup(tmp);
      }
    });
  });

  describe("markAttachedSourceMissing (recovery: dangling Primary source, plan §8.7 step 5)", () => {
    test("flags the task and raises a truthful, visible alert instead of a silent pause", async () => {
      const { tmp, deps, runner, companionWorkspace } = await setupAttached();
      try {
        companionWorkspace.task.pausedFromState = "judge-evaluating";
        companionWorkspace.task.state = "paused";

        runner.markAttachedSourceMissing(companionWorkspace.id);

        expect(companionWorkspace.task.primaryMissing).toBe(true);
        expect(deps.alerts.length).toBeGreaterThan(0);
        expect(deps.alerts[deps.alerts.length - 1].detail).toContain("Primary conversation no longer exists");
      } finally {
        await cleanup(tmp);
      }
    });

    // Continue used to be a blind branch: resumeTask flipped the badge to
    // running/judge-evaluating and the reconcile injected into a session that no
    // longer existed — fire-and-forget, so the failure only showed up in the log.
    test("Continue is refused once the Primary is known to be gone", async () => {
      const { tmp, deps, runner, companionWorkspace } = await setupAttached();
      try {
        companionWorkspace.task.pausedFromState = "judge-evaluating";
        companionWorkspace.task.state = "paused";
        runner.markAttachedSourceMissing(companionWorkspace.id);

        const writesBefore = deps.written.length;
        expect(runner.resumeTask(companionWorkspace.id)).toBe(false);
        // No state change, and nothing injected into the dead session.
        expect(companionWorkspace.task.state).toBe("paused");
        expect(deps.written.length).toBe(writesBefore);
      } finally {
        await cleanup(tmp);
      }
    });

    // Reset used to clear the flag, which only made a dead binding LOOK
    // continuable — nothing in Reset re-attaches a Primary that no longer
    // exists. Recovery is delete-and-recreate (plan §8.7 step 5).
    test("Reset does not clear the flag, and the following Start is still refused", async () => {
      const { tmp, deps, runner, companionWorkspace } = await setupAttached();
      try {
        companionWorkspace.task.state = "paused";
        runner.markAttachedSourceMissing(companionWorkspace.id);
        expect(companionWorkspace.task.primaryMissing).toBe(true);

        expect(await runner.resetTask(companionWorkspace.id)).toBe(true);
        expect(companionWorkspace.task.primaryMissing).toBe(true);
        expect(companionWorkspace.task.state).toBe("idle");

        const writesBefore = deps.written.length;
        expect(await runner.startTask(companionWorkspace.id)).toBe(false);
        expect(companionWorkspace.task.state).toBe("idle");
        expect(deps.written.length).toBe(writesBefore);
      } finally {
        await cleanup(tmp);
      }
    });

    test("the baseline Start from brief-ready is refused too, instead of spawning a Companion for a dead Primary", async () => {
      const { tmp, deps, runner, companionWorkspace } = await setupAttached();
      try {
        companionWorkspace.task.state = "paused";
        runner.markAttachedSourceMissing(companionWorkspace.id);
        companionWorkspace.task.state = "brief-ready";

        const writesBefore = deps.written.length;
        expect(await runner.startTask(companionWorkspace.id)).toBe(false);
        expect(companionWorkspace.task.state).toBe("brief-ready");
        expect(deps.written.length).toBe(writesBefore);
      } finally {
        await cleanup(tmp);
      }
    });

    test("answering a question is refused once the Primary is gone", async () => {
      const { tmp, deps, runner, companionWorkspace } = await setupAttached();
      try {
        companionWorkspace.task.state = "paused";
        runner.markAttachedSourceMissing(companionWorkspace.id);
        companionWorkspace.task.state = "awaiting-user";
        companionWorkspace.task.pendingQuestions = [{ id: "Q-1", question: "Which option?", whyNeeded: "x" }];

        const writesBefore = deps.written.length;
        expect(await runner.answerCompanionTask(companionWorkspace.id, ["Q-1"], "Option B.")).toBe(false);
        expect(companionWorkspace.task.state).toBe("awaiting-user");
        expect(companionWorkspace.task.pendingQuestions).toHaveLength(1);
        expect(deps.written.length).toBe(writesBefore);
      } finally {
        await cleanup(tmp);
      }
    });

    test("is a no-op for a standard (non-attached) task workspace", async () => {
      const runner = new AgentTaskRunner();
      const deps = createMockDeps([]);
      runner.init(deps);
      const workspace = {
        id: "task-standard",
        kind: "task",
        cwd: "/tmp/standard",
        task: { taskId: "t1", mode: "standard", workerPanelId: "worker", judgePanelId: "judge", state: "paused" },
        panels: [],
      };
      deps.getState = () => ({ workspaces: [workspace], activeProfileId: "default" });

      runner.markAttachedSourceMissing("task-standard");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((workspace.task as any).primaryMissing).toBeUndefined();
      expect(deps.alerts.length).toBe(0);
    });
  });

  describe("standard task regression", () => {
    test("a standard (non-attached) task workspace is completely unaffected by attached-mode wiring", () => {
      const runner = new AgentTaskRunner();
      const ws = runner.createTaskWorkspace({ state: {}, description: "x", cwd: "/tmp/p", parentWorkspaceId: "" });
      expect(ws.panels).toHaveLength(3);
      expect(ws.task.mode).toBe(undefined);
      const deps = createMockDeps([ws]);
      runner.init(deps);
      // onAgentIdle for the standard worker panel must still take the
      // ORIGINAL (non-attached) branch — verified by the full pre-existing
      // agent-task-runner.test.ts suite; this is a smoke check that the new
      // resolveTaskBinding fast path still identifies it correctly.
      const handled = runner.onAgentIdle(`${ws.id}:${ws.task.workerPanelId}`, "test");
      expect(handled).toBe(true);
    });
  });
});
