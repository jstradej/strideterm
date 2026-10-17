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

**Refresh** in the review pane toolbar is the action that moves your review checkout's `HEAD` onto the PR's latest source commit. There is no read-only mode and no "Enable editing": a PR link never decides what Git may do — the runtime looks at the real state of the checkout for every action, whatever your role (author or reviewer) and however the workspace was created (managed checkout, or "Work here" on an existing one).

It:

1. Asks the provider for the PR source branch's **exact current commit** and pins that commit for the rest of the operation (it never trusts a possibly stale tracking ref).
2. Does nothing when `HEAD` already is that commit, and **fast-forwards** when `HEAD` is simply behind it. No commit is lost, so it just happens.
3. When the author rewrote the branch (rebase or force-push) and `HEAD` is **exactly the commit this checkout last integrated or pushed** (the _source baseline_) with a clean tree and no Git operation in progress, it resets onto the new commit automatically — after saving a recovery ref (`refs/strideterm/recovery/...`) to the old `HEAD`.
4. Otherwise, if it would have to discard commits (you committed on top, the baseline is unknown, or the history diverged), it **stops and shows both sides** — your commits that would be discarded and the incoming ones — and only proceeds if you choose to. Keeping your commits is always an option.
5. Blocks, with the reason, on uncommitted changes (nothing is ever stashed for you), a rebase/merge/cherry-pick/revert in progress, a detached `HEAD`, a deleted source branch, or a checkout switched to an unrelated branch (switch back, or detach).
6. Refreshes the git snapshot and the PR metadata, and reloads the diff you have open.

The **source baseline** is stored with the workspace (`sourceBaselineSha`), bound to the provider, connection, PR, full source ref and the PR's actual _source_ repository. It advances only after a refresh that integrated the source or a push of your `HEAD` to the source branch — never on a fetch, a metadata poll, a target rebase, a local commit or a cancelled prompt. It is dropped if the PR's source identity changes, and left unknown (never guessed) when it cannot be proved.

**Background refresh** (switching into the pane, polling) only updates PR metadata and never touches the checkout.

**Rebase on target** is a different operation: it rewrites your local commits onto the PR's _target_ branch (the target commit is pinned, and you are shown what is rewritten and asked first). It never pushes and never moves the source baseline — publishing the rewritten history is a separate **Force push**.

Refresh, Rebase, Push and Force push start at once and report back when they finish, so a slow network (or a phone on the mobile relay) never shows "failed" for work that is still running. The result also reaches clients that were not connected when it ended.

---

## Push & Publish

**Push & publish** is the main action for sending your work to Azure DevOps. Its label shows the counts — **Push (3) & publish (2)**: three commits to push, two drafts to publish. In order it:

1. Checks the checkout is on the PR's branch (the managed `pr-{id}-...` branch or the source branch) — if you switched to another branch it refuses and says how to get back
2. Pushes `HEAD` to the PR **source branch in the verified source repository**, only when that is a fast-forward of the commit the server has right now. (Uncommitted files do not block pushing committed work.) A PR whose source lives in another repository (a fork) is only pushed to when the connection is verified to have write access there; otherwise it is refused.
3. Publishes every queued draft to its Azure DevOps thread

The push and each comment are reported independently: if the push succeeds but a comment fails you see both, and a retry publishes only what is left — a successful push is never repeated. **Publish only** sends drafts without pushing.

After a history rewrite (a reset or rebase), inline draft comments are re-checked against the new `HEAD`. A comment whose file or line no longer exists is marked **Anchor out of date** and is **not** moved to another line; publishing refuses it until you fix or delete it.

**Force push** always uses `--force-with-lease` on the exact commit the server has now. If the server holds commits you do not have _and_ it moved since your baseline, you are shown the server, baseline and local commits and asked first. A rejected lease is reported and never retried automatically.

---

## Working with AI Agents

Agent tabs opened in a review workspace (Claude Code, Codex, GitHub Copilot, OpenCode) are wired to the **review bridge**, one MCP server that lets the agent list and read the PR's comment threads, write draft replies — and work with Git on the checkout. The agent does not start on its own: use a template from the Agent tab or give your own instructions. (Claude also gets a short review briefing; the other CLIs get only the MCP wiring, because their prompt flags would start an unrequested run. Every client gets the same rules from the MCP server's own instructions and the tool descriptions.)

**Review mode** — the agent reads the threads and the code and writes draft replies. Drafts appear in the Comments tab at once; edit or delete them, then **Push & publish**.

**Fix mode** — discuss a comment with the agent, let it edit files in the worktree (which is the PR branch) and reply describing the change (the thread gets the "Reply with code changes" banner). Then the agent can stage, commit and push through the Git tools (asking you first, below) — or you do it yourself.

**Agents can never publish comments.** They write only to the local review database; every published comment goes through your **Push & publish**. A push by an agent never publishes drafts either.

Every draft — from a reply in the UI or from an agent — is queued for publishing automatically; there is no separate "queue" step. Published drafts disappear and come back as normal Azure DevOps comments.

### Git tools

The same MCP server also offers `review_git_*` tools: read-only `identity`, `status`, `refs`, `diff`, `history`, `conflicts` and `checks`, plus `fetch`, `refresh`, `rebase`, `stage`, `unstage`, `commit`, `continue` / `skip` / `abort`, `push` and `force_push`, `get_git_audit_log` and `git_operation_status`. There is no shell tool and no arbitrary-Git tool, and the agent is told not to run state-changing Git in a shell for the PR (that would bypass the safety checks and the audit trail — a rule given to the agent, not something the OS enforces).

- **Consent.** Before a rebase, stage/unstage, conflict continue/skip/abort, commit, push or force push — and before a refresh that would discard commits — the tool first returns a _proposal_ (exact commits, paths and SHAs; nothing is done). The agent must ask **you** (Claude uses `AskUserQuestion` and waits for your actual answer; other agents ask in the conversation and stop), and only then repeat the call with the proposal id and your answer. Tool permission prompts, `PermissionRequest` hooks and auto-approval are never your consent, and `AskUserQuestion` is on the auto-approve never-list. A proposal id only proves the repository still looks as it did when you were asked — if anything changed you get a new proposal. There is no approval queue in strIDEterm, and what the agent reports you answered is recorded in the audit trail as context, not as proof.
- **Safe refresh needs no question** (fast-forward, or the baseline-proven reset above).
- **Capability.** The tools reach strIDEterm through a short-lived capability for this one tab, scoped to its profile, workspace, PR and source identity. It ends when the tab is detached or closed, the profile goes away or the PR's source changes — for new requests; an operation that already started keeps running and stays queryable for 24 hours with `git_operation_status`. Neither the remote-access token nor any provider token ever reaches the agent.
- **Audit.** Every mutation writes its intent to the audit trail before it runs (and is refused if that cannot be written) and records the outcome on the same row: operation id, workspace, PR, source ref, requester and agent, reported consent, and the SHAs involved.

---

## Git Tab in a Review Workspace

The Git tab has every action — nothing is hidden or disabled because the workspace is linked to a PR. "Detach from PR review" only removes the link; it is never needed to use Git.

- **Base branch** is `origin/{source-branch}` (where you push), not `origin/master`, so **Compare with base** shows only unpushed commits
- The **base-compare chip** can detach the comparison from the PR's base for an ad-hoc diff against any branch; **Reset to PR base** snaps back
- Branch pickers filter as you type
- Unpushed commits are highlighted
- While the checkout is on the PR's branch, **Push** goes to the PR's _source_ branch, **Force push** leases the exact server commit, and **Update from base** against the PR target is the target rebase above. On any other branch the ordinary Git actions act on that branch and its upstream.
- Merge into the target still happens in Azure DevOps

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
