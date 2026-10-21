# Manual Git view verification

Run the app with `.\dev.ps1` after building the current branch. The new view stays opt-in.

1. In Settings → Git, confirm **New Git view** starts off. Turn it on, visit History / Changes / Review, switch it off, and confirm the classic tabs return.
2. In a dirty repository, open Changes. Check staged, unstaged, untracked, and conflict groups. Select a text file with separated hunks and stage one hunk at a time; confirm the other hunk stays unstaged. Stage and unstage a file, then commit staged changes while unrelated worktree edits remain.
3. Open History. Search/select a local branch, remote branch, and tag using the keyboard; confirm the working branch label does not change. Favorite a ref, switch roots, and verify its favorite stays with the original root. Resize commit and diff panes.
4. In a linked PR workspace, open Review and confirm provider, PR identity, source, target/base, changed-file list, and provider diff. Draft a comment, switch views and files, then return and confirm the draft remains. Confirm local unstaged changes are not shown as PR changes.
5. Repeat the view and picker checks at a narrow window size. Confirm conflicts and an active Git operation remain visible after changing views and that completed/failed fetch, pull, or push results appear once.

## Recorded walkthrough — 2026-10-22

I ran `dev.ps1` against a task-specific data directory and disposable local repositories. The first Electron window was behind the locked desktop, so I restarted the isolated session on a separate Vite port with CDP enabled and drove the actual Electron renderer through CDP. The temporary debug-port change in `scripts/dev-electron.mts` was reverted after the walkthrough. The task data directory was isolated from the normal dev profile.

- **Settings and shell:** New Git view was unchecked by default. Saving it on exposed History, Changes, and Review; saving it off restored classic Overview, Branches, Changes, Stashes, Pull Request, and Worktrees tabs.
- **Changes:** In a disposable repository with separated text hunks, one hunk staged while the other stayed unstaged. Stage/unstage worked for a tracked file and an untracked file. A staged-only commit created a commit containing only the staged hunk/file; the other notes hunk and untracked file remained in the worktree. Staged, unstaged, untracked, and conflicted states were visible in the expected groups.
- **History:** Local branch, remote branch, and tag options had distinct labels. Selecting a different reference left the working-branch label at `conflict-right`. A favorite was present when returning to its repository and absent from another root. At a 760 × 850 viewport, History and Changes remained reachable through the compact Tabs menu; Changes used the compact file/detail layout and offered inline diff.
- **Review and conflicts:** Review displayed the explained unlinked-PR state with an “Open pull request tools” action. During a real merge conflict, the conflict status and “Open conflict resolution” action remained visible while switching among History, Changes, and Review.
- **Long operation:** A delayed push remained marked “Pushing…” after switching through Review, Changes, and History. The shared in-progress card stayed visible. The successful push updated the local bare remote; a later hook-rejected push produced a visible Last result and one failed operation event. The notification thread contained one success event and one failure event, not duplicate events for either operation.
- **Visual evidence:** `evidence/changes-staging.png`, `evidence/history-wide.png`, `evidence/history-narrow.png`, and `evidence/changes-narrow.png` capture the staging layout, working-branch label, and compact History/Changes layouts.
- **Observed warning:** Resizing once produced a Chromium `ResizeObserver loop completed with undelivered notifications` renderer log entry. The UI remained interactive and rendered correctly after resizing; the warning did not recur during subsequent staging, view switching, or operation checks, so no code change was indicated by this run.

**Still unverified:** The isolated profile had no linked PR workspace or provider connection. I could not exercise a provider-owned PR diff, comment draft persistence in a linked review, or exclusion of local edits from a real provider diff. These provider-specific visual steps remain open; automated Review coverage is listed in `JUDGE_TODO.md`.

## Isolated linked-PR fixture follow-up — 2026-10-22

To investigate the remaining provider step without connecting to a real account, I created a task-local `Mock Azure PR QA` workspace backed by the existing Azure development fixture (`azure:1001`) and a disposable local repository. This verifies the Review rendering and pinned Git diff path with provider-shaped mock metadata; it is **not** a real Azure DevOps connection or provider-owned PR review.

- The Electron Review pane rendered the fixture PR identity, provider/repository, source and target refs, changed-file list, reviewer, pipeline status, and mock comment thread.
- After temporarily giving the fixture source/target commit IDs from the disposable repository, the Changes pane rendered the diff between those exact commits. A deliberately unstaged local-only line was absent, confirming the displayed diff was pinned to the fixture revisions rather than the worktree.
- Creating a standalone draft comment returned successfully and persisted in the isolated Review Bridge database (`azure:1001`, ready-to-sync). The fixture thread's Reply action failed because the mock thread was not represented in Review Bridge's comment context, so a draft reply round-trip through that thread was **not** verified. The earlier editor-dialog/view/file persistence steps were likewise not completed in this mock run.
- Screenshot: `evidence/provider-review-mock.png`.
- The temporary commit IDs in `src/stores/dev-mocks.ts` and CDP launch flag in `scripts/dev-electron.mts` were reverted. The fixture workspace, repository, and profile data are task-local ignored artifacts.

**Acceptance status:** this mock follow-up adds evidence for the renderer and pinned local Git diff only. It does not satisfy the open real linked-provider visual review or substitute for a user-authored waiver. Do not treat it as completion of that TODO item.
