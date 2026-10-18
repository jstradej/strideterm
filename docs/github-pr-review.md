# GitHub Pull Request Review

strIDEterm brings GitHub pull requests into local review workspaces. Browse your inbox, inspect changes and discussion, work on the branch with or without an AI agent, then publish your review when ready.

## Connect GitHub

Open the GitHub workspace and select **Add connection**. Enter `https://github.com` or your GitHub Enterprise Server address, a personal access token with access to the repositories you want to review, and a local folder for review workspaces. Read access is enough to browse. Give the token repository write access if you want to push changes. You can filter the inbox by owner or repository. Keep the token private; strIDEterm stores it with your saved credentials.

## Find and open a pull request

The inbox groups active pull requests by repository. **All**, **Needs attention**, **Needs review**, and **My PRs** help you find work to review. Expand a card to inspect its description, merge state, discussion, checks, and reviewers without opening a workspace. **Connections** manages saved accounts and **Activity Log** shows requests made by strIDEterm. Select **Browser** to open a pull request on GitHub.

Select **Review** to create or reopen a local review workspace for the pull request's source branch. The workspace uses its own Git worktree, so your regular checkout stays untouched; existing review work and commits are kept when you return. For a pull request you authored, **Work here** can link the review to the source branch you already have checked out.

To prepare a fix or a new pull request, select **New Branch** from the inbox or sidebar. Choose a repository, base branch, and branch name. After making, committing, and pushing your changes, create the pull request from the workspace's Review tab.

## Review the pull request

The review pane has **Summary**, **Files**, **Comments**, **Conflicts**, and **Agent** tabs. Review the diff against the target branch or inspect individual commits. You can add a general comment, draft a review response, or work through the discussion. GitHub review actions are **Approve**, **Request Changes**, and **Comment**. strIDEterm cannot resolve or reactivate GitHub comment threads.

Drafts are not visible on GitHub until you publish them. GitHub currently publishes strIDEterm's review drafts as top-level pull-request comments. A reply drafted against an inline code thread is also posted as a top-level comment rather than a reply inside that thread.

## Refresh and publish

Use **Refresh** in the review workspace to check for new source commits and discussion. If your local work can be kept, the checkout updates. If incoming changes or rewritten history could discard your commits, strIDEterm shows what would be affected and asks before proceeding. Resolve local uncommitted changes or an in-progress Git operation before refreshing when prompted.

**Push & publish** sends your committed changes to the pull request's source branch and publishes queued comments. If there are no new commits to push, it can publish comments only. strIDEterm reports the push and comments separately. Before publishing, review the confirmation and check that you are pushing to the intended source repository; a fork needs write access from your connection.

For comments whose code changed after a rebase or history rewrite, strIDEterm checks the original file and line. An outdated draft is flagged rather than silently moved to a different line. Delete it and add a new comment at the current code location.

## Work with AI agents

Agent tabs can inspect pull-request discussions and code, suggest changes, edit files, and draft replies. They cannot publish comments for you. Review their changes and draft comments before selecting **Push & publish**. Git actions that can change the checkout or remote branch are shown for your approval before they run.

## Activity and notifications

The **Activity Log** tab records GitHub requests made by strIDEterm, including background updates and comment publishing. Use it to check whether an action succeeded or investigate a connection error. Pull-request notifications appear in the app's Notification Center.

A **Ready** notification can start a basic review that creates an isolated workspace and saves an agent's findings as local drafts. It does not edit files, push commits, or publish comments. To start reviews from a paired mobile device, update both apps and enable **Start PR reviews** in the device's access settings; the permission is off by default.

Review worktrees stay on disk after closing a workspace. When deleting a review or quick-fix workspace, choose whether to remove its worktree files too.
