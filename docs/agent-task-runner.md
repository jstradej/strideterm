# Agent Task Runner

The Agent Task Runner pairs a **Worker**, which makes changes, with an independent **Judge**, which reviews the result. You describe the goal and acceptance criteria; the agents work through rounds until the Judge approves the work or the configured round limit is reached.

## Create and start a task

1. Select **+ → Create task workspace**.
2. Choose the project directory. A project without a Git repository is initialized so the task has a baseline for reviewing changes. Optionally enable **Create in git worktree** to isolate the task on a new branch from the current commit.
3. Choose a Worker and a Judge. Each role can use a different installed and signed-in CLI: Claude Code, Codex CLI, Gemini CLI, GitHub Copilot, or OpenCode.
4. Write the task assignment, then select **Create workspace**.
5. In the Dashboard, review the assignment, provider choices, and maximum rounds, then select **Start**.

Write a brief with concrete deliverables and checks you expect the Worker to run. A useful assignment names the behavior you want, important constraints, and how you will recognize completion. The generated Assignment files are editable before and during a task: **Task** is your brief, **Worker** provides the Worker instructions, and **Judge** provides review instructions. Changes apply on the next Start or Continue. Keep unrelated requests in separate task workspaces so each Judge can evaluate one clear outcome.

## Follow a run

The Dashboard shows the current stage and the history of rounds. The Worker makes changes and reports its work; once it finishes, strIDEterm checks that the Worker has finished its checklist and asks the Judge to compare the result with your brief and the changes. The Judge can approve completion or send the Worker back with specific feedback for another round. Choose a maximum number of rounds in the task configuration to cap the loop. If the limit is reached, review the result and decide whether to continue or reset the task.

The **Status** tab shows the current stage, rounds, and check results; **Assignment** lets you edit the Task, Worker, and Judge instructions; **Config** shows the description, round limit, and provider choices; **Log** shows the event history. The task files are also stored with the project, so you can inspect them outside the app. You can type into either agent's terminal while the task is running; this is useful for answering an agent or adding context. The runner waits for an agent turn to finish before sending its own next prompt.

### Pause, continue, reset

- **Pause** stops the task loop. The agent sessions and task files remain available.
- **Continue** resumes a paused task, or continues a completed or failed task from its saved state.
- **Reset** clears the round history and returns the task to idle while keeping its files, so you can revise the brief and start a fresh run.

If strIDEterm closes while a task is running, the next start can show an interruption recovery dialog. Choose **Resume** to start fresh agent sessions and continue from the task files, **Restart** to clear the round history but keep the files, or **Skip** to leave the task paused. See [Recover an interrupted task](task-recovery.md).

## Choose agent permissions and notifications

Each role has its own provider, model, and permission setting. You can mix providers, such as Claude Code for the Worker and Codex for the Judge. A custom command is available for advanced setups. Providers that are not installed on the app's computer are unavailable in the picker, and each CLI must already be signed in. The **Skip permission prompts** default depends on the provider. When enabled, the CLI may make changes without asking you at each step; check the selected provider's behavior and choose deliberately. Your task brief should state what actions and checks are expected, and you should review the result before using it.

For faster Worker/Judge handoffs, configure the selected provider's notification hook in **Settings → General** when one is available. Without a hook, the task runner still works but may take longer to detect that the agent has finished. If a hook is not configured, the Dashboard may offer a prompt to set it up before the task starts.

## Review and keep the result

Task files and changes stay in the selected project or task worktree. The Worker is instructed to commit changes locally so the Judge can review them, but the task runner does not push to a remote. Review the diff and commits in the Git pane; then push, merge, or discard them yourself. Agent completion is not approval to publish or deploy changes.

When using a Git worktree, the task has its own branch and checkout so it can run beside your main workspace. Deleting the task workspace asks whether to remove its worktree from disk. If you keep the worktree, you can inspect or continue working with its branch later.

## Start a task from an AI planning terminal

You can optionally enable **Allow internal MCP for agents** in a workspace's settings. New local terminal sessions launched directly as Claude Code, Codex, GitHub Copilot, or OpenCode agents can then use the strIDEterm MCP tools. Restart an open agent terminal after changing this setting. The agent can prepare and monitor a task, but it must show you the proposed brief, project, Worker and Judge choices before you approve task creation and start. Review the summary carefully: starting creates an ordinary child task workspace with its own agents. The same MCP connection can create a Companion for the live conversation that owns the connection, then start it after you approve. `companion_start` starts or resumes that attached review, `companion_pause` pauses it, and `companion_answer` sends your answer to its pending questions; `task_get` reports those questions. This option is off by default and is not available to remote sessions or SSH-hosted agent sessions. Task Worker and Judge agents do not inherit this access.

## Companion review of an existing conversation

To have a second agent review a conversation that is already running, right-click its terminal tab and choose **Add companion agent…**. Select a role, provider and model, and optionally add a focus note. The original agent stays in its current session and workspace; the Companion reads the captured context and evaluates it independently. You can leave **Start the loop as soon as the brief is ready** off to inspect the captured brief before the first evaluation. Use the Companion Dashboard to follow progress, answer a question, send feedback for another round, or reset the review.

The Companion does not change files or replace the original agent. Choose **Reviewer** to check requirements and changes, **Critic** to look for confirmed flaws in an approach, **Consultant** to assess whether a plan fits your goal and constraints, or **Planner** to assess a written plan's coverage. Reviewer, Critic, and Consultant can pause for a question; Planner produces a plan review without asking you a question. Review the findings and make any changes in the original workspace yourself. Deleting the Companion task does not delete or stop the original agent session.
