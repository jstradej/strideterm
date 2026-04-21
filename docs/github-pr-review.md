# GitHub Pull Request Review

strIDEterm turns your GitHub pull request inbox into a local review workspace where AI agents help you review and fix code. Same architecture as the [Azure DevOps integration](azure-devops-review.md).

---

## Getting Started

### Add a Connection

Open the GitHub workspace and click **Add connection**. You need:

- **Host URL** — `https://github.com` for GitHub.com, or your GitHub Enterprise Server URL
- **PAT** — Personal Access Token (fine-grained or classic, with `repo` scope)
- **Review root** — local directory where PR worktrees are created
- **Owner filters** — optional, limit to specific organizations or users
- **Repository filters** — optional, limit to specific `owner/repo` names

If you paste a full repository URL (e.g. `https://github.com/myorg/myrepo`), the app automatically extracts the host and adds the owner/repo as filters.

PAT is stored encrypted, separately from the main state file. Your GitHub login is detected automatically from the token.

### The Inbox

The inbox shows all active pull requests across your connections, grouped by repository. Filter tabs:

- **All** — every PR sorted by recent activity
- **Needs attention** — PRs with new comments, review state changes, or check failures
- **Needs review** — PRs where your review is requested
- **My PRs** — PRs you authored
- **Connections** — manage GitHub connections
- **Activity Log** — see every GitHub API call strIDEterm made on your behalf

When you have multiple repositories, filter buttons appear at the top to show only PRs from a specific repo.

Each PR card shows: number, title, author, branches, role (author/reviewer), approval status, and attention reason. Actions: **Review** (opens review workspace), **Browser** (opens on GitHub).

### Open a Review Workspace

Clicking **Review** on a PR creates a local workspace:

1. Clones the repository (cached, shared across PRs from the same repo)
2. Creates a git worktree at `{reviewRoot}/reviews/{connection}/pr-{number}/`
3. Checks out the PR source branch
4. Opens the workspace with terminal tabs (Claude Code, Codex, GitHub Copilot, Shell) and review pane

For PRs you authored, strIDEterm can attach to your existing workspace instead of creating a duplicate.

### New Branch (Quick Fix)

Click **New Branch** in the inbox toolbar or the sidebar icon to create a fresh branch for a new PR:

1. Select a repository from your GitHub account
2. Pick a base branch (main/develop/master auto-suggested)
3. Enter a branch name with optional prefix (e.g. `fix/my-change`)
4. A worktree workspace is created, ready for coding

After committing and pushing, use the Review tab to create a pull request directly from the workspace. The workspace then promotes to a full review workspace automatically.

---

## The Review Pane

The review pane has five tabs (identical to Azure DevOps):

### Summary

- PR metadata: title, author, branches, merge status, draft indicator
- **Review actions**: Approve, Request Changes, Comment
- **Git operations**: Fetch, Rebase on target, Push branch
- **Checks**: CI status with pass/fail/pending indicators
- **Reviewers**: who reviewed and their state

### Files

Split view: changed files tree on the left, diff preview on the right. Click a file to see its diff.

### Comments

All conversations — both general issue comments and code review threads. Each thread shows:

- Thread number (`#N`), status chip, file path (for code comments), relative time
- All published replies with author avatars
- Draft replies (queued for publishing) with edit/delete actions

Human-authored comments show as **"You"**, agent-authored comments show the agent name.

### Conflicts

Merge conflict detection with file tree and diff preview.

### Agent

Ready-to-use prompt templates for AI agents. Copy a prompt and paste it into Claude Code, Codex, or GitHub Copilot. Templates are editable and stored locally.

Also shows the MCP server command line for connecting custom agents.

---

## Push & Publish

The **Push & publish** button in the toolbar sends your work to GitHub. It shows dynamic counts:

> **Push (3) & publish (2)**

What it does:

1. **Skips push** if there are no commits ahead of remote (only publishes comments)
2. **Pushes commits** to the remote PR branch (with PAT authentication, using `HEAD:refs/heads/{branch}` refspec)
3. **Publishes all queued draft comments** as GitHub issue comments

If there are no commits to push, only comments are published — no dirty worktree check needed.

After publishing, draft comments are removed from the local database and re-imported as normal remote comments on the next refresh.

---

## Working with AI Agents

Same workflow as Azure DevOps:

1. Open a Claude Code, Codex, or GitHub Copilot tab in the review workspace
2. The agent automatically gets MCP tools for the review bridge (Copilot uses `--additional-mcp-config` with inline JSON; Claude uses `--mcp-config`; Codex uses `-c mcp_servers.review.*`)
3. The agent reads comments, analyzes code, writes draft replies
4. Drafts appear in the Comments tab
5. Click **Push & publish** to send to GitHub

Agents cannot publish directly to GitHub. All publishing goes through user-controlled actions.

---

## Authentication and Security

### PAT Storage

PAT values are stored encrypted in `credentials.json`, not in the main state. On Electron, `safeStorage` is used when available.

### Git Authentication

Git commands authenticate via `http.extraheader` (Basic auth with `x-access-token:{PAT}`), not by embedding tokens in remote URLs.

### Agent Isolation

MCP agents interact only with the local SQLite database. They cannot call the GitHub API directly.

### GitHub Enterprise Server

Connections support custom host URLs. The API base URL is derived automatically:

- `github.com` -> `https://api.github.com`
- Custom host -> `https://{host}/api/v3`

---

## Activity Log

The **Activity Log** tab shows every GitHub API call strIDEterm made — fetching PRs, loading comments, posting your replies. Useful for:

- Confirming a comment was published
- Investigating sync failures
- Checking polling frequency and response times
- Distinguishing user-triggered vs. automatic background operations

Supports filtering by category (read/write), status, source, date range, and free-text search. Entries are kept for 30 days.

---

## Technical Details

### Data Storage

- **Main state** (`~/.strideterm/strideterm-state.json`) — workspaces, connections (without PAT), settings
- **Review bridge** (SQLite, shared with Azure DevOps) — imported threads, draft comments, sync queue, agent prompts
- **Audit log** (`github-audit-log.db`) — every GitHub API call with timing, status, and classification (30-day retention)
- **Review cache** — PR tracking state, seen timestamps, workspace mapping
- **Exports** — markdown/JSON context files for agent consumption

### Polling

Default: 120 seconds per connection. Configurable per connection (minimum 15 seconds). The active review workspace polls more frequently through manual refresh.

### Differences from Azure DevOps Integration

| Feature          | Azure DevOps                  | GitHub                                   |
| ---------------- | ----------------------------- | ---------------------------------------- |
| Auth             | Basic (login:PAT)             | Bearer (PAT)                             |
| Login            | User provides login           | Auto-detected from token                 |
| Projects         | Yes (project → repo)          | No (repos directly)                      |
| Review actions   | Vote (10/5/0/-5/-10)          | APPROVE / REQUEST_CHANGES / COMMENT      |
| Thread status    | Active/Fixed/Closed/etc.      | No thread resolution (GitHub limitation) |
| Inline comments  | Via Azure threads             | Via review comments (code-level)         |
| General comments | Via Azure threads             | Via issue comments (separate API)        |
| Checks           | Policy evaluations + statuses | Check runs + combined status             |
