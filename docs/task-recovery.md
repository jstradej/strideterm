# Task-Agent Crash Recovery

When strIDEterm closes — whether the user quits, the window is closed, the
machine reboots, or the OS kills the process — every PTY hosting a task agent
(Worker / Judge) dies with the parent process. The persisted application state
on disk, however, still says those tasks were `running` (or `judge-evaluating`,
`evaluating`, `refreshing`). On the next startup the app must reconcile this
contradiction: state-on-disk claims work is in flight, but no process exists
to do the work.

This document describes how that reconciliation happens.

## Design principles

1. **One source of truth.** Task state already persists in
   `~/.strideterm/strideterm-state.json` under each task workspace. We do not
   keep a separate "running tasks" registry — it would only drift from the
   primary state file.

2. **Pure prompt, no provider context restore.** We never use Claude Code's
   `--continue`, Codex's resume flag, or any IDE-side session reattach. Those
   features either don't exist for our supported providers or restore the
   wrong context (the previous human dialog, not the task state). Instead, we
   spawn a fresh agent process and inject a pure-text orientation prompt that
   tells it to re-read the artifacts the previous round wrote to disk.

3. **The user decides.** A modal dialog lists every recoverable task at
   startup with three per-task choices: Resume, Restart, Skip. The default is
   Resume. There's also a "Resume all" shortcut for the common case. Users
   who never want the dialog can disable it in settings; the runtime then
   auto-resolves every candidate as Resume.

## What qualifies as a recoverable task

The startup sweep (`#reconcileOnStartup` in
`electron/backend/agent-task-runner.ts`) considers a task workspace a recovery
candidate when its persisted `task.state` is one of:

| State              | Meaning                                        |
| ------------------ | ---------------------------------------------- |
| `running`          | Worker was actively coding                     |
| `evaluating`       | Between rounds, runner about to spawn judge    |
| `judge-evaluating` | Judge was actively reviewing                   |
| `refreshing`       | Worker had just had a periodic context refresh |

The following states are **deliberately NOT recovered**:

| State       | Why we leave it alone                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `paused`    | The user paused intentionally — don't second-guess                                                        |
| `completed` | A verdict was issued; reopening should go through "Send Back" with explicit feedback, not silently re-run |
| `failed`    | Same as `completed`                                                                                       |
| `idle`      | Task workspace exists but was never started                                                               |

Every recovered task is flipped to `paused` and recorded in
`pausedFromState` so that, when the user clicks Resume, the runner knows
whether to drop back into `running` (for worker phases) or `judge-evaluating`
(for the judge phase).

## The recovery prompt

`buildRecoveryPrompt` in `electron/backend/agent-task-prompts.ts` produces the
text that's injected into the freshly-spawned agent on its first idle. It
tells the agent:

- The app restarted during round N
- Their role (Worker or Judge)
- To check the task directory on disk (`TASK.md` for the user brief,
  `WORKER.md` for operational rules + verification, `TODO.md`,
  `HANDOFF.md`, `WORK_LOCK`, possibly `verdict.json`)
- Not to overwrite an already-complete `HANDOFF.md`
- Not to revert / rebase / force-push existing commits — they represent real
  work
- To watch out for side-effects that may already have happened (PRs created,
  external APIs called) before redoing anything
- Then continue the round

Because every artifact the agent needs is on disk, a fresh agent with no
transcript memory can pick up where the previous one left off after a few
seconds of orientation.

## End-to-end flow

```
[App startup]
    |
    v
runtime.createRuntime()
    |
    +-- store.load() reads strideterm-state.json
    |
    +-- taskRunner.init()
    |       |
    |       +-- #reconcileOnStartup()
    |             |  scans state.workspaces
    |             |  for each task in active state:
    |             |    - flip to "paused", record pausedFromState
    |             |    - push onto #startupRecoveryCandidates
    |
    +-- _recoveryCandidates = taskRunner.getStartupRecoveryCandidates()
    |
    +-- if settings.recovery.showTaskRecoveryDialog === false:
    |       setImmediate(() => resolveTaskRecovery(all-as-continue))
    |
    +-- return runtime
            |
            v
    [Renderer attaches, gets initial state via getPayload()]
            |
            +-- meta.recoveryCandidates is non-empty
            +-- and settings.recovery.showTaskRecoveryDialog !== false
            |
            v
    [src/stores/app.ts] opens TaskRecoveryDialog
            |
            v
    [User clicks Confirm / Resume all / Skip all]
            |
            v
    api.resolveTaskRecovery({ decisions })
            |
            v
[runtime.resolveTaskRecovery]
    for each candidate:
      - "skip"     → no-op (task stays paused)
      - "fresh"    → taskRunner.resetTask()  (clear rounds, recreate WORK_LOCK)
      - "continue" → buildRecoveryPrompt({role, round, taskId})
                   → store.mutate: task.showerResumePrompt = recoveryPrompt
                                   task.promptSent = false
                   → sessions.ensureSession(workerSessionId)  (spawn PTY)
                   → sessions.ensureSession(judgeSessionId)   (spawn PTY)
                   → taskRunner.resumeTask()  (set state, drive idle hook)

    _recoveryCandidates = []   (idempotency: no double-spawn)
    broadcastState()
            |
            v
[Worker / Judge agent emits first idle]
            |
            v
[onAgentIdle in agent-task-runner.ts]
    sees task.showerResumePrompt is set
    injects it into the session
    clears showerResumePrompt
    task continues normally
```

## Reusing `showerResumePrompt`

The recovery flow stores the orientation prompt on the task's
`showerResumePrompt` field, which was originally added for the periodic
"context refresh" feature ("shower"). Both flows want the same thing — replace
the next idle's prompt with our own text — so reusing the field avoids a
parallel implementation. A `promptSent = false` flag triggers the injection
path in `onAgentIdle`.

## Auto-resolve when the dialog is suppressed

Settings expose `settings.recovery.showTaskRecoveryDialog` (defaults `true`).
When the user sets it to `false`, the renderer never opens the dialog. To
prevent tasks from getting silently stranded in `paused`, the runtime detects
this case at the end of `createRuntime` and schedules
`resolveTaskRecovery(allContinue)` via `setImmediate`. The deferred call
fires on the next tick, after `createRuntime` has returned and the runtime is
fully usable.

This path is not the recommended UX — most users want a chance to skip a task
they don't actually want to resume — but it's there as a safety net.

## What this implementation deliberately does NOT do

- **Snapshot files.** Earlier iterations wrote per-task `recovery.json`
  snapshots into `~/.strideterm/tasks/{taskId}/`. Since the persisted
  `AppState` is already the source of truth, those snapshots only duplicated
  information and added desync risk. They were removed.
- **Provider context restore.** We never call provider-specific resume flags.
  See "Pure prompt" above.
- **Profile filtering.** The recovery dialog shows tasks from every profile,
  not just the active one. Task agents in inactive profiles are background
  workers; their existence shouldn't be invisible to the user.
- **Auto-resume completed/failed tasks.** Those have terminal verdicts. The
  user can reopen them via "Send Back" with explicit feedback — that's a
  conscious decision, not a recovery.

## Source map

| File                                                                   | Role                                 |
| ---------------------------------------------------------------------- | ------------------------------------ |
| `electron/backend/agent-task-runner.ts` `#reconcileOnStartup`          | Startup sweep                        |
| `electron/backend/agent-task-runner.ts` `getStartupRecoveryCandidates` | Hand list to runtime                 |
| `electron/backend/agent-task-prompts.ts` `buildRecoveryPrompt`         | Pure-text orientation prompt         |
| `electron/backend/runtime.ts` `resolveTaskRecovery`                    | Apply user decisions                 |
| `electron/backend/runtime.ts` (end of `createRuntime`)                 | Auto-resolve when dialog is disabled |
| `src/components/dialogs/TaskRecoveryDialog.vue`                        | User-facing dialog                   |
| `src/stores/app.ts` `recoveryCandidates`, `resolveTaskRecovery`        | Renderer state + IPC plumbing        |
| `electron/shared/types/state.ts` `RecoveryCandidate`                   | Shared payload shape                 |
