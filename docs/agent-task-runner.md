# Agent Task Runner

The Agent Task Runner is a supervised coding loop that coordinates two AI agents (Worker + Judge) to complete coding tasks autonomously. It generates editable control files (`TASK.md` for your brief, `WORKER.md` for operational rules and a generic verification block, `JUDGE_PROMPT.md` for evaluation instructions) and uses an independent judge to evaluate completion.

Worker and Judge each run one of the supported CLIs — **Claude Code**, **Codex CLI**, **Gemini CLI**, **GitHub Copilot**, or **OpenCode** — selected independently per role. You can mix providers (e.g. Claude Code as Worker + OpenCode as Judge) to take advantage of each model's strengths.

## Quick Start

1. Click the **+** button in the sidebar and select **Create task workspace**
2. Choose your **project directory** (must contain the code you want to modify)
3. _(Optional)_ Check **Create in git worktree** to isolate the task on its own branch
4. Pick the **Worker** and **Judge** agents — provider (Claude Code / Codex CLI / Gemini CLI / GitHub Copilot / OpenCode) + model. Unavailable providers (not on PATH) are disabled.
5. Write a **task assignment** describing what needs to be done
6. Click **Create workspace** — control files are generated automatically
7. Press **Start** in the Dashboard to begin

The Worker will start executing the task. When it goes idle, the Task Runner automatically runs built-in checks and, if they pass, asks the Judge to independently evaluate the work.

## How It Works

```
You write a task brief (TASK.md)
    |
    v
[Worker] reads TASK.md + WORKER.md, executes the task, commits changes
    |     (runs the verification steps from WORKER.md before finishing)
    |
    v  (worker goes idle)
[Built-in checks] WORK_LOCK absent? TODO clear?
    |
    |-- FAIL --> re-prompt Worker with failure details
    |
    v  PASS
[Judge] independently reviews git diff + TASK.md + WORKER.md verification + JUDGE_PROMPT.md
    |
    |-- "continue" --> re-prompt Worker with feedback
    |
    v  "complete"
Done! You get notified.
```

The loop repeats until the Judge approves the work or the maximum number of rounds is reached.

## Provider Selection

Each task workspace configures Worker and Judge independently. Two modes:

**Picker mode (default)** — pick a provider and model from dropdowns, plus a per-role **Skip permission prompts (dangerous)** checkbox. Defaults per provider: Claude, Codex, Copilot, and OpenCode skip on, Gemini skip off. The checkbox controls CLI flags:

| Provider       | Skip ON flag                                                       |
| -------------- | ------------------------------------------------------------------ |
| Claude Code    | `--dangerously-skip-permissions`                                   |
| Codex CLI      | `--dangerously-bypass-approvals-and-sandbox -s danger-full-access` |
| Gemini CLI     | `--yolo`                                                           |
| GitHub Copilot | `--allow-all-tools` (plus `COPILOT_ALLOW_ALL=true` in env)         |
| OpenCode       | `--yolo`                                                           |

**Advanced: custom command** — full CLI command string, e.g. `codex --model o3 --approval-mode auto`. Toggling to advanced prefills the field from the picker state so you can tweak rather than start blank.

Choose **Default** as the model to let the CLI use its own default without passing a `--model` flag.

### Idle detection per provider

Each CLI signals end-of-turn differently. An event-driven notification is the primary signal for all five — a hook for four of them, a native plugin for OpenCode — instant, reliable, and independent of the agent emitting any particular terminal sequence between turns. Without it configured, the Task Runner falls back to a silence-based heuristic.

| Provider       | Primary signal (with hooks)                        | Fallback (no hooks)         |
| -------------- | -------------------------------------------------- | --------------------------- |
| Claude Code    | Notification / Stop / SubagentStop hooks (instant) | OSC 133 + silence heuristic |
| Codex CLI      | Stop / UserPromptSubmit hooks (instant)            | Silence timer (8 s)         |
| Gemini CLI     | AfterAgent / Notification hooks (instant)          | Silence timer (8 s)         |
| GitHub Copilot | sessionEnd / userPromptSubmitted hooks (instant)   | Silence timer (8 s)         |
| OpenCode       | session.idle / chat.message plugin (instant)       | Silence timer (8 s)         |

Enable hooks for all five providers in **Settings → General** (under _Agent notification hook_) — one click each. Without hooks the silence heuristic still works but introduces an 8-second delay per handoff (and longer if the CLI reasons for a while), and is more prone to false positives during long turns. OSC 133 shell integration only fires when a _shell_ returns to its prompt, so for interactive agent sessions (which never return to a prompt between turns) it's effectively silent — hooks are what carries the signal.

Codex hooks require **Codex CLI 0.121.0+** on Windows — older Windows builds ship with hooks gated off. Current Codex builds use `[features] hooks = true`; older `codex_hooks = true` configs are legacy and may produce a deprecation warning. After strIDEterm writes Codex hooks, Codex can still require a one-time `/hooks` review before those commands are allowed to run. Copilot hooks require **GitHub Copilot CLI 1.0.32+** and honor `COPILOT_HOME` for config-path overrides; if `disableAllHooks: true` is set in `~/.copilot/config.json`, strIDEterm surfaces a distinct _"Configured — hooks disabled"_ state in Settings. OpenCode is wired up differently: its config schema has no `hooks` key and OpenCode refuses to start when one is present, so strIDEterm installs a native OpenCode plugin instead — `~/.config/opencode/plugins/strideterm-notify.js`, the same path on Windows (OpenCode resolves its config dir XDG-style everywhere; `XDG_CONFIG_HOME` is honored, `OPENCODE_HOME` is not read at all). Restart any running `opencode` after configuring so it picks the plugin up. If an older strIDEterm had written the rejected `hooks` block into your OpenCode config, startup strips it and — because writing it meant you had opted in — installs the plugin in its place, so the integration keeps working instead of quietly disappearing.

## Writing Good Task Descriptions

A good task description is specific, measurable, and includes acceptance criteria. The Worker and Judge both read TASK.md to understand what needs to be done.

**Good examples:**

```
Add pagination to the /api/users endpoint. Return 25 items per page
with ?page=N query parameter. Include totalPages and currentPage in
the response envelope. Add integration tests covering page 1, last
page, and out-of-range page numbers.
```

```
Refactor the notification system to use a pub/sub pattern instead of
direct function calls. Extract a NotificationBus class in
src/lib/notification-bus.ts. Migrate all 3 existing notification
callers (auth, orders, comments) to use the bus. Keep backward
compatibility — existing tests must still pass.
```

```
Fix the memory leak in the WebSocket connection handler. Connections
are not being cleaned up on disconnect — the connectionMap grows
indefinitely. Add a cleanup interval and write a test that verifies
connections are removed after disconnect.
```

**What makes these work:**

- Concrete deliverables (not vague "improve" or "clean up")
- Mention specific files/paths when known
- Include testing expectations
- Define "done" clearly so the Judge can verify

**Tips for task descriptions:**

- Detailed specifications are welcome — the Worker reads TASK.md from a file, so length is not a problem. You can paste full design docs, API specs, or requirement documents into TASK.md
- Shower mode (context refresh) ensures the Worker stays effective even on long tasks that span many rounds
- If you have an external specification, paste it directly into the task description or into the Task brief in the Assignment tab

**Anti-patterns to avoid:**

- "Make the code better" (too vague — the Judge needs concrete criteria to verify completion)
- Multiple unrelated tasks in one (split them into separate workspaces — each task should have its own verification criteria)

## Control Files

All task state lives in `.strideterm/tasks/<taskId>/` inside your project directory. These files are auto-gitignored.

| File                | Purpose                                                                                     | Who writes it                                 | In Assignment tab |
| ------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------- |
| **TASK.md**         | The task brief — what you want built. Just header + description.                            | Auto-generated, you can edit                  | Yes ("Task")      |
| **WORKER.md**       | Operational rules + generic "Verification before completion" block for the Worker           | Auto-generated, you can edit                  | Yes ("Worker")    |
| **JUDGE_PROMPT.md** | Customizable Judge evaluation instructions                                                  | Auto-generated, you can edit                  | Yes ("Judge")     |
| **TODO.md**         | Kanban board (To Do / In Progress / Done)                                                   | Worker maintains                              | No                |
| **WORK_LOCK**       | Signal file: "work remains"                                                                 | Worker deletes when done                      | No                |
| **JUDGE_TODO.md**   | Judge's evaluation scratchpad                                                               | Judge only                                    | No                |
| **verdict.json**    | Judge's completion verdict                                                                  | Judge only                                    | No                |
| **HANDOFF.md**      | End-of-run or shower-mode summary so the next worker session can pick up where you left off | Worker writes on completion / context refresh | No                |

### Editing Control Files

The **Assignment** tab in the Dashboard exposes the three files you actually write — the **Task** brief (TASK.md), the **Worker** operational rules (WORKER.md), and the **Judge** instructions (JUDGE_PROMPT.md). The brief is always editable, even while the task is running. The other files are managed by the agents and aren't shown in the UI to keep editing focused on inputs. If you need to inspect or hand-edit them (rare — typically only after a Reset), open `.strideterm/tasks/<taskId>/` directly in your file system.

Common edits:

- **Task** brief — refine what you want built. Concrete verification commands (e.g. `npm test`, `pytest -x`) live here, not in WORKER.md.
- **Worker** rules — tweak the generic verification prose if your project has a non-standard healthy-state definition (rarely needed)
- **Judge** instructions — see "Customizing the Judge" below

### Verification

When you create a task workspace, the Task Runner writes a generic **"Verification before completion"** block into WORKER.md. It is **deliberately not stack-specific** — earlier versions tried to auto-detect `npm test` / `cargo test` / `pytest` from manifests, but the heuristic produced wrong commands on polyglot or non-standard repos and ran tools the user didn't actually want. The current block reads:

```markdown
## Verification before completion

> Before finishing, check the project's own documentation (README,
> agent guide such as CLAUDE.md or AGENTS.md) for what counts as a
> healthy state, and run those checks. If the user's brief in
> TASK.md above lists concrete steps, those take precedence.
> If the project has no automated check setup, do a careful manual
> review of every file you changed.
```

**The intended workflow:**

- Put concrete verification commands directly in your TASK.md brief (e.g. "When done, run `npm test`, `npm run lint`, and `npx tsc --noEmit` — all must pass").
- The Worker will see them in the brief, run them before claiming completion, and the Judge will independently re-run them.
- Leave WORKER.md's generic prose alone unless your project has a non-standard healthy-state definition the Worker needs spelled out.

### Two layers of verification

1. **Worker self-verification** — the Worker reads the brief in TASK.md (concrete commands, if any) and the generic block in WORKER.md, then runs the checks before finishing. This is the first line of defense.

2. **Judge evaluation** (AI-based) — the Judge independently:
   - **Re-runs the verification steps** the Worker followed, to confirm the Worker's claims
   - **Requirements check**: reads TASK.md and verifies every requirement point by point against the actual code changes (git diff)
   - **Code review**: reads the changed files and checks for bugs, edge cases, dead code, debug leftovers, and consistency with existing codebase style

If the Judge finds issues, it sends the Worker back with specific feedback. The cycle repeats until the Judge is satisfied.

### Customizing the Judge

The Judge's evaluation behavior is defined in **JUDGE_PROMPT.md** (the **Judge** sub-tab in the Assignment tab). By default it runs the verification checklist, does a requirements check (point by point), and a code review (bugs, edge cases, quality). You can customize this before or during task execution.

**Examples of customization:**

Make the Judge stricter about code quality:

```markdown
# Judge Instructions

... (keep the default requirements check) ...

## Additional code quality rules

- Every new public function must have JSDoc
- No function longer than 50 lines
- All error paths must be tested
- Reject any console.log or debug leftovers
```

Add domain-specific evaluation:

```markdown
# Judge Instructions

... (keep the default) ...

## Domain rules

- All API responses must follow our envelope format: { data, meta, errors }
- Database queries must use parameterized statements (no string concatenation)
- New React components must have Storybook stories
```

Skip code review entirely (faster, less strict):

```markdown
# Judge Instructions

1. Read the task description in TASK.md
2. Run the verification checklist commands
3. Verify each requirement is implemented
4. Write verdict to verdict.json
   Do not review code quality — only check if requirements are met.
```

The Judge always receives task description, built-in check results, and git context regardless of what you write in JUDGE_PROMPT.md.

## Git Integration

The Task Runner integrates with git to give the Judge visibility into actual code changes:

- **Auto-init**: If your project doesn't have a git repo, the Task Runner runs `git init` and creates an initial commit as a baseline for diffs
- **Judge sees git context**: Before each judge evaluation, the runner gathers `git status`, `git diff --stat`, and `git diff --name-only` and includes them in the judge prompt
- **Worker should commit**: The task rules instruct the Worker to commit regularly with clear messages — this is how the Judge verifies what code actually changed
- **Never pushes**: The Task Runner never pushes to any remote. All work stays local

## Git Worktree Mode

When creating a task workspace, you can check **Create in git worktree** to run the task agent in an isolated git worktree instead of the main working directory.

### How it works

1. You provide the **base repository** path (the project root with a `.git` directory)
2. A **branch name** is auto-generated from the task description (e.g. `task/add-pagination`) or you can type your own
3. The Task Runner creates a git worktree at `<repo>/.strideterm/tree/<branch-name>` using `git worktree add`
4. The task workspace's working directory points to the worktree, not the base repo
5. All control files, commits, and changes happen inside the worktree

### When to use worktree mode

- **Parallel tasks**: Run multiple task agents on the same repository simultaneously. Each agent gets its own worktree with its own branch — no file conflicts, no merge headaches during execution.
- **Keep your checkout clean**: Your main working directory stays untouched while the agent works. You can continue editing files in the base repo without affecting the task.
- **Easy review**: When the task completes, the work is on a separate branch. Review the diff, merge it, or discard it.

### Example workflow

```
1. Create task workspace with worktree mode:
   - Base repository: /home/user/my-project
   - Branch name: task/add-pagination  (auto-generated)
   → Agent works in /home/user/my-project/.strideterm/tree/task-add-pagination

2. While the first task is running, create another:
   - Base repository: /home/user/my-project
   - Branch name: task/fix-auth-bug
   → Agent works in /home/user/my-project/.strideterm/tree/task-fix-auth-bug

3. Both agents run in parallel on separate branches.

4. When done, merge the branches into your main branch.
```

### Cleanup

When you delete a worktree task workspace, you'll be prompted whether to also delete the worktree files from disk. If you choose yes, the Task Runner runs `git worktree remove` to cleanly detach the worktree.

The `.strideterm/` directory is auto-added to `.gitignore`, so worktree directories won't appear in git status of the base repo.

## Dashboard

The Dashboard is the first tab in a task workspace. It has five sections:

### Status Tab

Shows the execution pipeline (Worker -> Checks -> Judge -> Done) and a history of evaluation rounds with pass/fail details for each check. Auto-selected as the active tab when a task starts running so you can watch the run from the moment you press Start.

### Assignment Tab

Editor for the three files you actually write: the **Task** brief (TASK.md), the **Worker** operational rules (WORKER.md), and the **Judge** instructions (JUDGE_PROMPT.md). The brief is always editable — including while the task is running — so you can refine requirements mid-flight without resetting. The Worker's TODO board, the Judge's audit notes, and the event log are not editable here — they're agent-managed and surfaced in Status / Log instead.

### Config Tab

Shows the task configuration (description, max rounds, selected providers) with a link that jumps you to the Task brief to edit it.

### Log Tab

Full event log of every round (TASK_LOG.jsonl rendered as a table). Includes copy/save buttons for sharing.

### Help Tab

Quick reference with examples and tips.

## Controls

| Button       | When visible                    | Action                                                    |
| ------------ | ------------------------------- | --------------------------------------------------------- |
| **Start**    | Task is idle                    | Begin execution, send prompt to Worker                    |
| **Pause**    | Task is running/evaluating      | Pause the task                                            |
| **Continue** | Task is paused/completed/failed | Resume from current state                                 |
| **Reset**    | Task is paused/completed/failed | Clear round history, keep files, return to idle for retry |

You can type into the Worker or Judge terminal at any time. If you type during an evaluation cycle, the Task Runner automatically pauses to avoid conflicts.

## Shower Mode (Context Refresh)

Long-running tasks can degrade the Worker's context quality. Shower mode automatically refreshes the Worker session every N rounds (default: 5):

1. The Worker is asked to write a handoff summary (HANDOFF.md)
2. The Worker session is killed and restarted fresh
3. The new session receives the handoff summary + task context + last Judge feedback
4. Work continues from where it left off

This is transparent — you'll see a "shower" action in the round history. The Judge's feedback survives the refresh.

## Reset & Retry

After stopping, completing, or failing a task, you'll see **Continue** and **Reset** buttons. Continue picks up where you left off. Reset clears all round history and returns the task to idle — but preserves every control file on disk. This lets you iterate on the same workspace:

1. Press **Pause** to pause the task (or wait for it to complete/fail)
2. Press **Reset** — clears rounds, returns to idle
3. Switch to the **Assignment** tab and refine your inputs:
   - **Task** — change the assignment, update verification commands in the brief, or refine the description
   - **Worker** — adjust the generic verification block (rarely needed)
   - **Judge** — adjust how strictly the work should be evaluated
4. Press **Start** to run the task again with your updated inputs

Reset also clears any cached agent context so the next run starts fresh. The Worker and Judge terminals stay open — only the round state is cleared. The Judge's last feedback (`lastJudgeInstructions`) is also preserved, so if you resume without editing files the next run benefits from prior context.

This makes the task workspace reusable: create it once, then reset and re-run as many times as you need with different task descriptions or criteria.

## Tips

- **Start small**: Test with a well-defined task on a project with good tests before attempting large refactors
- **Customize the Judge**: If you have stricter standards (extra code-review rules, domain-specific checks), edit the Judge instructions in the Assignment tab before pressing Start
- **Watch the first round**: Monitor the Worker's approach in round 1 and Pause if it's going in the wrong direction
- **Use the terminal**: You can always type directly into the Worker or Judge terminal for course correction
- **Put verification commands in your brief**: the Task Runner does not auto-detect them. If you want `npm test` / `cargo test` / `pytest -x` to run before completion, write them into TASK.md.

## Companion Loop (Attach to an Existing Conversation)

The Companion loop attaches an independent AI evaluator to a **live, already-in-progress** agent conversation — Claude Code, Codex, Gemini, Copilot, or OpenCode — without restarting it, cloning it, or scraping its terminal scrollback. It reuses the same Worker+Judge task-runner infrastructure described above, in an "attached" mode.

The conversation you attach to is called the **Primary**. It stays exactly as it was: same session, same command, same permissions. The Companion never sends it `/clear`, never restarts it, and is never itself allowed to run with permission-bypass/yolo flags — it only reads.

### Starting a Companion loop

1. Right-click the tab of a running agent panel and choose **Add companion agent…**
2. Pick a role (see below), a provider/model for the Companion, and optionally a focus note
3. The Primary is asked to write `CONTEXT.md` and `HANDOFF.md` from its own context — nothing in your project is touched during this step
4. Once those are ready, review them in the **Brief ready** screen and press **Start `<Role>` loop**

The attached task workspace contains only a **Dashboard** and one **Companion** panel — there is never a second, fake "Worker" panel. While the loop is live, the Primary tab is **shown inside the task workspace** as well, so `Dashboard | Primary | <Role>` is one place instead of two (see below).

### Where the Primary tab lives

While the loop is running, the Primary is _presented_ in the companion task workspace: the tab disappears from its own workspace's tab strip and appears between the Dashboard and the Companion. The move is presentation only.

- The conversation itself does not move. The panel stays in the source workspace, the session id stays `<sourceWorkspace>:<panel>`, and the PTY, scrollback replay, hooks, notification binding, cwd and task binding are never re-keyed or restarted. Only where the tab is _drawn_ changes.
- The source workspace keeps owning it — panel order, its own active tab and its split layout are untouched, so the tab returns to exactly the slot it came from. If hiding it leaves the source workspace with nothing to show, it says "Primary is currently shown in `<task workspace>`" with a button to open the loop.
- **Completed** and **failed** are return states: the tab goes back to the source workspace and the task workspace falls back to its Dashboard. Nothing jumps you anywhere — the task workspace stays open so you can read the result.
- **Send back**, **Continue** and **Reset** put it back in the task workspace as soon as the loop leaves the terminal state. Every other state — including `paused` and `awaiting user` — keeps hosting it, because the loop is not finished.
- Desktop defaults to a three-pane `Dashboard / Primary / Companion` split, dropping back to `Dashboard | Companion` when the Primary leaves. A split you arranged yourself is never rewritten by a lifecycle change — only the unavailable pane is dropped.
- Mobile/remote shows one view at a time as usual: the picker lists `Dashboard → Primary → <Role>`, entering the workspace still opens the Dashboard first, and the composer writes to the real source session.
- The Dashboard's **Open Primary** button follows the tab: it activates the local Primary tab while the loop is live, and jumps to the source workspace once the tab has gone home.

Alongside `CONTEXT.md`/`HANDOFF.md`, the task also gets a `WORKER.md` — durable ground rules for the Primary for the whole loop (never restart/`/clear` itself, record verification evidence before removing WORK_LOCK, keep TODO.md/HANDOFF.md current). It's shown as the **Worker rules** tab in the Dashboard's Assignment view, next to **Your focus** (TASK.md) and the role customization file.

### Roles

Each role has a materially different blocking policy, not just a different persona:

| Role           | What it checks                                                                   | What can block completion                                                                                                    |
| -------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Reviewer**   | Requirements vs. git diff, code quality, scope creep                             | Missing/incorrect requirements                                                                                               |
| **Critic**     | Steelmans the approach first, then tries to disprove it                          | Confirmed flaws only — speculative concerns are advisory                                                                     |
| **Consultant** | Whether the chosen direction is the best safe next step for the goal/constraints | The approach can't meet the goal, an unresolved decision blocks progress, or a major ignored trade-off contradicts the brief |
| **Planner**    | Coverage/completeness of a plan document, assumptions, open questions            | Never asks you a question — resolves ambiguity with a documented working default                                             |

Reviewer, Critic, and Consultant can all leave the loop in a **blocking** or `needs-input` state; Planner alone always reaches `complete` (optionally with advisories/documentation), resolving ambiguity with a documented working default instead of asking.

### Dashboard states unique to attached mode

| State                        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Capturing context**        | Waiting for the Primary to write CONTEXT.md/HANDOFF.md                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Brief ready**              | Captured brief is ready for your review before the loop starts                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Awaiting user**            | The Companion asked a genuine question it couldn't resolve on its own — Reviewer, Critic, or Consultant can reach this; Planner never does. Your decision must cover every question of that round — the round resumes as soon as it's sent, so a partial answer is refused rather than left half-open                                                                                                                                                                                                                        |
| **Paused: policy violation** | The Companion hit a permission prompt during evaluation — it tried something outside its inspect-only scope, so the runner paused it rather than nudging it to retry                                                                                                                                                                                                                                                                                                                                                         |
| **Primary no longer exists** | The Primary's workspace or tab is gone (deleted, or missing at app-restart recovery). Terminal in every state, not just while paused: the Dashboard replaces the state hero with a "Primary no longer exists" hero whose only action is **Delete task**, and hides Start, Continue, Send back, Send decision, Reset, and the Primary resend — the runner refuses all of them and Reset does not lift the flag, because nothing in this app re-attaches a conversation that no longer exists. The last verdict stays readable |

Verification is a hard gate: only the Worker-owned `VERIFICATION.md` counts as evidence — the Companion never runs your project's build/test/lint commands itself.

**Send back.** Overriding a `complete`/max-rounds verdict re-opens a round exactly like a Companion `continue` does: the Primary gets your feedback, a `VERIFICATION.md` template tagged for the new round, and a fresh freshness baseline the next record has to beat. If the feedback can't be delivered (the Primary's CLI is gone), nothing is consumed — the verdict stands, the round bookkeeping and the previous round's evidence are left untouched, and you can retry.

**Evaluation identity.** A verdict only counts as the answer to the evaluation the runner asked for. `role`, `phase` and `round` are not enough for that on their own — a `needs-input` answer and a withheld completion both re-evaluate the _same_ phase and round — so every request also carries a monotonic `evaluationAttempt` that the Companion must echo in `verdict.json`. A verdict carrying an older attempt (the previous turn writing late, or a file left over from a previous run) is treated as stale and rewritten, never processed. The counter deliberately survives Reset.

**Completion floor.** Every role except Planner can only reach `complete` against a `VERIFICATION.md` for the current round that the runner itself read as fresh. This is checked twice: the verdict schema rejects a `complete` whose `recordStatus` isn't `fresh`, and the runner then compares that claim against the record it actually handed to that evaluation — so a baseline review (which is given no record at all) can't sign off by simply claiming one exists. When the claim doesn't hold, the review is kept but the sign-off is withheld: the Primary is asked to record the evidence for the same round, no round is consumed, and the next round-review can complete. A round that genuinely needs no command still satisfies the floor — a fresh record whose "Checks not run" section says why.

### Isolation level

The Companion always starts without any permission-bypass/yolo flag, and the create dialog refuses a custom command override for it — those are the only two guarantees this feature makes universally. Beyond that, how much is actually _enforced_ depends on the provider, shown as one of:

- **Enforced** — the provider has a verified read-only/execution-disabled mode
- **Permission-gated** — no bypass flag is used; the provider's own per-tool approval prompt gates any write/execution attempt, and the app pauses the task instead of auto-approving it (this is what triggers the "Paused: policy violation" state above)
- **Prompt-enforced** — the provider can't demonstrably gate tool use on its own; only the prompt contract restrains it, not a technical boundary

This label is shown both in the creation dialog and, live, in the running task's Config tab — it's never claimed as a hard sandbox it can't back up.

### Guards

- Deleting the Primary's workspace, or closing/removing the tab that hosts it, is refused for as long as the Primary is shown inside the Companion task workspace — that is every state except **completed** and **failed**, pausing included. Finish or delete the companion task first. (Renderer and backend share one predicate, so what you can see and what you can delete never disagree.)
- Once the loop is completed or failed the tab has returned home and the source is deletable again; the retained task is then flagged "Primary no longer exists"
- Deleting the Companion task workspace never touches the Primary session — the tab simply returns to its own workspace
- A source session can have at most one active Companion attached at a time

---

## Technical Details

### Architecture

```
WorkspaceDialog (UI, task mode)
  --> transport.ts: createTaskWorkspace()
    --> runtime.ts: createTaskWorkspace()
      --> [if useWorktree] git worktree add     // create isolated branch
      --> AgentTaskRunner.createTaskWorkspace()  // builds workspace object
      --> AgentTaskRunner.writeInitialFiles()    // writes TASK.md, TODO.md, etc.
      --> runtime.saveWorkspace()                // persists to state
```

```
Worker goes idle (hook/silence detection)
  --> runtime.onAgentIdle(sessionId)
    --> AgentTaskRunner.onAgentIdle(sessionId)
      --> #evaluateWorker(workspace)
        --> #runBuiltInChecks()         // WORK_LOCK, TODO sections
        --> [short-circuit if failed]   // re-prompt worker
        --> #getGitContext()            // git status, diff
        --> buildJudgePrompt()          // include git context
        --> #injectPrompt() to Judge    // file-based for long prompts
```

### State Machine

```
idle --> running --> evaluating --> judge-evaluating --> completed
  ^        |  ^         |               |                  |
  |        |  |         v               v                  |
  |        |  +---- refreshing          |                  |
  |        |  |  (shower mode)          |                  |
  |        +--|---- paused <-------+    |                  |
  |        |                       |    |                  |
  |        +-----> failed <--------+----+                  |
  |                                                        |
  +--------------------------------------------------------+
                    (resume)
```

- **idle**: Not started
- **running**: Worker is executing
- **evaluating**: Built-in checks running
- **judge-evaluating**: Judge is reviewing
- **refreshing**: Shower mode — restarting worker session with fresh context
- **paused**: User intervened or error occurred
- **completed**: Judge approved
- **failed**: Max rounds reached

### Prompt Injection

Short prompts (< 400 chars) are pasted directly into the PTY. Longer prompts are written to `.strideterm/tasks/<taskId>/PROMPT.md` and a short directive is sent instead:

```
Read .strideterm/tasks/<taskId>/PROMPT.md and follow the instructions in it now.
```

This avoids reliability issues with pasting large text blocks into terminal sessions.

### Completion Claim Heuristic

Before invoking the Judge, the runner checks if the Worker has signaled completion:

- **WORK_LOCK exists?** Worker hasn't claimed done -> re-prompt immediately
- **TODO "In Progress" not empty?** Active items remain -> re-prompt
- **Both clear?** Invoke the Judge for independent evaluation

This saves time by only involving the Judge when the Worker believes the task is done.

### Persistence

Task state (rounds, shower interval, judge instructions) is persisted to `~/.strideterm/strideterm-state.json` via `normalizeWorkspace()`. Survives Electron restarts. Ephemeral state (shower resume prompt) is intentionally in-memory only.

### Crash recovery

When the app closes mid-task (quit, window close, OS reboot), the PTY processes die but the task state on disk still says `running` / `judge-evaluating`. On the next startup the runtime sweeps those tasks, flips them to `paused`, and offers the user a dialog to resume. Resume re-spawns the PTY and injects a pure-text orientation prompt — no `--continue` flag, no transcript replay. See [task-recovery.md](./task-recovery.md) for the full protocol.
