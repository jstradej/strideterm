# GitHub Pull Request Review

strIDEterm turns your GitHub pull request inbox into a local review workspace where AI agents help you review and fix code. It works like the [Azure DevOps integration](azure-devops-review.md); this page covers what is specific to GitHub.

---

## Getting Started

### Add a Connection

Open the GitHub workspace and click **Add connection**. You need:

- **Host URL** — `https://github.com`, or your GitHub Enterprise Server URL
- **PAT** — Personal Access Token (fine-grained or classic, with `repo` scope)
- **Review root** — local directory where PR worktrees are created
- **Owner / repository filters** — optional, limit the inbox to specific organizations, users or `owner/repo` names

Pasting a full repository URL (e.g. `https://github.com/myorg/myrepo`) fills in the host and adds the repo as a filter. Your GitHub login is detected from the token. The PAT is stored encrypted, separately from the main state file.

For GitHub Enterprise Server the API base is derived from the host (`https://{host}/api/v3`; `github.com` uses `https://api.github.com`).

### The Inbox

All active pull requests across your connections, grouped by repository. Tabs: **All**, **Needs attention** (new comments, review state changes, check failures), **Needs review** (your review is requested), **My PRs**, **Connections** and **Activity Log**.

Each card offers **Review** (opens the review workspace) and **Browser** (opens it on GitHub). The **▸** caret expands a row in place — description, mergeable state (clean / dirty / blocked / behind / unstable), comment counts, check runs and reviewers — for triage without opening a workspace.

Connections poll every 120 seconds by default (configurable per connection).

### Open a Review Workspace

**Review** clones the repository (cached per repo), creates a worktree at `{reviewRoot}/reviews/{connection}/pr-{number}/`, checks out the PR source branch and opens the workspace with agent and shell tabs and the review pane. For a PR you authored, strIDEterm can attach to your existing checkout instead of creating a duplicate (see **Work here** in the Azure DevOps guide).

### New Branch (Quick Fix)

**New Branch** (inbox toolbar or sidebar) starts a fresh branch for a new PR: pick a repository, a base branch and a branch name, and a worktree workspace is created. After committing and pushing, create the pull request from the workspace's Review tab; the workspace then becomes a full review workspace.

---

## The Review Pane

The same five tabs as Azure DevOps — Summary, Files, Comments, Conflicts, Agent — with these differences:

- **Review actions** are Approve, Request Changes and Comment.
- **Comments** shows both general (issue) comments and code review threads. Your comments show as **"You"**, agent-written ones show the agent's name.
- **Threads cannot be resolved or reactivated** from strIDEterm on GitHub; there is no thread status chip to set.

---

## Refresh & Staying Up to Date

Works exactly like the [Azure DevOps integration](azure-devops-review.md#refresh--staying-up-to-date): **Refresh** pins the PR source branch's exact current commit, fast-forwards your checkout when that loses nothing, resets onto a rewritten branch automatically only when `HEAD` is exactly the last integrated source commit (after saving a recovery ref), and otherwise shows your commits and the incoming ones and asks before discarding anything. There is no read-only mode: the real state of the checkout decides, not your role. GitHub's source repository is the PR's _head_ repository, so a PR from a fork is pushed to only when the connection is verified to have write access there.

---

## Push & Publish

**Push & publish** shows its counts — **Push (3) & publish (2)** — and:

1. Skips the push when `HEAD` already is the server's commit (then only comments are published; uncommitted files never block pushing committed work)
2. Pushes `HEAD` to the PR branch in the head repository, only as a fast-forward of the server's current commit
3. Publishes every queued draft

The push and every comment are reported independently, and nothing that succeeded is ever repeated. Inline drafts whose line no longer exists after a history rewrite are marked and refused, never moved. See [Push & Publish](azure-devops-review.md#push--publish) for the details shared by both providers.

**Limitation:** drafts are published as top-level PR (issue) comments. A reply you queue against an inline review-comment thread is also posted top-level — strIDEterm does not yet reply inside the original code thread.

After publishing, the drafts are removed locally and come back as normal GitHub comments on the next refresh.

---

## Working with AI Agents

The same workflow as Azure DevOps: agent tabs in a review workspace get the review bridge (list and read comments, write drafts) and the `review_git_*` Git tools, wait for your first instruction, **can never publish comments**, and ask you before every consent-required Git operation. See [Working with AI Agents](azure-devops-review.md#working-with-ai-agents).

---

## Authentication and Security

- **PAT storage** — encrypted in `credentials.json` (Electron `safeStorage`), never in the main state file.
- **Git authentication** — the token is never embedded in a remote URL or written to `.git/config`. It reaches git as an `http.extraheader` (Basic auth with `x-access-token`) through `GIT_CONFIG_*` environment variables, so it stays off the command line; only a git older than 2.31 (or one whose version cannot be read) gets it as a `-c` argument.
- **Agent isolation** — agents talk only to the local review database and cannot call the GitHub API.

---

## Activity Log

The **Activity Log** tab records every GitHub API call strIDEterm made — fetching PRs, loading comments, posting your replies — so you can confirm a comment was published, investigate a failed sync and tell your actions from background polling. Filter by category, status, source, date range and free text. Entries are kept for 30 days.
