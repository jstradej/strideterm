# Agent Task Runner

The Agent Task Runner is a supervised coding loop: a **Worker** agent does the task, an independent **Judge** agent decides whether it is done. Both are driven through editable control files (`TASK.md` for your brief, `WORKER.md` for operational rules, `JUDGE_PROMPT.md` for evaluation instructions).

Worker and Judge each run one of the supported CLIs — **Claude Code**, **Codex CLI**, **Gemini CLI**, **GitHub Copilot**, or **OpenCode** — chosen independently per role, so providers can be mixed (e.g. Claude Code as Worker, OpenCode as Judge).

## Quick Start

1. Click the **+** button in the sidebar and select **Create task workspace**
2. Choose your **project directory** (must contain the code you want to modify)
3. _(Optional)_ Check **Create in git worktree** to isolate the task on its own branch
4. Pick the **Worker** and **Judge** agents — provider + model. Providers not found on PATH are disabled.
5. Write a **task assignment** describing what needs to be done
6. Click **Create workspace** — control files are generated automatically
7. Press **Start** in the Dashboard to begin

## How It Works

```
You write a task brief (TASK.md)
    |
    v
[Worker] reads TASK.md + WORKER.md, executes the task, commits changes
    |     (runs the verification steps before finishing)
    |
    v  (worker goes idle)
[Built-in checks] WORK_LOCK absent? TODO clear?
    |
    |-- FAIL --> re-prompt Worker with failure details
    |
    v  PASS
[Judge] independently reviews git diff + TASK.md + WORKER.md + JUDGE_PROMPT.md
    |
    |-- "continue" --> re-prompt Worker with feedback
    |
    v  "complete"
Done! You get notified.
```

The loop repeats until the Judge approves the work or the maximum number of rounds is reached. The Judge is only asked once the Worker itself claims to be done (no `WORK_LOCK`, nothing left "In Progress").

## Provider Selection

**Picker mode (default)** — pick a provider and model, plus a per-role **Skip permission prompts (dangerous)** checkbox. It is on by default for Claude, Codex, Copilot and OpenCode, off for Gemini. The checkbox adds:

| Provider       | Skip ON flag                                                       |
| -------------- | ------------------------------------------------------------------ |
| Claude Code    | `--dangerously-skip-permissions`                                   |
| Codex CLI      | `--dangerously-bypass-approvals-and-sandbox -s danger-full-access` |
| Gemini CLI     | `--yolo`                                                           |
| GitHub Copilot | `--allow-all-tools` (plus `COPILOT_ALLOW_ALL=true` in env)         |
| OpenCode       | `--yolo`                                                           |

**Advanced: custom command** — a full CLI command string; switching to it prefills the field from the picker. Choose **Default** as the model to let the CLI pick its own.

**Idle detection.** The runner needs to know when an agent has finished its turn. Enable the agent notification hook for each provider in **Settings → General** — it is instant and reliable. Without it the runner falls back to a silence heuristic, which adds a delay per handoff and can misfire during long turns.

## Writing Good Task Descriptions

The Worker and the Judge both read TASK.md. Make it specific and verifiable:

```
Add pagination to the /api/users endpoint. Return 25 items per page
with ?page=N query parameter. Include totalPages and currentPage in
the response envelope. Add integration tests covering page 1, last
page, and out-of-range page numbers. When done, run `npm test` and
`npm run lint` — both must pass.
```

- Concrete deliverables, not "improve" or "clean up"
- Name files and paths when you know them
- Put the verification commands in the brief — they are not auto-detected
- Length is not a problem: the Worker reads the brief from a file, so a full spec can go in
- One task per workspace — unrelated goals need separate verification criteria

## Control Files

All task state lives in `.strideterm/tasks/<taskId>/` inside your project directory, which is added to `.gitignore` automatically.

| File                | Purpose                                                              | Who writes it                                 | In Assignment tab |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------------- | ----------------- |
| **TASK.md**         | The task brief — what you want built                                 | Auto-generated, you can edit                  | Yes ("Task")      |
| **WORKER.md**       | Operational rules + a generic "Verification before completion" block | Auto-generated, you can edit                  | Yes ("Worker")    |
| **JUDGE_PROMPT.md** | Judge evaluation instructions                                        | Auto-generated, you can edit                  | Yes ("Judge")     |
| **TODO.md**         | Kanban board (To Do / In Progress / Done)                            | Worker maintains                              | No                |
| **WORK_LOCK**       | Signal file: "work remains"                                          | Worker deletes when done                      | No                |
| **JUDGE_TODO.md**   | Judge's evaluation scratchpad                                        | Judge only                                    | No                |
| **verdict.json**    | Judge's completion verdict                                           | Judge only                                    | No                |
| **HANDOFF.md**      | Summary so the next worker session can pick up where this one left   | Worker writes on completion / context refresh | No                |

The brief is editable at any time, including while the task runs. The agent-managed files are not shown in the UI; open the directory if you need to inspect them.

### Verification

WORKER.md carries a deliberately **stack-agnostic** verification block: check the project's own documentation (README, CLAUDE.md, AGENTS.md) for what counts as a healthy state and run those checks; steps listed in TASK.md take precedence; with no automated checks, review every changed file by hand.

So the rule is: **concrete commands go in your brief.** The Worker runs them before claiming completion, and the Judge re-runs them.

Verification has two layers:

1. **Worker self-verification** — the checks from the brief and WORKER.md, before finishing.
2. **Judge evaluation** — re-runs the verification, checks every requirement in TASK.md against the git diff, and reviews the changed code for bugs, edge cases and leftovers. Issues send the Worker back with specific feedback.

### Customizing the Judge

JUDGE_PROMPT.md (the **Judge** sub-tab in Assignment) defines how strict the evaluation is. You can change it before or during a run, for example:

```markdown
# Judge Instructions

... (keep the default requirements check) ...

## Additional rules

- All API responses must follow our envelope format: { data, meta, errors }
- Database queries must use parameterized statements
- Reject any console.log or debug leftovers
```

The Judge always receives the task description, the built-in check results and the git context, whatever this file says.

## Git Integration

- **Auto-init**: a project without a repo gets `git init` and an initial commit as the diff baseline
- **Judge sees the changes**: each evaluation includes `git status` and the diff summary
- **Worker commits**: the rules tell the Worker to commit regularly — that is how the Judge sees what changed
- **Never pushes**: the Task Runner never pushes to any remote. All work stays local

## Git Worktree Mode

With **Create in git worktree**, the task runs in its own worktree at `<repo>/.strideterm/tree/<branch-name>` on a new branch (generated from the description, or typed by you). Control files, commits and changes all stay in the worktree.

Use it to run several tasks on one repository in parallel, to keep your own checkout untouched while the agent works, and to get the result as a separate branch you can review, merge or discard.

Deleting a worktree task workspace asks whether to remove the worktree from disk too.

## Dashboard and Controls

The Dashboard is the first tab of a task workspace:

- **Status** — the pipeline (Worker → Checks → Judge → Done) and the history of rounds with each check's result
- **Assignment** — editors for TASK.md, WORKER.md and JUDGE_PROMPT.md
- **Config** — description, max rounds, selected providers
- **Log** — the full event log (`TASK_LOG.jsonl`), with copy/save
- **Help** — quick reference

| Button       | When visible                    | Action                                                    |
| ------------ | ------------------------------- | --------------------------------------------------------- |
| **Start**    | Task is idle                    | Begin execution, send prompt to Worker                    |
| **Pause**    | Task is running/evaluating      | Pause the task                                            |
| **Continue** | Task is paused/completed/failed | Resume from current state                                 |
| **Reset**    | Task is paused/completed/failed | Clear round history, keep files, return to idle for retry |

You can type into the Worker or Judge terminal at any time; typing during an evaluation cycle pauses the task so the two do not collide.

## Shower Mode (Context Refresh)

Long tasks degrade an agent's context. Every N rounds (default 5) the Worker writes HANDOFF.md, its session is restarted fresh, and the new session gets the handoff, the task context and the Judge's last feedback. It shows up as a "shower" entry in the round history.

## Reset & Retry

**Reset** clears the round history and returns the task to idle, but keeps every control file and the Judge's last feedback. Refine the brief, the Worker rules or the Judge instructions in Assignment and press **Start** again — one workspace can be re-run as often as needed.

If the app closes mid-task, the next start offers to resume the interrupted tasks — see [task-recovery.md](./task-recovery.md).

## Companion Loop (Attach to an Existing Conversation)

The Companion loop attaches an independent AI evaluator to a **live, already-running** agent conversation (Claude Code, Codex, Gemini, Copilot or OpenCode) without restarting or cloning it. It reuses the task runner in an "attached" mode.

The conversation you attach to is the **Primary**. It keeps its session, command and permissions; the Companion never sends it `/clear`, never restarts it, and itself only reads.

### Starting a Companion loop

1. Right-click the tab of a running agent panel and choose **Add companion agent…**
2. Pick a role, a provider/model for the Companion and optionally a focus note
3. The Primary writes `CONTEXT.md` and `HANDOFF.md` from its own context — nothing in your project is touched
4. The baseline evaluation then starts on its own. Untick **Start the loop as soon as the brief is ready** to stop at **Brief ready** and review the captured brief first

The task also gets a `WORKER.md` with ground rules for the Primary for the whole loop (never restart or `/clear` itself, record verification evidence before removing WORK_LOCK, keep TODO.md and HANDOFF.md current).

### Where the Primary tab lives

While the loop runs, the Primary tab is **shown** inside the companion task workspace (`Dashboard | Primary | <Role>`). This is presentation only: the conversation, its PTY, session id, hooks and cwd stay in the source workspace, and the tab returns to its original slot. It goes home when the loop is **completed** or **failed** and comes back on **Send back**, **Continue** or **Reset**.

### Roles

Each role has a different blocking policy, not just a different persona:

| Role           | What it checks                                                                   | What can block completion                                                                                                    |
| -------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Reviewer**   | Requirements vs. git diff, code quality, scope creep                             | Missing/incorrect requirements                                                                                               |
| **Critic**     | Steelmans the approach first, then tries to disprove it                          | Confirmed flaws only — speculative concerns are advisory                                                                     |
| **Consultant** | Whether the chosen direction is the best safe next step for the goal/constraints | The approach can't meet the goal, an unresolved decision blocks progress, or a major ignored trade-off contradicts the brief |
| **Planner**    | Coverage/completeness of a plan document, assumptions, open questions            | Never asks you a question — resolves ambiguity with a documented working default                                             |

Reviewer, Critic and Consultant can stop in **Awaiting user** with a question; Planner always reaches `complete`.

### States unique to attached mode

| State                        | Meaning                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Capturing context**        | Waiting for the Primary to write CONTEXT.md/HANDOFF.md                                                                  |
| **Brief ready**              | The captured brief waits for your review (skipped with auto-start)                                                      |
| **Awaiting user**            | The Companion asked a question it couldn't resolve. Your answer must cover every question of that round                 |
| **Paused: policy violation** | The Companion hit a permission prompt — it tried something outside its inspect-only scope, so the runner paused it      |
| **Primary no longer exists** | The Primary's workspace or tab is gone. Terminal: only **Delete task** remains, because nothing re-attaches a lost chat |

The Status tab always says who the loop is waiting on, what is happening, why, and what comes next, over a four-phase pipeline (Capture → Primary → Verification → _role_).

### Invariants

- **Verification is a hard gate.** Only the Worker-owned `VERIFICATION.md` counts as evidence; the Companion never runs your build/test/lint itself.
- **A verdict counts only for the evaluation it answers.** Every request carries an `evaluationAttempt` that `verdict.json` must echo; a verdict from an older attempt is stale and is never processed.
- **No sign-off without fresh evidence.** Every role except Planner can reach `complete` only against a `VERIFICATION.md` for the current round that the runner itself read as fresh. Otherwise the review is kept, the sign-off is withheld and the Primary is asked to record the evidence — no round is consumed.
- **Send back** re-opens a round like a Companion `continue`; if the feedback cannot be delivered, nothing is consumed.

### Isolation level

The Companion always starts without any permission-bypass flag, and a custom command override is refused for it. How much more is enforced depends on the provider and is shown in the create dialog and the Config tab:

- **Enforced** — the provider has a verified read-only/execution-disabled mode
- **Permission-gated** — the provider's own approval prompt gates writes; the app pauses the task instead of approving
- **Prompt-enforced** — only the prompt contract restrains it, not a technical boundary

### Guards

- The Primary's workspace or tab cannot be deleted or closed while it is shown in the Companion task workspace (every state except **completed** and **failed**). Finish or delete the companion task first.
- Deleting the Companion task workspace never touches the Primary session — the tab returns home.
- A source session can have at most one active Companion at a time.

---

Implementation: `electron/backend/agent-task-runner.ts` (loop, state machine, prompts via `agent-task-prompts.ts`).
