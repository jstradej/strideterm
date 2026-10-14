/**
 * Typing into a task panel must never pause or stall the task.
 *
 * The runner used to pause a task when the user typed into the panel it was
 * driving, and (since 3.0.6) to cross the session's incarnation on every
 * keystroke — which silently killed the step in flight and could leave a task
 * in `evaluating` for good. Now a keystroke only makes the runner's next write
 * into that session polite: it waits for 10 s of quiet, submits text the user
 * left behind once the agent's turn is over (never into a dialog), waits for
 * the agent's answer, writes, and starts over if the user types mid-write.
 *
 * Driven end to end: the REAL runner and the REAL store, the task started with
 * startTask and advanced by its own hooks. Each PTY is a scripted agent that
 * receives the bytes the way a PTY does — runner writes and user keystrokes
 * alike — and answers with the signals the runtime forwards: UserPromptSubmit
 * and Stop hooks for hook-capable providers, the silence-detected idle for the
 * others. Keystrokes go through `hasMeaningfulUserInput` → `onUserInput(id,
 * data)` exactly as runtime's prepareTerminalInput sends them.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentTaskRunner, foldTerminalInput, sessionIdFor } from "./agent-task-runner.js";
import { createStore } from "./store.js";
import { CONTEXT_FILE, HANDOFF_FILE, TODO_FILE, VERDICT_FILE, WORK_LOCK_FILE, taskDir } from "./agent-task-utils.js";
import { hasMeaningfulUserInput } from "../shared/terminal-input.js";
import type { Logger } from "./logger.js";
import type { WorkspaceState } from "../shared/types/state.js";

type LogCall = { level: string; label: string; message: string; meta?: Record<string, unknown> };
const logCalls = vi.hoisted(() => [] as LogCall[]);
// Records every call and still forwards it to the real logger.
vi.mock("./logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./logger.js")>();
  return {
    ...actual,
    getLogger: (label: string): Logger => {
      const real = actual.getLogger(label);
      const capture =
        (level: string, forward: Logger["info"]): Logger["info"] =>
        (message, meta) => {
          logCalls.push({ level, label, message, meta });
          forward(message, meta);
        };
      return {
        error: capture("error", real.error),
        warn: capture("warn", real.warn),
        info: capture("info", real.info),
        debug: capture("debug", real.debug),
        trace: capture("trace", real.trace),
      };
    },
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */

const QUIET_MS = AgentTaskRunner.USER_QUIET_MS;

type Entry = { at: number; agent: string; from: "runner" | "user" | "agent"; data: string };
type TurnHandler = (_text: string) => Promise<"dialog" | void> | "dialog" | void;

/**
 * A scripted agent CLI behind one PTY. It keeps a composer, submits on Enter,
 * treats a leading "/" as the CLI's own command (no turn), queues a message
 * submitted while it is busy, and ends each turn with the idle signal the
 * runtime would forward.
 */
class AgentSim {
  composer = "";
  busy = false;
  dialogOpen = false;
  stopped = false;
  /** Called when a turn starts with its text; may write files. "dialog" opens a permission dialog first. */
  onTurn: TurnHandler = () => {};
  readonly sessionId: string;
  readonly name: string;
  readonly answerMs: number;
  private queue: string[] = [];
  private readonly runner: AgentTaskRunner;
  private readonly timeline: Entry[];
  private readonly hooks: boolean;

  constructor(
    runner: AgentTaskRunner,
    sessionId: string,
    name: string,
    timeline: Entry[],
    hooks: boolean,
    answerMs = 3_000,
  ) {
    this.runner = runner;
    this.sessionId = sessionId;
    this.name = name;
    this.timeline = timeline;
    this.hooks = hooks;
    this.answerMs = answerMs;
  }

  receive(data: string, from: "runner" | "user"): void {
    if (this.stopped) return;
    this.timeline.push({ at: Date.now(), agent: this.name, from, data });
    if (data === "\x03") {
      this.composer = "";
      return;
    }
    if (data === "\r") {
      if (this.dialogOpen) {
        this.dialogOpen = false;
        this.note("dialog-answered");
        this.endTurnLater();
        return;
      }
      const text = this.composer;
      this.composer = "";
      if (text.trim()) this.submit(text);
      return;
    }
    // While a dialog is up, keys move its selection; the composer is untouched.
    if (this.dialogOpen) return;
    this.composer += data.replace(/\x1b\[20[01]~/g, "");
  }

  /** A fresh process after a restart: nothing typed, nothing running. */
  reset(): void {
    this.composer = "";
    this.busy = false;
    this.dialogOpen = false;
    this.queue = [];
    this.note("restarted");
  }

  private note(data: string): void {
    this.timeline.push({ at: Date.now(), agent: this.name, from: "agent", data });
  }

  private submit(text: string): void {
    if (text.trim().startsWith("/")) {
      this.note(`command ${text.trim()}`);
      return;
    }
    if (this.busy) {
      this.queue.push(text);
      return;
    }
    this.startTurn(text);
  }

  private startTurn(text: string): void {
    this.busy = true;
    this.note("turn");
    if (this.hooks) setTimeout(() => this.hook("UserPromptSubmit"), 10);
    void Promise.resolve(this.onTurn(text)).then((reaction) => {
      if (reaction === "dialog") {
        setTimeout(() => {
          this.dialogOpen = true;
          this.note("dialog");
          if (this.hooks) this.hook("Notification", "permission_prompt");
        }, 100);
        return;
      }
      this.endTurnLater();
    });
  }

  private endTurnLater(): void {
    setTimeout(() => this.endTurn(), this.answerMs);
  }

  private endTurn(): void {
    if (this.stopped) return;
    this.busy = false;
    this.note("idle");
    if (this.hooks) this.hook("Stop");
    else this.runner.onAgentIdle(this.sessionId, "silence");
    const next = this.queue.shift();
    if (next !== undefined) this.startTurn(next);
  }

  private hook(hook: string, subtype?: string): void {
    if (!this.stopped) this.runner.onHookEvent({ sessionId: this.sessionId, hook, subtype });
  }
}

/** What runtime's prepareTerminalInput does with a keystroke, then the PTY write. */
function userTypes(runner: AgentTaskRunner, sim: AgentSim, keys: string[]): number {
  for (const data of keys) {
    if (hasMeaningfulUserInput(data)) runner.onUserInput(sim.sessionId, data);
    sim.receive(data, "user");
  }
  return Date.now();
}

/** One chunk per key, as xterm sends typed text. */
const keystrokes = (text: string): string[] => [...text];

const FS_REQUESTS = new Set(["FSReqPromise", "FSReqCallback", "CloseReq"]);

/** Let in-flight file I/O finish before fake time moves on — otherwise the
 * runner's own disk reads would make "10 s of quiet" pass behind its back. */
async function letIoFinish(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!process.getActiveResourcesInfo().some((resource) => FS_REQUESTS.has(resource))) return;
  }
}

/** Advance fake time in small steps, letting real file I/O land in between. */
async function drive(predicate: () => boolean, { maxFakeMs = 180_000, stepMs = 20 } = {}): Promise<void> {
  let advanced = 0;
  await letIoFinish();
  while (!predicate()) {
    if (advanced > maxFakeMs) throw new Error(`condition not reached within ${maxFakeMs} ms of task time`);
    await vi.advanceTimersByTimeAsync(stepMs);
    advanced += stepMs;
    await letIoFinish();
  }
}

/** Advance a fixed amount of fake time, letting real I/O land in between. */
async function elapse(ms: number): Promise<void> {
  const until = Date.now() + ms;
  await drive(() => Date.now() >= until, { maxFakeMs: ms + 1_000 });
}

function holdRead(filePath: string) {
  let entered = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const originalReadFile = fs.readFile.bind(fs);
  const spy = vi.spyOn(fs, "readFile").mockImplementation((async (
    ...[file, options]: Parameters<typeof fs.readFile>
  ) => {
    if (String(file) === filePath && !entered) {
      entered = true;
      await released;
    }
    return originalReadFile(file, options);
  }) as typeof fs.readFile);
  syncBuiltinESMExports();
  cleanups.push(async () => {
    release();
    spy.mockRestore();
    syncBuiltinESMExports();
  });
  return { isHeld: () => entered, release: () => release() };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()!();
  logCalls.length = 0;
});

const VALID_CONTEXT =
  "# Objective\nX\n\n# Confirmed requirements\nX\n\n# Acceptance criteria\nX\n\n# Constraints\nX\n\n# Decisions already made\nX\n\n# Explicit non-goals\nX\n\n# Open questions or ambiguities\nX\n";
const VALID_HANDOFF =
  "# Current state\nX\n\n# Work already completed\nX\n\n# Work in progress\nX\n\n# Files and commits touched\nX\n\n# Verification already run\nX\n\n# External or destructive side effects already performed\nX\n\n# Known blockers\nX\n\n# Recommended next step\nX\n";

async function harness(workspaces: WorkspaceState[], cwd: string, hooks: boolean) {
  const store = await createStore(path.join(cwd, `.state-${randomUUID()}.json`));
  await store.mutate((draft) => {
    draft.workspaces.push(...workspaces);
  });
  const timeline: Entry[] = [];
  const sims = new Map<string, AgentSim>();
  const runner = new AgentTaskRunner();
  const restartSession = vi.fn(async (sessionId: string) => {
    // runtime.restartSession: cancel pending input, then a new process.
    runner.cancelPendingInput(sessionId);
    sims.get(sessionId)?.reset();
  });
  const raiseAlert = vi.fn();
  runner.init({
    writeToSession: (sessionId: string, data: string) => sims.get(sessionId)?.receive(data, "runner"),
    getState: () => store.getState(),
    broadcastState: () => {},
    raiseAlert,
    restartSession,
    isSessionBusy: (sessionId: string) => sims.get(sessionId)?.busy ?? false,
    isSessionHookCapable: () => hooks,
    isAgentDroppedToShell: () => false,
  });
  const addSim = (sessionId: string, name: string, answerMs?: number) => {
    const sim = new AgentSim(runner, sessionId, name, timeline, hooks, answerMs);
    sims.set(sessionId, sim);
    return sim;
  };
  cleanups.push(async () => {
    for (const sim of sims.values()) sim.stopped = true;
    runner.dispose();
    await store.flush();
  });
  return { store, runner, timeline, addSim, restartSession, raiseAlert };
}

/** A standard task started the way the UI starts one; the Worker got its prompt. */
async function standardTask({ hooks, showerInterval }: { hooks: boolean; showerInterval?: number }) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-polite-"));
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
  const builder = new AgentTaskRunner();
  const created = builder.createTaskWorkspace({
    state: {},
    description: "Implement the parser.",
    cwd,
    parentWorkspaceId: "",
    maxRounds: 3,
  });
  // The task's own setting (Settings → shower interval), not a runner state.
  if (showerInterval !== undefined) created.task.showerInterval = showerInterval;
  await builder.writeInitialFiles(cwd, created.task);
  const h = await harness([created as unknown as WorkspaceState], cwd, hooks);
  const workspaceId = created.id;
  const live = () => h.store.getState().workspaces.find((ws) => ws.id === workspaceId) as unknown as typeof created;
  const worker = h.addSim(sessionIdFor(live(), "worker"), "worker");
  const judge = h.addSim(sessionIdFor(live(), "judge"), "judge");
  // The Worker keeps working until the test says it is done.
  worker.onTurn = () => new Promise<void>(() => {});

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  let started: boolean | undefined;
  void h.runner.startTask(workspaceId).then((result) => (started = result));
  await drive(() => started !== undefined);
  expect(started).toBe(true);
  expect(live().task.state).toBe("running");
  // The placeholder repo only spared startTask a real `git init`. Without it the
  // evaluation's git context is one fs check instead of child processes, which
  // would let fake time run ahead of the runner while they finish.
  await fs.rm(path.join(cwd, ".git"), { recursive: true, force: true });
  const dir = taskDir(cwd, created.task.taskId);
  return { ...h, cwd, dir, workspaceId, live, worker, judge };
}

/** The Worker's turn ends — the hook / silence signal that starts the evaluation. */
function workerFinishes(t: { runner: AgentTaskRunner; worker: AgentSim }, hooks: boolean): void {
  t.worker.busy = false;
  if (hooks) t.runner.onHookEvent({ sessionId: t.worker.sessionId, hook: "Stop" });
  else t.runner.onAgentIdle(t.worker.sessionId, "silence");
}

const runnerWrites = (timeline: Entry[], agent: string) =>
  timeline.filter((entry) => entry.agent === agent && entry.from === "runner");
const isJudgePrompt = (entry: Entry) =>
  entry.from === "runner" && /JUDGE|judge/.test(entry.data) && entry.data.length > 20;
const paused = (logs: LogCall[]) => logs.filter((call) => /paused/.test(call.message) && call.level !== "trace");
const warnRefusals = () =>
  logCalls.filter((call) => call.level === "warn" && call.message.startsWith("task operation rejected as stale"));

describe("terminal input fold", () => {
  const fold = (data: string, pending = false, lastChar = "") => foldTerminalInput({ pending, lastChar }, data);

  test("typed text and paste are pending; a bare Enter submits them", () => {
    expect(fold("h")).toMatchObject({ pending: true, submitted: false });
    expect(fold("\x1b[200~line one\rline two\x1b[201~")).toMatchObject({ pending: true, entered: false });
    expect(fold("\r", true)).toMatchObject({ pending: false, entered: true, submitted: true });
    expect(fold("fix it\r")).toMatchObject({ pending: false, submitted: true });
    expect(fold("fix it\ragain")).toMatchObject({ pending: true, submitted: true });
  });

  test("Enter on an empty composer submits nothing; Ctrl+C clears", () => {
    expect(fold("\r")).toMatchObject({ pending: false, entered: true, submitted: false });
    expect(fold("\x03", true)).toMatchObject({ pending: false, submitted: false });
    expect(fold("abc\x03")).toMatchObject({ pending: false });
  });

  test("newline forms are not a submit; unknown keys count as pending", () => {
    expect(fold("\x1b\r", true)).toMatchObject({ pending: true, submitted: false }); // Alt/Option+Enter
    expect(fold("\r", true, "\\")).toMatchObject({ pending: true, submitted: false }); // backslash+Enter
    expect(fold("\n", true)).toMatchObject({ pending: true, submitted: false }); // Ctrl+J
    expect(fold("\x1b[13;2u")).toMatchObject({ pending: true, submitted: false }); // CSI-u Shift+Enter
    expect(fold("\x1b[A")).toMatchObject({ pending: true }); // history recall
    expect(fold("\x7f")).toMatchObject({ pending: true }); // backspace: maybe text is left
    expect(fold("\x1b[A\r", false)).toMatchObject({ submitted: true }); // a recalled entry, sent
  });
});

describe.each([
  ["hook-capable provider", true],
  ["provider without hooks", false],
])("polite injection into the Judge (%s)", (_label, hooks) => {
  test("typing into the Judge while the checks run: the evaluation carries on; /clear + prompt follow 10 s of quiet", async () => {
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true }); // the Worker's "done"
    const checks = holdRead(path.join(t.dir, TODO_FILE));
    workerFinishes(t, hooks);
    await drive(() => checks.isHeld());
    expect(t.live().task.state).toBe("evaluating");

    const typedAt = userTypes(t.runner, t.judge, [...keystrokes("how is it going?"), "\r"]);
    expect(t.live().task.state).toBe("evaluating");
    checks.release();
    await drive(() => t.live().task.state === "judge-evaluating");

    const writes = runnerWrites(t.timeline, "judge");
    expect(writes.map((entry) => entry.data).slice(0, 2)).toEqual(["/clear", "\r"]);
    expect(writes[0].at).toBeGreaterThanOrEqual(typedAt + QUIET_MS);
    // The user's question was answered before the runner touched the Judge.
    const answered = t.timeline.findIndex((entry) => entry.agent === "judge" && entry.data === "idle");
    expect(answered).toBeGreaterThanOrEqual(0);
    expect(answered).toBeLessThan(t.timeline.indexOf(writes[0]));
    expect(writes.some(isJudgePrompt)).toBe(true);
    expect(paused(logCalls)).toEqual([]);
    expect(warnRefusals()).toEqual([]);
    expect(logCalls.some((call) => call.message === "task injection deferred: the user is active in the session")).toBe(
      true,
    );
  });

  test("text left unsubmitted in the Judge is sent for the user, answered, and only then /clear + prompt", async () => {
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    const checks = holdRead(path.join(t.dir, TODO_FILE));
    workerFinishes(t, hooks);
    await drive(() => checks.isHeld());

    const typedAt = userTypes(t.runner, t.judge, keystrokes("is the parser done?"));
    checks.release();
    await drive(() => t.live().task.state === "judge-evaluating");

    const judgeEvents = t.timeline.filter((entry) => entry.agent === "judge" && entry.from !== "user");
    const order = judgeEvents.map((entry) =>
      entry.from === "agent" ? `agent:${entry.data}` : isJudgePrompt(entry) ? "runner:prompt" : `runner:${entry.data}`,
    );
    // Enter for the user → their turn → answered → /clear → prompt, exactly.
    expect(order.slice(0, 7)).toEqual([
      "runner:\r",
      "agent:turn",
      "agent:idle",
      "runner:/clear",
      "runner:\r",
      "agent:command /clear",
      "runner:prompt",
    ]);
    expect(order[7]).toBe("runner:\r");
    expect(judgeEvents[0].at).toBeGreaterThanOrEqual(typedAt + QUIET_MS);
    expect(
      logCalls.some((call) => call.message === "task injection: submitted the user's pending input for them"),
    ).toBe(true);
    // Diagnostics carry ids and states, never what the user typed.
    for (const call of logCalls.filter((c) => c.message.startsWith("task injection"))) {
      expect(JSON.stringify(call.meta)).not.toContain("parser done");
    }
  });
});

describe("polite injection: interruptions, dialogs and lifecycle", () => {
  test("the user typing during the runner's own write: Enter withheld, write restarted, eventually delivered", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    workerFinishes(t, hooks);
    // The prompt text is in, its Enter is 200 ms away — the user types now.
    await drive(() => runnerWrites(t.timeline, "judge").some(isJudgePrompt));
    const promptEntry = runnerWrites(t.timeline, "judge").find(isJudgePrompt)!;
    const typedAt = userTypes(t.runner, t.judge, ["x"]);
    await elapse(1_000);
    const afterPrompt = runnerWrites(t.timeline, "judge").filter((entry) => entry.at > promptEntry.at);
    expect(afterPrompt).toEqual([]); // no Enter glued to the user's key

    await drive(() => t.live().task.state === "judge-evaluating");
    const later = runnerWrites(t.timeline, "judge").filter((entry) => entry.at > promptEntry.at);
    expect(later[0].at).toBeGreaterThanOrEqual(typedAt + QUIET_MS);
    // The composer (our text + their key) is sent for them, answered, then the
    // Judge is cleared again and gets the prompt with its Enter.
    expect(later.map((entry) => (isJudgePrompt(entry) ? "prompt" : entry.data))).toEqual([
      "\r",
      "/clear",
      "\r",
      "prompt",
      "\r",
    ]);
    expect(
      logCalls.some((call) => call.message === "task injection restarted: the user typed during the runner's write"),
    ).toBe(true);
    expect(paused(logCalls)).toEqual([]);
  });

  test("an open dialog: no Enter is pressed for the user until they answer it", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    const checks = holdRead(path.join(t.dir, TODO_FILE));
    workerFinishes(t, hooks);
    await drive(() => checks.isHeld());

    // The user asks the Judge something; its turn stops on a permission dialog,
    // and the user moves the dialog's selection without confirming.
    t.judge.onTurn = () => {
      t.judge.onTurn = () => {};
      return "dialog";
    };
    userTypes(t.runner, t.judge, [...keystrokes("run the tests"), "\r"]);
    await drive(() => t.judge.dialogOpen);
    userTypes(t.runner, t.judge, ["\x1b[B"]);
    checks.release();
    await elapse(QUIET_MS + AgentTaskRunner.TURN_QUIET_FALLBACK_MS + 30_000);

    expect(runnerWrites(t.timeline, "judge")).toEqual([]);
    expect(t.live().task.state).toBe("evaluating");
    expect(
      logCalls.some(
        (call) =>
          call.message === "task injection deferred: the user is active in the session" &&
          call.meta?.waitingFor === "dialog-open",
      ),
    ).toBe(true);

    // They confirm; the turn finishes; the runner goes on.
    const answeredAt = userTypes(t.runner, t.judge, ["\r"]);
    await drive(() => t.live().task.state === "judge-evaluating");
    const writes = runnerWrites(t.timeline, "judge");
    expect(writes[0]).toMatchObject({ data: "/clear" });
    expect(writes[0].at).toBeGreaterThanOrEqual(answeredAt + QUIET_MS);
  });

  test.each(["pause", "stop"] as const)("%s during a polite wait ends it at once", async (action) => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    const checks = holdRead(path.join(t.dir, TODO_FILE));
    workerFinishes(t, hooks);
    await drive(() => checks.isHeld());
    userTypes(t.runner, t.judge, keystrokes("hold on"));
    checks.release();
    await drive(() =>
      logCalls.some((call) => call.message === "task injection deferred: the user is active in the session"),
    );

    expect(action === "pause" ? t.runner.pauseTask(t.workspaceId) : t.runner.stopTask(t.workspaceId)).toBe(true);
    // No time passes: the wait must notice through its cancel, not on a later tick.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(
      logCalls.some(
        (call) =>
          call.message === "task operation rejected as stale" &&
          call.meta?.operation === `session-injection:${t.judge.sessionId}` &&
          (call.meta?.failedChecks as any[]).some((check) => check.check === "injection"),
      ),
    ).toBe(true);
    await elapse(QUIET_MS * 3);
    expect(runnerWrites(t.timeline, "judge")).toEqual([]);
    expect(t.live().task.state).toBe("paused");
  });

  test("Reset ends the polite wait of the task-ended notice at once", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    t.judge.onTurn = () =>
      fs.writeFile(path.join(t.dir, VERDICT_FILE), JSON.stringify({ verdict: "complete", reason: "All done." }));
    workerFinishes(t, hooks);
    await drive(() => t.live().task.state === "judge-evaluating");
    // The user is chatting with the Worker when the Judge approves.
    userTypes(t.runner, t.worker, keystrokes("one more thing"));
    await drive(() => t.live().task.state === "completed");
    const workerWritesAtCompletion = runnerWrites(t.timeline, "worker").length;
    expect(
      logCalls.some(
        (call) =>
          call.message === "task injection deferred: the user is active in the session" && call.meta?.role === "worker",
      ),
    ).toBe(true);

    expect(await t.runner.resetTask(t.workspaceId)).toBe(true);
    await elapse(QUIET_MS * 3);
    // No Ctrl+C under the user's hands, no notice after the reset.
    expect(runnerWrites(t.timeline, "worker")).toHaveLength(workerWritesAtCompletion);
    expect(runnerWrites(t.timeline, "worker").some((entry) => entry.data === "\x03")).toBe(false);
  });
});

describe("former pause-on-input cases: the task carries on", () => {
  test("Worker input during evaluating: no pause; the Worker is re-prompted after the user's own turn", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    const checks = holdRead(path.join(t.dir, TODO_FILE)); // WORK_LOCK stays: checks fail
    workerFinishes(t, hooks);
    await drive(() => checks.isHeld());
    t.worker.onTurn = () => {}; // it answers the user normally
    const typedAt = userTypes(t.runner, t.worker, [...keystrokes("also add tests"), "\r"]);
    expect(t.live().task.state).toBe("evaluating");
    checks.release();
    await drive(() => t.live().task.state === "running" && runnerWrites(t.timeline, "worker").length > 2);

    const reprompt = runnerWrites(t.timeline, "worker").at(-2)!;
    expect(reprompt.at).toBeGreaterThanOrEqual(typedAt + QUIET_MS);
    expect(paused(logCalls)).toEqual([]);
  });

  test("Worker input during refreshing: no pause; the shower restarts the Worker after the user's turn", async () => {
    const hooks = true;
    const t = await standardTask({ hooks, showerInterval: 1 });
    await fs.writeFile(path.join(t.dir, HANDOFF_FILE), "", "utf8");
    // The Worker answers the handoff directive by writing HANDOFF.md.
    t.worker.onTurn = async (text) => {
      if (text.includes("SHOWER_REQUEST")) await fs.writeFile(path.join(t.dir, HANDOFF_FILE), "Parser half done.");
    };
    workerFinishes(t, hooks);
    await drive(() => t.live().task.state === "refreshing");
    userTypes(t.runner, t.worker, [...keystrokes("write the handoff carefully"), "\r"]);
    await drive(() => t.restartSession.mock.calls.length > 0 && t.live().task.state === "running", {
      maxFakeMs: 300_000,
    });

    expect(t.live().task.showerResumePrompt).toContain("Parser half done.");
    expect(paused(logCalls)).toEqual([]);
    expect(warnRefusals()).toEqual([]);
  });

  test("Judge input during judge-evaluating: no pause, and an idle answering the user does not spend the verdict nudge", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    let judgeTurns = 0;
    t.judge.onTurn = async (text) => {
      judgeTurns += 1;
      // Evaluation and the first reminder: no verdict. The user's own message
      // arrives while the reminder is answered. Only the second reminder works.
      if (judgeTurns === 2) {
        setTimeout(() => userTypes(t.runner, t.judge, [...keystrokes("why so slow?"), "\r"]), 500);
      }
      if (text.includes("You MUST write your verdict") && judgeTurns >= 4) {
        await fs.writeFile(path.join(t.dir, VERDICT_FILE), JSON.stringify({ verdict: "complete", reason: "Done." }));
      }
    };
    workerFinishes(t, hooks);
    await drive(() => ["completed", "paused"].includes(t.live().task.state), { maxFakeMs: 300_000 });

    expect(t.live().task.state).toBe("completed");
    expect(
      logCalls.some(
        (call) => call.message === "judge verdict missing after the user's own turn — reminding the Judge again",
      ),
    ).toBe(true);
    expect(t.raiseAlert.mock.calls.some(([alert]) => /did not produce a verdict/.test(alert.detail ?? ""))).toBe(false);
  });

  test("Primary input during capturing-context (attached): no pause; the capture completes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-polite-attached-"));
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const source = {
      id: "source",
      name: "Source",
      icon: "",
      color: "#123456",
      kind: "manual",
      source: "manual",
      pluginId: "",
      cwd,
      gitRoots: [],
      activeRootPath: "",
      notes: "",
      profileId: "default",
      connectionId: "",
      activePanelId: "primary",
      activeViewId: null,
      splitLayout: null,
      splitViewIds: [],
      starred: false,
      review: null,
      quickfix: null,
      panels: [{ id: "primary", title: "Primary", command: "claude", shell: "true", cwd }],
      task: null,
    } as unknown as WorkspaceState;
    const builder = new AgentTaskRunner();
    const companion = builder.createCompanionTaskWorkspace({
      state: { workspaces: [source] },
      workerWorkspaceId: source.id,
      workerPanelId: "primary",
      companionRole: "reviewer",
      companionProvider: { providerId: "codex", model: "gpt-5.5" },
      maxRounds: 3,
    });
    await builder.writeCompanionFiles(cwd, companion.task);
    const h = await harness([source, companion as unknown as WorkspaceState], cwd, true);
    const live = () =>
      h.store.getState().workspaces.find((ws) => ws.id === companion.id) as unknown as typeof companion;
    const primary = h.addSim("source:primary", "primary");
    const dir = taskDir(cwd, companion.task.taskId);
    let captureTurns = 0;
    primary.onTurn = async (text) => {
      if (text.includes("API limits")) return; // the user's own question
      captureTurns += 1; // the capture prompt, then the reminder
      if (captureTurns >= 2) {
        await fs.writeFile(path.join(dir, CONTEXT_FILE), VALID_CONTEXT);
        await fs.writeFile(path.join(dir, HANDOFF_FILE), VALID_HANDOFF);
      }
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let started: boolean | undefined;
    void h.runner.startTask(companion.id).then((result) => (started = result));
    await drive(() => started !== undefined && live().task.state === "capturing-context");
    // While the Primary works on the capture, the user asks it something.
    userTypes(h.runner, primary, [...keystrokes("what about the API limits?"), "\r"]);
    await drive(() => ["brief-ready", "paused"].includes(live().task.state), { maxFakeMs: 300_000 });

    expect(live().task.state).toBe("brief-ready");
    expect(paused(logCalls)).toEqual([]);
  });
});

describe("the two suspected stalls no longer stall", () => {
  test("Judge input during refreshing: the shower completes", async () => {
    const hooks = true;
    const t = await standardTask({ hooks, showerInterval: 1 });
    t.worker.onTurn = async (text) => {
      if (text.includes("SHOWER_REQUEST")) await fs.writeFile(path.join(t.dir, HANDOFF_FILE), "Parser half done.");
    };
    workerFinishes(t, hooks);
    await drive(() => t.live().task.state === "refreshing");
    userTypes(t.runner, t.judge, [...keystrokes("anything for me?"), "\r"]);
    await drive(() => t.restartSession.mock.calls.length > 0 && t.live().task.state === "running", {
      maxFakeMs: 300_000,
    });
    expect(t.live().task.showerResumePrompt).toContain("Parser half done.");
    expect(warnRefusals()).toEqual([]);
  });

  test("Worker input while a verdict is handled: the next round starts", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    t.judge.onTurn = () =>
      fs.writeFile(path.join(t.dir, VERDICT_FILE), JSON.stringify({ verdict: "continue", reason: "Add tests." }));
    workerFinishes(t, hooks);
    await drive(() => t.live().task.state === "judge-evaluating");
    const verdictRead = holdRead(path.join(t.dir, VERDICT_FILE));
    await drive(() => verdictRead.isHeld());
    t.worker.onTurn = () => {};
    const typedAt = userTypes(t.runner, t.worker, [...keystrokes("status?"), "\r"]);
    verdictRead.release();
    await drive(() => t.live().task.state === "running" && t.live().task.currentRound === 2);

    // The new round's /clear and feedback prompt waited for the user's quiet.
    const newRound = runnerWrites(t.timeline, "worker").filter((entry) => entry.at > typedAt);
    expect(newRound.map((entry) => (entry.data.startsWith("Read ") ? "prompt" : entry.data))).toEqual([
      "/clear",
      "\r",
      "prompt",
      "\r",
    ]);
    expect(newRound[0].at).toBeGreaterThanOrEqual(typedAt + QUIET_MS);
    expect(warnRefusals()).toEqual([]);
  });
});
