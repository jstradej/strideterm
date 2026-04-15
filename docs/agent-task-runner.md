# Agent Task Runner

The Agent Task Runner is a supervised coding loop that coordinates two AI agents (Worker + Judge) to complete coding tasks autonomously. It auto-detects verification commands from your project and pre-fills them as a checklist in TASK.md, then uses an independent judge to evaluate completion.

## Quick Start

1. Click the **+** button in the sidebar and select **Create task workspace**
2. Choose your **project directory** (must contain the code you want to modify)
3. _(Optional)_ Check **Create in git worktree** to isolate the task on its own branch
4. Write a **task assignment** describing what needs to be done
5. Click **Create workspace** — control files are generated automatically
6. Press **Start** in the Dashboard to begin

The Worker (Claude Code) will start executing the task. When it goes idle, the Task Runner automatically runs built-in checks and, if they pass, asks the Judge to independently evaluate the work.

## How It Works

```
You write a task
    |
    v
[Worker] executes the task, commits changes
    |     (runs verification checklist from TASK.md before finishing)
    |
    v  (worker goes idle)
[Built-in checks] WORK_LOCK absent? TODO clear?
    |
    |-- FAIL --> re-prompt Worker with failure details
    |
    v  PASS
[Judge] independently reviews git diff + task + verification checklist
    |
    |-- "continue" --> re-prompt Worker with feedback
    |
    v  "complete"
Done! You get notified.
```

The loop repeats until the Judge approves the work or the maximum number of rounds is reached.

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
- If you have an external specification, paste it directly into the task description or into TASK.md via the Files tab

**Anti-patterns to avoid:**

- "Make the code better" (too vague — the Judge needs concrete criteria to verify completion)
- Multiple unrelated tasks in one (split them into separate workspaces — each task should have its own verification criteria)

## Control Files

All task state lives in `.strideterm/tasks/<taskId>/` inside your project directory. These files are auto-gitignored.

| File                | Purpose                                         | Who writes it                    |
| ------------------- | ----------------------------------------------- | -------------------------------- |
| **TASK.md**         | Task description, verification checklist, rules | Auto-generated, you can edit     |
| **TODO.md**         | Kanban board (To Do / In Progress / Done)       | Worker updates, you can pre-fill |
| **JUDGE_PROMPT.md** | Customizable Judge evaluation instructions      | Auto-generated, you can edit     |
| **WORK_LOCK**       | Signal file: "work remains"                     | Worker deletes when done         |
| **JUDGE_TODO.md**   | Judge's evaluation scratchpad                   | Judge only (you can read)        |
| **verdict.json**    | Judge's completion verdict                      | Judge only                       |

### Editing Control Files

Switch to the **Files** tab in the Dashboard to edit any control file. Common edits:

- **TASK.md** — Refine the task description, add/remove verification steps, adjust rules
- **TODO.md** — Pre-fill specific to-do items before starting

### Verification Checklist

When you create a task workspace, the Task Runner auto-detects your project's tooling (package.json, Cargo.toml, pyproject.toml, etc.) and pre-fills a **"Verification before completion"** section in TASK.md:

```markdown
## Verification before completion

- [ ] Run `npm test` — must pass
- [ ] Run `npm run lint` — must pass
- [ ] Run `npx tsc --noEmit` — must pass
```

This checklist is **yours to edit** — add, remove, rewrite in your own language. Both the Worker and Judge read it:

- The **Worker** runs each check before claiming completion
- The **Judge** independently re-runs the checks to verify

You don't need a special format — write in plain language:

```markdown
## Verification before completion

- [ ] Spusť testy: `npm test`
- [ ] Zkontroluj, že existuje soubor src/api/users.ts
- [ ] Ověř, že stávající testy stále procházejí
```

### Two layers of verification

1. **Worker self-verification** — the Worker reads the verification checklist in TASK.md and runs each check before finishing. This is the first line of defense.

2. **Judge evaluation** (AI-based) — the Judge independently:
   - **Re-runs the verification checklist** from TASK.md to confirm the Worker's claims
   - **Requirements check**: reads TASK.md and verifies every requirement point by point against the actual code changes (git diff)
   - **Code review**: reads the changed files and checks for bugs, edge cases, dead code, debug leftovers, and consistency with existing codebase style

If the Judge finds issues, it sends the Worker back with specific feedback. The cycle repeats until the Judge is satisfied.

### Customizing the Judge

The Judge's evaluation behavior is defined in **JUDGE_PROMPT.md**. By default it runs the verification checklist, does a requirements check (point by point), and a code review (bugs, edge cases, quality). You can customize this in the Files tab before or during task execution.

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

The Dashboard is the first tab in a task workspace. It has four sections:

### Status Tab

Shows the execution pipeline (Worker -> Checks -> Judge -> Done) and a history of evaluation rounds with pass/fail details for each check.

### Files Tab

Built-in editor for task control files. Edit TASK.md, TODO.md, or JUDGE_PROMPT.md directly without leaving the workspace.

### Config Tab

Shows the task configuration (description, max rounds) with a link to edit verification steps in TASK.md.

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
3. Switch to the **Files** tab and edit what you need:
   - **TASK.md** — change the assignment, update the verification checklist, or refine the description
   - **TODO.md** — rewrite the to-do list for the next run
4. Press **Start** to run the task again with your updated files

The Worker and Judge terminals stay open — only the round state is cleared. The Judge's last feedback (`lastJudgeInstructions`) is also preserved, so if you resume without editing files the next run benefits from prior context.

This makes the task workspace reusable: create it once, then reset and re-run as many times as you need with different task descriptions or criteria.

## Tips

- **Start small**: Test with a well-defined task on a project with good tests before attempting large refactors
- **Pre-fill TODO.md**: If you know the subtasks, write them before pressing Start — it guides the Worker
- **Watch the first round**: Monitor the Worker's approach in round 1 and Pause if it's going in the wrong direction
- **Use the terminal**: You can always type directly into the Worker or Judge terminal for course correction
- **Review the verification checklist**: The auto-detected commands may not be perfect — review and adjust in TASK.md before starting

---

## Technical Details

### Architecture

```
TaskWorkspaceDialog (UI)
  --> transport.js: createTaskWorkspace()
    --> runtime.js: createTaskWorkspace()
      --> [if useWorktree] git worktree add     // create isolated branch
      --> AgentTaskRunner.createTaskWorkspace()  // builds workspace object
      --> AgentTaskRunner.writeInitialFiles()    // writes TASK.md, TODO.md, etc.
      --> runtime.saveWorkspace()                // persists to state
```

```
Worker goes idle (hook/OSC 133/silence detection)
  --> runtime.onAgentIdle(sessionId)
    --> AgentTaskRunner.onAgentIdle(sessionId)
      --> #evaluateWorker(workspace)
        --> #runBuiltInChecks()         // WORK_LOCK, TODO sections
        --> [short-circuit if failed]   // re-prompt worker
        --> #getGitContext()            // git status, diff
        --> #buildJudgePrompt()         // include git context
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

### Key Implementation Files

| File                                                  | Purpose                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `electron/backend/agent-task-runner.js`               | Core orchestrator (state machine, checks, prompts, shower mode) |
| `electron/backend/agent-task-prompts.js`              | Worker and Judge prompt builders                                |
| `electron/backend/agent-task-utils.js`                | Shared constants and helpers                                    |
| `electron/backend/agent-task-detection.js`            | Project technology detection (auto-detect verify commands)      |
| `electron/backend/agent-task-runner.test.js`          | Unit tests                                                      |
| `src/components/workspace/TaskDashboardPane.vue`      | Dashboard shell (header, tabs, controls)                        |
| `src/components/workspace/TaskDashboardStatusTab.vue` | Pipeline + round history                                        |
| `src/components/workspace/TaskDashboardFilesTab.vue`  | Control file editor                                             |
| `src/components/workspace/TaskDashboardHelpTab.vue`   | Help content                                                    |
| `src/composables/useTaskFiles.js`                     | File I/O composable                                             |
| `src/components/dialogs/TaskWorkspaceDialog.vue`      | Creation dialog                                                 |

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
