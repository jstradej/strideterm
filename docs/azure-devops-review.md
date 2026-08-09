# Azure DevOps Pull Request Review

strIDEterm turns your pull request inbox into a local review workspace where AI agents help you review and fix code.

---

## Getting Started

### Add a Connection

Open the Azure DevOps workspace and click **Add connection**. You need:

- **Organization URL** — e.g. `https://dev.azure.com/myorg`
- **Login** — your email or UPN
- **PAT** — Personal Access Token (minimum `Code: Read`; `Code: Read & Write` for push)
- **Review root** — local directory where PR worktrees are created
- **Project filters** — optional, limit to specific projects
- **Repository filters** — optional, limit to specific repos

PAT is stored encrypted, separately from the main state file.

### The Inbox

The inbox shows all active pull requests across your connections, grouped by repository. The default tab is **Needs attention** so the most actionable items surface first. Filter tabs:

- **Needs attention** (default) — PRs flagged for you, sub-grouped by why: assigned reviewer, comments on PRs you watch, your own PRs with new activity, and other (build status, conflicts, …)
- **All** — every PR sorted by recent activity
- **Needs review** — PRs where you are a reviewer
- **My PRs** — PRs you authored
- **Connections** — manage Azure DevOps connections
- **Activity Log** — see what strIDEterm did on your behalf in Azure DevOps (see [Activity Log](#activity-log) below)

When you have multiple repositories, filter buttons appear at the top to show only PRs from a specific repo.

Each PR card shows: number, title, author, branches, role (author/reviewer), and attention reason. Actions: **Open/Review** (opens review workspace), **Browser** (opens in Azure DevOps).

Click the **▸** caret on the left of the title to expand a PR row in place. The expanded view shows the PR description, creation date, status, merge state, comment counts (total / unresolved / new since you last looked), check pass/fail/pending breakdown, reviewer roll-up, the source-branch HEAD short SHA, and a preview of the latest comment from someone other than you — handy for triaging the inbox without opening every review workspace.

### Open a Review Workspace

Clicking **Review** on a PR creates a local workspace:

1. Clones the repository (cached, shared across PRs from the same repo)
2. Creates a git worktree at `{reviewRoot}/reviews/{connection}/pr-{id}/`
3. Checks out the PR source branch
4. Opens the workspace with terminal tabs (Claude Code, Codex, GitHub Copilot, Shell) and review pane

For PRs you authored, strIDEterm can attach to your existing workspace instead of creating a duplicate — the action button reads **Attach** in that case. This only happens when that workspace's checkout is on the PR's source branch.

### Detach from a Review

An attached (or managed) workspace stays linked to its PR until you unlink it. To get out, use **Detach from PR review** from the workspace's ⋯ menu in the sidebar. The same action is also available in the workspace editor and — for review-locked reviewer checkouts — in the Git tab's banner.

Detaching removes the Review tab, stops agent tabs from being launched with the review MCP bridge, and restores normal git operations. The PR on the server is not touched.

**Attached workspaces unlink themselves** once the PR reaches a terminal state (completed / abandoned; closed on GitHub). The attach is made while your checkout sits on the PR's source branch — after the merge that branch is usually gone and the link is dead weight, so the next poll clears it. Managed review worktrees are left linked: they exist only for the review, so there is nothing to restore.

---

## The Review Pane

The review pane has five tabs:

### Summary

- PR metadata: title, author, branches, merge status, draft indicator
- **Review actions**: Approve, Approve with suggestions, Wait, Reject, Clear vote
- **Git operations**: Fetch, Rebase on target, Push branch, Force push, Open Lazygit
- **Checks**: pipeline status with pass/fail/pending indicators
- **Reviewers**: who reviewed and their vote

### Files

Split view: changed files tree on the left, Monaco diff editor on the right (side-by-side or inline, F7 / Shift+F7 to step through changes). Click a file to load its diff. Above the editor a **Final** chip shows the rolled-up branch diff vs the PR target; one chip per commit lets you scope the view to that commit's changes only.

### Comments

All review threads with inline code context. Each thread shows:

- Thread number (`#N`), status chip (Active/Fixed/etc.), file path, relative time
- All published replies with author avatars
- Draft replies (queued for publishing) with edit/delete actions
- **"Reply with code changes"** banner (green) when an agent marked code changes for this thread

**Actions per thread:**

- **Reply** — create a draft reply (auto-queued for publishing)
- **Resolve** — immediately resolve on Azure DevOps
- **Reactivate** — reopen a resolved thread

**Toolbar:**

- **Filters**: All, Active, Fixed, Has draft, Mine
- **Sort**: by #N, Newest, Status, File — click again to toggle ascending/descending
- **Search**: filter by file path or comment text
- **Delete all drafts** — remove all drafts at once

**Badge** on the Comments tab shows only active (unresolved) thread count.

### Conflicts

Merge conflict detection with file tree and diff preview. Shows merge status from Azure DevOps.

### Agent

Ready-to-use prompt templates for AI agents. Copy a prompt and paste it into Claude Code, Codex, or GitHub Copilot. Templates are editable and stored locally.

Also shows the MCP server command line for connecting custom agents.

---

## Push & Publish

The **Push & publish** button in the toolbar is the main action for sending your work to Azure DevOps. It shows dynamic counts:

> **Push (3) & publish (2)**

This means: 3 commits to push, 2 draft comments to publish.

What it does (in order):

1. **Checks for uncommitted changes** — if the worktree is dirty, shows an error asking you to commit first
2. **Pushes commits** to the remote PR branch (with PAT authentication)
3. **Publishes all queued draft comments** to Azure DevOps threads

If push succeeds but publishing fails, you see both a success message (commits pushed) and an error (which comments failed). Retry will only publish the remaining comments since commits are already pushed.

**"Publish only"** is available as a secondary button if you only want to publish comments without pushing.

After completion, a green banner shows the result:

> **3 commits pushed, 2 comments published to Azure DevOps.**

---

## Working with AI Agents

### Review Mode (agent reads code, writes replies)

1. Open a Claude Code, Codex, or GitHub Copilot tab in the review workspace
2. The agent automatically gets MCP tools for the review bridge (Copilot uses `--additional-mcp-config` with inline JSON; Claude uses `--mcp-config`; Codex uses `-c mcp_servers.review.*`)
3. Use a prompt template from the Agent tab, or give custom instructions — the agent does not start on its own. Claude additionally gets a short review briefing via `--append-system-prompt`; Codex, Copilot and OpenCode get the MCP wiring only, because their prompt flags submit immediately and would kick off an unrequested run
4. The agent reads comments via MCP, analyzes code, writes draft replies
5. Drafts appear instantly in the Comments tab
6. Review, edit, or delete drafts
7. Click **Push & publish** to send everything to Azure DevOps

### Fix Mode (agent fixes code based on review comments)

1. Discuss a review comment with the agent
2. Tell the agent to implement the fix
3. The agent edits files in the worktree (which is the PR branch)
4. The agent writes a reply to the reviewer describing what was changed — the comment gets a green **"Reply with code changes"** banner in the UI
5. Tell the agent to commit
6. Click **Push & publish** — pushes the commit and publishes the reply

Agents cannot publish directly to Azure DevOps. All publishing goes through the user-controlled **Push & publish** action.

### MCP Tools

The review bridge exposes these tools to agents:

| Tool                      | Purpose                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `list_review_comments`    | List all threads with status, priority, and draft previews                           |
| `get_review_comment`      | Full thread detail by `#N` index (replies, file context, code snippet)               |
| `create_review_comment`   | Create a new draft comment, auto-queued for publishing                               |
| `save_review_draft`       | Save a draft reply and auto-queue it for publishing                                  |
| `queue_review_draft`      | Explicitly queue a draft (rarely needed — drafts auto-queue)                         |
| `reply_with_code_changes` | Reply to a comment after making code changes — marks the thread and queues the reply |

Additionally:

- **Resource** `review://brief` — current PR review brief in markdown
- **Prompt** `process-review-comments` — step-by-step review workflow guide

---

## Git Tab in Review Workspace

The Git tab adapts for review workspaces:

- **Base branch** is set to `origin/{source-branch}` (where you push), not `origin/master`
- **"Compare with base"** shows only unpushed commits, not the full diff against the merge target
- **Base-compare chip** above the commit list shows the currently-compared base; click it to detach from the PR's tracked base and pick an arbitrary branch for an ad-hoc diff (handy when reviewing how a feature branch has drifted from `main` independently of the PR target). Click "Reset to PR base" on the chip to snap back.
- **Searchable branch picker** — every branch dropdown (checkout, compare, base) filters as you type, so repos with hundreds of branches stay navigable.
- **Unpushed commits** are highlighted with an orange border and "unpushed" badge
- **Merge buttons are hidden** — merging into the target branch is done through Azure DevOps, not locally
- **Rebase on target** is available in the Summary tab (rebases onto the PR target branch)
- **Force push** is available after rebase (uses `--force-with-lease` for safety)

Both Push and Force push check for uncommitted changes before pushing.

---

## Draft Workflow

All draft creation paths (UI reply, agent MCP calls) automatically queue drafts for publishing. There is no manual "queue" step.

1. Create a draft (Reply button, agent MCP tool, or edit dialog)
2. Draft appears in the Comments tab as "queued"
3. Edit or delete if needed
4. Click **Push & publish** to send to Azure DevOps
5. After publishing, drafts disappear from the UI (published replies show as normal Azure comments)

---

## Authentication and Security

### PAT Storage

PAT values are stored encrypted in a separate `credentials.json` file, not in the main state. On Electron, `safeStorage` is used when available.

### Git Authentication

Git commands authenticate via `http.extraheader`, not by embedding tokens in remote URLs. This keeps `.git/config` clean.

### Agent Isolation

MCP agents interact only with the local SQLite database. They cannot publish to Azure DevOps directly — all publishing requires explicit user action.

---

## Activity Log

strIDEterm regularly communicates with Azure DevOps in the background — fetching pull requests, loading review threads, posting your comments, and creating branches. The **Activity Log** tab gives you a complete record of everything strIDEterm did on your behalf, so you can always verify what happened and when.

This is useful when you want to:

- confirm that a comment was actually published
- investigate why a sync failed or a connection timed out
- see how often the app polls Azure DevOps and how fast it responds
- check exactly which operations were triggered by your actions vs. automatic background sync

### Browsing the Log

Open the **Activity Log** tab in the Azure DevOps inbox. Each row represents one request to Azure DevOps — for example, fetching the list of pull requests or posting a comment.

Click any row to expand its detail panel showing the full URL, exact timestamp, connection, and error message (if the request failed). You can **copy the detail to clipboard** for sharing or troubleshooting.

### Filtering

Use the filter bar at the top to narrow down the log:

- **Category** — show only reads (data fetching) or writes (comments, votes, PR creation)
- **Status** — focus on successful operations or errors only
- **Source** — distinguish between operations you triggered (clicking Refresh, posting a comment) and automatic background sync
- **Date range** — last 24 hours, 7 days, or 30 days
- **Search** — type to search across operation names, projects, URLs, and error messages

The stats bar below the filters gives a quick overview: total count, success/error ratio, read vs. write breakdown, and average response time.

### Sorting and Resizing

Column headers are clickable — click to sort by that column, click again to reverse the direction. Column borders can be dragged to adjust widths.

### Retention

The log keeps the last 30 days of history. Older entries are automatically cleaned up when the application starts.

---

## Technical Details

### Data Storage

- **Main state** (`~/.strideterm/strideterm-state.json`) — workspaces, connections (without PAT), settings
- **Review bridge** (SQLite per review root) — imported threads, draft comments, drafts, sync queue, agent prompts
- **Audit log** (`azure-audit-log.db` per review root) — every Azure DevOps API call with timing, status, and context (30-day retention)
- **Review cache** — PR tracking state, seen timestamps, workspace mapping
- **Exports** — markdown/JSON context files for agent consumption (`agent-brief.md`, `threads.md`, etc.)

### Comment Status Lifecycle

```
ready-for-agent → agent-working → draft-ready → ready-to-sync → synced
                                                                  ↓
                                                               conflict (on failure)
```

Comments with code changes get `fix_status = 'has-code-changes'` alongside their regular status.

### Live Sync

When an MCP agent writes to the database, the UI updates within ~150ms:

1. Store writes a `.bridge-signal` file after every mutation
2. Runtime watches this file for instant notification
3. Fallback: `PRAGMA data_version` polled every 3 seconds
4. State broadcast pushes changes to the renderer via IPC/WebSocket

### Worktree Management

Review worktrees persist on disk after closing a workspace. Reopening the same PR reuses the existing worktree with all local commits and data intact.

When you delete a review or quickfix workspace (click the ✕ button in the sidebar), the app asks whether you also want to remove the worktree files from disk. If you confirm, the directory and its git worktree reference are cleaned up. If you decline, the workspace is removed from the sidebar but the files stay on disk for manual cleanup later. If file deletion fails (e.g. a process is still using the directory), you get a message with the path so you can delete it yourself.

### Communication Flow

```
Azure DevOps REST API
    ↓                    ↘
AzureDevOpsManager        AuditLogStore (logs every API call)
    ↓
ReviewBridgeStore (import into SQLite, export context files)
    ↓
MCP Agent (reads via tools, writes drafts)
    ↓ (signal file)
Runtime (detects change, broadcasts state)
    ↓ (IPC / WebSocket)
Renderer (re-renders Comments tab, Activity Log)
    ↓ (user clicks Push & publish)
Runtime → AzureDevOpsManager → Azure DevOps REST API
```
