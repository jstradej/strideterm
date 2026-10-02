# Task-Agent Crash Recovery

When strIDEterm closes — the user quits, the window closes, the machine reboots, or the OS kills the
process — every PTY hosting a task agent (Worker / Judge) dies with it. The persisted state still says
those tasks were in flight. On the next start the app reconciles that contradiction.

## Design principles

1. **One source of truth.** Task state already lives in the persisted app state
   (`strideterm-state.json`). There is no separate "running tasks" registry to drift from it.
2. **Pure prompt, no provider context restore.** No `--continue`, resume flag or session reattach —
   those either do not exist for every provider or restore the wrong context (the previous human
   dialog, not the task). A fresh agent is spawned and told, in plain text, to re-read the artifacts
   the previous round left on disk.
3. **The user decides.** A dialog at startup lists every recoverable task.

## What is recovered

| State              | Meaning                                        |
| ------------------ | ---------------------------------------------- |
| `running`          | Worker was actively coding                     |
| `evaluating`       | Between rounds, runner about to spawn judge    |
| `judge-evaluating` | Judge was actively reviewing                   |
| `refreshing`       | Worker had just had a periodic context refresh |

Deliberately **not** recovered:

| State       | Why                                                                             |
| ----------- | ------------------------------------------------------------------------------- |
| `paused`    | The user paused intentionally                                                   |
| `completed` | A verdict was issued; reopening goes through "Send Back" with explicit feedback |
| `failed`    | Same as `completed`                                                             |
| `idle`      | Never started                                                                   |

Every recovered task is first flipped to `paused`, remembering which phase it was in, so nothing runs
until the user chooses.

## The choices

- **Resume** (default) — spawn fresh Worker/Judge sessions and send an orientation prompt: the app
  restarted during round N, this is your role, re-read `TASK.md`, `WORKER.md`, `TODO.md`,
  `HANDOFF.md`, `WORK_LOCK` (and `verdict.json` if present), do not overwrite a complete
  `HANDOFF.md`, do not revert or force-push existing commits, check for side effects that may already
  have happened (PRs, external calls), then continue the round.
- **Restart** — reset the task (round history cleared, files kept) and leave it ready to start again.
- **Skip** — leave it paused with everything on disk, to inspect or resume later from the Dashboard.

**Resume all** and **Skip all** apply one choice to every remaining task.

## Without the dialog

`settings.recovery.showTaskRecoveryDialog` (default `true`) can turn the dialog off. Then every
candidate is resolved as **Resume** automatically, so tasks are never silently stranded in `paused`.

## Deliberately not done

- **Snapshot files** — the persisted state is the source of truth; a second copy only adds desync risk.
- **Provider context restore** — see "Pure prompt" above.
- **Profile filtering** — the dialog shows tasks from every profile. Agents in an inactive profile are
  background workers, and their existence must not be invisible.
- **Auto-resume of completed/failed tasks** — they have a verdict; reopening one is a conscious
  decision ("Send Back"), not a recovery.

Implementation: `electron/backend/agent-task-runner.ts` (startup sweep),
`agent-task-prompts.ts` (`buildRecoveryPrompt`), `runtime.ts` (`resolveTaskRecovery`) and
`src/components/dialogs/TaskRecoveryDialog.vue`.
