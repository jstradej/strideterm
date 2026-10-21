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

**Provider fixture note:** The initial walkthrough used an unlinked workspace. The isolated mock-linked-PR follow-up below covers the provider-shaped visual path; no live Azure DevOps connection was used.

## Isolated linked-PR fixture follow-up — 2026-10-22

For the linked-PR visual acceptance, I created a task-local `Mock Azure PR QA` workspace backed by the existing Azure development fixture (`azure:1001`) and a disposable local repository. This verifies the Review rendering and pinned Git diff path with provider-shaped mock metadata; it does not use a live Azure DevOps connection.

- The Electron Review pane rendered the fixture PR identity, provider/repository, source and target refs, changed-file list, reviewer, pipeline status, and mock comment thread.
- After temporarily giving the fixture source/target commit IDs from the disposable repository, Review → Files rendered the diff between those exact commits. A deliberately unstaged local-only line was absent, confirming the displayed PR diff was pinned to the fixture revisions rather than the worktree.
- The isolated Review Bridge database was seeded with the fixture PR context, then the UI's **New comment → Create & queue** flow created a draft. I switched Git to Changes, selected the worktree file, returned to Review, switched to Files and selected a different PR file, then opened Comments. The draft remained visible as a queued PR-level comment. `evidence/provider-draft-roundtrip.png` captures the return state.
- The fixture thread's Reply action failed before this follow-up because no mock Review Bridge thread context existed. The verified draft flow is a new PR-level comment, not a reply to the provider thread.
- The Changes view showed only the disposable worktree's one unstaged modified file. In Review → Files, the selected PR file diff displayed the pinned base and target commit IDs and the PR changes while the workspace header still showed one uncommitted local change. The local-only unstaged line was absent from that pinned diff. `evidence/provider-pinned-diff-mock.png` captures the source and target hashes, PR file list, diff, and dirty-worktree indicator. `evidence/provider-review-mock.png` captures the PR summary metadata.
- The mocked PR metadata, local commits, and manually seeded Review Bridge context are isolated QA fixtures. No provider API connection, provider thread reply, or remote publication was exercised.
- The temporary commit IDs in `src/stores/dev-mocks.ts` and CDP launch flag in `scripts/dev-electron.mts` were reverted. The fixture workspace, repository, and profile data are task-local ignored artifacts.

**Acceptance status:** the linked-PR Review visual path was exercised in an isolated workspace using the application's Azure mock provider fixture and a disposable local repository. This verifies the UI acceptance path with deterministic provider-shaped data; it does not claim live provider connectivity or remote write acceptance.
