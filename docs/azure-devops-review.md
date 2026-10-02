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
- **Project / repository filters** — optional, limit the inbox to specific projects or repos

The PAT is stored encrypted, separately from the main state file.

### The Inbox

The inbox shows all active pull requests across your connections, grouped by repository. Filter tabs:

- **Needs attention** (default) — PRs flagged for you, sub-grouped by why: assigned reviewer, comments on PRs you watch, your own PRs with new activity, and other (build status, conflicts, …)
- **All** — every PR sorted by recent activity
- **Needs review** — PRs where you are a reviewer
- **My PRs** — PRs you authored
- **Connections** — manage Azure DevOps connections
- **Activity Log** — what strIDEterm did on your behalf in Azure DevOps (see [Activity Log](#activity-log))

With several repositories, filter buttons at the top narrow the list to one repo. Each card offers **Open/Review** (opens the review workspace) and **Browser** (opens the PR in Azure DevOps). The **▸** caret expands a row in place — description, merge state, comment counts (unresolved, new since you last looked), checks, reviewers and the latest comment — so you can triage without opening every workspace.

### Open a Review Workspace

**Review** creates a local workspace:

1. Clones the repository (cached and shared across PRs from the same repo)
2. Creates a git worktree at `{reviewRoot}/reviews/{connection}/pr-{id}/`
3. Checks out the PR source branch
4. Opens the workspace with agent and shell tabs (Claude Code, Codex, GitHub Copilot, Shell) and the review pane

**Review** means the same thing on every row, whoever opened the PR: a separate workspace, your own checkouts untouched.

For a PR **you authored**, the row also offers **Work here** when you already have a checkout on that PR's source branch. It links the PR to that workspace instead of cloning: the review pane opens there, and agent tabs launched in it get the PR's comments over the review bridge. Read the feedback, act on it and push from the checkout you actually work in — pushing from a separate worktree would leave your own checkout silently behind.

### Detach from a Review

A linked workspace stays linked until you unlink it: **Detach from PR review** in the workspace's ⋯ menu (also in the workspace editor and, for review-locked checkouts, the Git tab banner). Detaching removes the Review tab, stops wiring the review bridge into new agent tabs and restores normal git operations. The PR on the server is not touched.

Workspaces linked by **Work here** unlink themselves once the PR is completed or abandoned — the source branch is usually gone by then. Managed review worktrees stay linked: they exist only for the review.

---

## The Review Pane

### Summary

- PR metadata: title, author, branches, merge status, draft indicator
- **Review actions**: Approve, Approve with suggestions, Wait, Reject, Clear vote
- **Git operations**: Push; Rebase on target, Force push and Open Lazygit under **More git actions** (there is no separate "Fetch" — see [Refresh & Staying Up to Date](#refresh--staying-up-to-date))
- **Checks** and **Reviewers** with their votes

### Files

Changed-file tree and a Monaco diff editor (side-by-side or inline, F7 / Shift+F7 to step through changes). A **Final** chip shows the whole branch diff against the PR target; one chip per commit scopes the view to that commit.

### Comments

All review threads with inline code context, published replies, and your draft replies (queued for publishing). A green **"Reply with code changes"** banner marks a thread where an agent changed code for it.

Per thread: **Reply** (creates a queued draft), **Resolve** and **Reactivate** (applied on Azure DevOps immediately). The toolbar filters (All, Active, Fixed, Has draft, Mine), sorts, searches by file or text, and can delete all drafts. The tab badge counts only active threads.

### Conflicts

Merge-conflict detection with file tree and diff preview, plus the merge status Azure DevOps reports.

### Agent

Editable prompt templates for agents, stored locally, and the review-bridge MCP command line for connecting a custom agent.

---

## Refresh & Staying Up to Date

**Refresh** in the review pane toolbar is the only action that can move your review checkout's `HEAD`. It:

1. Fetches the PR's exact source branch — not whatever the local branch is named or tracking (a managed checkout is `pr-{id}-...` and may have no upstream).
2. Fast-forwards onto it **only** when that is safe — never `reset --hard`, rebase or merge.
3. Refreshes the git snapshot and the PR metadata (title, checks, comments), and reloads the diff you have open.
4. Reports the outcome: updated N commits, already up to date, or why it could not update safely — uncommitted changes or a rebase/merge in progress, local commits ahead, or diverged history. In those cases nothing is touched.

Refresh works the same in a read-only reviewer checkout — no **Enable editing** needed, because fast-forwarding onto the PR's own branch is not an edit.

**Background refresh** (switching into the pane, polling) only updates PR metadata and never touches the checkout.

**Rebase on target** is a different operation: it rewrites history onto the PR's _target_ branch, and its availability depends on how far behind the target you are, not on whether the source branch moved.

---

## Push & Publish

**Push & publish** is the main action for sending your work to Azure DevOps. Its label shows the counts — **Push (3) & publish (2)**: three commits to push, two drafts to publish. In order it:

1. Refuses if the worktree has uncommitted changes
2. Pushes commits to the PR branch
3. Publishes every queued draft to its Azure DevOps thread

If the push succeeds but publishing fails, you see both; a retry publishes only what is left. **Publish only** sends drafts without pushing.

---

## Working with AI Agents

Agent tabs opened in a review workspace (Claude Code, Codex, GitHub Copilot) are wired to the **review bridge**, an MCP server that lets the agent list and read the PR's comment threads and write draft replies. The agent does not start on its own: use a template from the Agent tab or give your own instructions. (Claude also gets a short review briefing; the other CLIs get only the MCP wiring, because their prompt flags would start an unrequested run.)

**Review mode** — the agent reads the threads and the code and writes draft replies. Drafts appear in the Comments tab at once; edit or delete them, then **Push & publish**.

**Fix mode** — discuss a comment with the agent, let it edit files in the worktree (which is the PR branch) and reply describing the change (the thread gets the "Reply with code changes" banner). Have it commit, then **Push & publish** sends the commit and the reply together.

**Agents can never publish.** They write only to the local review database; every push and every published comment goes through your **Push & publish**.

Every draft — from a reply in the UI or from an agent — is queued for publishing automatically; there is no separate "queue" step. Published drafts disappear and come back as normal Azure DevOps comments.

---

## Git Tab in a Review Workspace

- **Base branch** is `origin/{source-branch}` (where you push), not `origin/master`, so **Compare with base** shows only unpushed commits
- The **base-compare chip** can detach the comparison from the PR's base for an ad-hoc diff against any branch; **Reset to PR base** snaps back
- Branch pickers filter as you type
- Unpushed commits are highlighted
- **Merge buttons are hidden** — merging into the target happens in Azure DevOps
- **Force push** (after a rebase) uses `--force-with-lease`

Push and Force push both refuse a worktree with uncommitted changes.

---

## Authentication and Security

- **PAT storage** — encrypted in `credentials.json` (Electron `safeStorage`), never in the main state file.
- **Git authentication** — the token is never embedded in a remote URL or written to `.git/config`. It reaches git as an `http.extraheader` through `GIT_CONFIG_*` environment variables, so it stays off the command line (process listings, endpoint telemetry); only a git older than 2.31 (or one whose version cannot be read) gets it as a `-c` argument.
- **Agent isolation** — agents talk only to the local review database and cannot publish to Azure DevOps.

---

## Activity Log

strIDEterm talks to Azure DevOps in the background — fetching pull requests, loading threads, posting your comments. The **Activity Log** tab records every one of those requests, so you can confirm a comment was published, investigate a failed sync, see how often and how fast the app polls, and tell your own actions from background sync.

Each row is one request; expand it for the URL, timestamp, connection and error, and copy it for troubleshooting. Filter by category (read / write), status, source (you / background), date range and free text; the stats bar shows totals, error ratio and average response time. Entries are kept for 30 days.

---

## Review Worktrees on Disk

Review worktrees stay on disk after you close a workspace; reopening the PR reuses the worktree with its local commits. Deleting a review or quick-fix workspace asks whether to remove the worktree files too; if removal fails (a process still holds the directory), you get the path to delete it yourself.
