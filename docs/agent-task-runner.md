# Agent Task Runner

The Agent Task Runner is a supervised coding loop that coordinates two AI agents (Worker + Judge) to complete coding tasks autonomously. It auto-detects verification commands from your project, runs deterministic checks between rounds, and uses an independent judge to evaluate completion.

## Quick Start

1. Click the **+** button in the sidebar and select **Create task workspace**
2. Choose your **project directory** (must contain the code you want to modify)
3. _(Optional)_ Check **Create in git worktree** to isolate the task on its own branch
4. Write a **task assignment** describing what needs to be done
5. Click **Create workspace** — control files are generated automatically
6. Press **Start** in the Dashboard to begin

The Worker (Claude Code) will start executing the task. When it goes idle, the Task Runner automatically runs verification checks and, if they pass, asks the Judge to independently evaluate the work.

## How It Works

```
You write a task
    |
    v
[Worker] executes the task, commits changes
    |
    v  (worker goes idle)
[Built-in checks] WORK_LOCK absent? TODO clear?
    |
    |-- FAIL --> re-prompt Worker with failure details
    |
    v  PASS
[Verify commands] npm test, lint, etc.
    |
    |-- FAIL --> re-prompt Worker with output
    |
    v  PASS
[Judge] independently reviews git diff + task
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

| File                   | Purpose                                         | Who writes it                    |
| ---------------------- | ----------------------------------------------- | -------------------------------- |
| **TASK.md**            | Full task description and rules                 | Auto-generated, you can edit     |
| **TODO.md**            | Kanban board (To Do / In Progress / Done)       | Worker updates, you can pre-fill |
| **FINISH_CRITERIA.md** | Verification commands, required/forbidden files | Auto-detected, you can edit      |
| **JUDGE_PROMPT.md**    | Customizable Judge evaluation instructions      | Auto-generated, you can edit     |
| **WORK_LOCK**          | Signal file: "work remains"                     | Worker deletes when done         |
| **JUDGE_TODO.md**      | Judge's evaluation scratchpad                   | Judge only (you can read)        |
| **verdict.json**       | Judge's completion verdict                      | Judge only                       |

### Editing Control Files

Switch to the **Files** tab in the Dashboard to edit any control file. Common edits:

- **TASK.md** — Refine the task description before pressing Start
- **TODO.md** — Pre-fill specific to-do items before starting
- **FINISH_CRITERIA.md** — Add/remove verification commands, adjust timeouts

### Two layers of verification

The Agent Task Runner verifies completion at two levels:

1. **Deterministic checks** (FINISH_CRITERIA.md) — automated, binary pass/fail:
   - Verification commands: `npm test`, `npm run lint`, etc. (auto-detected from your project)
   - Required/forbidden file paths
   - WORK_LOCK absent, TODO sections clear

2. **Judge evaluation** (AI-based) — the Judge does two things automatically:
   - **Requirements check**: reads TASK.md and verifies every requirement point by point against the actual code changes (git diff). "Did the worker actually implement pagination?" "Is the error handling complete?"
   - **Code review**: reads the changed files and checks for bugs, edge cases, dead code, debug leftovers, and consistency with existing codebase style. This is a real code review, not just a rubber stamp.

You don't need to add "check the requirements" or "do a code review" as a verify command — the Judge does both automatically. Put **automated, deterministic checks** in FINISH_CRITERIA.md (tests, lint, type-check) and leave **requirement verification and code quality review** to the Judge.

If the Judge finds code quality issues, it sends the Worker back with specific feedback ("function X in file Y has an unhandled edge case when Z is empty"). The Worker fixes it and the cycle repeats until the Judge is satisfied.

### Verification Command Format

In FINISH_CRITERIA.md, verification commands use this format:

```markdown
## Verify Commands

- Tests: `npm test`
- Lint: `npm run lint` (timeout: 30s)
- Type-check: `npx tsc --noEmit` (timeout: 120s)
```

The Task Runner auto-detects commands for Node.js, Python, Rust, Go, Java (Maven/Gradle), .NET, Ruby, and Makefile projects.

### Customizing the Judge

The Judge's evaluation behavior is defined in **JUDGE_PROMPT.md**. By default it does a requirements check (point by point) and a code review (bugs, edge cases, quality). You can customize this in the Files tab before or during task execution.

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
2. Verify each requirement is implemented
3. Write verdict to verdict.json
   Do not review code quality — only check if requirements are met.
```

The Judge always receives task description, automated check results, and git context regardless of what you write in JUDGE_PROMPT.md.

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

Built-in editor for task control files. Edit TASK.md, TODO.md, or FINISH_CRITERIA.md directly without leaving the workspace.

### Config Tab

Shows the task configuration (description, max rounds) with a link to edit finish criteria.

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
   - **TASK.md** — change the assignment entirely, or refine the description
   - **FINISH_CRITERIA.md** — add/remove verification commands, adjust timeouts
   - **TODO.md** — rewrite the to-do list for the next run
4. Press **Start** to run the task again with your updated files

The Worker and Judge terminals stay open — only the round state is cleared. The Judge's last feedback (`lastJudgeInstructions`) is also preserved, so if you resume without editing files the next run benefits from prior context.

This makes the task workspace reusable: create it once, then reset and re-run as many times as you need with different task descriptions or criteria.

## Tips

- **Start small**: Test with a well-defined task on a project with good tests before attempting large refactors
- **Pre-fill TODO.md**: If you know the subtasks, write them before pressing Start — it guides the Worker
- **Watch the first round**: Monitor the Worker's approach in round 1 and Pause if it's going in the wrong direction
- **Use the terminal**: You can always type directly into the Worker or Judge terminal for course correction
- **Check FINISH_CRITERIA.md**: The auto-detected commands may not be perfect — review and adjust before starting

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
        --> [short-circuit if failed]   // skip verify commands
        --> #readFinishCriteria()       // parse FINISH_CRITERIA.md
        --> #runFileChecks()            // required/forbidden paths
        --> #runVerifyCommands()        // npm test, lint, etc.
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
- **evaluating**: Built-in checks + verify commands running
- **judge-evaluating**: Judge is reviewing
- **refreshing**: Shower mode — restarting worker session with fresh context
- **paused**: User intervened or error occurred
- **completed**: Judge approved
- **failed**: Max rounds reached

### Key Implementation Files

| File                                                  | Purpose                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `electron/backend/agent-task-runner.js`               | Core orchestrator (state machine, checks, prompts, shower mode) |
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

Before running expensive verification commands (tests, lint), the runner checks if the Worker has signaled completion:

- **WORK_LOCK exists?** Worker hasn't claimed done -> skip verify commands, re-prompt immediately
- **TODO "In Progress" not empty?** Active items remain -> skip verify commands
- **Both clear?** Run the full verification suite

This saves minutes per round on projects with slow test suites.

### Persistence

Task state (rounds, shower interval, judge instructions) is persisted to `~/.strideterm/strideterm-state.json` via `normalizeWorkspace()`. Survives Electron restarts. Ephemeral state (shower resume prompt) is intentionally in-memory only.
