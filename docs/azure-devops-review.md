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

The inbox shows all active pull requests across your connections, grouped by repository. Filter tabs:

- **All** — every PR sorted by recent activity
- **Needs attention** — PRs with new comments, vote changes, or check failures
- **Needs review** — PRs where you are a reviewer
- **My PRs** — PRs you authored
- **Connections** — manage Azure DevOps connections

When you have multiple repositories, filter buttons appear at the top to show only PRs from a specific repo.

Each PR card shows: number, title, author, branches, role (author/reviewer), and attention reason. Actions: **Open/Review** (opens review workspace), **Browser** (opens in Azure DevOps).

### Open a Review Workspace

Clicking **Review** on a PR creates a local workspace:

1. Clones the repository (cached, shared across PRs from the same repo)
2. Creates a git worktree at `{reviewRoot}/reviews/{connection}/pr-{id}/`
3. Checks out the PR source branch
4. Opens the workspace with terminal tabs (Claude Code, Codex, Shell) and review pane

For PRs you authored, strIDEterm can attach to your existing workspace instead of creating a duplicate.

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

Split view: changed files tree on the left, diff preview on the right. Click a file to see its diff.

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

Ready-to-use prompt templates for AI agents. Copy a prompt and paste it into Claude Code or Codex. Templates are editable and stored locally.

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

1. Open a Claude Code or Codex tab in the review workspace
2. The agent automatically gets MCP tools for the review bridge
3. Use a prompt template from the Agent tab, or give custom instructions
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

| Tool | Purpose |
|------|---------|
| `list_review_comments` | List all threads with status, priority, and draft previews |
| `get_review_comment` | Full thread detail by `#N` index (replies, file context, code snippet) |
| `create_review_comment` | Create a new draft comment, auto-queued for publishing |
| `save_review_draft` | Save a draft reply and auto-queue it for publishing |
| `queue_review_draft` | Explicitly queue a draft (rarely needed — drafts auto-queue) |
| `reply_with_code_changes` | Reply to a comment after making code changes — marks the thread and queues the reply |

Additionally:
- **Resource** `review://brief` — current PR review brief in markdown
- **Prompt** `process-review-comments` — step-by-step review workflow guide

---

## Git Tab in Review Workspace

The Git tab adapts for review workspaces:

- **Base branch** is set to `origin/{source-branch}` (where you push), not `origin/master`
- **"Compare with base"** shows only unpushed commits, not the full diff against the merge target
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

## Technical Details

### Data Storage

- **Main state** (`~/.strideterm/strideterm-state.json`) — workspaces, connections (without PAT), settings
- **Review bridge** (SQLite per review root) — imported threads, draft comments, drafts, sync queue, agent prompts
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

Review worktrees persist on disk after closing a workspace. Reopening the same PR reuses the existing worktree with all local commits and data intact. Worktrees are not automatically cleaned up.

### Communication Flow

```
Azure DevOps REST API
    ↓
AzureDevOpsManager (fetch threads, comments, checks)
    ↓
ReviewBridgeStore (import into SQLite, export context files)
    ↓
MCP Agent (reads via tools, writes drafts)
    ↓ (signal file)
Runtime (detects change, broadcasts state)
    ↓ (IPC / WebSocket)
Renderer (re-renders Comments tab)
    ↓ (user clicks Push & publish)
Runtime → AzureDevOpsManager → Azure DevOps REST API
```
