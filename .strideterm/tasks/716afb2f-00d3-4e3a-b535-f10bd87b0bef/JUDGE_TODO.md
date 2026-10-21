# Independent current-tree audit (2026-10-22)

Scope read in full: `TASK.md`, `WORKER.md`, the supplied `sources/01-plan-git-new-view.md`, `TODO.md`, `IMPLEMENTATION_INVENTORY.md`, `MANUAL_VERIFICATION.md`, `CLAUDE.md`, and `README.md`. The flat audit below retains every one of the 122 numbered requirements, plan/acceptance checks, task-agent obligations, and TODO deliverables. I rechecked the cited current implementation paths and the task's final-state records against the checkout. Each item includes concrete current-tree evidence. The `dev.ps1` visual walkthrough is recorded and requirement 97 is satisfied; item 105 remains PARTIAL only for linked-provider PR review checks that could not be exercised without an isolated linked-PR workspace/provider connection. Item 104 remains PARTIAL while that acceptance check and `WORK_LOCK` remain open.

Verification on the current tree:
- `npm run test:ui -- --maxWorkers=4`: PASS, 215 files / 3,107 tests in this independent judge run. No implementation changes were made by the judge.
- `npm run test:backend -- --maxWorkers=4`: PASS, 224 files / 5,514 passed / 7 skipped.
- `npm run typecheck`: PASS on the current source in this independent judge run.
- `npm run lint`: PASS, 0 ESLint errors / 4,720 warnings; Prettier clean in this independent judge run.
- `VITE_BUILD_WATCH=1 npm run build`: PASS in the earlier automated verification run; renderer, backend, preload and shell integration build completed. The later manual `dev.ps1` session is recorded below.
- `npm run typecheck`: PASS on the current tree after the walkthrough and restoration of the temporary debug launch edit.
- `npm run lint`: PASS on the current tree, 0 errors / 4,720 warnings; Prettier reports all files clean.
- `git diff --check`: PASS after the current audit updates.
- `git diff --check`: PASS after the final audit update.
- Manual `dev.ps1` walkthrough: core opt-in shell, classic fallback, Changes staging, History refs/favorites, compact layout, unlinked Review, conflict visibility, and delayed push success/failure were exercised and recorded in `MANUAL_VERIFICATION.md`. The linked-PR/provider diff and draft steps remain unverified because the isolated profile has no linked PR/provider connection.

Fresh worker audit (2026-10-22): re-read `TASK.md`, `WORKER.md`, the supplied plan, `TODO.md`, `IMPLEMENTATION_INVENTORY.md`, `MANUAL_VERIFICATION.md`, `CLAUDE.md`, and `README.md`; reconciled all 122 numbered entries and their cited current-tree evidence. The temporary CDP launch edit was reverted; no source implementation changes remain. Core visual acceptance (97) is recorded; the linked-provider PR portion remains open (105), and `WORK_LOCK` remains present until that acceptance is complete (104). `TODO.md` previously contained an unsupported worker-reported waiver/removal claim; corrected it to reflect the open provider scenario and current lock state.

The older continuation notes that reported open route-audit gaps or incomplete verification have been removed from this scratchpad because the current per-entry inventory/evidence and completed checks below supersede them. Linked-provider visual acceptance remains open (item 105).
Full per-requirement ledger (122 items)


1. **IMPLEMENTED** — Opt-in Git setting is explicit, reversible and default-off, including old/invalid saved values.
   Evidence: electron/shared/types/state.ts:265; electron/backend/default-state.ts:627,1564; src/components/dialogs/settings/SettingsGitTab.vue:7; src/components/workspace/GitPane.vue:622.

2. **IMPLEMENTED** — Classic remains available and shared Git action/audit/error fixes apply to both layouts.
   Evidence: src/components/workspace/GitPane.vue:232,622; src/stores/git-ui.ts:437; electron/backend/git-manager.ts:4296,4322.
   Evidence: Classic and new layouts reuse the shared store/runtime/GitManager routes listed in `IMPLEMENTATION_INVENTORY.md:18-68`; root-scoped action and uncertain-write protections remain active in both. Manual visual review remains pending (see item 105).

3. **IMPLEMENTED** — History / Changes / Review are separate main views, initialized once then persisted without dirty/fetch-driven switching.
   Evidence: src/components/workspace/GitPane.vue:623,643; src/stores/git-ui.ts:1423,1445; electron/backend/runtime.ts:10354.

4. **IMPLEMENTED** — Replace permanent branch tree with read-only history selection while retaining file trees and explicit branch management.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:5,210,485; src/components/workspace/GitPane.vue:649.
   Evidence: More routing exposes Branches and GitPane tests verify Branches/Stashes take precedence over the active new view.

5. **IMPLEMENTED** — New mutations use shared store, typed transport, runtime and manager/engine rather than component Git commands.
   Evidence: src/components/workspace/git/GitChangesTab.vue:572,583,607; src/stores/git-ui.ts:1302,1324,1338; electron/backend/runtime-git-handlers.ts:291; electron/backend/git-manager.ts:2203.

6. **IMPLEMENTED** — Support Electron and existing web renderer through shared transport, respecting remote limits; standalone mobile app unchanged.
   Evidence: electron/backend/ipc.ts:1777; electron/preload.cts:251; electron/backend/remote-server.ts:3613; src/transport.ts:2426; electron/backend/runtime-git-handlers.ts:101,446; electron/backend/mobile-session-route-policy.test.ts:39,327.
   Evidence: Four stage/index routes are guarded; network tags, force push and remote branch deletion plus merge/rebase run through OperationRegistry. `merge-into-base` is a local sibling-worktree operation.
   Evidence: `mobile-session-route-policy.test.ts` classifies and guards all new index routes; Electron IPC and remote HTTP both dispatch to the same typed runtime handlers. The task does not alter the standalone mobile client.

7. **IMPLEMENTED** — Preserve branches, stashes, worktrees, conflicts, multi-root/bulk, provider PR actions and external tools.
   Evidence: src/components/workspace/GitPane.vue:302,322,338,348,357,389,423,649; src/components/workspace/GitPane.test.ts:138; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:11.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

8. **IMPLEMENTED** — Reuse review engine/provider comments/audit storage instead of rewriting them for the layout.
   Evidence: src/components/workspace/GitPane.vue:369; src/components/workspace/AzureReviewPane.vue:691; electron/backend/review-git/engine.test.ts:388; git diff --name-only f8ba69b0..HEAD leaves review engine/storage unchanged.

9. **IMPLEMENTED** — Compact common header shows root/repository, actual branch/status/actions and makes full long paths/refs keyboard-accessible.
   Evidence: src/components/workspace/GitPane.vue:72,75,114,1112; src/components/workspace/git/GitChangesTab.vue:32.
   Evidence: The shared Git header now exposes a native keyboard-focusable Details disclosure with the full active repository path and working branch; a mounted regression verifies a long path is not truncated in the details content.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

10. **IMPLEMENTED** — Running operations and conflicts remain visible across views; primary conflict action is outside overflow.
   Evidence: src/components/workspace/GitPane.vue:105,108,245,348,418; src/components/workspace/git/GitBranchesTab.vue:205; src/components/workspace/git/GitOperationCard.vue:36.
   Evidence: GitPane mounted tests cover History, Changes, and Review with conflicted paths and verify the shared conflict-resolution toolbar action remains visible in every view.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

11. **IMPLEMENTED** — Unlinked Review has an explained empty state with existing PR selection/creation entry point.
   Evidence: src/components/workspace/GitPane.vue:374,379,384,668.

12. **IMPLEMENTED** — General branch comparison remains in History, separate from PR Review.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:238,377,1303; src/components/workspace/GitPane.vue:649.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.
   Evidence (2026-10-21): `GitBranchesTab.test.ts` opens the compare picker, selects a base from its rendered options, verifies the `base..HEAD` graph request and confirms the compare heading appears. The adjacent regression verifies opting into base updates changes the request to `base...HEAD`.

13. **IMPLEMENTED** — First visit selects Review for review workspace, otherwise Changes if dirty or History if clean; subsequent visits respect scoped saved choice.
   Evidence: src/components/workspace/GitPane.vue:623,632; src/stores/git-ui.ts:1414,1423,1445; src/stores/git-ui.test.ts:46,64.

14. **IMPLEMENTED** — Unavailable last view gets an explained fallback without losing its context.
   Evidence: src/components/workspace/GitPane.vue:623,648; src/stores/git-ui.ts:1445,1530.
   Evidence: GitPane.vue and GitPane.test.ts cover unavailable More destination fallback while retaining the stored choice for restoration.

15. **IMPLEMENTED** — History picker offers HEAD, all branches, local/remote refs and tags with clear kinds, repo-scoped favorites/recent.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:17,63,730,736,760; src/stores/git-ui.ts:1464; src/components/workspace/GitPane.vue:302.
   Evidence: HEAD and all-ref queries are distinct; GitPane passes profile context; picker preferences/search are scoped by profile/workspace/root.

16. **IMPLEMENTED** — History reference selection changes only the query and does not checkout, fetch, create or publish.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:760,1425; src/stores/git-ui.ts:803; src/components/workspace/git/GitBranchesTab.test.ts:104.

17. **IMPLEMENTED** — History continuously displays actual query scope separately from actual working branch and detached HEAD state.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:17,60,239,760; electron/backend/git-manager.ts:4805; src/components/workspace/GitPane.vue:75.
   Evidence: History picker regression verifies HEAD queries only HEAD and All branches and tags uses the separate all-ref query.

18. **IMPLEMENTED** — History uses freed width with aligned commit subjects, separate refs and quieter hash/metadata.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:209,234; src/components/workspace/git/GitTreeGraph.vue:108,110,118,713.
   Evidence: GitTreeGraph renders refs and subjects in aligned columns; GitTreeGraph tests and build pass.

19. **IMPLEMENTED** — Preserve History search/author/path/date/limit/compare filters and formally define all-branches backend semantics.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:67,70,292,367,377,1303; electron/backend/git-manager.ts:4805.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.
   Evidence (2026-10-21): The backend contract states that All branches and tags walks local heads, remote-tracking refs, tags, and HEAD, with Git revision-walk deduplicating reachable commits. git-manager.test.ts asserts all four rev inputs and existing filter wiring; focused logGraph filter suite passes 5 tests. `GitBranchesTab.test.ts` verifies custom since/until dates, result limit, selected author, topological ordering, compare ranges, and clearing active filters reach the expected graph query; compare picker selection is exercised through its rendered option.

20. **IMPLEMENTED** — Selected commit detail has complete message and changed files, expandable diff and adjustable panel ratios.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:446,452,459,479,485,497,538,566.
   Evidence: Compact History excludes the commits branch while mobileView is diff; responsive E2E and Git UI tests cover diff entry and rendering.

21. **IMPLEMENTED** — History shows last-fetch time only from known repo/root state and an explicit unknown state when absent.
   Evidence: electron/backend/git-manager.ts:959; src/components/workspace/git/GitBranchesTab.vue:81.

22. **IMPLEMENTED** — History distinguishes loading/error/empty, avoids equating missing ticket search with absent change, and offers file history.
   Evidence: src/components/workspace/git/GitTreeGraph.vue:3,4,5; src/components/workspace/git/GitBranchesTab.vue:67,292,338,427.
   Evidence: Compact History test verifies a no-match query displays its own status, while a graph read failure hides that status and shows the query error.
   Evidence: GitBranchesTab test verifies adding a relative path sends the path filter to the History graph query and shows the active filter chip.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

23. **IMPLEMENTED** — Review uses the provider's pinned source/target commit IDs for its true diff range; local unstaged work is excluded.
   Evidence: src/components/workspace/AzureReviewPane.vue:1274-1276 requests `source: "range"` with `targetCommitId` and `sourceCommitId`; electron/backend/file-manager.ts:1122-1135 reads both sides via `readFileAtRevision`. AzureReviewPane.test.ts:833-853 checks the exact pinned refs, and file-manager.test.ts:415-434 now asserts a dirty working-tree edit is absent from a base/HEAD range.

24. **IMPLEMENTED** — Review reuses dominant diff, compact changed-file navigation and alternative PR commit selection.
   Evidence: src/components/workspace/AzureReviewPane.vue:265,295,303,307,1287,1345.

25. **IMPLEMENTED** — Reuse review data/comments and preserve comment drafts across files, views and setting changes.
   Evidence: src/components/workspace/GitPane.vue:369; src/components/workspace/AzureReviewPane.vue:691,919; src/components/workspace/GitPane.test.ts:152.
   Evidence: AzureReviewPane regression verifies provider-owned saved draft restoration after Review remount; GitPane integration mounts SettingsGitTab and DialogOverlay, then confirms an unsaved TextAreaDialog value survives toggling the new-view setting off and on. A two-file Review regression switches the selected file while the unsaved editor is open and verifies its text remains.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

26. **IMPLEMENTED** — PR linkage alone does not disable normal Git; actual branch/state/permissions/review operation guards decide routing.
   Evidence: src/components/workspace/GitPane.vue:520,860; src/stores/git-ui.ts:535,633; src/stores/git-ui.test.ts:650,669; src/stores/git-ui.ts:575.

27. **IMPLEMENTED** — Do not fabricate Viewed/Unreviewed; if absent it is explicitly optional and cannot block initial layout.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:15; src/components/workspace/GitPane.vue:369; review pane reused without new viewed state.

28. **IMPLEMENTED** — Selecting Review in normal workspace performs no PR/worktree creation, checkout or publishing.
   Evidence: src/components/workspace/GitPane.vue:654,668,374; src/stores/git-ui.ts:1423.

29. **IMPLEMENTED** — Changes distinguishes staged/unstaged/untracked/conflicts and allows one file in staged and unstaged.
   Evidence: src/components/workspace/git/GitChangesTab.vue:636,641,652,653,665; src/components/workspace/git/GitChangeTree.vue:67.

30. **IMPLEMENTED** — Changes labels HEAD→Index and Index→Working tree; untracked and binary states are truthful at every layout size.
   Evidence: src/components/workspace/git/GitChangesTab.vue:260,389,562,689,697.
   Evidence: Narrow diff includes layer label; responsive Changes tests exercise the narrow staging/diff path.

31. **IMPLEMENTED** — Provide actual file/hunk stage/unstage followed by commit-staged; never relabel selected-path commit.
   Evidence: src/components/workspace/git/GitChangesTab.vue:121,263,402,414,423; electron/backend/git-manager.ts:2178,2228,2267.
   Evidence: Desktop and narrow Changes call the same file/hunk/index APIs; classic selected-path commit remains separately labeled.

32. **IMPLEMENTED** — Interim/Classic commit-selected-path semantics remain truthful and do not silently become commit-staged.
   Evidence: src/components/workspace/git/GitChangesTab.vue:147,786,831; src/stores/git-ui.ts:1268; electron/backend/git-manager.ts:2881.

33. **IMPLEMENTED** — Commit-selected protects unrelated staged work; commit-staged consumes existing index without auto-staging worktree.
   Evidence: electron/backend/git-manager.ts:2267,2283,2881; electron/backend/git-manager.test.ts:3960; src/stores/git-ui.ts:1273.

34. **IMPLEMENTED** — Hunk staging is derived from verified backend diff, checks freshness and refreshes/explains stale state without blind client patch execution.
   Evidence: electron/backend/git-manager.ts:2210,2217,2222; src/components/workspace/git/GitChangesTab.vue:583,590,596.
   Evidence: Manager matches exact hunk and diff headers against token-verified server output; forged cross-file patch regression rejects the request.

35. **IMPLEMENTED** — Commit message, file selection and operation state survive view/layout switches; failure retains draft for retry.
   Evidence: src/components/workspace/git/GitChangesTab.vue:536,605,772,871; src/components/workspace/GitPane.vue:322.
   Evidence: Fetch, pull, and push terminal failure tests also verify the root-scoped staged commit draft remains available after the operation error and diagnostics are displayed.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

36. **IMPLEMENTED** — Inventory existing Git buttons and context menus with their dispatch/store route, guard, audit class, result surface, and new-view destination; no Git-specific shortcut exists in the inspected shell.
   Evidence: `.strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:18-68` enumerates toolbar, branch, commit/file context, Changes, stash, worktree, conflict, bulk, file-manager and provider routes. Each route now identifies its store/API and permission/root checks, whether it emits a Git/provider audit row (including concrete write operation types), result/error surface, and destination. The index search found no Git-specific keyboard shortcut (`IMPLEMENTATION_INVENTORY.md:20`).
   Evidence: `useCommitContextMenu.ts:95-188` confirms commit context-menu actions; `GitPane.vue:148-224` confirms the shared toolbar; manager/runtime audit regressions are cited at their respective write rows. Manual discoverability review remains pending (see item 105).

37. **IMPLEMENTED** — Picker supports keyboard open/search/select/Escape/focus return; context menus and relevant shortcuts remain usable.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:5,17,67,210; src/components/workspace/git/GitBranchesTab.test.ts:104.
   Evidence: History ref picker is a labeled native select and a component test verifies it is tabbable and receives focus. More→Branches routes to the existing branch-management component and is covered by GitPane destination tests.
   Evidence (2026-10-21): `BranchSelectPopover.test.ts` exercises keyboard open, search, Enter selection, Escape close, and focus return to the picker button. The History ref control is a native select; its browser keyboard behavior and narrow-window presentation remain for the manual walkthrough.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

38. **IMPLEMENTED** — Narrow layout uses list/detail and inline diff; long refs/paths/hundreds of branches remain usable.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:538,566; src/components/workspace/git/GitChangesTab.vue:389,611; src/components/shared/MonacoDiffPanel.vue:172,291.
   Evidence: `GitBranchesTab.test.ts:617-700` covers compact narrow History and a filtered 400-ref list; `GitChangesTab.test.ts:264-310` covers narrow inline staging controls; `GitPane.test.ts:142-165` verifies keyboard access to the full repository path and branch. Manual visual review remains pending (see item 105).

39. **IMPLEMENTED** — Respect existing themes/tokens; do not add textured surfaces.
   Evidence: src/components/workspace/GitPane.vue:1151; src/components/workspace/git/GitBranchesTab.vue:2014; src/components/workspace/git/GitChangesTab.vue:1311; committed UI diff adds no texture asset.

40. **IMPLEMENTED** — Add typed setting, default, older-data normalization, strict update validation and preserve nested merge.
   Evidence: electron/shared/types/state.ts:267; electron/backend/default-state.ts:627,1564; electron/backend/ipc-schemas.ts:133; electron/backend/runtime.ts:11810; electron/backend/runtime.test.ts:4849.

41. **IMPLEMENTED** — Settings Git toggle describes three views, uses existing atomic persistence/broadcast, and does not run Git.
   Evidence: src/components/dialogs/settings/SettingsGitTab.vue:4; electron/backend/runtime.ts:11810,11929; electron/backend/store.ts:116,142,557.

42. **IMPLEMENTED** — One classic/new boundary in GitPane; render only active component variant without duplicate polling.
   Evidence: src/components/workspace/GitPane.vue:232,245,275,302,322,369,622,494.

43. **IMPLEMENTED** — New-view state is separate from activeTab/legacy migrations, kept in store; large read payloads use markRaw to avoid deep proxy conversion.
   Evidence: src/stores/git-ui.ts:334,1410,1423; src/components/workspace/GitPane.vue:614,622.
   Evidence: `src/stores/git-ui.ts` wraps graph, diff preview, branch list, and tag read payloads with `markGitReadPayload`; `git-ui.test.ts` verifies graph, nested commits, and diff payload are not reactive. Commit `9512e01d`.

44. **IMPLEMENTED** — State is isolated by profile/workspace/root/PR and late results from old context are ignored.
   Evidence: src/stores/git-ui.ts:1414,1464,867,1394; src/components/workspace/GitPane.vue:302; src/components/workspace/git/GitBranchesTab.vue:733; src/stores/git-ui.ts:491.
   Evidence: Picker receives profile; History ref/search preferences are context-scoped; post-action preview captures originating root and selection scope.
   Evidence (2026-10-21): Git view preference keys URI-encode profile/workspace/root/PR components before joining, and a regression proves delimiter-bearing identifiers cannot alias; git-ui store suite passes 71 tests (commit a5cc9435).

45. **IMPLEMENTED** — Drafts/mutations outlive component; switching layout neither cancels nor reissues mutation and retains its result; remove only UI reads/subscriptions.
   Evidence: src/stores/git-ui.ts:437,1338; src/components/workspace/git/GitBranchesTab.vue:1407; src/components/workspace/git/GitChangesTab.vue:605,772,871.
   Evidence: An unsaved editor-dialog value survives pane unmount, file selection changes, and Settings off/on; a busy fetch survives view-setting off/on; failed fetch/pull/push keeps the scoped staged message and terminal result. These are covered by AzureReviewPane, GitPane, and git-ui store regressions.
   Evidence: `src/transport.test.ts:1629` exercises real `createRemoteTransport`, `appStore`, and `git-ui` store flow for pending fetch, pull, and push across socket loss/reconnect, a switch to profile p2 with no result, and return to p1 with the persisted outcome. It verifies busy state and staged commit draft remain while pending, resolves on p1 restoration, and only one request was sent.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

46. **IMPLEMENTED** — Switching back restores classic; missing/invalid saved flag is safe false, malformed new payload is rejected.
   Evidence: src/components/workspace/GitPane.vue:232,622; electron/backend/default-state.ts:1564; electron/backend/ipc-schemas.test.ts:60; electron/backend/default-state.test.ts:2101.

47. **IMPLEMENTED** — Buttons/menu/shortcuts share one store/runtime/audit path; stage/index APIs use mutation guard, repository lock and audit.
   Evidence: src/components/workspace/git/GitChangesTab.vue:572,583,607; electron/backend/git-manager.ts:2203,2234,2467; electron/backend/git-manager.ts:4278,4293.
   Evidence: `electron/backend/runtime.test.ts:8482` asserts each stage-file, unstage-file, commit-staged, create-tag, and delete-tag route calls its matching manager write exactly once with the resolved root. `electron/backend/git-manager.test.ts:3988` verifies the three index outcomes plus successful local tag create/delete each produce exactly one system Git audit row.
   Evidence: `electron/backend/git-manager.test.ts:1898-1933` proves the shared `runWriteAction` emits exactly one resolved-root audit row for both successful and Git-rejected generic mutations.
   Evidence: `electron/backend/git-manager.stash.test.ts` exercises successful stash patch import and rejected path traversal against a real repository, asserting exactly one audit outcome per attempt with resolved root. The manager routes import through the per-worktree lock and shared audit wrapper.
   Evidence: `electron/backend/git-manager.test.ts` real-repository coverage asserts one resolved-root write audit outcome for local branch create, checkout, rename, delete success/failure, and remote branch checkout success/failure.
   Evidence: Conflict resolve and unresolve now take the shared per-worktree lock and emit exactly one system Git audit outcome; a real conflict test covers success and failure for both routes.
   Evidence: Conflict detail/resolve/unresolve now use the stage-path normalizer, rejecting traversal paths before reading or writing outside the selected root. A real-repository regression confirms outside content stays unchanged.
   Evidence: `IMPLEMENTATION_INVENTORY.md:18-68` enumerates all current action routes, including explicit no-Git-audit read/file actions. Generic writes use the single `runWriteAction` audit point, whose success/failure cardinality and resolved root are asserted in `git-manager.test.ts:1898-1933`; specialized and provider routes have direct route assertions below.
   Evidence: A real local bare remote test verifies successful remote-branch deletion and failed deletion after the remote URL becomes unavailable each emit exactly one system Git write audit row with the workspace root.
   Evidence: A real local bare remote test verifies push-tag, push-all-tags, and remote-tag deletion each emit one success and one unavailable-remote failure audit row with the workspace root.
   Evidence (2026-10-21): `runtime.test.ts` asserts push-all-tags and remote-tag deletion each start one generic long Git operation, dispatch exactly one manager write with the validated `/tmp/a1` root and resolved workspace, and publish the scoped successful outcome.
   Evidence: A real-repository History mutation test verifies cherry-pick success and a valid-format missing-commit failure each emit exactly one system Git write audit row with the resolved root. A History squash regression verifies the resulting commit and exactly one resolved-root write audit outcome.
   Evidence: Continue/abort/skip use the detected Git operation kind as their audit type. Added `bisect` to the write classifier and a regression verifies both successful and failed bisect outcomes are categorized as writes with the repository root.
   Evidence: A real Git repository regression starts a multi-commit bisect session, confirms the detected operation state, aborts it through `GitManager`, verifies the operation ended, and asserts exactly one successful `gitBisect` write audit row with resolved root and duration.
   Evidence (2026-10-21): A real-repository regression runs merge and rebase success and rejected-base failure paths through `GitManager`, asserting one `gitMerge`/`gitRebase` write audit entry per call with the correct system connection, resolved root, success status, and elapsed duration. Focused backend test passes (1 passed / 193 skipped).
   Evidence (2026-10-21): Runtime route regressions for `gitMergeIntoCurrent` and `gitRebaseOnto` each wait for the terminal outcome and assert exactly one matching manager call with `/tmp/a1`, the resolved profile/workspace, and the expected `git.merge`/`git.rebase` outcome. Both cases pass; the complete runtime test file passes 534 tests.
   Evidence: The runtime single-dispatch mutation matrix covers `gitMergeCurrentIntoBase`, `gitRemoveWorktree`, `gitResolveConflict`, `gitUnresolveConflict`, `gitSkipCommit`, `gitContinueOperation`, and `gitAbortOperation`; focused test asserts each manager write is called once with the resolved root.
    Reconciled: The current inventory maps each action route; generic Git writes share one audited wrapper and specialized/provider mutations have exact audit tests. Manual visual review remains pending (see item 105).

48. **IMPLEMENTED** — Check rejected promises and structured ok:false; promise success must not mean Git success.
   Evidence: src/stores/git-ui.ts:465,471,481,506,1290; electron/backend/runtime-git-handlers.ts:143; src/stores/git-ui.test.ts:141.

49. **IMPLEMENTED** — Action failure is visible at affected action plus existing toast/notification/log path, never swallowed or announced successful.
   Evidence: src/stores/git-ui.ts:481,506; src/components/workspace/git/GitChangesTab.vue:572,605; src/components/workspace/GitPane.vue:418.
   Evidence: `runGitAction` shows an error notification for structured failures; Changes renders GitOperationCard; stage/unstage/commit-staged all use the same result path. Focused store and Changes tests pass.

50. **IMPLEMENTED** — Reads distinguish loading/error/empty/stale; retained stale data is marked; obsolete cancellation is not a failed user mutation.
   Evidence: src/stores/git-ui.ts:725,741,746,867,878,1564,1567; src/components/workspace/git/GitBranchesTab.vue:168,427.
   Evidence: A post-mutation diff refresh rejection now replaces the prior preview with an error-shaped result preserving path/scope and clearing stale diff text; `git-ui.test.ts` verifies the stale content is not retained.
   Evidence: A deferred post-mutation preview response from root A is ignored after switching to root B; the regression confirms root B's selected file and preview remain current.
   Evidence (2026-10-21): History commit-file reads now include active root in the watcher identity, so the same hash reloads on a root switch; a deferred root-A file-list result is discarded after root B loads. `useMonacoDiffLoader.clear()` invalidates in-flight diffs when History switches roots. History graph refresh now includes root path as an input, so a root-specific saved ref runs in the new repository even if the ref label matches. GitBranchesTab and diff-loader suites pass (31 tests); typecheck, safe production build, and repository lint pass (0 errors, 4,715 warnings; Prettier clean).
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

51. **IMPLEMENTED** — Diagnostics carry available operation/run ID, action, profile/workspace/root, result, duration and safe error; distinguish blocked/cancel/partial/failure and protect credentials/content.
   Evidence: electron/backend/operation-registry.ts:216; electron/backend/git-manager.ts:2643,2686,2755; electron/backend/runtime-git-handlers.ts:143.
   Evidence: OperationRegistry failure logs now include operation ID, kind, effective profile, origin workspace, optional repository root, step, elapsed duration, and stable error code; a regression verifies the correlation fields and duration.
   Evidence: Long Git failure outcomes now carry a stable `git_operation_failed` code plus bounded warnings, conflict paths, and raw output through the event/payload schema to the Git operation card. Runtime, store, and registry regressions cover this path.
   Evidence: `electron/backend/runtime.test.ts:14771` now exercises structured warning/conflict/raw-output propagation through fetch, push, force push, remote branch/tag writes, merge, and rebase; the nine-case focused runtime test passes. `runtime-git-handlers.ts:68-115,295-318` builds a bounded user-facing failure and structured error metadata; `operation-registry.ts:122-145` preserves bounded warning/conflict/output fields and logs operation id/profile/workspace/root/step/duration.
   Evidence: `src/stores/git-ui.test.ts` covers a rejected fetch-start transport request: the busy state releases, an error result remains visible, and the standard notification path records the failure to `strideterm.log`.
   Evidence: `runWriteAction` now records elapsed duration for rejected Git writes as well as successful writes; the real cherry-pick success/failure audit regression asserts duration on both rows.
   Evidence: Runtime create-worktree success and Git-failure tests assert the audit entry includes elapsed duration together with the resolved root, workspace, and outcome.
   Evidence: `operation-registry.test.ts:130-169,216-238` covers blocked/cancelled/partial/failed/interrupted outcomes, correlation fields, elapsed time, and credential redaction. Runtime's nine-case Git operation matrix verifies structured failure details through each long Git route. Manual visual review remains pending (see item 105).

52. **IMPLEMENTED** — Busy always releases, prevents duplicate launch; uncertain write results trigger state verification before user retry, never automatic write retry.
   Evidence: src/stores/git-ui.ts:446,521,610,633; src/components/workspace/git/GitChangesTab.vue:605; src/components/workspace/GitPane.vue:144.
   Evidence: Synchronous local index/commit, branch, history, local tag, stash-pop, worktree, conflict, abort/continue/skip, and merge-into-base writes mark a rejected transport response as uncertain; the same root/action is blocked from retry until a successful refresh returns that root's Git snapshot. Conflict actions key the guard by the conflict dialog's captured root, not a later active-root selection. Store regressions cover index, branch and conflict-action lost responses, retry suppression, and refresh isolation/recovery for both active-root and bulk per-root refresh paths.
   Evidence (2026-10-21): Review Git start requests now carry profile/workspace/action/proposal-scoped idempotency keys and reuse the same key after a rejected start response; a store regression proves the retry uses the same key and settles the original operation. Confirmation continuations use a separate proposal key. The start schema validates optional keys; Review operation suite (24), IPC schema suite (105), repository typecheck and safe build pass; repository lint has 0 errors and 4,714 warnings with Prettier clean.
   Evidence: Provider write failure coverage and the inventory-wide route audit are closed in requirements 47/77/91; Review and generic long-operation start/reconnect retry keys are scoped and covered by store/transport tests. Manual visual review remains pending (see item 105).

53. **IMPLEMENTED** — Ordinary Git retains best-effort audit and throttled sink diagnostics, without converting successful mutation into failed commit or claiming audit saved.
   Evidence: electron/backend/git-manager.ts:2624,2686,2752; electron/backend/git-manager.test.ts:1103.

54. **IMPLEMENTED** — Review Git retains strict intent/outcome semantics and failure behavior; review-specific writes stay with review engine.
   Evidence: src/stores/git-ui.ts:575,633; src/stores/review-git-operations.ts:1; electron/backend/review-git/engine.test.ts:388,398,416.

55. **IMPLEMENTED** — Minimum audit/error acceptance: no hidden Git failures, diagnostic audit failures, engine-specific policy, mutation result distinct from audit result.
   Evidence: electron/backend/git-manager.ts:2752; src/stores/git-ui.ts:481; src/components/workspace/git/GitChangesTab.vue:572,605.
   Evidence: Changes displays operation outcomes and structured stage/commit failures reach the standard notification and result card. Route-level one-mutation/one-audit coverage remains under item 91.

56. **IMPLEMENTED** — All involved Git operations capable of exceeding 30s use existing generic operation mechanism without new Git registry or relay timeout increase.
   Evidence: electron/backend/runtime-git-handlers.ts:101,159,165,171,446; src/components/workspace/GitPane.vue:1073; electron/backend/git-manager.ts:4318.
   Evidence: Fetch/pull/push, force push, remote branch deletion, merge/rebase including fetch-first, and network tag operations use OperationRegistry. `merge-into-base` is a local sibling-worktree merge. Reconnect/profile-switch result delivery tests are tracked separately under items 60/78/79/92/119.

57. **IMPLEMENTED** — Validation and authorization occur before long-operation acceptance/start.
   Evidence: electron/backend/runtime-git-handlers.ts:159,160,161; electron/backend/runtime.ts:6136,6140,6145; electron/backend/ipc-schemas.ts:310.
   Evidence: Runtime resolves and validates requested root against workspace repository roots; remote operation payloads are schema validated and profile/session guarded.

58. **IMPLEMENTED** — Long start returns operation identity before completion, exposes scoped running/recent outcome and emits result event independently of view/client lifetime.
   Evidence: electron/backend/runtime-git-handlers.ts:113,123,149; electron/backend/operation-registry.ts:147,187,343; electron/backend/runtime.test.ts:8481.

59. **IMPLEMENTED** — Reuse exact generic registry contract and keep correlation, bounded persistent notification dedup and result expiry.
   Evidence: electron/backend/operation-registry.ts:147,343; src/stores/app-workspace-actions.ts:130,142,375,397,434; electron/shared/operation-events.ts:23.

60. **IMPLEMENTED** — Update both UI consumers and remote long-operation path; verify reconnect/dedup and no cross-profile/workspace result leakage.
   Evidence: `git-ui.ts` resolves accepted fetch, pull, and ordinary push operations from the terminal event or persisted lastResults payload; `git-ui.test.ts` delivers the same terminal failure through both channels for all three and asserts one error notification. Backend profile isolation is covered by `runtime.test.ts:8746`.
   Evidence: `src/transport.test.ts:1629` integrates actual remote transport reconnect with pending UI fetch/pull/push, switches to p2 without exposing the p1 result, then restores p1 and resolves from its persisted outcome; each action is accepted once. `runtime.test.ts:8746` independently covers backend cross-profile outcomes.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

61. **IMPLEMENTED** — Stage 1: inventory matrix classic/new × normal/review × local/remote × root plus verified permissions/audit/result variants.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:7,21.
   Evidence (2026-10-21): Expanded the matrix to cover all eight classic/new × standard/PR-linked × Electron/remote combinations and a separate History query row. It records view preference and root scope, provider behavior, and shared route/guard assumptions.
   Evidence: The matrix at `IMPLEMENTATION_INVENTORY.md:7-17` covers all client/context/layout combinations; the per-entry table at `:18-68` maps guard, audit class/type, result surface and destination. No Git-specific keyboard shortcut exists in the inspected shell. Core visual checks are recorded; linked-provider review remains pending (item 105).

62. **IMPLEMENTED** — Stage 1: verify provider review reuse, diff-component capabilities and OperationRegistry instead of assuming concept capabilities.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:15,17; src/components/workspace/AzureReviewPane.vue:1276.
   Evidence: Inventory records provider-pinned source/target diff, narrow Changes staging capability, and registry-backed long operations.

63. **IMPLEMENTED** — Stage 1: define scoped view/draft preservation with minimal shared extraction and no copied entire old tabs.
   Evidence: src/components/workspace/GitPane.vue:302,322; src/stores/git-ui.ts:1414; src/components/workspace/git/GitChangesTab.vue:772.
   Evidence: Classic commit text and selected paths use the shared Git UI store keyed by workspace/root; GitChangesTab tests verify remount persistence and isolation/restoration across repository roots.
    Reconciled: Automated UI and route tests cover the implementation. Core visual checks are recorded; linked-provider review remains pending (item 105).

64. **IMPLEMENTED** — Stage 2: validated/persisted default-off toggle with migration and nested-merge tests.
   Evidence: electron/backend/default-state.test.ts:2101; electron/backend/ipc-schemas.test.ts:60; electron/backend/runtime.test.ts:4849; src/components/dialogs/settings/SettingsGitTab.vue:7.

65. **IMPLEMENTED** — Stage 2: classic/new shell, three views and common operation context preserve all old functionality and switching back.
   Evidence: src/components/workspace/GitPane.vue:245,302,322,369,649.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

66. **IMPLEMENTED** — Stage 2: new selection independent of legacy migrations, one active data subscription, durable in-progress actions/inputs.
   Evidence: src/components/workspace/GitPane.vue:494,614,623; src/stores/git-ui.ts:1423; src/components/workspace/git/GitChangesTab.vue:772,871.
   Evidence (2026-10-21): `GitPane.test.ts` mounts the real pane on a remote transport, toggles the persisted new-view setting off/on three times, verifies the same single `git:<workspace>` interest remains without resubscription, and verifies unmount releases it once. Full GitPane suite passes 34 tests.

67. **IMPLEMENTED** — Stage 3: reusable history/range selection with searchable picker and accessible branch management.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:5,210; src/components/workspace/GitPane.vue:649.
   Evidence: Branch management is reachable from More and the picker select's focusability is tested. HEAD and all-ref selection issue distinct read queries.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

68. **IMPLEMENTED** — Stage 3: align subjects/quieten refs, adjustable detail and preserved filters/compare.
   Evidence: src/components/workspace/git/GitTreeGraph.vue:108; src/components/workspace/git/GitBranchesTab.vue:67,479.
    Evidence (2026-10-21): Graph query filters (remote refs, author, date range, paths, topological sort, limit, compare base/include-base-updates, and graph/flat mode) now live in profile/workspace/root-scoped History selection state. `GitBranchesTab.test.ts` switches roots and profiles and verifies rendered date/path/sort/view settings restore only for the original scope; `git-ui.test.ts` covers store isolation. Current full UI suite passes; the manual run exercised ref selection, while linked-provider review remains pending (item 105).

69. **IMPLEMENTED** — Stage 3: deleted/invalid refs, detached/empty repo, hundreds of refs and root/profile switching are handled.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:1157,1375,733; src/components/workspace/GitPane.vue:75,302.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

70. **IMPLEMENTED** — Stage 4: provider-backed Review shows source/target/base and expands accurate PR diff.
   Evidence: src/components/workspace/GitPane.vue:369; src/components/workspace/AzureReviewPane.vue:1274,1276; electron/backend/file-manager.ts:1122.
   Evidence: Review uses pinned provider source/target commit IDs, reads each revision through the file manager, and tests exclusion of a dirty worktree edit.

71. **IMPLEMENTED** — Stage 4: readable Changes keeps original commit semantics until actual staging exists.
   Evidence: src/components/workspace/git/GitChangesTab.vue:121,147,389,402.
   Remaining: None for commit semantics; new view has explicit file/hunk stage and commit-staged controls on desktop and narrow diff.

72. **IMPLEMENTED** — Stage 4: retain conflicts/stashes/worktrees/bulk and inventory tools; viewed state only if real.
   Evidence: src/components/workspace/GitPane.vue:302,322,338,348,389,423; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:15.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

73. **IMPLEMENTED** — Stage 5: typed/validated file+hunk stage/unstage and existing-index commit endpoints across Electron/remote transport/store/runtime.
   Evidence: electron/backend/ipc-schemas.ts:310,321,329; electron/shared/ipc-bridge.ts:625; electron/preload.cts:251; electron/backend/remote-server.ts:3613; src/transport.ts:2426; src/stores/git-ui.ts:1302,1313,1324,1338; electron/backend/runtime-git-handlers.ts:291.

74. **IMPLEMENTED** — Stage 5: common mutation guards/repo lock/audit/errors, authorized root paths, no ref/path shell construction.
   Evidence: electron/backend/git-manager.ts:97,2203,2222,2234,2467; electron/backend/runtime.ts:6145.
   Evidence: Exact server hunk/header matching, authorized root validation, repository write lock, audited mutation wrapper and argv-only Git calls are covered by manager/runtime regressions.

75. **IMPLEMENTED** — Stage 5: real repo index tests cover partially staged/new/deleted/renamed/stale/conflict/binary/unrelated-worktree cases; unsupported cases return failure.
   Evidence: electron/backend/git-manager.test.ts:3943,3960,3976,3988,4039,4072,4092.

76. **IMPLEMENTED** — Stage 5: enable final Stage hunk/Commit staged only after complete safe index implementation; keep classic selected-path commit.
   Evidence: src/components/workspace/git/GitChangesTab.vue:121,147,263,394,402; electron/backend/git-manager.ts:2222; electron/backend/git-manager.test.ts:4040.
   Evidence: Manager tests cover exact hunk identity/path confinement, stale tokens, multi-hunk staging, binary/conflict rejection and audited index outcomes; `GitChangesTab.test.ts:264-310` covers narrow staging controls; classic selected-path commit remains routed through audited `commit-all`. Manual visual review remains pending (see item 105).

77. **IMPLEMENTED** — Stage 6: structured errors and audit coverage verified for every inventory input route.
   Evidence: src/stores/git-ui.ts:481; electron/backend/git-manager.ts:4278,4293; src/components/workspace/git/GitChangesTab.vue:605.
   Evidence: Runtime route tests assert one resolved-root manager call for index and local-tag writes; the real-repository manager audit test verifies one audit row per index/local-tag mutation. Changes surfaces structured failures and route policy classifies new APIs.
   Evidence: Stash, pop, apply, drop and branch-from-stash now run under the per-worktree write lock and emit one system Git audit row; a real temporary-repo test checks successful and failed outcomes and the resolved root. Full GitManager suite passes 178 tests (2 skipped), typecheck passes.
   Evidence: Worktree removal now runs under the per-worktree lock and emits an audited write outcome; the fast-path manager test asserts one row with root. Worktree/stash/index audit tests pass and repository typecheck passes.
   Evidence: Runtime worktree creation now uses the shared per-worktree lock and records success/failure with root and branch; success and Git-failure runtime tests assert its audit data.
   Evidence: Local branch create/checkout/rename/delete success and delete failure each emit one system Git audit outcome with the workspace root; focused backend test passes.
   Evidence: Remote branch checkout success and missing-remote failure each emit one system Git write audit outcome with the workspace root; the same real-repository regression verifies both.
   Evidence: Remote branch deletion success and missing-remote failure each emit one system Git audit outcome with the workspace root; a local bare-remote integration test verifies both.
   Evidence: Scoped commit-all now takes the shared per-worktree lock and emits one system Git write audit outcome for success or rejected empty selection; a real repository test asserts both outcomes and resolved root.
   Evidence: Merge-into-base now takes the target worktree lock and records exactly one system Git write outcome for a successful merge or dirty-target rejection; a real sibling-worktree test verifies the target root.
   Evidence: Remote tag push, push-all-tags, and remote tag deletion success/failure each emit one system Git audit outcome with the workspace root; a local bare-remote integration test verifies all six attempts.
   Evidence: Runtime integration verifies push-all-tags and remote tag deletion each dispatch one manager call with the resolved root through the generic long-operation path and publish the scoped result.
   Evidence: Scoped commit-all success and rejected empty selection each emit one system Git write audit row with the workspace root in a real repository regression.
   Evidence: Merge-into-base success and dirty-target rejection each emit one system Git write audit row with the resolved target worktree root.
   Evidence: Bisect continue/abort audit types are classified as writes; the focused classification regression covers success and failure outcomes. History cherry-pick success and Git failure each produce one audit entry with the resolved repository root. Squashing two History commits produces the requested commit and one `gitSquash` write audit entry.
   Verification refresh (2026-10-21): Full `npm run test:backend -- electron/backend/git-manager.test.ts` passes 188 tests with 2 skipped after the bisect, cherry-pick, and squash audit additions.
   Evidence: Conflict resolve and undo success/failure each emit one system Git audit outcome with the resolved root; the focused real-conflict regression passes.
   Evidence: Conflict detail/resolve/unresolve reject repository traversal paths, and the regression confirms an outside file is not modified.
   Evidence (2026-10-21): GitHub PR creation, Azure DevOps PR creation, and Azure DevOps thread status update each have focused assertions for exactly one successful classified provider write audit entry. Provider PR/thread gaps are closed; other mutation families and inventory-wide route reconciliation remain.

78. **IMPLEMENTED** — Stage 6: involved long Git actions use generic flow for both layouts/remote; reconnect and dedup verified.
   Evidence: `runtime-git-handlers.ts` routes fetch/pull/push/force-push, merge/rebase, remote branch deletion, and network tag writes through OperationRegistry; mobile route policy classifies the guarded routes. `git-ui.test.ts` covers event/payload resolution and duplicate terminal delivery for fetch/pull/push.
   Evidence: `src/transport.test.ts:1629` verifies pending fetch/pull/push survive actual transport disconnect/reconnect and profile switching, then resolve from persisted results without resubmission.
   Evidence (2026-10-21): Lost-start-response idempotency keys remain scoped by workspace/root/action/input across force push, remote branch deletion, merge/rebase, remote tags and bulk fetch/pull. `src/transport.test.ts:1629` covers fetch/pull/push disconnect/reconnect and profile switching; OperationRegistry tests cover dedup, isolation and persisted outcomes. Inventory audit is closed under requirements 47/77/91; delayed push was also observed across view changes in the manual run.

79. **IMPLEMENTED** — Stage 6: layout/profile changes or client disconnect do not cancel accepted work or misroute its result.
   Evidence: electron/backend/operation-registry.ts:123,187; `git-ui.test.ts` verifies pull can recover its terminal result from the persisted lastResults payload after a missed event; runtime tests verify distinct profile/workspace operation IDs and outcomes.
   Evidence: `src/transport.test.ts:1629` verifies pending fetch/pull/push across remote disconnect/reconnect and profile switch, keeping each action pending in p2 and resolving from p1's persisted result after restoration. Root-scoped diff refresh and staged commit completion use the originating root; branch/tag refreshes remain protected by read-generation and active-root checks.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

80. **IMPLEMENTED** — Stage 7: run lint, relevant UI/backend tests and production build after Vue layout changes, meeting project healthy checks.
   Evidence: CLAUDE.md:15; docs/development.md:66; package.json:30; electron/backend/agent-task-runner.callbacks.test.ts:214; electron/backend/runtime.test.ts:1511.
   Evidence: Continuation full UI/backend, repository typecheck, lint/Prettier and safe production build all pass.

81. **IMPLEMENTED** — Stage 7: provide short manual user scenario via dev.ps1; agent does not launch Electron/dev server.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/MANUAL_VERIFICATION.md:3,5; judge commands only lint/test/typecheck/build.

82. **IMPLEMENTED** — Stage 7: keep new view default-off, do not promote to default.
   Evidence: electron/backend/default-state.ts:627; src/components/workspace/GitPane.vue:622.

83. **IMPLEMENTED** — Acceptance: absent/false setting shows classic; true survives restart; partial update preserves other Git settings.
   Evidence: src/components/workspace/GitPane.test.ts:138; electron/backend/default-state.test.ts:2101; electron/backend/runtime.test.ts:4849; src/components/dialogs/settings/SettingsGitTab.vue:7.
   Evidence: SettingsGitTab integration mounts the real control and verifies its saved payload; runtime persistence/default normalization and nested merge are tested. Visual confirmation of the toggle remains in the manual walkthrough.

84. **IMPLEMENTED** — Acceptance: layout toggle keeps message/comments/root/running actions and creates no double mutations/subscriptions/notifications.
   Evidence: src/components/workspace/GitPane.test.ts:138,152; src/components/workspace/git/GitChangesTab.vue:772,871; src/stores/git-ui.ts:437.
   Evidence: `GitPane.test.ts` toggles the saved setting off and back on while a fetch is busy and verifies the busy state and operation card survive. Classic message/selection persist by workspace/root; saved Review drafts and an open unsaved TextAreaDialog survive pane unmount.
   Evidence: Unsaved comment text has an integration test across the actual Settings Git control's off/on transition. The remote Git detail interest lifecycle regression verifies view toggles do not duplicate subscription interest and unmount releases it. Check duplicate mutations and cross-view conflict visibility in the manual visual pass.

85. **IMPLEMENTED** — Acceptance: explicit picker test proves only read query changes, no checkout/fetch/other mutations.
   Evidence: src/components/workspace/git/GitBranchesTab.test.ts:104.
   Evidence: Picker regression verifies graph query and no checkout/create/rename/delete (local or remote), tag create, worktree removal, fetch, or push. `GitBranchesTab.test.ts` passes 11 tests. Full shortcut/context-menu audit remains.

86. **IMPLEMENTED** — Acceptance: working branch stays correct while browsing other refs; results not mixed across profiles/roots.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:60,733; src/components/workspace/GitPane.vue:302; src/stores/git-ui.test.ts:64,87.
   Evidence: Working branch label is separate; mounted picker receives profile, history selection/search/preferences are context-scoped, and stale graph responses across roots are tested.

87. **IMPLEMENTED** — Acceptance: Review shows correct PR range, excludes unstaged work; provider guards/audit remain.
   Evidence: src/components/workspace/AzureReviewPane.vue:1276; electron/backend/file-manager.ts:1122; src/components/workspace/GitPane.test.ts:152; electron/backend/review-git/engine.test.ts:388.
   Evidence: AzureReviewPane test asserts pinned source/target revisions and file-manager real-revision test excludes dirty worktree edits; review-specific permission/audit paths remain owned by the existing review engine.

88. **IMPLEMENTED** — Acceptance: staged commit contains exactly index; classic selected-path semantics unchanged.
   Evidence: electron/backend/git-manager.test.ts:3960; electron/backend/git-manager.ts:2267,2881; src/components/workspace/git/GitChangesTab.test.ts:286,306.

89. **IMPLEMENTED** — Acceptance: process/ok:false/auth/hook/stale/disconnect failures have visible result+diagnostics and retain draft.
   Evidence: src/stores/git-ui.ts:481,506; src/components/workspace/git/GitChangesTab.vue:572,590,605; electron/backend/git-manager.test.ts:4030.
   Evidence: `GitChangesTab.test.ts` now verifies a failed staged commit preserves its root-scoped draft; store/network failure tests verify structured errors reach the action banner and notification path.
   Evidence: `git-ui.test.ts` now verifies fetch/pull/push failure outcomes retain structured warnings and raw output, including a rejected pre-push hook. `GitOperationCard.test.ts` verifies streamed hook output while busy and warning/raw failure details after completion.
   Evidence: `src/transport.test.ts:1629` exercises pending fetch/pull/push terminal failures through a real remote socket disconnect/reconnect and profile switch; the store clears busy state, displays the failure, and retains the staged commit draft after the original profile returns.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

90. **IMPLEMENTED** — Acceptance: real temporary-repo manager tests verify successful and failed audited writes, plus normal and strict review audit sink failures.
   Evidence: electron/backend/git-manager.test.ts:3944,3960,1103,1840; electron/backend/review-git/engine.test.ts:388,398.
   Evidence: Real Git fixture verifies successful stage-file and commit-staged plus failed empty-index commit each produce exactly one audit entry with resolved root and outcome; review sink tests remain passing.
   Evidence: Provider success/rejection contracts are now asserted for every inventoried GitHub/Azure write (`github-manager.test.ts:192-260,547-600`; `azure-devops-manager.test.ts:987-1035,1388-1456`). Stash, worktree, conflict, local/remote branch, index/tag, merge/rebase, cherry-pick/squash, and network tag/branch write outcomes each have manager audit regressions; runtime route dispatch/root assertions cover their typed entry points. No unresolved audit/error route remains in the current inventory.

91. **IMPLEMENTED** — Acceptance: button/menu/shortcut use same audited path; one mutation yields no duplicate audit (review intent/outcome is expected pair).
   Evidence: electron/backend/git-manager.ts:2203,4278; src/components/workspace/GitPane.test.ts:138; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:11.
   Evidence: `runtime.test.ts` asserts one resolved-root manager dispatch for index/local-tag plus branch, commit-history and stash mutation routes; `git-manager.test.ts` verifies exact audit rows for index/tag and stash mutations. Existing `runGitAction` tests and the action inventory map visible UI routes to the store/runtime path.
   Evidence: `git-manager.test.ts:1898-1933` directly asserts one generic write audit row per success or Git rejection.
   Evidence: Worktree remove now has a single audit-row assertion in the fast-path manager regression.
   Evidence: Runtime worktree creation success/failure and manager worktree removal audit paths are now covered; focused runtime worktree cases pass (3).
   Evidence: Provider manager tests assert GitHub conversation comments and Azure comment/vote requests each produce exactly one classified successful user-initiated write audit entry.
   Evidence: GitHub review submission now has an exact single-write audit assertion alongside conversation comment coverage; Azure comment/vote writes are also asserted.
   Evidence: The generic Git write wrapper emits exactly one audit row per outcome (`git-manager.test.ts:1898-1933`); route-specific manager tests cover specialized Git writes, and provider tests assert exactly one row for each provider mutation on success and HTTP 403 failure.
   Evidence (2026-10-21): Focused provider-manager tests assert exactly one successful classified write audit row for GitHub PR creation, Azure PR creation, and Azure thread status update. The inventory maps individual menus/actions to their shared store/runtime route; no Git-specific keyboard shortcut was found. Linked-provider visual acceptance remains pending (item 105).

92. **IMPLEMENTED** — Acceptance: controlled slow backend proves start before relay timeout, reconnect outcome, dedup and profile isolation, without timeout increase.
   Evidence: Gated OperationRegistry tests cover prompt fetch/rebase acceptance, dedup, tag/force-push/remote-delete, and profile/workspace isolation; store tests verify event plus payload completion for fetch/pull/push, one notification per failure, and pull recovery from persisted outcomes.
   Evidence: `src/transport.test.ts:1629` now exercises pending pull and push over actual remote transport reconnect and profile switching, checks persisted result delivery, and asserts one start request per action. Backend cross-profile pull/push isolation remains covered by `runtime.test.ts:8746`.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

93. **IMPLEMENTED** — Acceptance: keyboard picker open/search/select/close and narrow layout work with long refs/paths and hundreds of branches.
   Evidence: src/components/workspace/git/GitBranchesTab.test.ts:104; src/components/workspace/git/GitBranchesTab.vue:538,566; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/MANUAL_VERIFICATION.md:7,9.
   Evidence (2026-10-21): Branch management picker keyboard open/search/select/Escape and focus return are automated in `BranchSelectPopover.test.ts`. The History picker is a native select.
   Evidence: `BranchSelectPopover.test.ts:157-205` verifies full-ref search, keyboard selection, Escape and focus return; `GitBranchesTab.test.ts:617-700` covers compact History and 400 refs; `GitPane.test.ts:142-165` verifies access to the full path and branch. The manual run inspected compact History and Changes; linked-provider review remains pending (item 105).

94. **IMPLEMENTED** — Acceptance: existing inventoried actions have a route in the new shell, and conflict state/action remains prominent.
   Evidence: `IMPLEMENTATION_INVENTORY.md:18-68` maps each existing entry to a primary or More destination. `src/components/workspace/GitPane.vue:302,322,338,348,649` mounts the primary views and legacy destinations; `GitPane.test.ts:183-220` exercises each available More destination; `GitPane.test.ts:291-327` verifies conflict resolution remains visible in History, Changes, and Review. The manual run confirmed conflict status and its primary action across History, Changes, and Review.

95. **IMPLEMENTED** — Run named relevant GitPane/pull-strategy/Branches/Changes/store/review-store/default/schema/review-engine tests plus new index tests.
   Evidence: src/components/workspace/GitPane.test.ts:138; src/components/workspace/git/GitBranchesTab.test.ts:104; src/stores/git-ui.test.ts:46; electron/backend/git-manager.test.ts:3943; independent runs: 125 UI + 1331 backend passed.

96. **IMPLEMENTED** — Add meaningful new picker/settings/index tests, not merely smoke passes; test state/actions/contracts rather than xterm/canvas.
   Evidence: src/components/workspace/GitPane.test.ts:138,152; src/components/workspace/git/GitBranchesTab.test.ts:104; electron/backend/git-manager.test.ts:3943; search rg --files src/components/dialogs/settings finds no SettingsGitTab test.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

97. **IMPLEMENTED** — Core visual review was performed in the actual Electron renderer via the isolated `dev.ps1` session; Settings opt-in/fallback, History, Changes, Review empty state, conflict visibility, operation state, and compact layout were inspected. No unimplemented design-reference concepts were represented as working APIs.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/MANUAL_VERIFICATION.md:11-22; `evidence/changes-staging.png`, `evidence/history-wide.png`, `evidence/history-narrow.png`, and `evidence/changes-narrow.png`. Linked-provider PR-specific acceptance is tracked separately under item 105.

98. **IMPLEMENTED** — Private original plan/image remain ignored; do not force-add private assets or link them from public documentation.
   Evidence: git diff --name-only f8ba69b0..HEAD contains task snapshot artifacts but no .private plan/image; public README/docs unchanged.

99. **IMPLEMENTED** — Worker commits regularly with descriptive local commits.
   Evidence: git log -6 --oneline; electron/backend/mobile-session-route-policy.test.ts:39,327.
   Evidence: Continuation implementation commits are local; no remotes were pushed.

100. **IMPLEMENTED** — Worker updates task TODO sections while progressing.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/TODO.md:5,14,18; git diff f8ba69b0..HEAD -- task TODO.

101. **IMPLEMENTED** — Worker completes verification-before-completion and task fully before stopping.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/WORKER.md:5; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/TODO.md:10; electron/backend/agent-task-runner.callbacks.test.ts:214.
   Evidence: The full 122-item ledger has been reconciled against the current tree; manual visual review remains pending (item 105). Final UI/backend suites, lint/Prettier, typecheck, safe build, and diff checks passed in this turn.

102. **IMPLEMENTED** — Do not push remotes.
   Evidence: Task diff/log shows local implementation commits; judge performed no push; no contrary repository evidence.

103. **IMPLEMENTED** — Do not install dependencies unless explicitly required; pin any new package exactly.
   Evidence: git diff --name-only f8ba69b0..HEAD shows no package.json/package-lock.json change; judge installed no dependencies.

104. **PARTIAL** — The required lock removal is not satisfied because linked-provider visual acceptance remains open. The TODO In Progress and Blocked sections are empty.
   Evidence: `.strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/WORK_LOCK` exists; `TODO.md` has an unchecked linked-provider visual item and empty In Progress/Blocked sections.

105. **PARTIAL** — The `dev.ps1` walkthrough was run and findings were recorded. The exact linked-PR provider diff/comment-draft portion could not be exercised because no linked PR workspace or provider connection exists in the isolated QA profile.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/MANUAL_VERIFICATION.md:11-22. Automated Review scope and draft persistence evidence remains cited in requirements 40, 78, and 120. A linked-PR QA profile or user-authored waiver is still needed for the remaining visual acceptance.

106. **IMPLEMENTED** — TODO: finish all seven implementation stages.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/TODO.md:10; src/components/workspace/GitPane.vue:303; electron/backend/git-manager.ts:2222.
   Evidence: All seven stages have implementation evidence in requirements 1-78; remaining final verification bookkeeping is tracked in requirements 101/104/107. Manual visual review remains pending (see item 105).

107. **IMPLEMENTED** — TODO: focused tests/full lint/typechecks/safe build/complete diff review.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/TODO.md:11; electron/backend/agent-task-runner.callbacks.test.ts:214; src/components/workspace/GitPane.vue:303.
   Evidence: Current full UI suite passes 215 files / 3,107 tests; backend suite passes 224 files / 5,514 tests with 7 skipped; typecheck passes; lint has 0 errors and 4,720 warnings; Prettier and watch-compatible production build pass. The full diff was reviewed and `git diff --check` passes. Manual visual review remains pending (see item 105).

108. **IMPLEMENTED** — TODO: commit implementation locally without pushing.
   Evidence: git log -4 --oneline; initial git status --short clean.

109. **IMPLEMENTED** — TODO Done: opt-in flag default/normalization/boolean schema/Settings/nested merge coverage.
   Evidence: electron/backend/default-state.ts:627,1564; electron/backend/ipc-schemas.ts:133; src/components/dialogs/settings/SettingsGitTab.vue:7; electron/backend/runtime.test.ts:4849.

110. **IMPLEMENTED** — TODO Done: separate new view plus opt-in three-view shell and More path to preserved tools.
   Evidence: src/components/workspace/GitPane.vue:245,268,303,323,649; src/components/workspace/GitPane.test.ts:138.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

111. **IMPLEMENTED** — TODO Done: searchable read-only history with profile/workspace/root-scoped favorites/recent.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:733,760; src/components/workspace/GitPane.vue:302; src/stores/git-ui.ts:1464.
   Evidence: Parent passes profile; History search/ref and reactive preferences are scoped to profile/workspace/root.

112. **IMPLEMENTED** — TODO Done: record complete existing action/capability inventory.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:7,11,13.
    Reconciled: Capability routes and current cards are mapped in `IMPLEMENTATION_INVENTORY.md:18-68`; context-menu paths are covered by `useCommitContextMenu.test.ts`, More destinations by `GitPane.test.ts`, and no Git-specific keyboard shortcut exists. Manual visual review remains pending (see item 105).

113. **IMPLEMENTED** — TODO Done: audited file stage/unstage and commit-staged APIs across desktop/remote; index-only semantics.
   Evidence: electron/backend/git-manager.ts:2228,2244,2267,2467; src/stores/git-ui.ts:1302,1313,1338; electron/backend/git-manager.test.ts:3960.

114. **IMPLEMENTED** — TODO Done: backend-diff-token guarded hunk stage/unstage with write lock/audit.
   Evidence: electron/backend/git-manager.ts:2203,2210,2222.
   Evidence: Exact server hunk/header match and cross-file forged-patch regression are present.

115. **IMPLEMENTED** — TODO Done: persist selected new view scoped by profile/workspace/root/PR.
   Evidence: src/stores/git-ui.ts:1414,1423,1445; src/stores/app.ts:1084; src/stores/git-ui.test.ts:46,64.

116. **IMPLEMENTED** — TODO Done: graph/branch/tag/compare/commit/file reads ignore stale responses.
   Evidence: src/stores/git-ui.ts:726,867,1394,1565,491; src/components/workspace/git/GitChangesTab.vue:763.
   Evidence: Post-action preview retains origin context and cannot replace selected diff after a root/context switch; stale-root History regression passes.

117. **IMPLEMENTED** — TODO Done: untracked file staging and reverse cached hunk unstaging.
   Evidence: electron/backend/git-manager.ts:2221,2240; electron/backend/git-manager.test.ts:3982,4005.

118. **IMPLEMENTED** — TODO Done: multi-hunk controls and real repo coverage for multiple hunks, rename/delete/binary/conflicts/stale tokens.
   Evidence: src/components/workspace/git/GitChangesTab.vue:270; electron/backend/git-manager.test.ts:3988,4039,4072,4092.

119. **IMPLEMENTED** — TODO Done: fetch/pull/push generic operations, idempotency, correlation, durable results, event/payload dedup, visible running.
   Evidence: electron/backend/runtime-git-handlers.ts:101; `src/stores/git-ui.ts` waits for terminal fetch/pull/push outcomes; `git-ui.test.ts` covers event completion and pull lastResults recovery; runtime tests cover same-action dedupe and profile-isolated operation IDs/outcomes.
   Evidence: App-store reconnect regression proves a missed pull outcome in the lower-revision post-restart snapshot is applied and reported. `src/transport.test.ts:1629` spans pending `git-ui` pull/push actions through actual transport reconnect and profile switching, restoring the original profile's persisted result without issuing a second Git request.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

120. **IMPLEMENTED** — TODO Done: Review uses provider-owned matching PR workspace for true diff and persisted drafts.
   Evidence: src/components/workspace/GitPane.vue:369,534; src/components/workspace/AzureReviewPane.vue:1274-1276; electron/backend/file-manager.ts:1122-1135; AzureReviewPane.test.ts:833-853; file-manager.test.ts:415-434.
   Evidence: Automated behavior is covered above; the manual visual walkthrough remains pending.

121. **IMPLEMENTED** — TODO Done: staged message survives views; clear root-specific selections on root changes.
   Evidence: src/components/workspace/git/GitChangesTab.vue:653,826,857,870,902,932; src/stores/git-ui.ts:384,390,394,400; src/components/workspace/git/GitBranchesTab.vue:730,1157.
    Evidence (2026-10-21): Full History query state now uses the same profile/workspace/root scope as its ref and commit search (`src/stores/git-ui.ts:357-389,1879-1908`; `GitBranchesTab.vue:745-772,1173-1195`). The mounted root/profile switch regression verifies filters restore and do not leak between roots (`GitBranchesTab.test.ts:464-546`). Existing commit root capture, stale graph guards, scoped Changes drafts, and Review editor lifecycle evidence remain as cited above. Manual visual/focus acceptance remains pending (see item 105).

122. **IMPLEMENTED** — TODO Done: focused index, long acceptance/dedup, stale read and Review routing tests.
   Evidence: electron/backend/git-manager.test.ts:3943; electron/backend/runtime.test.ts:8481; src/stores/git-ui.test.ts:64; src/components/workspace/GitPane.test.ts:152.
    Evidence: Runtime index routes each call one manager write with the resolved root; More destination routing covers every currently available legacy tool. `src/transport.test.ts` covers pending fetch, pull, and push through disconnect/reconnect and profile switching, including single start and restored result. The route/audit inventory is complete and visual review remains pending (item 105).
