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
import {
  CONTEXT_FILE,
  HANDOFF_FILE,
  TASK_LOG_FILE,
  TODO_FILE,
  VERDICT_FILE,
  WORK_LOCK_FILE,
  taskDir,
} from "./agent-task-utils.js";
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
 * A scripted agent CLI behind one PTY, modelled on Claude Code as the runtime
 * sees it:
 *  - a composer; Enter submits it, a leading "/" is the CLI's own command (no
 *    turn), a message submitted while busy is queued;
 *  - each turn ends with the signal the runtime forwards: the Stop hook for a
 *    hook-capable agent, the silence-detected idle for the others;
 *  - "busy" the way runtime.isSessionBusy reports it — only with output in the
 *    last 30 s: a turn prints continuously, a dialog or the rewind picker is
 *    silent;
 *  - a permission dialog takes the keys: Enter answers it, Esc / Ctrl+C reject
 *    it and interrupt the turn;
 *  - Esc interrupts a running turn; two Escs on an idle composer open the
 *    rewind picker, where Enter picks an old message into the composer;
 *  - an interrupted turn sends no Stop; for a hook-capable agent an
 *    `idle_prompt` notification follows a minute after it settles at the
 *    prompt (never while a dialog or the picker is up).
 */
class AgentSim {
  composer = "";
  busy = false;
  dialogOpen = false;
  pickerOpen = false;
  stopped = false;
  exited = false;
  /** The UserPromptSubmit hook is not installed (an older / partial hook setup). */
  noPromptSubmitHook = false;
  /** The next N Enters the runner sends are lost (the "Enter sat in the composer" failure). */
  dropRunnerEnters = 0;
  /**
   * Two Escs on an idle, empty composer this close together open the selector,
   * unless another key came between: Claude Code's rewind picker uses 800 ms
   * (1 s here); Codex's Esc-Esc backtrack has no time limit (Infinity).
   */
  escSelectorWindowMs = 1_000;
  /** Called with each piece of text the runner writes (not its Enters). */
  onRunnerText: (_text: string) => void = () => {};
  /** Every text that started a turn. */
  readonly submitted: string[] = [];
  /** Called when a turn starts with its text; may write files. "dialog" opens a permission dialog first. */
  onTurn: TurnHandler = () => {};
  readonly sessionId: string;
  readonly name: string;
  readonly answerMs: number;
  private queue: string[] = [];
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private idlePromptTimer: ReturnType<typeof setTimeout> | null = null;
  private silentSince = 0;
  private lastEscAt = -Infinity;
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

  /** runtime.isSessionBusy: the busy latch AND output within the last 30 s. */
  isBusy(): boolean {
    if (!this.busy) return false;
    if (this.dialogOpen) return Date.now() - this.silentSince < 30_000;
    return true;
  }

  receive(data: string, from: "runner" | "user"): void {
    // SessionManager drops a write to a session that is gone, silently.
    if (this.stopped || this.exited) return;
    this.timeline.push({ at: Date.now(), agent: this.name, from, data });
    if (data === "\x1b") {
      this.escape();
      return;
    }
    // Any other key ends a run of Escs (Codex: "a non-Esc key cancels a primed backtrack").
    this.lastEscAt = -Infinity;
    if (data === "\x03") {
      if (this.pickerOpen) this.closePicker("ctrl-c");
      else if (this.dialogOpen || (this.busy && !this.composer)) this.interrupt("ctrl-c");
      else this.composer = "";
      return;
    }
    if (data === "\r") {
      if (from === "runner" && this.dropRunnerEnters > 0) {
        this.dropRunnerEnters -= 1;
        this.note("enter-lost");
        return;
      }
      if (this.pickerOpen) {
        this.pickerOpen = false;
        this.composer = "(an earlier message)";
        this.note("picker: earlier message picked into the composer");
        this.idlePromptLater();
        return;
      }
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
    // While a dialog or the picker is up, keys move its selection.
    if (this.dialogOpen || this.pickerOpen) return;
    if (from === "runner") this.onRunnerText(data);
    this.composer += data.replace(/\x1b\[20[01]~/g, "");
  }

  /** A fresh process after a restart: nothing typed, nothing running. */
  reset(): void {
    this.composer = "";
    this.busy = false;
    this.dialogOpen = false;
    this.pickerOpen = false;
    this.queue = [];
    this.clearTimers();
    this.note("restarted");
  }

  /** The PTY exits — what runtime does on terminal:exit. */
  exit(): void {
    this.exited = true;
    this.busy = false;
    this.clearTimers();
    this.note("exited");
    this.runner.onSessionExit(this.sessionId, false);
  }

  /** The running turn stops on a permission dialog (Claude's permission_prompt). */
  askPermission(): void {
    this.dialogOpen = true;
    this.silentSince = Date.now();
    this.note("dialog");
    if (this.hooks) this.hook("Notification", "permission_prompt");
  }

  private escape(): void {
    if (this.pickerOpen) {
      this.closePicker("esc");
      return;
    }
    if (this.dialogOpen || this.busy) {
      this.interrupt("esc");
      return;
    }
    const now = Date.now();
    if (now - this.lastEscAt < this.escSelectorWindowMs && !this.composer) {
      this.pickerOpen = true;
      this.clearTimers();
      this.note("picker opened");
    }
    this.lastEscAt = now;
  }

  private closePicker(by: string): void {
    this.pickerOpen = false;
    this.note(`picker closed (${by})`);
    this.idlePromptLater();
  }

  private interrupt(by: string): void {
    this.dialogOpen = false;
    this.busy = false;
    this.queue = [];
    this.clearTimers();
    this.note(`interrupted (${by})`);
    // No Stop for an interrupted turn; Claude says it is waiting a minute later.
    this.idlePromptLater();
  }

  private idlePromptLater(): void {
    if (!this.hooks) return;
    this.idlePromptTimer = setTimeout(() => {
      this.idlePromptTimer = null;
      if (this.dialogOpen || this.pickerOpen || this.busy) return;
      this.note("idle_prompt");
      this.hook("Notification", "idle_prompt");
    }, 60_000);
  }

  private clearTimers(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.idlePromptTimer) clearTimeout(this.idlePromptTimer);
    this.turnTimer = null;
    this.idlePromptTimer = null;
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
    if (this.idlePromptTimer) clearTimeout(this.idlePromptTimer);
    this.idlePromptTimer = null;
    this.submitted.push(text);
    this.note("turn");
    if (this.hooks && !this.noPromptSubmitHook) setTimeout(() => this.hook("UserPromptSubmit"), 10);
    void Promise.resolve(this.onTurn(text)).then((reaction) => {
      if (reaction === "dialog") {
        setTimeout(() => {
          if (!this.busy) return;
          this.dialogOpen = true;
          this.silentSince = Date.now();
          this.note("dialog");
          if (this.hooks) this.hook("Notification", "permission_prompt");
        }, 100);
        return;
      }
      this.endTurnLater();
    });
  }

  private endTurnLater(): void {
    this.turnTimer = setTimeout(() => this.endTurn(), this.answerMs);
  }

  private endTurn(): void {
    this.turnTimer = null;
    if (this.stopped || this.exited) return;
    this.busy = false;
    this.note("idle");
    if (this.hooks) this.hook("Stop");
    else this.runner.onAgentIdle(this.sessionId, "silence");
    const next = this.queue.shift();
    if (next !== undefined) this.startTurn(next);
  }

  private hook(hook: string, subtype?: string): void {
    if (!this.stopped && !this.exited) this.runner.onHookEvent({ sessionId: this.sessionId, hook, subtype });
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
  // Bounded by real time, not by event-loop turns: on a loaded machine a disk
  // write can outlast any fixed number of turns, and fake time must not move
  // while it is in flight. (`performance` is not faked here.)
  const deadline = performance.now() + 10_000;
  for (;;) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!process.getActiveResourcesInfo().some((resource) => FS_REQUESTS.has(resource))) return;
    if (performance.now() > deadline) return;
  }
}

/**
 * A user action "returns at once" when it settles before its write could go
 * in: before the user's 10 s of quiet are over and before any runner write
 * reached the panel. Measured in task time, so real I/O speed cannot fail it.
 */
async function expectSettledBeforeWrite(
  settled: () => boolean,
  t: { timeline: Entry[] },
  agent: string,
  typedAt: number,
): Promise<void> {
  await drive(settled, { maxFakeMs: QUIET_MS });
  expect(Date.now()).toBeLessThan(typedAt + QUIET_MS);
  expect(runnerWrites(t.timeline, agent).filter((entry) => entry.at >= typedAt)).toEqual([]);
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
    isSessionBusy: (sessionId: string) => sims.get(sessionId)?.isBusy() ?? false,
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
async function standardTask({
  hooks,
  showerInterval,
  typeBeforeStart,
  noPromptSubmitHook = false,
  workerProvider,
}: {
  hooks: boolean;
  /** The Worker's provider id (default Claude) — e.g. "copilot", which types its prompts. */
  workerProvider?: string;
  showerInterval?: number;
  /** Text the user leaves in the Worker before pressing Start. */
  typeBeforeStart?: string;
  /** The provider's UserPromptSubmit hook is not installed (a partial hook setup). */
  noPromptSubmitHook?: boolean;
}) {
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
  if (workerProvider) created.task.workerProviderConfig = { providerId: workerProvider, model: "" } as never;
  await builder.writeInitialFiles(cwd, created.task);
  const h = await harness([created as unknown as WorkspaceState], cwd, hooks);
  const workspaceId = created.id;
  const live = () => h.store.getState().workspaces.find((ws) => ws.id === workspaceId) as unknown as typeof created;
  const worker = h.addSim(sessionIdFor(live(), "worker"), "worker");
  const judge = h.addSim(sessionIdFor(live(), "judge"), "judge");
  worker.noPromptSubmitHook = noPromptSubmitHook;
  judge.noPromptSubmitHook = noPromptSubmitHook;
  // The Worker keeps working on its task prompt until the test says it is
  // done; anything the user asks it, it answers.
  worker.onTurn = (text) => (text.includes("PROMPT.worker.md") ? new Promise<void>(() => {}) : undefined);

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const typedBeforeStartAt = typeBeforeStart ? userTypes(h.runner, worker, keystrokes(typeBeforeStart)) : 0;
  let started: boolean | undefined;
  void h.runner.startTask(workspaceId).then((result) => (started = result));
  if (typeBeforeStart) {
    // Start answers before its prompt, which has to wait for the user, goes in.
    await expectSettledBeforeWrite(() => started !== undefined, { timeline: h.timeline }, "worker", typedBeforeStartAt);
  } else {
    await drive(() => started !== undefined);
  }
  expect(started).toBe(true);
  expect(live().task.state).toBe("running");
  // The placeholder repo only spared startTask a real `git init`. Without it the
  // evaluation's git context is one fs check instead of child processes, which
  // would let fake time run ahead of the runner while they finish.
  await fs.rm(path.join(cwd, ".git"), { recursive: true, force: true });
  const dir = taskDir(cwd, created.task.taskId);
  return { ...h, cwd, dir, workspaceId, live, worker, judge, typedBeforeStartAt };
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

  test("Esc and Ctrl+C dismiss a dialog and interrupt; Esc is no text", () => {
    expect(fold("\x1b")).toMatchObject({ pending: false, dismissed: true, escaped: true, interrupted: true });
    expect(fold("\x1b", true)).toMatchObject({ pending: true, dismissed: true, escaped: true }); // composer as it was
    expect(fold("\x1b\x1b")).toMatchObject({ pending: false, dismissed: true });
    expect(fold("\x1b[A")).toMatchObject({ pending: true, dismissed: false }); // an arrow, not Esc
    expect(fold("\x1b\r", true)).toMatchObject({ pending: true, dismissed: false }); // Alt+Enter
    expect(fold("\x03")).toMatchObject({ dismissed: true, escaped: false, interrupted: true });
    expect(fold("\x03", true)).toMatchObject({ pending: false, dismissed: true, interrupted: false });
  });

  test("two Escs in a row — in one chunk or across chunks — are the selector pattern; any other key ends the run", () => {
    expect(fold("\x1b")).toMatchObject({ escRun: 1, doubleEscaped: false });
    expect(fold("\x1b\x1b")).toMatchObject({ escRun: 2, doubleEscaped: true });
    const next = (after: ReturnType<typeof fold>, data: string) =>
      foldTerminalInput({ pending: after.pending, lastChar: after.lastChar, escRun: after.escRun }, data);
    expect(next(fold("\x1b"), "\x1b")).toMatchObject({ escRun: 2, doubleEscaped: true });
    for (const between of ["a", "\r", "\x03", "\x1b[A", "\x1b[200~x\x1b[201~"]) {
      const broken = next(fold("\x1b"), between);
      expect(broken.escRun).toBe(0);
      expect(next(broken, "\x1b")).toMatchObject({ escRun: 1, doubleEscaped: false });
    }
    expect(fold("\x1ba")).toMatchObject({ escRun: 0, doubleEscaped: false }); // Alt+a, not Esc
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

describe("review fixes: dismissed dialogs, long waits, user actions, lost Enters", () => {
  const judgeAsksPermission = (t: { judge: AgentSim }) => {
    t.judge.onTurn = () => {
      t.judge.onTurn = () => {};
      return "dialog";
    };
  };

  /** The user asks the Judge something during the checks; its turn stops on a permission dialog. */
  async function judgeDialogDuringChecks(question: string) {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    const checks = holdRead(path.join(t.dir, TODO_FILE));
    workerFinishes(t, hooks);
    await drive(() => checks.isHeld());
    judgeAsksPermission(t);
    userTypes(t.runner, t.judge, [...keystrokes(question), "\r"]);
    await drive(() => t.judge.dialogOpen);
    return { t, releaseChecks: () => checks.release() };
  }

  test("Ctrl+C rejects a dialog: the turn ends without a Stop, and the runner goes on once the user is quiet", async () => {
    const { t, releaseChecks } = await judgeDialogDuringChecks("run the tests");
    const rejectedAt = userTypes(t.runner, t.judge, ["\x03"]);
    releaseChecks();
    await drive(() => t.live().task.state === "judge-evaluating", { maxFakeMs: 11 * 60_000 });

    const writes = runnerWrites(t.timeline, "judge");
    expect(writes[0]).toMatchObject({ data: "/clear" });
    expect(writes[0].at).toBeGreaterThanOrEqual(rejectedAt + QUIET_MS);
    expect(writes[0].at).toBeLessThan(rejectedAt + QUIET_MS + 5_000);
  });

  test("Esc rejects a dialog like Ctrl+C: the runner goes on once the user is quiet, without waiting for an agent signal", async () => {
    const { t, releaseChecks } = await judgeDialogDuringChecks("run the tests");
    const rejectedAt = userTypes(t.runner, t.judge, ["\x1b"]);
    releaseChecks();
    await drive(() => t.live().task.state === "judge-evaluating", { maxFakeMs: 11 * 60_000 });

    // One Esc closes the dialog and interrupts the turn; the composer is back.
    const writes = runnerWrites(t.timeline, "judge");
    expect(t.timeline.some((entry) => entry.agent === "judge" && entry.data === "interrupted (esc)")).toBe(true);
    expect(writes[0]).toMatchObject({ data: "/clear" });
    expect(writes[0].at).toBeGreaterThanOrEqual(rejectedAt + QUIET_MS);
    expect(writes[0].at).toBeLessThan(rejectedAt + QUIET_MS + 5_000);
    // Claude's idle_prompt comes a minute after the interrupt — not needed.
    const idlePrompt = t.timeline.find((entry) => entry.agent === "judge" && entry.data === "idle_prompt");
    if (idlePrompt) expect(writes[0].at).toBeLessThan(idlePrompt.at);
  });

  test("a dialog nobody answers: still waiting after five minutes and after Pause + Continue — nothing written into it", async () => {
    const { t, releaseChecks } = await judgeDialogDuringChecks("deploy it");
    userTypes(t.runner, t.judge, ["\x1b[B"]); // moves the selection, confirms nothing
    releaseChecks();
    await elapse(AgentTaskRunner.POLITE_WAIT_WARN_MS + QUIET_MS + 1_000);

    const warns = () =>
      logCalls.filter((call) => call.level === "warn" && call.message === "task injection still waiting for the user");
    expect(warns()).toHaveLength(1);
    expect(warns()[0].meta).toMatchObject({ waitingFor: "dialog-open", role: "judge", state: "evaluating" });
    expect(warns()[0].meta?.waitedMs).toBeGreaterThanOrEqual(AgentTaskRunner.POLITE_WAIT_WARN_MS);
    expect(JSON.stringify(warns()[0].meta)).not.toContain("deploy it");

    // Pause + Continue forget the turn the runner believed in — never the
    // dialog the user still has to answer.
    expect(t.runner.pauseTask(t.workspaceId)).toBe(true);
    expect(t.runner.resumeTask(t.workspaceId)).toBe(true);
    workerFinishes(t, true);
    await elapse(AgentTaskRunner.POLITE_WAIT_WARN_MS + 1_000);
    expect(runnerWrites(t.timeline, "judge")).toEqual([]);
    expect(t.judge.dialogOpen).toBe(true);
    expect(warns().length).toBeGreaterThanOrEqual(2);
  });

  /** A task the Judge approved, the Worker idle and answering whatever it is asked. */
  async function completedTask() {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    t.judge.onTurn = () =>
      fs.writeFile(path.join(t.dir, VERDICT_FILE), JSON.stringify({ verdict: "complete", reason: "All done." }));
    t.worker.onTurn = () => {};
    workerFinishes(t, hooks);
    await drive(() => t.live().task.state === "completed");
    await elapse(5_000); // the "task ended" notice is in
    return t;
  }

  test("Send back returns at once while the user has text in the Worker; the feedback follows them", async () => {
    const t = await completedTask();
    const typedAt = userTypes(t.runner, t.worker, keystrokes("let me check one thing"));
    let result: boolean | undefined;
    void t.runner.rejectTaskVerdict(t.workspaceId, "Also cover the error path.").then((ok) => (result = ok));
    await expectSettledBeforeWrite(() => result !== undefined, t, "worker", typedAt);

    expect(result).toBe(true);
    expect(t.live().task).toMatchObject({ state: "running", currentRound: 2 });

    await drive(() => runnerWrites(t.timeline, "worker").filter((entry) => entry.at > typedAt).length >= 3);
    const after = runnerWrites(t.timeline, "worker").filter((entry) => entry.at > typedAt);
    // Their text first, answered, then our feedback prompt with its Enter.
    expect(after.map((entry) => (entry.data.startsWith("Read ") ? "prompt" : entry.data))).toEqual([
      "\r",
      "prompt",
      "\r",
    ]);
    expect(after[0].at).toBeGreaterThanOrEqual(typedAt + QUIET_MS);
  });

  test("a Send back whose Worker session ends before the feedback goes in tells the user so", async () => {
    const t = await completedTask();
    const typedAt = userTypes(t.runner, t.worker, keystrokes("let me check one thing"));
    let result: boolean | undefined;
    void t.runner.rejectTaskVerdict(t.workspaceId, "Also cover the error path.").then((ok) => (result = ok));
    await expectSettledBeforeWrite(() => result !== undefined, t, "worker", typedAt);
    expect(result).toBe(true);

    // The Worker's PTY exits (terminal:exit → onSessionExit), as in production.
    t.worker.exit();
    await drive(() => t.raiseAlert.mock.calls.some(([alert]) => /did not reach the Worker/.test(String(alert.detail))));

    expect(t.live().task.state).toBe("paused");
    expect(t.worker.submitted.some((text) => text.includes("PROMPT.worker.md") && text !== t.worker.submitted[0])).toBe(
      false,
    );
    expect(
      logCalls.some(
        (call) => call.level === "error" && call.message === "rejectTaskVerdict: feedback was not delivered",
      ),
    ).toBe(true);
  });

  test("Start returns at once while the user has text in the Worker; the task prompt follows them", async () => {
    const t = await standardTask({ hooks: true, typeBeforeStart: "one more idea" });
    // standardTask already required Start to answer before its prompt went in.
    expect(runnerWrites(t.timeline, "worker")).toEqual([]);
    // Start finished in the background once the prompt was confirmed.
    await drive(() => t.live().task.promptSent === true);
    const writes = runnerWrites(t.timeline, "worker");
    expect(writes.map((entry) => (entry.data.startsWith("Read ") ? "prompt" : entry.data))).toEqual([
      "\r",
      "prompt",
      "\r",
    ]);
    expect(writes[0].at).toBeGreaterThanOrEqual(t.typedBeforeStartAt + QUIET_MS);
  });

  /** Drop the Enter after the Judge's evaluation prompt; the user then types into the composer. */
  async function lostJudgeEnter(t: Awaited<ReturnType<typeof standardTask>>) {
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    workerFinishes(t, true);
    await drive(() => runnerWrites(t.timeline, "judge").some(isJudgePrompt));
    t.judge.dropRunnerEnters = 1;
    await elapse(2_000);
  }

  test("a lost Enter while the user types: their Enter carries our prompt, nothing is written twice", async () => {
    const t = await standardTask({ hooks: true });
    await lostJudgeEnter(t);
    userTypes(t.runner, t.judge, ["x"]);
    await drive(() => t.judge.submitted.some((text) => text.includes("PROMPT.judge.md")));
    await drive(() => t.live().task.state === "judge-evaluating");

    expect(t.judge.submitted.filter((text) => text.includes("PROMPT.judge.md"))).toHaveLength(1);
    expect(runnerWrites(t.timeline, "judge").filter(isJudgePrompt)).toHaveLength(1);
    expect(
      logCalls.some(
        (call) =>
          call.message === "injectPrompt: submit unconfirmed and the user is typing — waiting for them before deciding",
      ),
    ).toBe(true);
  });

  test("a lost Enter the user then clears: the prompt is written again and goes in", async () => {
    const t = await standardTask({ hooks: true });
    await lostJudgeEnter(t);
    userTypes(t.runner, t.judge, ["x", "\x03"]); // Ctrl+C clears our text with theirs
    await drive(() => t.judge.submitted.some((text) => text.includes("PROMPT.judge.md")));
    await drive(() => t.live().task.state === "judge-evaluating");

    expect(runnerWrites(t.timeline, "judge").filter(isJudgePrompt)).toHaveLength(2);
    expect(t.judge.submitted.filter((text) => text.includes("PROMPT.judge.md"))).toHaveLength(1);
    expect(
      logCalls.some((call) => call.message === "injectPrompt: the runner's prompt never went in — writing it again"),
    ).toBe(true);
  });
});

describe("the runner never answers, accepts, selects or confirms anything for the user", () => {
  const judgeAsksPermission = (t: { judge: AgentSim }) => {
    t.judge.onTurn = () => {
      t.judge.onTurn = () => {};
      return "dialog";
    };
  };

  test("an untouched dialog is never answered — not by the evaluation, Resend, the rate-limit Enter, or after Pause + Continue", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    const checks = holdRead(path.join(t.dir, TODO_FILE));
    workerFinishes(t, hooks);
    await drive(() => checks.isHeld());
    // The user asks; the Judge's turn stops on a dialog the user never touches.
    judgeAsksPermission(t);
    userTypes(t.runner, t.judge, [...keystrokes("deploy it"), "\r"]);
    await drive(() => t.judge.dialogOpen);
    checks.release();
    // Well past the quiet window and past "30 s without output" (a dialog is silent).
    await elapse(QUIET_MS + AgentTaskRunner.TURN_QUIET_FALLBACK_MS + 60_000);
    expect(t.judge.isBusy()).toBe(false);

    // Nothing was sent yet, but the evaluation's /clear already waits behind
    // the dialog: Resend starts no second write and says why.
    expect(await t.runner.resendLastInstruction(t.workspaceId, "judge")).toBe(true);
    t.runner.onAgentRateLimited(
      t.judge.sessionId,
      { resetAt: new Date(Date.now() + 60_000), needsConfirm: true, providerHint: "claude" },
      "test",
    );
    expect(t.runner.pauseTask(t.workspaceId)).toBe(true);
    expect(t.runner.resumeTask(t.workspaceId)).toBe(true);
    workerFinishes(t, hooks);
    await elapse(6 * 60_000);
    expect(runnerWrites(t.timeline, "judge")).toEqual([]);
    expect(t.judge.dialogOpen).toBe(true);

    // The user answers it; the turn ends; only then does the runner write.
    const answeredAt = userTypes(t.runner, t.judge, ["\r"]);
    await drive(() => t.live().task.state === "judge-evaluating");
    const firstWrite = runnerWrites(t.timeline, "judge")[0];
    const turnEnd = t.timeline.find(
      (entry) => entry.agent === "judge" && entry.data === "idle" && entry.at > answeredAt,
    );
    expect(firstWrite.at).toBeGreaterThanOrEqual(turnEnd!.at);
    expect(firstWrite.at).toBeGreaterThanOrEqual(answeredAt + QUIET_MS);
  });

  test("two Escs open the rewind picker: nothing is written into it — not even after an idle_prompt; a submitted message settles it", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    const checks = holdRead(path.join(t.dir, TODO_FILE));
    workerFinishes(t, hooks);
    await drive(() => checks.isHeld());
    userTypes(t.runner, t.judge, ["\x1b"]);
    await elapse(300);
    userTypes(t.runner, t.judge, ["\x1b"]);
    expect(t.judge.pickerOpen).toBe(true);
    checks.release();
    await elapse(AgentTaskRunner.POLITE_WAIT_WARN_MS + 1_000);

    expect(runnerWrites(t.timeline, "judge")).toEqual([]);
    expect(
      logCalls.some(
        (call) =>
          call.level === "warn" &&
          call.message === "task injection still waiting for the user" &&
          call.meta?.waitingFor === "ui-uncertain",
      ),
    ).toBe(true);

    // Whether Claude sends idle_prompt while the picker is open is unverified:
    // assume it might. A turn-end signal must not settle the screen.
    t.runner.onHookEvent({ sessionId: t.judge.sessionId, hook: "Notification", subtype: "idle_prompt" });
    await elapse(60_000);
    expect(runnerWrites(t.timeline, "judge")).toEqual([]);

    // The user closes the picker (Claude's idle_prompt follows a minute later):
    // still nothing written — then they send a message from the prompt.
    userTypes(t.runner, t.judge, ["\x1b"]);
    await elapse(2 * 60_000);
    expect(t.timeline.filter((entry) => entry.agent === "judge" && entry.data === "idle_prompt")).toHaveLength(1);
    expect(runnerWrites(t.timeline, "judge")).toEqual([]);
    const sentAt = userTypes(t.runner, t.judge, [...keystrokes("carry on"), "\r"]);
    await drive(() => t.live().task.state === "judge-evaluating");
    expect(runnerWrites(t.timeline, "judge")[0].at).toBeGreaterThanOrEqual(sentAt + QUIET_MS);
    expect(t.timeline.some((entry) => entry.data.startsWith("picker: earlier message picked"))).toBe(false);
  });

  test("without hooks, two Escs minutes apart may open Codex's backtrack: only the user's own message proves the prompt", async () => {
    const hooks = false;
    const t = await standardTask({ hooks });
    t.judge.escSelectorWindowMs = Infinity; // Codex: Esc, then Esc again with no key between
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    const checks = holdRead(path.join(t.dir, TODO_FILE));
    workerFinishes(t, hooks);
    await drive(() => checks.isHeld());
    userTypes(t.runner, t.judge, ["\x1b"]);
    await elapse(2 * 60_000);
    userTypes(t.runner, t.judge, ["\x1b"]);
    expect(t.judge.pickerOpen).toBe(true);
    checks.release();
    await elapse(AgentTaskRunner.POLITE_WAIT_WARN_MS + 1_000);
    expect(runnerWrites(t.timeline, "judge")).toEqual([]);

    // The user leaves the selector and sends a message from the prompt.
    userTypes(t.runner, t.judge, ["\x03"]);
    expect(t.judge.pickerOpen).toBe(false);
    await elapse(AgentTaskRunner.POLITE_WAIT_WARN_MS);
    expect(runnerWrites(t.timeline, "judge")).toEqual([]);
    const sentAt = userTypes(t.runner, t.judge, [...keystrokes("carry on"), "\r"]);
    await drive(() => t.live().task.state === "judge-evaluating");
    const firstWrite = runnerWrites(t.timeline, "judge")[0];
    expect(firstWrite).toMatchObject({ data: "/clear" });
    expect(firstWrite.at).toBeGreaterThanOrEqual(sentAt + QUIET_MS);
  });

  /** A task the Judge approved, the Worker idle and answering whatever it is asked. */
  async function completedTask() {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    t.judge.onTurn = () =>
      fs.writeFile(path.join(t.dir, VERDICT_FILE), JSON.stringify({ verdict: "complete", reason: "All done." }));
    t.worker.onTurn = () => {};
    workerFinishes(t, hooks);
    await drive(() => t.live().task.state === "completed");
    await elapse(5_000);
    return t;
  }

  test("Resend while a Send back waits for the user starts no second write", async () => {
    const t = await completedTask();
    const typedAt = userTypes(t.runner, t.worker, keystrokes("let me check one thing"));
    let result: boolean | undefined;
    void t.runner.rejectTaskVerdict(t.workspaceId, "Also cover the error path.").then((ok) => (result = ok));
    await expectSettledBeforeWrite(() => result !== undefined, t, "worker", typedAt);

    expect(await t.runner.resendLastInstruction(t.workspaceId, "worker")).toBe(true);
    const before = t.worker.submitted.length;
    await drive(() => t.worker.submitted.length >= before + 2);

    // Their text, then the feedback on its own: every runner text was followed
    // by its own Enter — never two writes glued together in the composer.
    expect(t.worker.submitted.slice(before, before + 2)).toEqual([
      "let me check one thing",
      expect.stringMatching(/^Read \S+ and follow the instructions in it now\.$/),
    ]);
    const writes = runnerWrites(t.timeline, "worker").filter((entry) => entry.at > typedAt);
    for (let i = 0; i < writes.length - 1; i += 1) {
      if (writes[i].data !== "\r") expect(writes[i + 1].data).toBe("\r");
    }
    expect(logCalls.some((call) => call.message.startsWith("resendLastInstruction: a delivery to this session"))).toBe(
      true,
    );
  });

  test("a provider without a working UserPromptSubmit hook: an unconfirmed prompt is never written twice", async () => {
    const t = await standardTask({ hooks: true, noPromptSubmitHook: true });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    workerFinishes(t, true);
    await drive(() => runnerWrites(t.timeline, "judge").some(isJudgePrompt));
    t.judge.dropRunnerEnters = 1; // the Enter after the evaluation prompt is lost
    await elapse(2_000);
    userTypes(t.runner, t.judge, ["x"]);
    await drive(() => t.judge.submitted.some((text) => text.includes("PROMPT.judge.md")));
    await drive(() => t.live().task.state === "judge-evaluating");

    expect(runnerWrites(t.timeline, "judge").filter(isJudgePrompt)).toHaveLength(1);
  });

  test("an unconfirmed prompt the user keeps clearing is rewritten a bounded number of times", async () => {
    const t = await standardTask({ hooks: true });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    workerFinishes(t, true);
    await drive(() => runnerWrites(t.timeline, "judge").some(isJudgePrompt));
    // Every later Enter is lost too, and every time our prompt appears the
    // user types over it and clears the composer.
    t.judge.dropRunnerEnters = 99;
    const clearAfterPrompt = () => {
      setTimeout(() => userTypes(t.runner, t.judge, ["x", "\x03"]), 2_000);
    };
    t.judge.onRunnerText = (text) => {
      if (text.includes("PROMPT.judge.md")) clearAfterPrompt();
    };
    clearAfterPrompt();
    await drive(() => t.live().task.state === "judge-evaluating", { maxFakeMs: 30 * 60_000 });

    expect(runnerWrites(t.timeline, "judge").filter(isJudgePrompt)).toHaveLength(
      1 + AgentTaskRunner.MAX_UNCONFIRMED_REWRITES,
    );
    expect(
      logCalls.some(
        (call) => call.message === "injectPrompt: still unconfirmed after rewriting the prompt — assuming it went in",
      ),
    ).toBe(true);
  });

  /** An attached task whose Companion asked the user a question (awaiting-user). */
  async function awaitingUserTask() {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-polite-answer-"));
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
    const reviewer = h.addSim(sessionIdFor(live(), "judge"), "reviewer");
    const dir = taskDir(cwd, companion.task.taskId);
    primary.onTurn = async (text) => {
      if (!text.startsWith("Read ")) return; // the user's own messages
      await fs.writeFile(path.join(dir, CONTEXT_FILE), VALID_CONTEXT);
      await fs.writeFile(path.join(dir, HANDOFF_FILE), VALID_HANDOFF);
    };
    reviewer.onTurn = async (text) => {
      if (!text.startsWith("Read ")) return;
      await fs.writeFile(
        path.join(dir, VERDICT_FILE),
        JSON.stringify({
          schemaVersion: 1,
          role: "reviewer",
          phase: "baseline",
          round: 1,
          evaluationAttempt: live().task.companionEvaluationAttempt,
          verdict: "needs-input",
          reason: "Need a product decision.",
          blockingFindings: [],
          questions: [{ id: "Q-1", question: "Which option?", whyNeeded: "Two valid designs." }],
          verificationReview: { recordStatus: "not-required", evidenceReviewed: [], workerActionsRequired: [] },
          roleAnalysis: {
            type: "reviewer",
            requirementAudit: [{ requirement: "R1", status: "verified", evidence: ["file.ts:1"] }],
          },
          advisories: [],
        }),
      );
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let started: boolean | undefined;
    void h.runner.startTask(companion.id).then((ok) => (started = ok));
    await drive(() => started !== undefined && live().task.state === "brief-ready");
    started = undefined;
    void h.runner.startTask(companion.id).then((ok) => (started = ok));
    await drive(() => started !== undefined && live().task.state === "awaiting-user");
    return { ...h, live, primary, dir };
  }

  test("a second answer while the first is on its way is refused; an answer lost with the Primary is reported", async () => {
    const t = await awaitingUserTask();
    const typedAt = userTypes(t.runner, t.primary, keystrokes("thinking about it"));
    let first: boolean | undefined;
    void t.runner.answerCompanionTask(t.live().id, ["Q-1"], "Go with option B.").then((ok) => (first = ok));
    await expectSettledBeforeWrite(() => first !== undefined, t, "primary", typedAt);
    expect(first).toBe(true);

    // What the dashboard's toast is told (runtime-task-handlers reads it before the call).
    expect(t.runner.isCompanionAnswerInFlight(t.live().id)).toBe(true);
    expect(await t.runner.answerCompanionTask(t.live().id, ["Q-1"], "Actually option C.")).toBe(false);
    const taskMd = await fs.readFile(path.join(t.dir, "TASK.md"), "utf8");
    expect(taskMd.match(/User clarification/g)).toHaveLength(1);
    expect(taskMd).not.toContain("option C");

    // The Primary's PTY exits before the answer went in.
    t.primary.exit();
    await drive(() =>
      t.raiseAlert.mock.calls.some(([alert]) => /answer did not reach the Primary/.test(String(alert.detail))),
    );
    expect(t.live().task.state).toBe("awaiting-user");
    expect(t.live().task.pendingQuestions).toHaveLength(1);
    expect(
      logCalls.some(
        (call) => call.level === "error" && call.message === "answerCompanionTask: did not complete in the background",
      ),
    ).toBe(true);
  });
});

/** The Worker's round is done; the checks are held, so the Judge is next. */
async function judgeIsNext(hooks: boolean) {
  const t = await standardTask({ hooks });
  await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
  const checks = holdRead(path.join(t.dir, TODO_FILE));
  workerFinishes(t, hooks);
  await drive(() => checks.isHeld());
  return { t, releaseChecks: () => checks.release() };
}

const taskEvents = async (dir: string): Promise<Array<{ event: string; detail?: string }>> =>
  (await fs.readFile(path.join(dir, TASK_LOG_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

describe.each([
  ["hook-capable provider", true],
  ["provider without hooks", false],
])("a lone Esc never stalls a task (%s)", (_label, hooks) => {
  test("one Esc on the idle Judge: its /clear goes in after the usual quiet — no agent signal follows a lone Esc", async () => {
    const { t, releaseChecks } = await judgeIsNext(hooks);
    const escAt = userTypes(t.runner, t.judge, ["\x1b"]);
    releaseChecks();
    await drive(() => t.live().task.state === "judge-evaluating", { maxFakeMs: 2 * 60_000 });

    const writes = runnerWrites(t.timeline, "judge");
    expect(writes[0]).toMatchObject({ data: "/clear" });
    expect(writes[0].at).toBeGreaterThanOrEqual(escAt + QUIET_MS);
    expect(writes[0].at).toBeLessThan(escAt + QUIET_MS + 5_000);
    // Claude says nothing after an Esc on an idle prompt; the others never do.
    expect(t.timeline.some((entry) => entry.agent === "judge" && entry.data === "idle_prompt")).toBe(false);
  });

  test("Esc interrupts the Worker's turn: the task's next step goes in once the turn's idle comes", async () => {
    const t = await standardTask({ hooks });
    await elapse(5_000);
    const escAt = userTypes(t.runner, t.worker, ["\x1b"]);
    expect(t.timeline.some((entry) => entry.agent === "worker" && entry.data === "interrupted (esc)")).toBe(true);
    // The interrupted turn's idle: Claude's idle_prompt a minute later; the
    // runtime's silence detection for an agent without hooks.
    if (!hooks) {
      await elapse(5_000);
      t.runner.onAgentIdle(t.worker.sessionId, "silence");
    }
    await drive(() => runnerWrites(t.timeline, "worker").some((entry) => entry.at > escAt), { maxFakeMs: 3 * 60_000 });

    const next = runnerWrites(t.timeline, "worker").find((entry) => entry.at > escAt)!;
    expect(next.at).toBeGreaterThanOrEqual(escAt + QUIET_MS);
    if (!hooks) expect(next.at).toBeLessThan(escAt + QUIET_MS + 5_000);
  });
});

describe("the user's dashboard action settles a possible selector — never a dialog", () => {
  /** Two Escs open the Judge's selector during the checks; the user closes it. No agent signal follows. */
  async function selectorOpenedAndClosed() {
    const { t, releaseChecks } = await judgeIsNext(false);
    userTypes(t.runner, t.judge, ["\x1b"]);
    await elapse(300);
    userTypes(t.runner, t.judge, ["\x1b"]);
    expect(t.judge.pickerOpen).toBe(true);
    releaseChecks();
    await elapse(60_000);
    userTypes(t.runner, t.judge, ["\x1b"]); // closes it — the runner cannot know that
    expect(t.judge.pickerOpen).toBe(false);
    await elapse(60_000);
    expect(runnerWrites(t.timeline, "judge")).toEqual([]);
    return t;
  }

  test("Resend: the waiting write goes in — once — and Resend says so, though nothing was sent before", async () => {
    const t = await selectorOpenedAndClosed();
    const clickedAt = Date.now();
    // Not "nothing to resend": the press released the /clear that waited.
    expect(await t.runner.resendLastInstruction(t.workspaceId, "judge")).toBe(true);
    await drive(() => t.live().task.state === "judge-evaluating", { maxFakeMs: 60_000 });
    const skipped = (await taskEvents(t.dir)).filter((entry) => entry.event === "resend-skipped");
    expect(skipped.map((entry) => entry.detail)).toEqual([
      expect.stringMatching(/^Taken as your word that the Judge panel is at its prompt/),
    ]);

    const writes = runnerWrites(t.timeline, "judge");
    expect(writes[0]).toMatchObject({ data: "/clear" });
    expect(writes[0].at).toBeGreaterThanOrEqual(clickedAt);
    expect(writes.filter(isJudgePrompt)).toHaveLength(1);
    expect(t.timeline.some((entry) => entry.data.startsWith("picker: earlier message picked"))).toBe(false);
  });

  test("Continue: the resumed evaluation reaches the Judge", async () => {
    const t = await selectorOpenedAndClosed();
    expect(t.runner.pauseTask(t.workspaceId)).toBe(true);
    const clickedAt = Date.now();
    expect(t.runner.resumeTask(t.workspaceId)).toBe(true);
    await drive(() => t.live().task.state === "judge-evaluating", { maxFakeMs: 3 * 60_000 });
    expect(runnerWrites(t.timeline, "judge")[0].at).toBeGreaterThanOrEqual(clickedAt);
  });

  test("Start after Reset: both /clears go in and the Worker gets its prompt", async () => {
    const t = await selectorOpenedAndClosed();
    expect(t.runner.pauseTask(t.workspaceId)).toBe(true);
    expect(await t.runner.resetTask(t.workspaceId)).toBe(true);
    const clickedAt = Date.now();
    let started: boolean | undefined;
    void t.runner.startTask(t.workspaceId).then((ok) => (started = ok));
    await drive(() => t.live().task.promptSent === true, { maxFakeMs: 60_000 });

    expect(started).toBe(true);
    expect(t.live().task.state).toBe("running");
    const judgeClear = runnerWrites(t.timeline, "judge").find((entry) => entry.data === "/clear");
    expect(judgeClear!.at).toBeGreaterThanOrEqual(clickedAt);
  });
});

describe("a long wait for the user shows on the dashboard, not only in the log", () => {
  const waitingAlerts = (t: { raiseAlert: { mock: { calls: any[][] } } }) =>
    t.raiseAlert.mock.calls
      .map(([alert]) => alert)
      .filter((alert) => alert.kind === "waiting" && String(alert.detail).startsWith("task-waiting:"));

  test("behind a dialog: one urgent alert on the Judge panel, and the Activity log says what to do", async () => {
    const { t, releaseChecks } = await judgeIsNext(true);
    t.judge.onTurn = () => {
      t.judge.onTurn = () => {};
      return "dialog";
    };
    userTypes(t.runner, t.judge, [...keystrokes("deploy it"), "\r"]);
    await drive(() => t.judge.dialogOpen);
    releaseChecks();
    await elapse(AgentTaskRunner.POLITE_WAIT_WARN_MS + QUIET_MS + 1_000);

    expect(waitingAlerts(t)).toHaveLength(1);
    expect(waitingAlerts(t)[0]).toMatchObject({
      urgency: "urgent",
      sessionId: t.judge.sessionId,
      panelId: t.live().task.judgePanelId,
    });
    expect(waitingAlerts(t)[0].detail).toMatch(/a dialog is open in the Judge panel.*Answer it there/);
    const events = await taskEvents(t.dir);
    const waiting = events.filter((entry) => entry.event === "waiting-for-user");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].detail).toMatch(/a dialog is open in the Judge panel/);
    expect(JSON.stringify(events)).not.toContain("deploy it");

    // The next interval only logs again.
    await elapse(AgentTaskRunner.POLITE_WAIT_WARN_MS);
    expect(waitingAlerts(t)).toHaveLength(1);
    expect(runnerWrites(t.timeline, "judge")).toEqual([]);
  });

  test("behind a possible selector: the alert names the panel and the Resend that settles it", async () => {
    const { t, releaseChecks } = await judgeIsNext(true);
    userTypes(t.runner, t.judge, ["\x1b"]);
    await elapse(300);
    userTypes(t.runner, t.judge, ["\x1b"]);
    releaseChecks();
    await elapse(AgentTaskRunner.POLITE_WAIT_WARN_MS + 1_000);

    expect(waitingAlerts(t)).toHaveLength(1);
    expect(waitingAlerts(t)[0].detail).toMatch(/Esc was pressed twice in the Judge panel.*↻ Judge/);
    expect((await taskEvents(t.dir)).some((entry) => entry.event === "waiting-for-user")).toBe(true);
  });
});

describe("a dialog is not an idle", () => {
  test("a permission prompt in the Judge's evaluation: no verdict nudge, and the user's alert is not swallowed", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    const hookCalls = vi.spyOn(t.runner, "onHookEvent");
    t.judge.onTurn = () => {
      t.judge.onTurn = () => {};
      return "dialog";
    };
    workerFinishes(t, hooks);
    await drive(() => t.judge.dialogOpen);
    const askedAt = Date.now();
    await elapse(5 * 60_000);

    const permission = hookCalls.mock.calls.findIndex(([event]) => event.subtype === "permission_prompt");
    expect(hookCalls.mock.results[permission].value).toBe(false); // the runtime raises the user's alert
    expect(t.live().task.judgeNudged).toBeFalsy();
    expect(runnerWrites(t.timeline, "judge").filter((entry) => entry.at > askedAt)).toEqual([]);

    // The user approves; the Judge writes its verdict and ends the turn.
    await fs.writeFile(path.join(t.dir, VERDICT_FILE), JSON.stringify({ verdict: "complete", reason: "All done." }));
    userTypes(t.runner, t.judge, ["\r"]);
    await drive(() => t.live().task.state === "completed");
    expect(t.live().task.judgeNudged).toBeFalsy();
    expect(runnerWrites(t.timeline, "judge").filter((entry) => entry.at > askedAt)).toEqual([]);
  });

  test("an MCP elicitation in the Worker's own turn: the task tells the user at once — but not twice for a permission prompt", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await elapse(5_000);
    const waiting = () =>
      t.raiseAlert.mock.calls
        .map(([alert]) => alert)
        .filter((alert) => String(alert.detail).startsWith("task-waiting:"));
    // No runner write is pending, so no long-wait warning would ever come;
    // the runtime holds a normal-urgency question back in a running task.
    const elicitation = { sessionId: t.worker.sessionId, hook: "Notification", subtype: "elicitation_dialog" };
    expect(t.runner.onHookEvent(elicitation)).toBe(false);
    expect(waiting()).toHaveLength(1);
    expect(waiting()[0]).toMatchObject({
      kind: "waiting",
      urgency: "urgent",
      sessionId: t.worker.sessionId,
      panelId: t.live().task.workerPanelId,
    });
    expect(waiting()[0].detail).toMatch(/a dialog is open in the Worker panel.*Answer it there/);
    await elapse(1_000);
    expect((await taskEvents(t.dir)).filter((entry) => entry.event === "waiting-for-user")).toHaveLength(1);

    // A permission prompt raises the runtime's own urgent alert; so does any
    // question once the task is paused (the runner no longer owns the turn).
    t.worker.askPermission();
    expect(t.runner.pauseTask(t.workspaceId)).toBe(true);
    expect(t.runner.onHookEvent(elicitation)).toBe(false);
    expect(waiting()).toHaveLength(1);
  });

  test("a permission prompt in the Worker's turn: no evaluation and no re-prompt until the turn really ends", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    const hookCalls = vi.spyOn(t.runner, "onHookEvent");
    const evaluations = () =>
      logCalls.filter((call) => call.message === "worker idle detected, starting evaluation").length;
    await elapse(5_000);
    const askedAt = Date.now();
    t.worker.askPermission();
    await elapse(5 * 60_000);

    const permission = hookCalls.mock.calls.findIndex(([event]) => event.subtype === "permission_prompt");
    expect(hookCalls.mock.results[permission].value).toBe(false); // the runtime raises the user's alert
    expect(t.live().task.state).toBe("running");
    expect(evaluations()).toBe(0);
    expect(runnerWrites(t.timeline, "worker").filter((entry) => entry.at > askedAt)).toEqual([]);

    // The user approves; the turn ends with its Stop — that is the Worker's idle.
    const answeredAt = userTypes(t.runner, t.worker, ["\r"]);
    await drive(() => runnerWrites(t.timeline, "worker").some((entry) => entry.at > answeredAt));
    expect(evaluations()).toBe(1);
  });

  test("a typed prompt stops at the next character when a dialog comes up mid-write", async () => {
    const hooks = true;
    const t = await standardTask({ hooks, workerProvider: "copilot" }); // Copilot types its prompts
    let typed = 0;
    let dialogAt = 0;
    t.worker.onRunnerText = () => {
      typed += 1;
      if (typed === 6) {
        dialogAt = Date.now();
        t.worker.askPermission();
      }
    };
    workerFinishes(t, hooks); // WORK_LOCK is still there: the checks fail, the Worker is re-prompted
    await drive(() => dialogAt > 0);
    await elapse(10_000);
    expect(runnerWrites(t.timeline, "worker").filter((entry) => entry.at > dialogAt)).toEqual([]);
    expect(t.worker.dialogOpen).toBe(true);
  });

  test("the task-ended notice's Enter is withheld when a dialog came up after its text", async () => {
    const hooks = true;
    const t = await standardTask({ hooks });
    await fs.rm(path.join(t.dir, WORK_LOCK_FILE), { force: true });
    t.judge.onTurn = () =>
      fs.writeFile(path.join(t.dir, VERDICT_FILE), JSON.stringify({ verdict: "complete", reason: "All done." }));
    let noticeAt = 0;
    t.worker.onRunnerText = (text) => {
      if (!noticeAt && text.includes("The task has ended")) {
        noticeAt = Date.now();
        t.worker.askPermission();
      }
    };
    workerFinishes(t, hooks);
    await drive(() => noticeAt > 0);
    await elapse(60_000);

    expect(runnerWrites(t.timeline, "worker").filter((entry) => entry.at >= noticeAt && entry.data === "\r")).toEqual(
      [],
    );
    expect(t.worker.dialogOpen).toBe(true);
    expect(t.timeline.some((entry) => entry.data === "dialog-answered")).toBe(false);
  });
});
