# TODO

> Created: 2026-10-21 11:19:10
>
> The Worker updates this file as it progresses. You can pre-fill items before starting.
> The Task Runner checks that "In Progress" and "Blocked" sections are empty before completion.

## To Do

- [ ] Complete the user's visual review using `MANUAL_VERIFICATION.md` in their `dev.ps1` session; adjust anything they report.
- [ ] Finish remaining audit findings in `JUDGE_TODO.md`, including long operations and scoped read/draft lifecycle coverage.
- [ ] Re-run the full numbered self-audit against the current tree and update each requirement with verifiable evidence.
- [x] Commit implementation changes locally without pushing.

## In Progress

## Done

- [x] Add opt-in setting defaulting off, normalization, explicit boolean schema validation, Settings control, and safe nested merge coverage.
- [x] Add separate new-view selection and opt-in History / Changes / Review shell with a More path to preserved existing tools.
- [x] Add searchable read-only history ref selection, favorites and recent refs scoped by profile/workspace/root.
- [x] Record existing action/capability inventory in `IMPLEMENTATION_INVENTORY.md`.
- [x] Add audited stage/unstage file and commit-staged endpoints across Electron and remote transport; verify the commit consumes only the index.
- [x] Add diff-token-guarded stage/unstage hunk operations using backend diff preview, repository write lock and best-effort audit.
- [x] Persist selected view through workspace UI state and scope it by profile/workspace/root/PR.
- [x] Guard graph, branch, tag, compare, commit-diff and selected-file reads against stale responses.
- [x] Support untracked file staging and reverse cached hunk application for explicit hunk unstaging.
- [x] Add selectable multi-hunk controls and real-repository coverage for multiple hunks, rename/delete, binary, conflict and stale-token cases.
- [x] Route fetch/pull/push through the generic operation registry with idempotency, profile/workspace/root correlation, durable outcomes, event/payload dedupe and visible running state.
- [x] Render the provider-owned review pane in Review, keyed to the linked PR workspace so its provider diff and persisted drafts remain available.
- [x] Preserve staged commit messages across view changes and clear root-specific selections on root changes.
- [x] Add focused tests for new index operations, long-operation acceptance/deduplication, stale reads and Review routing.
- [x] Ensure More routes take precedence over History/Changes and expose Branches; require selected hunk text to match the token-verified server diff (`7aad383b`).
- [x] Require each staged/unstaged hunk patch to match an exact hunk and diff header from the current token-verified server diff; add a cross-file forged-patch regression.
- [x] Route local tag creation/deletion through the shared Git write lock and audit wrapper; preserve argv-level tag tests.
- [x] Pass the selected profile into History, make the mobile compact diff reachable, and show known/unknown last-fetch state.
- [x] Distinguish the HEAD history query from the all-branches query.
- [x] Keep a conflict resolution action in the shared Git frame and exercise More destination routing in GitPane tests.
- [x] Render operation outcomes inside Changes and send structured `{ ok: false }` mutation results through the standard error toast; GitChangesTab/store tests pass.
- [x] Add a typed two-revision file diff through Electron and remote transport; provider summaries now supply source/target commit IDs and Review compares those pinned commits instead of local branches or the working copy.
- [x] Re-run focused GitPane/History UI and GitManager tag/hunk tests, full lint, formatting check and safe production build; all pass. Full typecheck was subsequently restored and passes; remaining implementation work is still open.
- [x] Persist classic Changes commit text and selected paths by workspace/root, clear them only after successful commits, and clear staged-message completion against the captured root. Lifecycle tests pass.
- [x] Restore compact History commit-text search across message, author and hash, with a distinct no-match status; picker and GitPane UI suites pass.
- [x] Add the narrow Changes diff layer label, stage/unstage file and hunk actions, and commit-staged controls; its focused UI test passes.
- [x] Classify stage/unstage/commit-staged remote routes for mobile policy and correct the tag failure assertion; route policy (50), runtime/remote (212), focused GitManager (3), and GitPane/History/Changes/Review/store UI (110) tests pass.
- [x] Re-run project lint (0 errors; existing warnings, Prettier clean), watch-compatible production build, and focused UI/backend checks. The full Git backend run found and fixed the route-policy failure plus stale tag assertion; repository-wide typecheck was later restored.
- [x] Fix repository-wide TypeScript test errors in task-round, mobile invitation, SSH fixture, and component test typings; `npm run typecheck` passes.
- [x] Re-run project lint/format, full UI suite (214 files, 3,024 tests), focused Git UI, route policy (50), AppX config (9), and `npm run typecheck`; all pass.
- [x] Fix the E2E mock's missing `/git/diff-preview` fixture route; all nine responsive Git Changes viewport cases now pass.
- [x] Resolve backend codicon test failures by resolving Monaco's real installed package path instead of assuming a worktree-local `node_modules`; the two affected backend files pass 74 tests.
- [x] Persist the Settings → Git new-view checkbox through the dialog's form and save payload; integration coverage mounts the real tab and verifies the sibling `showAllActions` preference is preserved.
- [x] Reject caller-supplied Git roots outside a single-repository workspace before accepting long fetch operations; runtime regression and the full 509-test runtime suite pass.
- [x] Make History favorite/recent preferences reactive after localStorage updates; store and History component suites pass.
- [x] Deduplicate overlapping fetch/pull/push operations by profile, workspace, root, kind, and inputs, even when requests have distinct idempotency keys; runtime suite passes 510 tests.
- [x] Re-run repository verification on the current tree: typecheck, production build, lint/Prettier; current default-concurrency backend run showed load-related Git fixture failures; a four-worker full backend run now passes. User visual review and remaining audit items stay open.
- [x] Add a slow-fetch regression proving same-key Git operations in two profiles receive separate operation IDs and profile/workspace-scoped outcomes; the focused runtime test passes.
- [x] Verify PR Review uses pinned provider source/target revisions and excludes local unstaged edits; AzureReviewPane tests (28) and file-manager tests (37) pass.
- [x] Verify provider-owned saved Review drafts reappear after the AzureReviewPane is unmounted and reopened; all 29 AzureReviewPane tests and repository typecheck pass. Unsaved editor-dialog draft round-trip remains open.
- [x] Add a cross-root History stale-response test; the Git UI store suite passes 46 tests and repository typecheck passes. Correct stale audit notes for the already-fixed compact mobile diff path.
- [x] Preserve structured Git failure details (warnings, manual-resolution conflicts, bounded raw Git output) in long-operation outcomes; action-specific Notifications retain those diagnostics. The focused runtime and notification tests pass.
- [x] Add a History picker regression proving `HEAD` queries only `HEAD`, while “All branches and tags” uses the distinct all-ref query; focused test passes.
- [x] Refresh the stale Settings General visual snapshot from the current stable UI. Settings dialog E2E (5), full E2E (142 passed, 5 skipped), file-manager responsive E2E (1), and Git responsive E2E (10) pass.
- [x] Re-run the full UI suite after latest diagnostics and History query tests: 214 files, 3,028 tests pass.

- [x] Re-run full backend suite with reduced process pressure: `npm run test:backend -- --maxWorkers=4` passes 224 files / 5,459 tests (7 skipped); full default-concurrency run was unstable under Windows process load.
- [x] Re-run full typecheck and lint/Prettier after final audit/test/snapshot changes; both pass (lint 0 errors, 4,659 warnings).
- [x] Separate History refs from commit subjects into aligned columns on desktop and compact layouts; GitTreeGraph tests (13), typecheck, focused lint/format and safe production build pass.
- [x] Explain and fall back when a persisted More destination becomes unavailable, while preserving the stored destination for restoration; GitPane regression and the full UI suite pass.
- [x] Keep the shared Git operation status card visible in the new Review view, including its unlinked-PR empty state; focused GitPane tests pass.
- [x] Run merge/rebase, including optional fetch-first, inside the generic long-operation registry so disconnects cannot split fetch from integration; the runtime and Git UI regressions pass.
- [x] Route remote tag push, push-all-tags and remote tag deletion through the generic long-operation registry; validate remote payloads and verify operation deduplication.
- [x] Scope compact History ref/search state by profile/workspace/root, skip its hidden mobile branch-tree step, and prevent post-action diff refreshes from crossing repository roots.
- [x] Re-run full UI/backend suites, typecheck, lint/Prettier and the safe production build after this continuation; see JUDGE_TODO for results and remaining user/manual acceptance.
- [x] Reconcile the action inventory with current generic operation paths, guarded remote routes, scoped History state, and current healthy-check results; mobile route-policy suite passes all 50 cases.
- [x] Prevent duplicate same-action launches while a Git action is pending; store regression, typecheck, focused lint/format and safe build pass.
- [x] Emit local Git write audit entries for stage/unstage/hunk/index commit actions, including success/failure and resolved root; real-repository audit test and full GitManager suite pass.
- [x] Move force push and remote branch deletion into `OperationRegistry`; verify prompt acceptance, deduplication, outcome correlation, store waiting, typecheck and focused UI/runtime regressions. Local merge-into-base remains synchronous because it merges in a local sibling worktree.
- [x] Add explicit no-fetch/no-push assertions to read-only History ref browsing; focused GitBranchesTab tests pass (8).
- [x] Surface History tag-list read failures as an inline alert; GitBranchesTab suite passes (9), typecheck and safe production build pass.
- [x] Verify unsaved review editor text survives Review pane unmount because the app-level DialogOverlay remains mounted; focused AzureReviewPane integration regression passes.
- [x] Re-run AzureReviewPane tests after the dialog lifecycle addition (30 passed) and repository `npm run typecheck` (passes).
- [x] Preserve a scoped History ref selection while branch and tag reads are still loading; prevent initial empty lists from pruning persisted refs. GitBranchesTab suite (10) and repository typecheck pass; committed as `9b10429e`.
- [x] Verify current continuation: full UI suite passes 214 files / 3,040 tests; full backend suite passes 224 files / 5,465 tests (7 skipped, four workers); force-push/remote-delete runtime operation test and force-push store tests (2) pass; typecheck passes; full lint reports 0 errors (4,678 warnings), touched-file Prettier/ESLint pass; `VITE_BUILD_WATCH=1 npm run build` passes. The user visual walkthrough and remaining lifecycle/audit acceptance items remain open.
- [x] Retain a selected History ref visibly while branch/tag sources are loading, and avoid pruning saved refs when tag loading failed. `GitBranchesTab.test.ts` (10) and `npm run typecheck` pass; committed as `b8b2b7de`.
- [x] Refresh current-tree UI and project healthy checks after the History ref loading follow-up: full UI passes 214 files / 3,042 tests; repository typecheck, full lint (0 errors / 4,678 warnings, Prettier clean), and watch-compatible build pass. Full backend remains verified at 224 files / 5,465 passed / 7 skipped from the immediately preceding backend-code state. Manual `dev.ps1` walkthrough and remaining lifecycle/audit checks stay open.
- [x] Explain when a selected History ref disappears after successful branch/tag reads, and clear the notice when the user selects another ref. Focused GitBranchesTab suite passes 11 tests; typecheck, touched-file Prettier and diff check pass. Committed as `1ead33cc`.
- [x] Expand the read-only History picker regression to assert no local/remote checkout, branch create/rename/delete, tag create, worktree removal, fetch, or push calls. Focused GitBranchesTab suite passes 11 tests; typecheck, Prettier and diff check pass; committed as `273a5909`.

- [x] Extend the History read-only picker contract test to assert no local/remote checkout, branch create/rename/delete, remote branch delete, tag create, worktree removal, fetch, or push when selecting a ref. GitBranchesTab suite passes 11 tests; typecheck, Prettier and diff check pass; committed as `273a5909`.
- [x] Add compact History coverage for a repository with no commits and detached HEAD; verify the HEAD option, working-branch label, and empty graph state. GitBranchesTab suite passes 12 tests; Prettier and diff check pass; committed locally.
- [x] Commit empty/detached History regression as `276b50f6`.
- [x] Add compact History coverage for 400 refs and search filtering; GitBranchesTab suite passes 13 tests, repository typecheck passes, touched-file Prettier/ESLint and diff check pass. Committed as `9e62ee37`.
- [x] Verify History and Changes each render the shared operation card while a fetch is busy; GitBranchesTab/GitChangesTab suites pass 29 tests, repository typecheck and touched-file Prettier pass. Committed as `61c44782`.
- [x] Verify the History picker reads selection state with the active profile/workspace/root tuple; GitBranchesTab suite passes 14 tests, repository typecheck, Prettier and diff check pass. Committed as `530c7908`.
- [x] Cover a selected tag during a branch refresh with a failed tag read; History retains the selected ref and displays the tag-read alert. GitBranchesTab suite passes 15 tests; repository typecheck, touched-file Prettier and diff check pass. Committed as `473833d8`.
- [x] Re-run selected-ref pruning when branch/tag loading or error state changes, so successful empty ref reads prune stale saved selections instead of leaving them indefinitely. Regression verifies selection is retained while reads are pending then pruned with a status when both complete empty. GitBranchesTab suite passes 16 tests; typecheck, touched-file Prettier/ESLint and diff check pass. Committed as `fa4cd33b`.
- [x] Re-run full UI suite and safe production build after History ref-load fixes: 214 files / 3,049 UI tests pass; watch-compatible build passes. Repository typecheck passed after the changes. Backend sources are unchanged since the recorded 224 files / 5,465 passed / 7 skipped run. User visual walkthrough and remaining audit/lifecycle checks remain open.
- [x] Keep multi-selected branch refs while branch/tag data is pending or tag reads fail; prune them only after both sources are ready. Focused GitBranchesTab suite passes 16 tests; Prettier, ESLint and diff check pass. Committed as `d1e6b750`.
- [x] Re-run healthy-state checks on the current tree: UI 214 files / 3,049 tests; backend 224 files / 5,465 passed / 7 skipped; repository typecheck; full lint 0 errors / 4,678 warnings with Prettier clean; watch-compatible build. The manual walkthrough and remaining lifecycle/audit acceptance items stay open.
- [x] Keep large Git graph, diff, branch, and tag read payloads outside Vue deep reactivity with `markRaw`; store regression verifies graph commits and diff payloads are not reactive. Focused store suite (54), full UI suite (214 files / 3,050 tests), typecheck, focused ESLint/Prettier, and watch-compatible build pass; committed as `9512e01d`.
