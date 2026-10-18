# Azure DevOps Pull Request Review

Review Azure DevOps pull requests in strIDEterm workspaces. Browse an inbox, inspect changes and discussion, work on the source branch, and publish your response when ready.

## Connect Azure DevOps

Open the Azure DevOps workspace and select **Add connection**. Enter your organization URL (for example, `https://dev.azure.com/myorg`), your sign-in name or email, a personal access token, and a local folder for review workspaces. The token needs **Code: Read** to browse pull requests; add **Code: Read & Write** for actions such as publishing comments or votes and pushing changes. You can limit the inbox to selected projects or repositories. Keep the token private; strIDEterm stores it with your saved credentials.

## Find and open a pull request

The inbox groups pull requests by repository. Use **Needs attention**, **All**, **Needs review**, or **My PRs** to find relevant work, and the repository filters to narrow the list. Expand a card to see its description, merge state, checks, reviewers, comment counts, and recent discussion. Use **Connections** to manage saved accounts and **Activity Log** to review requests made by strIDEterm. Select **Browser** to open the pull request in Azure DevOps.

Select **Review** to open an isolated review workspace based on the pull request's source branch; your existing checkout stays untouched. Reopening the same review can reuse its local worktree and commits. For a pull request you authored, **Work here** is available when you already have that exact source branch checked out. It links the review to that workspace instead of making another checkout. The review link adds the review pane and agent support; it does not replace your checkout. When the PR is completed or abandoned, a linked **Work here** workspace detaches from it.

## Review the changes

The review pane includes:

- **Summary** with pull request details, reviewers, checks, and review actions: **Approve**, **Approve with suggestions**, **Wait**, **Reject**, or **Clear vote**.
- **Files** with a changed-file tree and side-by-side or inline diff. Review the complete branch against the target or focus on an individual commit.
- **Comments** with code context and discussion threads. Replying creates a local draft; **Resolve** and **Reactivate** update thread state in Azure DevOps immediately. Use the filters, sort, and search to find active, resolved, drafted, or your own threads; you can also delete all drafts from the pane.
- **Conflicts** to inspect files that need attention and the provider's reported merge state.
- **Agent** to choose a review prompt or ask an agent to inspect the changes.

You can edit files and commit from the workspace's Git pane. A review draft is local until you publish it. Review an agent's findings and code changes before sending anything to Azure DevOps.

## Refresh safely

Select **Refresh** in the review pane to move the review checkout to the pull request's latest source commit and load updated details and discussion. It advances a checkout that is simply behind. If the source history was rewritten and the checkout is still at the last integrated source commit, strIDEterm can safely update it; if local commits would be discarded, it shows both sides and asks before proceeding. Uncommitted files or an in-progress Git operation must be resolved first. Background inbox updates refresh pull-request details but do not change your checkout.

**Rebase on target** is a separate action that reapplies your local commits on the pull request's target branch; review the proposed changes before proceeding. It does not publish the rewritten commits. A **Force push** is a separate, explicitly confirmed action and is intended only when you need to publish rewritten history.

## Publish comments and changes

The main action, **Push & publish**, sends committed changes to the pull request's source branch and publishes queued comments. Use **Publish only** to send comments without pushing commits. strIDEterm reports the push and each comment separately, so you can see what succeeded if one part fails.

After a rebase or other history change, strIDEterm checks that each inline draft still points to the same code. If its file or line no longer matches, the comment is marked out of date and is not moved elsewhere; delete and recreate it on the current code. A push from a fork is available only when your connection has write access to the source repository.

The Git pane remains usable like a normal project checkout. A linked review directs push actions to the pull request's source branch while you are on that branch; **Update from base** rebases on the pull request's target. Merging the pull request into its target is done in Azure DevOps.

## Work with AI agents

Agent terminals in a review workspace can read pull-request discussions and code, draft replies, and help edit files. They cannot publish comments for you. If an agent proposes Git actions such as a rebase, commit, or push, review the proposed action and approve it before it runs. You can edit or delete draft replies in the Comments pane, then publish them yourself.

## Activity, notifications, and cleanup

The **Activity Log** tab records requests made by strIDEterm, including inbox refreshes and comment publishing. Open an entry to check whether an action succeeded or investigate a connection problem. Pull-request and review notifications appear in the app's Notification Center. A **Review now** action on a Ready notification starts a basic agent review and saves findings as drafts; it does not push or publish comments. To start reviews from a paired mobile device, enable **Start PR reviews** in its access settings; the permission is off by default.

Review worktrees remain on disk after closing a workspace so you can reopen the review with its local work. When deleting a review or quick-fix workspace, choose whether to remove its worktree files too. If you keep them, you can still inspect the branch from Git.

To clean up several completed reviews at once, open the Azure DevOps workspace's sidebar menu and select **Delete closed PR workspaces**. After confirmation, strIDEterm removes review workspaces for completed or abandoned pull requests and their owned checkout folders when safe. It skips external or unmanaged folders and any checkout with uncommitted changes, unpushed commits, or another workspace using it. The cleanup runs in the background and reports its results in the Notification Center.
