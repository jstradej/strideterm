# Independent judge audit

Task: 716afb2f-00d3-4e3a-b535-f10bd87b0bef
Initial independent review: 862c3f6a. Worker continuation review: current tree after dced0ea3 plus narrow Changes and mobile route classification fixes; working tree has not yet been committed.

Read TASK.md, WORKER.md, the entire supplied source snapshot, TODO.md, IMPLEMENTATION_INVENTORY.md, MANUAL_VERIFICATION.md, CLAUDE.md, README.md and development check guidance. This is the flat requirement ledger: repeated stage/acceptance/TODO requirements are deliberately retained so their completion claims are independently auditable. The source architecture table describes the starting system, rather than adding separate deliverables. The concept image is illustrative; pixel matching and optional viewed-state were not made requirements.

Verification run independently:

- npm run lint: PASS, exit 0; ESLint reports 0 errors and 4650 warnings; Prettier passes.
- npm run test:ui -- src/components/workspace/GitPane.test.ts src/components/workspace/GitPane.pull-strategy.test.ts src/components/workspace/git/GitBranchesTab.test.ts src/components/workspace/git/GitChangesTab.test.ts src/stores/git-ui.test.ts src/stores/review-git-operations.test.ts: PASS, 6 files / 125 tests.
- npm run test:backend -- electron/backend/default-state.test.ts electron/backend/ipc-schemas.test.ts electron/backend/git-manager.test.ts electron/backend/runtime.test.ts electron/backend/review-git electron/backend/operation-registry.test.ts electron/backend/remote-server.test.ts electron/backend/process-utils.test.ts: PASS, 14 files / 1331 tests passed, 4 skipped, 231.34 seconds. No process-utils test file was selected; its changes were reviewed in the diff and exercised through the real Git manager tests.
- VITE_BUILD_WATCH=1 npm run build: PASS, exit 0; full renderer/backend/preload build. The environment flag follows CLAUDE.md and preserves a possible existing dev watch. Neither Electron nor a dev server was launched.
- npm run typecheck: FAIL, exit 1. Representative errors: electron/backend/agent-task-runner.callbacks.test.ts:214 (TaskRound.judgeVerdict missing), electron/backend/runtime.test.ts:1511,1528,1544 (possibly undefined savedWorkspace), src/components/layout/RemoteAccessPanel.test.ts:85,100 (missing source), plus runtime QR/invitation, SSH and component-test type errors. Failure is recorded regardless of whether it predates this task; the judge rule does not permit a deterministic-failure waiver.
- git diff --check f8ba69b0..HEAD: PASS.
- Continuation: npm run test:backend -- electron/backend/mobile-session-route-policy.test.ts: PASS, 50 tests after explicitly classifying `/api/git/stage-file`, `stage-hunk`, `unstage-file`, and `commit-staged` as guarded routes; this policy applies workspace/profile checks.
- Continuation: focused backend runtime/remote tests PASS, 212 tests (one skipped). Focused GitManager index/tag error tests PASS, 3 tests.
- Continuation: GitPane/History/Changes/Review/store UI suites PASS, 110 tests, including the new narrow Changes staging controls test. Focused Changes suite alone PASS, 14 tests.
- Continuation: npm run test:backend -- electron/backend/git-manager.test.ts electron/backend/runtime.test.ts electron/backend/mobile-session-route-policy.test.ts: still FAIL overall (732 passed, 2 skipped, 2 failures before fixes). The mobile route failure is fixed and its test passes; tag failure wording now asserts the actual structured stderr message and its focused test passes. Runtime test process completed without further failures. Re-run the full trio after the fixes.
- npm run test:ui -- src/stores/app-operations.test.ts src/transport.test.ts: PASS, 2 files / 129 tests. Generic delivery tests do not replace Git-specific reconnect verification.
- Continuation full typecheck remains FAIL with unrelated existing test typings (TaskRound.judgeVerdict, nullable runtime test values, SSH and component test types); frontend/backend/preload production build typechecks and succeeds. User visual verification in dev.ps1 remains pending and agent did not launch the app.

Concrete reproductions / code review findings:

- Hunk confinement failure reproduced in a new temporary Git repository using the built GitManager. Both a.txt and b.txt were edited; stageHunk({path:'a.txt', diffToken: previewA.diffToken, hunk: previewB.diff}) returned {ok:true} and git diff --cached --name-only returned b.txt. Observed output: {"requestedPath":"a.txt","suppliedPatchPath":"b.txt","ok":true,"stagedPaths":"b.txt"}. The temporary fixture was removed. Cause: electron/backend/git-manager.ts:2210 validates only the current selected-file token, then :2222 applies the entire untrusted patch body. The first reproduction invocation had an incorrect relative import; it was corrected and the actual reproduction exited 0. This harness setup failure is separate from repository verification results.
- More navigation reproduced with a temporary mounted GitPane test: select Stashes while active new History => GitBranchesTab remains and GitStashesTab absent; repeat from Changes => GitChangesTab remains and GitStashesTab absent. The extra test passed as a bug reproduction, then was removed and the original test file has no diff. Source: GitPane.vue:303,323 match active view without checking the More destination. Overview is earlier in the chain and is an exception; later destinations remain shadowed.
- Compact mobile History's `commits` branch now explicitly excludes `mobileView === "diff"`, allowing a selected commit to reach the diff panel; see GitBranchesTab.vue:559,589 and its mobile diff controls at :180. The original finding is resolved in the current tree.
- Review's main Monaco diff calls fileGitDiff(source:'branch', origin/target) at AzureReviewPane.vue:1276; computeFileDiff at file-manager.ts:1122 reads its right side from disk, so local unstaged edits enter the displayed review diff. Provider shell reuse is not proof of a provider-pinned diff.
- HEAD and all-branches selection are conflated: GitBranchesTab.vue:762 maps HEAD to '', refreshGraph :1303 forwards '', and GitManager :4805 walks all branch/remote/tag refs. The picker still labels '' as HEAD at :17.
- The parent passes profile-id to GitBranchTab (GitPane.vue:280), but not to GitBranchesTab (:302); the actual picker therefore uses the default profile at GitBranchesTab.vue:691,733. Store scoping unit tests do not exercise this wiring.
- Changes does not render GitOperationCard or lastResult (search: rg -n 'GitOperationCard|gitUi.lastResult|lastResult' src/components/workspace/git/GitChangesTab.vue src/components/workspace/GitPane.vue; only a commit conditional in Changes and Worktrees card in GitPane). runGitAction stores structured failures at git-ui.ts:481 without error toast, and file staging/commit-staged handlers ignore false results. Those user actions can fail without a visible message.
- Staged message is persisted, but classic commitMessage/selectedPaths remain component refs (:772,:871), so unmount loses them. Staged commit completion reads the current props.activeRootPath after await (:605), so switching roots mid-commit can clear another root's message.
- Existing local tag creation/deletion now use runWriteAction (git-manager.ts:4296,4322); focused tag tests pass. Existing tag network operations and merge/rebase-with-fetch continue synchronously (runtime-git-handlers.ts:446; GitPane.vue:1073). These remain original plan inventory/common-action requirements.
- Registry idempotency records are intentionally retained under the existing generic contract; this audit does NOT demand their expiry. The plan's bounded persistent notification dedup is separately implemented in app-workspace-actions.ts:130,142; last-result expiry is operation-registry.ts:343.

Continuation reconciliation (current tree after `e923b7ec`): the initial reproduction bullets above are historical findings and several are resolved. More routing now prioritizes Branches/Stashes/other selected destinations; exact hunk matching rejects cross-file patches; provider Review reads pinned source/target revisions; HEAD is distinct from all refs; profile/root-scoped picker state and post-action read guards are implemented; Changes renders mutation errors; tag-list errors now render in History; classic message/path drafts and staged commit completion are scoped; local tags and index writes are audited; remote tag operations, force push, remote branch deletion and merge/rebase use `OperationRegistry`. The History picker regression asserts ref browsing does not call checkout/create/fetch/push (9 focused tests pass). A DialogOverlay integration test confirms an unsaved comment value survives Review pane unmount; the AzureReviewPane suite passes 30 tests and typecheck passes. Full UI (3,040 tests) and backend (5,465 passed, 7 skipped) suites and the safe build passed immediately before this test-only change. Still open: user-owned visual review; broad operation reconnect/profile switching tests; inventory-wide route audit assertions; full keyboard/scale/narrow visual review. `merge-into-base` is a local sibling-worktree operation, not a remote network write.

Continuation correction (`9b10429e`): History now waits for branch and tag reads to finish before pruning a selected ref. This prevents the initial empty loading state from erasing a persisted ref selection. `GitBranchesTab.test.ts` passes 10 tests and `npm run typecheck` passes. Deleted refs are still automatically pruned once reads complete; visual review, broad lifecycle/reconnect coverage, and inventory-wide route audit tests remain outstanding.

Full per-requirement ledger (122 items)

Worker continuation (provider PR creation and thread update audit): GitHub PR creation, Azure DevOps PR creation, and Azure DevOps thread status update tests now assert exactly one successful `category: write` audit entry with the expected operation, connection ID, and `userInitiated: true`. The focused provider manager tests pass (5 audit-related tests across both files); `npm run typecheck` passes; touched-file Prettier passes; ESLint reports 0 errors and 23 warnings; `git diff --check` passes. This adds evidence to requirements 77 and 91; inventory-wide per-action coverage and the user-owned manual visual review remain open.

1. **IMPLEMENTED** — Opt-in Git setting is explicit, reversible and default-off, including old/invalid saved values.
   Evidence: electron/shared/types/state.ts:265; electron/backend/default-state.ts:627,1564; src/components/dialogs/settings/SettingsGitTab.vue:7; src/components/workspace/GitPane.vue:622.

2. **PARTIAL** — Classic remains available and shared Git action/audit/error fixes apply to both layouts.
   Evidence: src/components/workspace/GitPane.vue:232,622; src/stores/git-ui.ts:437; electron/backend/git-manager.ts:4296,4322.
   Remaining: Local tag writes now share the audited wrapper. Other inventory-wide action/audit/error requirements and long network paths remain open.

3. **IMPLEMENTED** — History / Changes / Review are separate main views, initialized once then persisted without dirty/fetch-driven switching.
   Evidence: src/components/workspace/GitPane.vue:623,643; src/stores/git-ui.ts:1423,1445; electron/backend/runtime.ts:10354.

4. **IMPLEMENTED** — Replace permanent branch tree with read-only history selection while retaining file trees and explicit branch management.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:5,210,485; src/components/workspace/GitPane.vue:649.
   Evidence: More routing exposes Branches and GitPane tests verify Branches/Stashes take precedence over the active new view.

5. **IMPLEMENTED** — New mutations use shared store, typed transport, runtime and manager/engine rather than component Git commands.
   Evidence: src/components/workspace/git/GitChangesTab.vue:572,583,607; src/stores/git-ui.ts:1302,1324,1338; electron/backend/runtime-git-handlers.ts:291; electron/backend/git-manager.ts:2203.

6. **PARTIAL** — Support Electron and existing web renderer through shared transport, respecting remote limits; standalone mobile app unchanged.
   Evidence: electron/backend/ipc.ts:1777; electron/preload.cts:251; electron/backend/remote-server.ts:3613; src/transport.ts:2426; electron/backend/runtime-git-handlers.ts:101,446; electron/backend/mobile-session-route-policy.test.ts:39,327.
   Evidence: Four stage/index routes are guarded; network tags, force push and remote branch deletion plus merge/rebase run through OperationRegistry. `merge-into-base` is a local sibling-worktree operation.

7. **PARTIAL** — Preserve branches, stashes, worktrees, conflicts, multi-root/bulk, provider PR actions and external tools.
   Evidence: src/components/workspace/GitPane.vue:302,322,338,348,357,389,423,649; src/components/workspace/GitPane.test.ts:138; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:11.
   Remaining: More prioritizes and tests Branches/Stashes routing; the action inventory has been reconciled. Manual verification of every destination remains open.

8. **IMPLEMENTED** — Reuse review engine/provider comments/audit storage instead of rewriting them for the layout.
   Evidence: src/components/workspace/GitPane.vue:369; src/components/workspace/AzureReviewPane.vue:691; electron/backend/review-git/engine.test.ts:388; git diff --name-only f8ba69b0..HEAD leaves review engine/storage unchanged.

9. **PARTIAL** — Compact common header shows root/repository, actual branch/status/actions and makes full long paths/refs keyboard-accessible.
   Evidence: src/components/workspace/GitPane.vue:72,75,114,1112; src/components/workspace/git/GitChangesTab.vue:32.
   Evidence: The shared Git header now exposes a native keyboard-focusable Details disclosure with the full active repository path and working branch; a mounted regression verifies a long path is not truncated in the details content.
   Remaining: User visual verification of long names and narrow layout remains pending.

10. **PARTIAL** — Running operations and conflicts remain visible across views; primary conflict action is outside overflow.
   Evidence: src/components/workspace/GitPane.vue:105,108,245,348,418; src/components/workspace/git/GitBranchesTab.vue:205; src/components/workspace/git/GitOperationCard.vue:36.
   Evidence: GitPane mounted tests cover History, Changes, and Review with conflicted paths and verify the shared conflict-resolution toolbar action remains visible in every view.
   Remaining: User visual acceptance remains open.

11. **IMPLEMENTED** — Unlinked Review has an explained empty state with existing PR selection/creation entry point.
   Evidence: src/components/workspace/GitPane.vue:374,379,384,668.

12. **PARTIAL** — General branch comparison remains in History, separate from PR Review.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:238,377,1303; src/components/workspace/GitPane.vue:649.
   Remaining: Compare rendering remains; verify compare entry points from the compact History view and accessible Branches destination.

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

19. **PARTIAL** — Preserve History search/author/path/date/limit/compare filters and formally define all-branches backend semantics.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:67,70,292,367,377,1303; electron/backend/git-manager.ts:4805.
   Remaining: Compact commit search and distinct HEAD/all semantics are implemented. Verify compare entry points and narrow filter usability during manual review.

20. **IMPLEMENTED** — Selected commit detail has complete message and changed files, expandable diff and adjustable panel ratios.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:446,452,459,479,485,497,538,566.
   Evidence: Compact History excludes the commits branch while mobileView is diff; responsive E2E and Git UI tests cover diff entry and rendering.

21. **IMPLEMENTED** — History shows last-fetch time only from known repo/root state and an explicit unknown state when absent.
   Evidence: electron/backend/git-manager.ts:959; src/components/workspace/git/GitBranchesTab.vue:81.

22. **PARTIAL** — History distinguishes loading/error/empty, avoids equating missing ticket search with absent change, and offers file history.
   Evidence: src/components/workspace/git/GitTreeGraph.vue:3,4,5; src/components/workspace/git/GitBranchesTab.vue:67,292,338,427.
   Evidence: Compact History test verifies a no-match query displays its own status, while a graph read failure hides that status and shows the query error.
   Evidence: GitBranchesTab test verifies adding a relative path sends the path filter to the History graph query and shows the active filter chip.
   Remaining: User narrow-layout review remains.

23. **IMPLEMENTED** — Review uses the provider's pinned source/target commit IDs for its true diff range; local unstaged work is excluded.
   Evidence: src/components/workspace/AzureReviewPane.vue:1274-1276 requests `source: "range"` with `targetCommitId` and `sourceCommitId`; electron/backend/file-manager.ts:1122-1135 reads both sides via `readFileAtRevision`. AzureReviewPane.test.ts:833-853 checks the exact pinned refs, and file-manager.test.ts:415-434 now asserts a dirty working-tree edit is absent from a base/HEAD range.

24. **IMPLEMENTED** — Review reuses dominant diff, compact changed-file navigation and alternative PR commit selection.
   Evidence: src/components/workspace/AzureReviewPane.vue:265,295,303,307,1287,1345.

25. **PARTIAL** — Reuse review data/comments and preserve comment drafts across files, views and setting changes.
   Evidence: src/components/workspace/GitPane.vue:369; src/components/workspace/AzureReviewPane.vue:691,919; src/components/workspace/GitPane.test.ts:152.
   Evidence: AzureReviewPane regression verifies provider-owned saved draft restoration after Review remount; GitPane integration mounts SettingsGitTab and DialogOverlay, then confirms an unsaved TextAreaDialog value survives toggling the new-view setting off and on. A two-file Review regression switches the selected file while the unsaved editor is open and verifies its text remains.
   Remaining: The user visual walkthrough remains pending.

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

35. **PARTIAL** — Commit message, file selection and operation state survive view/layout switches; failure retains draft for retry.
   Evidence: src/components/workspace/git/GitChangesTab.vue:536,605,772,871; src/components/workspace/GitPane.vue:322.
   Evidence: Fetch, pull, and push terminal failure tests also verify the root-scoped staged commit draft remains available after the operation error and diagnostics are displayed.
   Remaining: Classic message and selected paths are scoped and persist across view switches. Saved provider drafts and an unsaved TextAreaDialog editor survive Review unmount, file selection changes, and actual Settings control off/on transitions. Renderer disconnect and user visual acceptance remain open.

36. **PARTIAL** — Inventory every existing button/context menu/shortcut with its store, permission, audit, results and new UI destination before decomposition.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:17-37 now maps shared toolbar, branch, commit context, file context, Changes, stash, worktree, conflict, bulk, and provider entry points to dispatch/guards, result surface, and new-view destination. `useCommitContextMenu.ts:95-188` confirms commit menu actions; `GitPane.vue:148-224` confirms shared toolbar actions.
   Evidence: The index now has individual rows for toolbar, branch, commit, Changes, stash, worktree, conflict, bulk, and provider actions, including dispatch/guard, result surface, and destination. It distinguishes stash import's write lock/audit from export's read-only path.
   Remaining: Reconcile any permission/audit variants that still need deeper route-level evidence. Human discoverability review also remains.

37. **PARTIAL** — Picker supports keyboard open/search/select/Escape/focus return; context menus and relevant shortcuts remain usable.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:5,17,67,210; src/components/workspace/git/GitBranchesTab.test.ts:104.
   Evidence: History ref picker is a labeled native select and a component test verifies it is tabbable and receives focus. More→Branches routes to the existing branch-management component and is covered by GitPane destination tests.
   Remaining: Full native open/search/select/Escape behavior and narrow-window review remain for the user visual walkthrough.

38. **PARTIAL** — Narrow layout uses list/detail and inline diff; long refs/paths/hundreds of branches remain usable.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:538,566; src/components/workspace/git/GitChangesTab.vue:389,611; src/components/shared/MonacoDiffPanel.vue:172,291.
   Remaining: Compact History diff entry and narrow Changes stage/unstage controls are implemented; a 400-ref picker test verifies large-list filtering. Human narrow-window layout, long paths, and keyboard/focus behavior still need the manual pass.

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

45. **PARTIAL** — Drafts/mutations outlive component; switching layout neither cancels nor reissues mutation and retains its result; remove only UI reads/subscriptions.
   Evidence: src/stores/git-ui.ts:437,1338; src/components/workspace/git/GitBranchesTab.vue:1407; src/components/workspace/git/GitChangesTab.vue:605,772,871.
   Evidence: An unsaved editor-dialog value survives pane unmount, file selection changes, and Settings off/on; a busy fetch survives view-setting off/on; failed fetch/pull/push keeps the scoped staged message and terminal result. These are covered by AzureReviewPane, GitPane, and git-ui store regressions.
   Evidence: `src/transport.test.ts:1629` exercises real `createRemoteTransport`, `appStore`, and `git-ui` store flow for pending pull and push across socket loss/reconnect, a switch to profile p2 with no result, and return to p1 with the persisted outcome. It verifies busy state and staged commit draft remain while pending, resolves on p1 restoration, and only one request was sent.
   Remaining: User visual acceptance remains open.

46. **IMPLEMENTED** — Switching back restores classic; missing/invalid saved flag is safe false, malformed new payload is rejected.
   Evidence: src/components/workspace/GitPane.vue:232,622; electron/backend/default-state.ts:1564; electron/backend/ipc-schemas.test.ts:60; electron/backend/default-state.test.ts:2101.

47. **PARTIAL** — Buttons/menu/shortcuts share one store/runtime/audit path; stage/index APIs use mutation guard, repository lock and audit.
   Evidence: src/components/workspace/git/GitChangesTab.vue:572,583,607; electron/backend/git-manager.ts:2203,2234,2467; electron/backend/git-manager.ts:4278,4293.
   Evidence: `electron/backend/runtime.test.ts:8482` asserts each stage-file, unstage-file, commit-staged, create-tag, and delete-tag route calls its matching manager write exactly once with the resolved root. `electron/backend/git-manager.test.ts:3988` verifies the three index outcomes plus successful local tag create/delete each produce exactly one system Git audit row.
   Evidence: `electron/backend/git-manager.stash.test.ts` exercises successful stash patch import and rejected path traversal against a real repository, asserting exactly one audit outcome per attempt with resolved root. The manager routes import through the per-worktree lock and shared audit wrapper.
   Evidence: `electron/backend/git-manager.test.ts` real-repository coverage asserts one resolved-root write audit outcome for local branch create, checkout, rename, delete success/failure, and remote branch checkout success/failure.
   Evidence: Conflict resolve and unresolve now take the shared per-worktree lock and emit exactly one system Git audit outcome; a real conflict test covers success and failure for both routes.
   Evidence: Conflict detail/resolve/unresolve now use the stage-path normalizer, rejecting traversal paths before reading or writing outside the selected root. A real-repository regression confirms outside content stays unchanged.
   Evidence: A real local bare remote test verifies successful remote-branch deletion and failed deletion after the remote URL becomes unavailable each emit exactly one system Git write audit row with the workspace root.
   Evidence: A real local bare remote test verifies push-tag, push-all-tags, and remote-tag deletion each emit one success and one unavailable-remote failure audit row with the workspace root.
   Evidence: A real-repository History mutation test verifies cherry-pick success and a valid-format missing-commit failure each emit exactly one system Git write audit row with the resolved root. A History squash regression verifies the resulting commit and exactly one resolved-root write audit outcome.
   Evidence: Continue/abort/skip use the detected Git operation kind as their audit type. Added `bisect` to the write classifier and a regression verifies both successful and failed bisect outcomes are categorized as writes with the repository root.
   Evidence: A real Git repository regression starts a multi-commit bisect session, confirms the detected operation state, aborts it through `GitManager`, verifies the operation ended, and asserts exactly one successful `gitBisect` write audit row with resolved root and duration.
   Evidence: The runtime single-dispatch mutation matrix covers `gitMergeCurrentIntoBase`, `gitRemoveWorktree`, `gitResolveConflict`, `gitUnresolveConflict`, `gitSkipCommit`, `gitContinueOperation`, and `gitAbortOperation`; focused test asserts each manager write is called once with the resolved root.
   Remaining: Route-level evidence covers index/local tag, branch/history/stash dispatch and writes, worktree add/remove, provider comments/votes/review submission, PR creation, and Azure thread update. Other mutation families still need assertions; manual menu/shortcut walkthrough remains.

48. **IMPLEMENTED** — Check rejected promises and structured ok:false; promise success must not mean Git success.
   Evidence: src/stores/git-ui.ts:465,471,481,506,1290; electron/backend/runtime-git-handlers.ts:143; src/stores/git-ui.test.ts:141.

49. **IMPLEMENTED** — Action failure is visible at affected action plus existing toast/notification/log path, never swallowed or announced successful.
   Evidence: src/stores/git-ui.ts:481,506; src/components/workspace/git/GitChangesTab.vue:572,605; src/components/workspace/GitPane.vue:418.
   Evidence: `runGitAction` shows an error notification for structured failures; Changes renders GitOperationCard; stage/unstage/commit-staged all use the same result path. Focused store and Changes tests pass.

50. **PARTIAL** — Reads distinguish loading/error/empty/stale; retained stale data is marked; obsolete cancellation is not a failed user mutation.
   Evidence: src/stores/git-ui.ts:725,741,746,867,878,1564,1567; src/components/workspace/git/GitBranchesTab.vue:168,427.
   Evidence: A post-mutation diff refresh rejection now replaces the prior preview with an error-shaped result preserving path/scope and clearing stale diff text; `git-ui.test.ts` verifies the stale content is not retained.
   Evidence: A deferred post-mutation preview response from root A is ignored after switching to root B; the regression confirms root B's selected file and preview remain current.
   Evidence (2026-10-21): History commit-file reads now include active root in the watcher identity, so the same hash reloads on a root switch; a deferred root-A file-list result is discarded after root B loads. `useMonacoDiffLoader.clear()` invalidates in-flight diffs when History switches roots. History graph refresh now includes root path as an input, so a root-specific saved ref runs in the new repository even if the ref label matches. GitBranchesTab and diff-loader suites pass (31 tests); typecheck, safe production build, and repository lint pass (0 errors, 4,715 warnings; Prettier clean).
   Remaining: Tag list failures now render as an inline alert in History and the focused picker suite passes. Verify visual treatment of preview refresh failures in the manual pass.

51. **PARTIAL** — Diagnostics carry available operation/run ID, action, profile/workspace/root, result, duration and safe error; distinguish blocked/cancel/partial/failure and protect credentials/content.
   Evidence: electron/backend/operation-registry.ts:216; electron/backend/git-manager.ts:2643,2686,2755; electron/backend/runtime-git-handlers.ts:143.
   Evidence: OperationRegistry failure logs now include operation ID, kind, effective profile, origin workspace, optional repository root, step, elapsed duration, and stable error code; a regression verifies the correlation fields and duration.
   Evidence: Long Git failure outcomes now carry a stable `git_operation_failed` code plus bounded warnings, conflict paths, and raw output through the event/payload schema to the Git operation card. Runtime, store, and registry regressions cover this path.
   Evidence: `electron/backend/runtime.test.ts:14771` now exercises structured warning/conflict/raw-output propagation through fetch, push, force push, remote branch/tag writes, merge, and rebase; the nine-case focused runtime test passes. `runtime-git-handlers.ts:68-115,295-318` builds a bounded user-facing failure and structured error metadata; `operation-registry.ts:122-145` preserves bounded warning/conflict/output fields and logs operation id/profile/workspace/root/step/duration.
   Evidence: `src/stores/git-ui.test.ts` covers a rejected fetch-start transport request: the busy state releases, an error result remains visible, and the standard notification path records the failure to `strideterm.log`.
   Evidence: `runWriteAction` now records elapsed duration for rejected Git writes as well as successful writes; the real cherry-pick success/failure audit regression asserts duration on both rows.
   Evidence: Runtime create-worktree success and Git-failure tests assert the audit entry includes elapsed duration together with the resolved root, workspace, and outcome.
   Remaining: Audit generic rejected-promise classification for each manager/runtime route, verify cancellation/blocked/partial distinctions, and complete user visual acceptance.

52. **PARTIAL** — Busy always releases, prevents duplicate launch; uncertain write results trigger state verification before user retry, never automatic write retry.
   Evidence: src/stores/git-ui.ts:446,521,610,633; src/components/workspace/git/GitChangesTab.vue:605; src/components/workspace/GitPane.vue:144.
   Evidence: Synchronous local index/commit, branch, history, local tag, stash-pop, worktree, conflict, abort/continue/skip, and merge-into-base writes mark a rejected transport response as uncertain; the same root/action is blocked from retry until a successful refresh returns that root's Git snapshot. Conflict actions key the guard by the conflict dialog's captured root, not a later active-root selection. Store regressions cover index, branch and conflict-action lost responses, retry suppression, and refresh isolation/recovery for both active-root and bulk per-root refresh paths.
   Evidence (2026-10-21): Review Git start requests now carry profile/workspace/action/proposal-scoped idempotency keys and reuse the same key after a rejected start response; a store regression proves the retry uses the same key and settles the original operation. Confirmation continuations use a separate proposal key. The start schema validates optional keys; Review operation suite (24), IPC schema suite (105), repository typecheck and safe build pass; repository lint has 0 errors and 4,714 warnings with Prettier clean.
   Remaining: Review-provider audit outcome coverage and inventory-wide route checks still need verification; user visual acceptance remains.

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

60. **PARTIAL** — Update both UI consumers and remote long-operation path; verify reconnect/dedup and no cross-profile/workspace result leakage.
   Evidence: `git-ui.ts` resolves accepted fetch, pull, and ordinary push operations from the terminal event or persisted lastResults payload; `git-ui.test.ts` delivers the same terminal failure through both channels for all three and asserts one error notification. Backend profile isolation is covered by `runtime.test.ts:8746`.
   Evidence: `src/transport.test.ts:1629` integrates actual remote transport reconnect with pending UI pull/push, switches to p2 without exposing the p1 result, then restores p1 and resolves from its persisted outcome; each action is accepted once. `runtime.test.ts:8746` independently covers backend cross-profile outcomes.
   Remaining: User visual acceptance remains open; exact audit-route coverage is tracked under 77/91.

61. **PARTIAL** — Stage 1: inventory matrix classic/new × normal/review × local/remote × root plus verified permissions/audit/result variants.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:7,21.
   Evidence (2026-10-21): Expanded the matrix to cover all eight classic/new × standard/PR-linked × Electron/remote combinations and a separate History query row. It records view preference and root scope, provider behavior, and shared route/guard assumptions.
   Remaining: Exact per-entry permission/audit/result variants and shortcut mapping still need inventory-level reconciliation; accessibility and actual layout acceptance remain manual.

62. **IMPLEMENTED** — Stage 1: verify provider review reuse, diff-component capabilities and OperationRegistry instead of assuming concept capabilities.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:15,17; src/components/workspace/AzureReviewPane.vue:1276.
   Evidence: Inventory records provider-pinned source/target diff, narrow Changes staging capability, and registry-backed long operations.

63. **IMPLEMENTED** — Stage 1: define scoped view/draft preservation with minimal shared extraction and no copied entire old tabs.
   Evidence: src/components/workspace/GitPane.vue:302,322; src/stores/git-ui.ts:1414; src/components/workspace/git/GitChangesTab.vue:772.
   Evidence: Classic commit text and selected paths use the shared Git UI store keyed by workspace/root; GitChangesTab tests verify remount persistence and isolation/restoration across repository roots.
   Remaining: User visual walkthrough remains open.

64. **IMPLEMENTED** — Stage 2: validated/persisted default-off toggle with migration and nested-merge tests.
   Evidence: electron/backend/default-state.test.ts:2101; electron/backend/ipc-schemas.test.ts:60; electron/backend/runtime.test.ts:4849; src/components/dialogs/settings/SettingsGitTab.vue:7.

65. **PARTIAL** — Stage 2: classic/new shell, three views and common operation context preserve all old functionality and switching back.
   Evidence: src/components/workspace/GitPane.vue:245,302,322,369,649.
   Remaining: More routing and Branches/Stashes precedence are fixed and tested; operation state is surfaced in main views. Verify specialized destination/conflict behavior visually.

66. **PARTIAL** — Stage 2: new selection independent of legacy migrations, one active data subscription, durable in-progress actions/inputs.
   Evidence: src/components/workspace/GitPane.vue:494,614,623; src/stores/git-ui.ts:1423; src/components/workspace/git/GitChangesTab.vue:772,871.
   Remaining: Independent selection and one shell subscription exist; required mounted lifecycle/subscription/draft/mutation verification is incomplete.

67. **PARTIAL** — Stage 3: reusable history/range selection with searchable picker and accessible branch management.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:5,210; src/components/workspace/GitPane.vue:649.
   Evidence: Branch management is reachable from More and the picker select's focusability is tested. HEAD and all-ref selection issue distinct read queries.
   Remaining: Human verification of native keyboard behavior remains.

68. **PARTIAL** — Stage 3: align subjects/quieten refs, adjustable detail and preserved filters/compare.
   Evidence: src/components/workspace/git/GitTreeGraph.vue:108; src/components/workspace/git/GitBranchesTab.vue:67,479.
   Remaining: Refs and subjects are aligned; compact commit search and More management entry are restored. Verify compare/filter behavior in manual review.

69. **PARTIAL** — Stage 3: deleted/invalid refs, detached/empty repo, hundreds of refs and root/profile switching are handled.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:1157,1375,733; src/components/workspace/GitPane.vue:75,302.
   Remaining: Deleted refs show a status; empty/detached, 400-ref filtering, loading completion, failed tag reads, and scoped profile/workspace/root getter wiring have tests. Actual root/profile switching and narrow/keyboard acceptance remain for the manual pass.

70. **IMPLEMENTED** — Stage 4: provider-backed Review shows source/target/base and expands accurate PR diff.
   Evidence: src/components/workspace/GitPane.vue:369; src/components/workspace/AzureReviewPane.vue:1274,1276; electron/backend/file-manager.ts:1122.
   Evidence: Review uses pinned provider source/target commit IDs, reads each revision through the file manager, and tests exclusion of a dirty worktree edit.

71. **IMPLEMENTED** — Stage 4: readable Changes keeps original commit semantics until actual staging exists.
   Evidence: src/components/workspace/git/GitChangesTab.vue:121,147,389,402.
   Remaining: None for commit semantics; new view has explicit file/hunk stage and commit-staged controls on desktop and narrow diff.

72. **PARTIAL** — Stage 4: retain conflicts/stashes/worktrees/bulk and inventory tools; viewed state only if real.
   Evidence: src/components/workspace/GitPane.vue:302,322,338,348,389,423; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:15.
   Remaining: No fake viewed state added; More precedence and shared conflict action are implemented. Verify every specialized destination and conflict state in the manual pass.

73. **IMPLEMENTED** — Stage 5: typed/validated file+hunk stage/unstage and existing-index commit endpoints across Electron/remote transport/store/runtime.
   Evidence: electron/backend/ipc-schemas.ts:310,321,329; electron/shared/ipc-bridge.ts:625; electron/preload.cts:251; electron/backend/remote-server.ts:3613; src/transport.ts:2426; src/stores/git-ui.ts:1302,1313,1324,1338; electron/backend/runtime-git-handlers.ts:291.

74. **IMPLEMENTED** — Stage 5: common mutation guards/repo lock/audit/errors, authorized root paths, no ref/path shell construction.
   Evidence: electron/backend/git-manager.ts:97,2203,2222,2234,2467; electron/backend/runtime.ts:6145.
   Evidence: Exact server hunk/header matching, authorized root validation, repository write lock, audited mutation wrapper and argv-only Git calls are covered by manager/runtime regressions.

75. **IMPLEMENTED** — Stage 5: real repo index tests cover partially staged/new/deleted/renamed/stale/conflict/binary/unrelated-worktree cases; unsupported cases return failure.
   Evidence: electron/backend/git-manager.test.ts:3943,3960,3976,3988,4039,4072,4092.

76. **PARTIAL** — Stage 5: enable final Stage hunk/Commit staged only after complete safe index implementation; keep classic selected-path commit.
   Evidence: src/components/workspace/git/GitChangesTab.vue:121,147,263,394,402; electron/backend/git-manager.ts:2222; electron/backend/git-manager.test.ts:4040.
   Remaining: Hunk matching and narrow controls are implemented. Full narrow interaction/accessibility review and audit/error contract coverage remain open.

77. **PARTIAL** — Stage 6: structured errors and audit coverage verified for every inventory input route.
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
   Evidence: Scoped commit-all success and rejected empty selection each emit one system Git write audit row with the workspace root in a real repository regression.
   Evidence: Merge-into-base success and dirty-target rejection each emit one system Git write audit row with the resolved target worktree root.
   Evidence: Bisect continue/abort audit types are classified as writes; the focused classification regression covers success and failure outcomes. History cherry-pick success and Git failure each produce one audit entry with the resolved repository root. Squashing two History commits produces the requested commit and one `gitSquash` write audit entry.
   Verification refresh (2026-10-21): Full `npm run test:backend -- electron/backend/git-manager.test.ts` passes 188 tests with 2 skipped after the bisect, cherry-pick, and squash audit additions.
   Evidence: Conflict resolve and undo success/failure each emit one system Git audit outcome with the resolved root; the focused real-conflict regression passes.
   Evidence: Conflict detail/resolve/unresolve reject repository traversal paths, and the regression confirms an outside file is not modified.
   Evidence (2026-10-21): GitHub PR creation, Azure DevOps PR creation, and Azure DevOps thread status update each have focused assertions for exactly one successful classified provider write audit entry. Provider PR/thread gaps are closed; other mutation families and inventory-wide route reconciliation remain.

78. **PARTIAL** — Stage 6: involved long Git actions use generic flow for both layouts/remote; reconnect and dedup verified.
   Evidence: `runtime-git-handlers.ts` routes fetch/pull/push/force-push, merge/rebase, remote branch deletion, and network tag writes through OperationRegistry; mobile route policy classifies the guarded routes. `git-ui.test.ts` covers event/payload resolution and duplicate terminal delivery for fetch/pull/push.
   Evidence: `src/transport.test.ts:1629` verifies pending pull/push survive actual transport disconnect/reconnect and profile switching, then resolve from persisted results without resubmission.
   Evidence (2026-10-21): Lost-start-response idempotency keys now remain scoped by workspace/root/action/input variant across force push, remote branch deletion, merge/rebase, remote tag mutations, and bulk fetch/pull; retry coverage verifies tag push and remote branch deletion reuse keys, and merge/rebase assert the key in their accepted start payload. Git UI store suite passes 62 tests and typecheck passes. Remaining: Inventory-wide route/audit assertions and user visual acceptance are still incomplete.

79. **PARTIAL** — Stage 6: layout/profile changes or client disconnect do not cancel accepted work or misroute its result.
   Evidence: electron/backend/operation-registry.ts:123,187; `git-ui.test.ts` verifies pull can recover its terminal result from the persisted lastResults payload after a missed event; runtime tests verify distinct profile/workspace operation IDs and outcomes.
   Evidence: `src/transport.test.ts:1629` verifies pending pull/push across remote disconnect/reconnect and profile switch, keeping the action pending in p2 and resolving from p1's persisted result after restoration. Root-scoped diff refresh and staged commit completion use the originating root; branch/tag refreshes remain protected by read-generation and active-root checks.
   Remaining: User visual acceptance remains open.

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

84. **PARTIAL** — Acceptance: layout toggle keeps message/comments/root/running actions and creates no double mutations/subscriptions/notifications.
   Evidence: src/components/workspace/GitPane.test.ts:138,152; src/components/workspace/git/GitChangesTab.vue:772,871; src/stores/git-ui.ts:437.
   Evidence: `GitPane.test.ts` toggles the saved setting off and back on while a fetch is busy and verifies the busy state and operation card survive. Classic message/selection persist by workspace/root; saved Review drafts and an open unsaved TextAreaDialog survive pane unmount.
   Remaining: Unsaved comment text now has an integration test across the actual Settings Git control's off/on transition. Check for duplicate subscriptions/mutations and cross-view conflict visibility in the manual visual pass.

85. **PARTIAL** — Acceptance: explicit picker test proves only read query changes, no checkout/fetch/other mutations.
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

89. **PARTIAL** — Acceptance: process/ok:false/auth/hook/stale/disconnect failures have visible result+diagnostics and retain draft.
   Evidence: src/stores/git-ui.ts:481,506; src/components/workspace/git/GitChangesTab.vue:572,590,605; electron/backend/git-manager.test.ts:4030.
   Evidence: `GitChangesTab.test.ts` now verifies a failed staged commit preserves its root-scoped draft; store/network failure tests verify structured errors reach the action banner and notification path.
   Evidence: `git-ui.test.ts` now verifies fetch/pull/push failure outcomes retain structured warnings and raw output, including a rejected pre-push hook. `GitOperationCard.test.ts` verifies streamed hook output while busy and warning/raw failure details after completion.
   Evidence: `src/transport.test.ts:1629` exercises pending pull/push terminal failures through a real remote socket disconnect/reconnect and profile switch; the store clears busy state, displays the failure, and retains the staged commit draft after the original profile returns.
   Remaining: User visual acceptance remains open.

90. **IMPLEMENTED** — Acceptance: real temporary-repo manager tests verify successful and failed audited writes, plus normal and strict review audit sink failures.
   Evidence: electron/backend/git-manager.test.ts:3944,3960,1103,1840; electron/backend/review-git/engine.test.ts:388,398.
   Evidence: Real Git fixture verifies successful stage-file and commit-staged plus failed empty-index commit each produce exactly one audit entry with resolved root and outcome; review sink tests remain passing.

91. **PARTIAL** — Acceptance: button/menu/shortcut use same audited path; one mutation yields no duplicate audit (review intent/outcome is expected pair).
   Evidence: electron/backend/git-manager.ts:2203,4278; src/components/workspace/GitPane.test.ts:138; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:11.
   Evidence: `runtime.test.ts` asserts one resolved-root manager dispatch for index/local-tag plus branch, commit-history and stash mutation routes; `git-manager.test.ts` verifies exact audit rows for index/tag and stash mutations. Existing `runGitAction` tests and the action inventory map visible UI routes to the store/runtime path.
   Evidence: Worktree remove now has a single audit-row assertion in the fast-path manager regression.
   Evidence: Runtime worktree creation success/failure and manager worktree removal audit paths are now covered; focused runtime worktree cases pass (3).
   Evidence: Provider manager tests assert GitHub conversation comments and Azure comment/vote requests each produce exactly one classified successful user-initiated write audit entry.
   Evidence: GitHub review submission now has an exact single-write audit assertion alongside conversation comment coverage; Azure comment/vote writes are also asserted.
   Evidence (2026-10-21): Focused provider-manager tests assert exactly one successful classified write audit row for GitHub PR creation, Azure PR creation, and Azure thread status update. The provider PR/thread audit gap is closed. Remaining: complete individual menu/shortcut mapping and user visual acceptance; other route-level action classes are tracked under 47/77.

92. **PARTIAL** — Acceptance: controlled slow backend proves start before relay timeout, reconnect outcome, dedup and profile isolation, without timeout increase.
   Evidence: Gated OperationRegistry tests cover prompt fetch/rebase acceptance, dedup, tag/force-push/remote-delete, and profile/workspace isolation; store tests verify event plus payload completion for fetch/pull/push, one notification per failure, and pull recovery from persisted outcomes.
   Evidence: `src/transport.test.ts:1629` now exercises pending pull and push over actual remote transport reconnect and profile switching, checks persisted result delivery, and asserts one start request per action. Backend cross-profile pull/push isolation remains covered by `runtime.test.ts:8746`.
   Remaining: User visual acceptance remains open.

93. **PARTIAL** — Acceptance: keyboard picker open/search/select/close and narrow layout work with long refs/paths and hundreds of branches.
   Evidence: src/components/workspace/git/GitBranchesTab.test.ts:104; src/components/workspace/git/GitBranchesTab.vue:538,566; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/MANUAL_VERIFICATION.md:7,9.
   Remaining: Compact commit search and diff entry are implemented. Keyboard/focus return, long refs/paths and hundreds-of-branches scaling still need user visual review.

94. **PARTIAL** — Acceptance: each existing inventoried action has an accessible new-view route and conflict state stays prominent.
   Evidence: src/components/workspace/GitPane.vue:302,322,338,348,649; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:11,13.
   Evidence: GitPane test.each covers More routing to Overview, Branches, Stashes, Pull Request, Worktrees, Bulk, and Conflicts when available; Changes stays in the primary shell. Remaining: Finish visual review of specialized destinations and operation visibility.

95. **IMPLEMENTED** — Run named relevant GitPane/pull-strategy/Branches/Changes/store/review-store/default/schema/review-engine tests plus new index tests.
   Evidence: src/components/workspace/GitPane.test.ts:138; src/components/workspace/git/GitBranchesTab.test.ts:104; src/stores/git-ui.test.ts:46; electron/backend/git-manager.test.ts:3943; independent runs: 125 UI + 1331 backend passed.

96. **PARTIAL** — Add meaningful new picker/settings/index tests, not merely smoke passes; test state/actions/contracts rather than xterm/canvas.
   Evidence: src/components/workspace/GitPane.test.ts:138,152; src/components/workspace/git/GitBranchesTab.test.ts:104; electron/backend/git-manager.test.ts:3943; search rg --files src/components/dialogs/settings finds no SettingsGitTab test.
   Remaining: Settings save control and off/on draft lifecycle, picker query/scope behavior, and restart persistence have tests. Keyboard/focus and visual confirmation remain manual.

97. **IMPLEMENTED** — Visual concept is illustrative, no pixel match/API invention; user supplies visual confirmation rather than agent running app.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/MANUAL_VERIFICATION.md:3; git diff --name-only f8ba69b0..HEAD contains no concept asset/provider engine rewrite.

98. **IMPLEMENTED** — Private original plan/image remain ignored; do not force-add private assets or link them from public documentation.
   Evidence: git diff --name-only f8ba69b0..HEAD contains task snapshot artifacts but no .private plan/image; public README/docs unchanged.

99. **IMPLEMENTED** — Worker commits regularly with descriptive local commits.
   Evidence: git log -6 --oneline; electron/backend/mobile-session-route-policy.test.ts:39,327.
   Evidence: Continuation implementation commits are local; no remotes were pushed.

100. **IMPLEMENTED** — Worker updates task TODO sections while progressing.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/TODO.md:5,14,18; git diff f8ba69b0..HEAD -- task TODO.

101. **PARTIAL** — Worker completes verification-before-completion and task fully before stopping.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/WORKER.md:5; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/TODO.md:10; electron/backend/agent-task-runner.callbacks.test.ts:214.
   Remaining: Healthy automated checks pass; full numbered audit and user-owned visual review remain incomplete.

102. **IMPLEMENTED** — Do not push remotes.
   Evidence: Task diff/log shows local implementation commits; judge performed no push; no contrary repository evidence.

103. **IMPLEMENTED** — Do not install dependencies unless explicitly required; pin any new package exactly.
   Evidence: git diff --name-only f8ba69b0..HEAD shows no package.json/package-lock.json change; judge installed no dependencies.

104. **PARTIAL** — No WORK_LOCK and no In Progress/Blocked TODO entries at stop.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/WORK_LOCK:1; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/TODO.md:14,16.
   Remaining: Work remains, so WORK_LOCK must remain present; In Progress/Blocked are empty. Do not clear lock until every requirement and verification completes.

105. **PARTIAL** — TODO: complete user's visual review using MANUAL_VERIFICATION in their dev.ps1 session, address reported issues.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/TODO.md:9; .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/MANUAL_VERIFICATION.md:3.
   Remaining: This remains an unchecked To Do. Keep user-owned visual confirmation explicitly pending; agent must not launch app or claim it was completed.

106. **PARTIAL** — TODO: finish all seven implementation stages.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/TODO.md:10; src/components/workspace/GitPane.vue:303; electron/backend/git-manager.ts:2222.
   Remaining: Numbered audit still contains partial History/context/long operation/accessibility/test/typecheck requirements and user manual review is pending.

107. **PARTIAL** — TODO: focused tests/full lint/typechecks/safe build/complete diff review.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/TODO.md:11; electron/backend/agent-task-runner.callbacks.test.ts:214; src/components/workspace/GitPane.vue:303.
   Evidence: Current continuation full UI/backend suites, typecheck, full lint, touched-file Prettier/ESLint, safe production build and diff checks pass. User visual review and remaining lifecycle/audit coverage remain open.

108. **IMPLEMENTED** — TODO: commit implementation locally without pushing.
   Evidence: git log -4 --oneline; initial git status --short clean.

109. **IMPLEMENTED** — TODO Done: opt-in flag default/normalization/boolean schema/Settings/nested merge coverage.
   Evidence: electron/backend/default-state.ts:627,1564; electron/backend/ipc-schemas.ts:133; src/components/dialogs/settings/SettingsGitTab.vue:7; electron/backend/runtime.test.ts:4849.

110. **PARTIAL** — TODO Done: separate new view plus opt-in three-view shell and More path to preserved tools.
   Evidence: src/components/workspace/GitPane.vue:245,268,303,323,649; src/components/workspace/GitPane.test.ts:138.
   Remaining: More destination precedence and Branches/Stashes routing are fixed. Inventory records the routes; verify each one across layouts in the user visual pass.

111. **IMPLEMENTED** — TODO Done: searchable read-only history with profile/workspace/root-scoped favorites/recent.
   Evidence: src/components/workspace/git/GitBranchesTab.vue:733,760; src/components/workspace/GitPane.vue:302; src/stores/git-ui.ts:1464.
   Evidence: Parent passes profile; History search/ref and reactive preferences are scoped to profile/workspace/root.

112. **PARTIAL** — TODO Done: record complete existing action/capability inventory.
   Evidence: .strideterm/tasks/716afb2f-00d3-4e3a-b535-f10bd87b0bef/IMPLEMENTATION_INVENTORY.md:7,11,13.
   Remaining: Capability routes and current cards are reconciled, including Branches in More and shared operation cards. Complete individual shortcut/context-menu/result-variant mapping, then review manually.

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

119. **PARTIAL** — TODO Done: fetch/pull/push generic operations, idempotency, correlation, durable results, event/payload dedup, visible running.
   Evidence: electron/backend/runtime-git-handlers.ts:101; `src/stores/git-ui.ts` waits for terminal fetch/pull/push outcomes; `git-ui.test.ts` covers event completion and pull lastResults recovery; runtime tests cover same-action dedupe and profile-isolated operation IDs/outcomes.
   Evidence: App-store reconnect regression proves a missed pull outcome in the lower-revision post-restart snapshot is applied and reported. `src/transport.test.ts:1629` spans pending `git-ui` pull/push actions through actual transport reconnect and profile switching, restoring the original profile's persisted result without issuing a second Git request.
   Remaining: User visual acceptance remains open.

120. **PARTIAL** — TODO Done: Review uses provider-owned matching PR workspace for true diff and persisted drafts.
   Evidence: src/components/workspace/GitPane.vue:369,534; src/components/workspace/AzureReviewPane.vue:1274-1276; electron/backend/file-manager.ts:1122-1135; AzureReviewPane.test.ts:833-853; file-manager.test.ts:415-434.
   Remaining: True pinned range, local unstaged exclusion, provider-owned saved draft restoration, unsaved editor survival across pane unmount, and editor survival through Settings off/on transitions are automated. Review file-switch remains for manual acceptance.

121. **PARTIAL** — TODO Done: staged message survives views; clear root-specific selections on root changes.
   Evidence: src/components/workspace/git/GitChangesTab.vue:653,826,857,870,902,932; src/stores/git-ui.ts:384,390,394,400; src/components/workspace/git/GitBranchesTab.vue:730,1157.
   Remaining: Staged/classic drafts and History query state are scoped; async commit completion captures its originating root; late graph responses are rejected; unsaved editor state survives pane unmount and setting off/on transitions. The busy-operation toggle has integration coverage. Reference-filter toggle and file-switch behavior remain for manual acceptance.

122. **PARTIAL** — TODO Done: focused index, long acceptance/dedup, stale read and Review routing tests.
   Evidence: electron/backend/git-manager.test.ts:3943; electron/backend/runtime.test.ts:8481; src/stores/git-ui.test.ts:64; src/components/workspace/GitPane.test.ts:152.
   Evidence: Runtime index routes each call one manager write with the resolved root; More destination routing covers every currently available legacy tool. Remaining: Full reconnect integration, complete menu/shortcut-to-audit inventory, and user visual acceptance remain open.

## Worker continuation correction (2026-10-21)

- The initial audit's Review diff finding (23) was stale: AzureReviewPane now calls the typed `source: "range"` file diff using provider `targetCommitId` and `sourceCommitId`. Backend range mode reads both file sides from those revisions; it never reads the working copy. Existing component coverage checks the exact commits. Added a direct backend assertion proving a dirty unstaged line is excluded from a base/HEAD range.
- Runtime test `long Git fetches in separate profiles have isolated operations and outcomes` now proves simultaneous gated fetches in profile-a/ws-a1 and profile-b/ws-b1 produce different operation IDs and terminal outcomes carrying each matching profile/workspace. Focused test passed.
- AzureReviewPane.test.ts now mounts the real ReviewCommentsTab against provider-owned saved draft data, unmounts the pane as a view switch would, then mounts it again and verifies the saved body is restored. The focused AzureReviewPane suite passes 29 tests; typecheck passes. Live unsaved dialog content is still unverified.
- `git-ui.test.ts` now resolves root-b's graph before root-a's delayed graph and asserts root-a cannot overwrite it. The focused store suite passes 46 tests; typecheck passes. The original compact mobile History diff ordering finding was rechecked and is already fixed in the current template.

Final concurrent-state observation: after the first continue verdict was written, WORK_LOCK appeared and final git status reported modifications to electron/backend/git-manager.test.ts, src/components/workspace/GitPane.vue and src/components/workspace/git/GitBranchesTab.vue. Those changes were not made by the judge and were left untouched. The source citations and reproduction results above describe the inspected 862c3f6a implementation before those subsequent edits. The later in-progress state does not satisfy completion and was not substituted for the reviewed snapshot.

Verdict: **continue**. 43 IMPLEMENTED, 78 PARTIAL, 1 MISSING. Full typecheck and the remote route-policy test failed, behavior defects were verified, an active To Do remains and final inspection found WORK_LOCK present. No implementation fixes were made by the judge.


## Worker continuation update (2026-10-21, after 93539ca3)

- `npm run typecheck`: PASS after commit `bdd79713`; corrected shared `TaskRound.judgeVerdict` typing and stale/unknown test fixture typings.
- `npm run lint`: PASS, 0 errors, 4653 warnings; Prettier passes.
- `npm test`: UI PASS (214 files, 3021 tests); backend FAIL (221 passed files, 3 failed files; 5451 passed, 6 failed, 7 skipped) because Monaco codicon TTF is missing from installed node_modules and native OpenSSH integration times out on Windows. AppX config tests pass separately (9).
- Focused task suites PASS: GitPane/Branches/Changes/AzureReview/store UI 110 tests; mobile route classification 50; GitManager index/tag focused 3; runtime/remote 212 from prior continuation.
- `npm run test:e2e`: FAIL, 132 passed, 10 failed, 5 skipped. Nine legacy mobile Git Changes renderer viewport cases cannot observe `after:` in Monaco view lines; one Settings screenshot differs. All nine Git cases run with default classic UI, so they do not exercise the new-view narrow staging controls. This is an outstanding project verification issue to investigate.
- New-view narrow staging controls, index route classification, and full typecheck fixes committed locally as `93539ca3` and `bdd79713`; branch has no uncommitted changes. No push.
- User visual verification in the `dev.ps1` session remains pending. WORK_LOCK remains because audit items, test failures, and user review are open.

## Worker continuation update (2026-10-21, after responsive mock fix)

- Fixed `test/mock-server.ts`: the Git Changes UI uses `/api/git/diff-preview`, but the E2E mock only handled `/api/file/git-diff`; the unhandled route returned no file contents. Added a fixture-backed diff-preview response.
- Added a `GitChangesTab.test.ts` regression proving backend left/right contents survive when no unified patch is returned; changed loader fallback so it does not replace backend content with empty strings.
- `npm run test:ui -- src/components/workspace/git/GitChangesTab.test.ts`: PASS, 15 tests.
- `npm run test:e2e -- --grep "mobile Git Changes responsive renderer"`: PASS, all 9 viewport tests. The separate native keyboard case was not included in this grep run; the earlier full spec had that test passing.
- `npm run typecheck`: PASS. `npm run lint`: PASS, 0 errors and 4654 warnings, Prettier passes. `npm run test:store-appx-config`: PASS, 9 tests. `$env:VITE_BUILD_WATCH='1'; npm run build`: PASS.
- Earlier full-suite backend failures (Monaco codicon asset missing from installed node_modules and Windows OpenSSH test timeouts) and one settings screenshot mismatch remain unverified/reported; user visual review and substantial independent audit items remain open. WORK_LOCK remains.
- Full `npm run test:e2e` rerun after the mock fix: 140 passed, 5 skipped, 2 failed. All Git responsive cases now pass. The settings dialog screenshot still differs by 4% of pixels. A file-manager responsive test failed to find `.file-list` under the 8-worker run, then passed alone (`npm run test:e2e -- test/e2e/file-manager-responsive.spec.ts`); treat as parallel-run flake pending a stable full rerun.
- Full backend continuation: corrected two tests to locate Monaco from `import.meta.resolve("monaco-editor")`, because this checkout shares dependencies at the parent workspace and has no local `node_modules/monaco-editor`. `npm run test:backend -- electron/backend/remote-static-assets.test.ts electron/backend/mobile/mobile-relay-connector.test.ts` passes 74 tests. Full `npm run test:backend` then reported 223 files passed, one failed SSH integration file (one test failed, 5454 passed, 7 skipped); the SSH failure was the known Windows native OpenSSH/conPTY timeout under suite load. Running `npm run test:backend -- electron/backend/ssh/ssh-connection-test.integration.test.ts` alone passes all 8 tests. `npm run typecheck` and targeted ESLint/Prettier pass after this test fix.
- Re-audit found a settings persistence defect: `SettingsGitTab.vue` bound `form.git.ui.newView`, but `SettingsDialog.vue` had not initialized or included it in the emitted save payload. Added explicit default-off initialization, typed field, payload persistence, and a SettingsDialog integration regression that mounts the real Git tab and checks the sibling action preference survives. `npm run test:ui -- src/components/dialogs/SettingsDialog.test.ts`: PASS, 33 tests. `npm run typecheck`, targeted ESLint/Prettier and watch-compatible production build pass.
- Root-scope audit follow-up: when `gitRoots` is empty, runtime now accepts an explicit root only if it resolves to that workspace's `cwd` (case-insensitive on Windows); absent root remains the existing implicit default. A runtime test proves a foreign root is rejected before a Git fetch is accepted. `npm run test:backend -- electron/backend/runtime.test.ts`: PASS, 509 tests; typecheck, targeted lint/format, and watch-compatible build pass.
- History preferences audit follow-up: favorites/recent previously read only `localStorage` from a computed value, so writes were not reactive in the mounted picker. The store now maintains a scoped reactive cache, hydrates it from storage, updates it before persistence, and keeps the current-session control responsive if storage writes fail. Added store regression covering favorite add/remove and recent-ref updates; `git-ui.test.ts` (45) and `GitBranchesTab.test.ts` (6) pass, typecheck, targeted lint, Prettier and watch-compatible build pass.
- Full UI verification after the settings, root-scope, and History fixes: `npm run test:ui` PASS, 214 files / 3,024 tests.
- Long Git operation duplicate-launch audit follow-up: `startLongGitAction` now checks accepted/running registry entries scoped to profile + origin workspace + root + kind before accepting. Same-input concurrent calls return the existing operation; differing input for an occupied kind/root is rejected. A regression sends separate idempotency keys concurrently and confirms only one fetch runs. Runtime suite PASS, 510 tests; typecheck, targeted ESLint/Prettier, and watch-compatible build pass.

## Worker continuation update (2026-10-21, fresh full verification)

- `npm run typecheck`: PASS.
- `npm run test:ui`: 213 files pass, 1 fails; 3,023 tests pass, 1 timeout in `SshDialogFlow.test.ts` under the full parallel run. The same file passes alone (10 tests), so this was load-sensitive and unrelated to Git changes.
- `npm run test:backend`: 221 files pass, 3 fail; 5,454 pass, 7 skipped, 3 timed out. Failures: agent-task callback and review-git fixture tests exceeded 30 seconds under suite load; native OpenSSH test timed out. The SSH integration file passes alone (8 tests). The full backend run took 380.56 seconds.
- `$env:VITE_BUILD_WATCH='1'; npm run build`: PASS; renderer, Electron backend, preload and shell integration build completed.
- `npm run lint`: PASS, 0 errors, 4,657 existing warnings; Prettier passes.
- The existing responsive Git E2E run after mock fix remains 9/9; the last full E2E report remains 140 passed, 5 skipped, 2 failures (settings screenshot mismatch and file-manager visibility under parallel load; file-manager passes alone).
- No application or dev server was launched. The visual walkthrough in `MANUAL_VERIFICATION.md` remains a user action in their `dev.ps1` session. WORK_LOCK remains because manual review and audit items are still open.

## Worker continuation update (2026-10-21, long Git diagnostics)

- `startLongGitAction` now carries structured failed mutation details into durable operation errors: warnings, conflicts, in-progress repository state, and the last 6,000 characters of Git output. Authentication failures receive a clear action-specific summary. Successful results carry warnings into notifications.
- Git operation notifications now identify Fetch/Pull/Push, show success summaries and warnings, and retain the detailed failure message.
- `npm run test:backend -- electron/backend/runtime.test.ts -t "long Git failures retain warnings"`: PASS (1 focused test). `npm run test:ui -- src/stores/app-workspace-actions.test.ts -t "Git operation notifications"`: PASS (1 focused test).
- `npm run typecheck`: PASS. `$env:VITE_BUILD_WATCH='1'; npm run build`: PASS. `npm run lint`: PASS, 0 errors and 4,659 warnings; Prettier passes. `git diff --check`: PASS.
- Full self-audit still has substantive PARTIAL requirements, full suite load-sensitive failures, and user visual review pending. WORK_LOCK remains in place.

## Worker continuation correction (2026-10-21, History query scope)

- The older audit entries 15 and 17 describe stale code: current `GitPane.vue` passes `profile-id` into `GitBranchesTab`; its picker maps explicit `HEAD` to `branch: "HEAD"` and maps the explicit all-ref option to the empty all-refs query. Current component behavior has a regression in `GitBranchesTab.test.ts` proving these queries differ; the focused test passes.
- Focused ESLint for the added test: 0 errors, 1 existing security object-injection warning. Prettier and full repository typecheck pass.

## Worker continuation update (2026-10-21, isolated Settings screenshot)

- Ran `npm run test:e2e -- test/e2e/interactive.spec.ts --grep "settings dialog"`: four functional settings tests pass; the settings visual snapshot fails by 4% pixels even when isolated.
- Screenshot inspection shows the current Settings General tab has terminal font size and notification timing controls, while the expected snapshot shows the external editor control and a shorter, differently sized dialog. This is a real stale screenshot/content mismatch in the current tree; it is not a parallel-load failure. Snapshot was not rewritten because the intended baseline needs to be reconciled against the feature/task change.
- User-owned `MANUAL_VERIFICATION.md` walkthrough remains outstanding; no dev.ps1 app session was launched.

## Worker continuation update (2026-10-21, full renderer verification)

- Updated `test/e2e/interactive.spec.ts-snapshots/settings-dialog-chromium-win32.png` to match the current Settings General tab; the previous snapshot dated April expected removed/different controls. The isolated Settings dialog flow + screenshot passes 5/5.
- `npm run test:ui`: PASS, 214 files / 3,028 tests.
- `npm run test:e2e`: PASS, 142 passed / 5 skipped. `test/e2e/file-manager-responsive.spec.ts`: PASS. `test/e2e/mobile-git-responsive.spec.ts`: PASS, 10 cases including keyboard handling.
- Full backend suite rerun is in progress; results to be appended after it finishes. User visual verification remains a dev.ps1 session owned by the user and is not completed here.

## Worker continuation update (2026-10-21, full suite refresh)

- Full UI: PASS, 214 files / 3,028 tests. Full E2E: PASS, 142 passed / 5 skipped. Git responsive E2E: 10/10. File-manager responsive E2E: PASS. Settings dialog E2E: 5/5 after refreshing the stale visual snapshot.
- Full backend: 223 files passed, 1 failed; 5,457 passed, 7 skipped. Two reviewer/author variants of the source-rewritten auto-reset test hit the 30-second test timeout. The same two tests pass isolated (2/2, 8.69 seconds before timeout change; 2/2, 25.46 seconds after). They perform real local commits, a force push and reset; the case-specific timeout is now 60 seconds. Global timeout unchanged.
- Began a redundant whole `review-git/engine.test.ts` run after the focused tests; stopped it after several minutes without a summary. The changed test cases were rerun directly and pass. A full backend rerun after the local timeout adjustment remains outstanding.
- Full lint/typecheck/build were green in the previous continuation; this continuation changed a screenshot and one test timeout. Focused ESLint reports 0 errors (33 existing warnings) and Prettier passes on the timeout change.
- No `dev.ps1` session was started. The manual visual walkthrough remains for the user's session. WORK_LOCK stays present.

## Worker continuation update (2026-10-21, stable full backend)

- `npm run test:backend -- --maxWorkers=4`: PASS, 224 files / 5,459 tests (7 skipped), duration 272.87 seconds. This reduced process concurrency after default parallelism caused Windows Git child-process crashes and fixture assertions to fail. The two review-Git rewritten-source reset cases use a 60-second per-case timeout; global timeout remains 30 seconds.
- `npm run typecheck`: PASS. `npm run lint`: PASS, 0 errors and 4,659 warnings; Prettier passes.
- Full UI passes (214 files / 3,028 tests); full E2E passes (142 passed / 5 skipped), including Settings visual, file-manager responsive, and Git responsive coverage.
- Remaining work is the independent requirement audit and the user's manual walkthrough in their `dev.ps1` session. WORK_LOCK remains present.

## Worker continuation correction (2026-10-21, History columns)

- Numbered audit item 18 is now implemented: `GitTreeGraph.vue` renders refs in a dedicated fixed-width column and commit subjects in a separate aligned column. Compact mode uses a narrower refs column. GitTreeGraph tests (13), full typecheck, focused ESLint/Prettier, and `$env:VITE_BUILD_WATCH='1'; npm run build` pass.
- Earlier numbered findings 15 and 17, and TODO item 111, were stale as already noted: current picker distinguishes `HEAD` from all refs and GitPane passes the active profile. Their interaction is tested in `GitBranchesTab.test.ts`.

## Worker continuation correction (2026-10-21, unavailable More destinations)

- Numbered audit item 14 is implemented for new-view More tools: if a selected destination disappears (for example Conflicts after resolution), the shell displays the currently selected main view with a status explanation and preserves the destination ID so it returns when available again. `GitPane.test.ts` covers the fallback, saved destination retention, empty select value, and visible History panel.
- Full UI after both History alignment and destination fallback changes: 214 files / 3,030 tests pass. Full typecheck passes. Safe production build passes. Focused ESLint has zero errors (28 existing warnings), Prettier and `git diff --check` pass.

## Worker continuation correction (2026-10-21, shared operation status in Review)

- Re-audit confirmed the History, Changes, and most More destinations render `GitOperationCard`, but the new Review view did not. This left an in-progress Git action or its last result unavailable while Review was active. The new Review branch now renders the shared card for both linked provider Review and the unlinked empty state. `GitPane.test.ts` verifies the card remains mounted when switching to Review during a fetch; the focused suite passes 20 tests. Full typecheck and safe production build were rerun after this Vue change (see latest verification below).

## Stale audit entries rechecked against current routing

- Findings 4 and 12's claim that More excludes Branches is stale: `legacyDestinations` is `tabs` minus only Changes, and the `branches` destination mounts `GitBranchesTab` without compact History mode. That retains branch management and general comparison. `GitPane.test.ts` exercises Branches and Stashes routing; the user's visual pass still needs to confirm every More destination.
- Findings 14, 15, 17, and 18 are corrected in the prior continuation notes: unavailable More selection is explained and retained; active profile is passed into History and HEAD/all-refs issue distinct queries; History refs and subjects occupy aligned separate columns. Do not count their older `PARTIAL` text as current findings.
- Finding 10's new-view operation visibility now includes Review. Other classic/More destinations keep their existing operation cards where their tools need them. The user visual pass remains required for cross-view conflict and operation behavior.

Verification after the Review operation-card fix: `npm run test:ui -- src/components/workspace/GitPane.test.ts` passes (20 tests); `npm run typecheck` passes; `$env:VITE_BUILD_WATCH='1'; npm run build` passes; focused Prettier, ESLint (0 errors; 2 pre-existing unused-parameter warnings), and `git diff --check` pass. The full stable suites remain those recorded above: UI 3,028 tests, backend 5,459 tests with 7 skipped at four workers, and E2E 142 passed / 5 skipped.

## Worker continuation correction (2026-10-21, fetch-first integration)

- Rechecked the long-operation conversion against the existing update-current-branch flow. `gitConfirmAction` previously awaited `gitFetch` as if it completed in the request, then immediately started merge/rebase; the runtime now returns `{ started, operationId }`, so the integration could run against stale refs. The store now listens for the operation completion event and watches `operations.lastResults` as a reconnect/replay fallback. It continues only after a successful fetch, keeps the busy phase across both steps, and surfaces a failed fetch without starting merge/rebase.
- Regression coverage proves merge and rebase do not begin before a successful fetch, a failed fetch prevents integration and leaves an error result, and a missed event can be recovered from the operations payload. `npm run test:ui -- src/stores/git-ui.test.ts` passes 50 tests; `npm run typecheck`, the safe production build, focused ESLint (0 errors; existing warnings), Prettier, and `git diff --check` pass.
- This closes the fetch-first composition gap only. Remote tag push/delete and the user visual walkthrough remain open audit items; WORK_LOCK remains.
- Fresh project verification after the fetch-first change: full UI passes 214 files / 3,035 tests; full `npm run lint` exits 0 with 4,663 warnings and Prettier passes; `npm run typecheck` passes. A safe production build is running before commit.

## Worker continuation correction (2026-10-21, fetch-first operation consolidated)

- Supersedes the interim fetch-first client wait described above. Merge/rebase were still synchronous, and a disconnect between the separately accepted fetch and integration could leave the update unfinished. Runtime now accepts merge/rebase through the generic operation registry and performs optional fetch plus integration inside that one operation. The store waits on the resulting `git.merge` / `git.rebase` event, or the outcome in `operations.lastResults` if the live event was missed. Remote slot-aware merge/rebase routes validate the safe Git payload before acceptance.
- Runtime regressions cover prompt acceptance/deduplication of a long rebase, the fetch → rebase sequence within one operation, and fetch failure preventing rebase. Store regressions cover merge/rebase busy state through the terminal result, failure display, and payload recovery. Focused backend tests pass 3 cases; `git-ui.test.ts` passes 50 cases.
- Fresh typecheck and focused UI/backend checks passed after this change. Full lint and a safe production build are being rerun. Remote tag push/delete and the user's visual walkthrough remain open; WORK_LOCK remains.

## Worker continuation correction (2026-10-21, network tags and History context)

- Remote `gitPushTag`, `gitPushAllTags`, and `gitDeleteRemoteTag` now use the generic operation registry. The store waits for the terminal operation outcome without the normal request timeout, including confirm-driven remote-tag deletion. Remote slot routes validate the Git payload before dispatch. A gated runtime test confirms remote tag push returns an operation ID promptly and same-input retry deduplicates to that ID.
- Compact History ref and commit-search state is now cached in the Git UI store by profile/workspace/root, so unmounting History does not lose its picker state and contexts do not share it. On narrow layouts compact History skips its hidden Branch Tree step and labels navigation as History. A component regression covers the mobile starting state.
- `runGitAction` now captures its starting root and selected path/scope before a mutation; it refreshes that preview only against the original root and only applies it if the same context remains selected. A delayed preview regression switches roots/selections and proves old-root content cannot overwrite the new context.
- Verification on current tree: full UI 214 files / 3,038 tests pass; full backend at four workers 224 files / 5,463 passed, 7 skipped; `npm run typecheck` passes; `npm run lint` passes with 0 errors / 4,672 existing warnings and Prettier clean; `$env:VITE_BUILD_WATCH='1'; npm run build` passes. Focused runtime tag test (1), focused UI/store tests (60), typecheck, build and touched-file ESLint/Prettier also pass.
- The previous audit contains many findings now stale from intervening fixes; earlier correction entries already supersede several navigation/History/hunk/Review claims. Concrete audit work remains, including full inventory-route audit/error assertions and some draft/settings/accessibility acceptance. `MANUAL_VERIFICATION.md` remains explicitly pending for the user's `dev.ps1` session; the app was not launched and `WORK_LOCK` remains.

## Worker continuation correction (2026-10-21, inventory reconciliation)

- Updated `IMPLEMENTATION_INVENTORY.md` to record the current typed Electron/remote transport paths, audited/index write behavior, operation-registry coverage for merge/rebase and remote tag writes, More precedence, scoped History selection/search, and current verified full-suite counts. Removed the stale claim that repository typecheck still fails.
- Re-ran `npm run test:backend -- electron/backend/mobile-session-route-policy.test.ts`: PASS, 50/50. `git diff --check` passes. Current full UI/backend/typecheck/lint/build evidence is recorded above from the previous continuation.
- Remaining To Do still includes the user's visual walkthrough and independent acceptance audit gaps (including unsaved Review editor round-trip and route-level audit assertions). No app was launched; WORK_LOCK remains.

## Worker continuation correction (2026-10-21, duplicate action exclusion)

- The shared `runGitAction` previously had no duplicate-launch guard. It now reserves `busyAction` before the first asynchronous boundary and ignores a second invocation of the same action while pending, avoiding overlapping operation waiters and premature busy-state clearing.
- `npm run test:ui -- src/stores/git-ui.test.ts`: PASS, 53 tests. `npm run typecheck`: PASS. Touched-file ESLint: 0 errors (existing warnings); Prettier and `git diff --check` pass. `$env:VITE_BUILD_WATCH='1'; npm run build`: PASS (existing chunk-size warnings).
- Full inventory audit, draft/settings/accessibility acceptance and the required user visual pass remain open. WORK_LOCK remains.

## Worker continuation correction (2026-10-21, local index audit outcomes)

- Local Git write actions now emit to `gitAuditLogStore` when there is no provider connection. The system audit includes stage/unstage file and hunk, commit-staged, branch/tag/history mutations, action outcome, duration, and the resolved effective repository root. Local write categories are recorded as writes; fetch remains a read. Provider-connected operations retain their provider audit path.
- Added a real Git fixture regression that checks exactly one audit entry for successful stage-file and commit-staged plus one failed empty-index commit entry, all scoped to the same resolved root. The focused audit test passes; full `git-manager.test.ts` passes 177 tests / 2 skipped. `npm run typecheck`, full `npm run lint` (0 errors / 4,674 warnings; Prettier clean), and safe watch-compatible build pass.
- `IMPLEMENTATION_INVENTORY.md` now reflects the system audit behavior. Broader route-level audit count assertions, other acceptance items, and the user's manual walkthrough remain open; WORK_LOCK remains.

## Worker continuation correction (`b8b2b7de`)

- History now renders a temporary option for a persisted ref while its sources load, preserving the select's visible value as well as the scoped store value. Ref pruning waits for branch and tag lists to be available; a tag read error no longer looks like a deleted tag. The History picker test asserts the saved value remains in the actual select. Focused `GitBranchesTab.test.ts` passes 10 tests, repository `npm run typecheck` passes, Prettier and `git diff --check` pass.
- The initial audit ledger's item 69 still has open empty/detached/large-list and human root/profile acceptance; the deleted-ref pruning behavior is implemented once both lists are available. User visual verification and broader lifecycle/audit coverage remain outstanding, so WORK_LOCK remains.

## Worker continuation verification refresh (2026-10-21)

- Current full renderer UI suite: `npm run test:ui` passes 214 files / 3,042 tests after the History picker loading-state change.
- Current repository `npm run typecheck`: passes. `npm run lint`: passes with 0 errors / 4,678 existing warnings; repository Prettier check passes. `$env:VITE_BUILD_WATCH='1'; npm run build`: passes. No Electron app or dev server was launched.
- Full backend was last run successfully immediately before the latest frontend-only History picker changes: 224 files / 5,465 passed / 7 skipped with four workers. Backend sources are unchanged since that run.
- Remaining: user-owned `MANUAL_VERIFICATION.md` walkthrough, detailed lifecycle/reconnect/route-audit coverage, and remaining numbered partial requirements. WORK_LOCK remains in place; this is not an assertion of completion.

## Worker continuation correction (`1ead33cc`)

- When completed branch/tag reads prove a persisted selected ref is gone, History now clears it to all commits and displays a `role="status"` explanation. Selecting another ref clears that notice. Added a reactive component regression for a deleted remote ref. `GitBranchesTab.test.ts` passes 11 tests; repository typecheck, touched-file Prettier and `git diff --check` pass. This closes the silent-prune behavior in audit item 69, while empty/detached/large-list and manual root/profile checks remain open.
- The latest full UI/lint/build verification was run before this small UI follow-up; its focused test and typecheck passed after the change. Manual walkthrough, broader reconnect/audit coverage, and other numbered partial items remain; WORK_LOCK remains present.

## Worker continuation (`read-only picker coverage`)

- Expanded the History picker contract test to assert no checkout (local or remote), branch create/rename/delete, remote branch delete, tag create, worktree removal, fetch, or push occurs when selecting a ref. The picker suite passes 11 tests, repository typecheck passes, Prettier and diff checks pass. This strengthens audit item 85; broader inventory mutation/audit mapping and manual acceptance remain open.

## Worker continuation (`empty/detached History`)

- Added a compact History regression for a repository with no commits and no current branch. It asserts the explicit detached HEAD picker label, detached working-branch label, and empty-history graph state. Focused `GitBranchesTab.test.ts` passes 12 tests; touched-file Prettier and `git diff --check` pass. This reduces the automated gap in item 69; hundreds-of-refs, root/profile switching, visual keyboard/narrow checks, and other audit findings remain open.

## Worker continuation (`large History ref lists`)

- Added a compact History component test with 400 local refs. It verifies the last ref is rendered and a targeted search sharply reduces visible matching options while retaining the intended ref. `GitBranchesTab.test.ts` passes 13 tests; repository typecheck, touched-file Prettier/ESLint and `git diff --check` pass. This closes the automated large-list portion of audit item 69; keyboard/focus, visual narrow behavior and root/profile switching acceptance remain open.

## Worker continuation (`operation card visibility`)

- Added component-level regressions proving History and Changes render the shared operation status card during an active fetch. The existing GitPane test verifies Review's parent-rendered card. `GitBranchesTab.test.ts` and `GitChangesTab.test.ts` pass 29 combined tests; repository typecheck and touched-file Prettier pass. This strengthens audit items 10 and 94; across-view conflict, operation completion, and human visual acceptance remain open.

## Worker continuation (`History scope wiring`)

- Added a component regression confirming History passes its active workspace, repository root, and profile into the scoped selection store getter. The focused GitBranchesTab suite passes 14 tests; repository typecheck, touched-file Prettier/ESLint and `git diff --check` pass. This adds UI wiring evidence to audit item 69; actual profile/root switching acceptance still needs broader lifecycle tests and the user walkthrough.

## Worker continuation (`tag read failure and selected ref`)

- Added a reactive regression where a branch list changes while tag loading has failed. The selected tag remains selected and the History alert stays visible, rather than treating the absent tag data as evidence of deletion. GitBranchesTab suite passes 15 tests; repository typecheck, touched-file Prettier/ESLint and `git diff --check` pass. This verifies the tag-error pruning guard; other scoped lifecycle and manual visual requirements remain.

## Worker continuation (`empty ref load completion`)

- The stale-ref watcher now observes branch/tag loading and tag-error state as well as ref names. A completed successful fetch that returns the same empty lists now rechecks and prunes a stale selection; pending reads and failed tag reads still preserve it. Added a component regression for the pending → successful empty transition. `GitBranchesTab.test.ts` passes 16 tests; repository typecheck, touched-file Prettier/ESLint and `git diff --check` pass. WORK_LOCK remains because user visual review and other lifecycle/audit items are open.

## Worker continuation verification refresh (2026-10-21, ref loading)

- `npm run test:ui`: PASS, 214 files / 3,049 tests after selected-ref loading/error-state changes.
- `npm run typecheck`: PASS after those changes. `$env:VITE_BUILD_WATCH='1'; npm run build`: PASS, including renderer, backend, preload, and shell integration copy. Existing chunk-size warnings remain.
- Backend source has not changed since the last full stable run: 224 files / 5,465 passed / 7 skipped with four workers. No app or dev server was launched.
- The manual `dev.ps1` walkthrough and broad reconnect/audit/accessibility acceptance remain open; WORK_LOCK remains.

## Worker continuation correction (`multi-ref loading guard`)

- The ref readiness guard now also protects multi-selected branch refs. Loading/error-state watcher callbacks no longer prune those selections while source lists are incomplete. GitBranchesTab suite passes 16 tests; touched-file Prettier/ESLint and diff checks pass. Remaining manual narrow/keyboard and broad operation/lifecycle requirements keep WORK_LOCK in place.

## Worker continuation verification refresh (2026-10-21, full suites)

- `npm run test:ui`: PASS, 214 files / 3,049 tests.
- `npm run test:backend -- --maxWorkers=4`: PASS, 224 files / 5,465 passed, 7 skipped, duration 266.79s.
- `npm run typecheck`: PASS. `npm run lint`: PASS, 0 errors / 4,678 warnings; repository Prettier check passes. Safe build with `VITE_BUILD_WATCH=1` passed in the preceding verification refresh after the latest implementation changes.
- No Electron app/dev server was launched. `MANUAL_VERIFICATION.md`, route/audit completeness, reconnect/draft lifecycle, and keyboard/narrow human acceptance are still open; WORK_LOCK remains.

## Worker continuation (large read payload reactivity)

- Audit item 43 is implemented: graph/diff, branch-list, and tag read results use `markRaw` at assignment. `git-ui.test.ts` verifies graph, nested commits, and diff preview are not reactive. Commit: `9512e01d`.
- Current checks: full UI 214 files / 3,050 tests; backend 224 files / 5,465 passed / 7 skipped (backend unchanged); typecheck passes; focused ESLint has 0 errors (63 warnings); touched-file Prettier and `git diff --check` pass; watch-compatible build passes.
- Manual `dev.ps1` walkthrough and other outstanding lifecycle/audit items remain; keep WORK_LOCK.

## Worker continuation (Git network operation completion)

- Fetch, pull, and ordinary push now wait for the accepted OperationRegistry result before clearing busy state or showing completion. The store resolves from the live operation event or persisted `operations.lastResults`; `git-ui.test.ts` covers terminal failure events for all three actions and pull recovery after a missed event.
- Focused Git UI store suite passes 58 tests; full UI passes 214 files / 3,054 tests; typecheck, full lint (0 errors / 4,680 warnings; Prettier clean), and watch-compatible build pass. Backend sources are unchanged; the recorded full backend run is 224 files / 5,465 passed / 7 skipped.
- Commit this continuation after verification. User visual walkthrough and renderer reconnect/profile-switch acceptance remain open; WORK_LOCK stays.

## Worker continuation (staged draft retry)

- Added a Changes component regression confirming `gitCommitStaged` returning failure leaves the submitted root-scoped message in both the input and store for retry. `GitChangesTab.test.ts` passes 17 tests.
- Full UI passes 214 files / 3,055 tests; typecheck, focused ESLint (0 errors / 2 warnings), touched-file Prettier and `git diff --check` pass. Backend and implementation code did not change in this follow-up.
- Updated the action inventory's operation-completion description and current verification counts. User visual/manual review, disconnect/pre-push-hook lifecycle scenarios, and broader inventory/audit requirements remain open; WORK_LOCK stays.

## Worker continuation (network outcome duplicate delivery)

- Expanded the fetch/pull/push operation tests so each terminal failure is delivered through both the operation event and persisted lastResults; one user-facing error notification is produced per accepted operation. `git-ui.test.ts` passes 58 tests; typecheck, focused ESLint (0 errors / existing warnings), Prettier and diff check pass.
- No implementation changed in this test-only follow-up. The last full UI run remains 214 files / 3,055 tests; backend remains 224 files / 5,465 passed / 7 skipped. Renderer reconnect/profile-switch, manual visual and route inventory acceptance remain open; WORK_LOCK stays.

## Worker continuation (setting toggle during operation)

- Added a GitPane integration test that keeps fetch active while toggling the opt-in new view off and on; the busy store state survives and the operation card is present after restoring the new view.
- GitPane tests pass 21 tests; full UI passes 214 files / 3,056 tests; typecheck passes. Comment-editor persistence through the actual Settings control and visual confirmation remain pending, along with other lifecycle/audit items; WORK_LOCK stays.

## Worker continuation (self-audit reconciliation)

- Reconciled numbered findings 78, 79, and 92 with the current long-operation coverage: registry-backed network operations, duplicate event/payload terminal delivery, pull recovery from persisted outcome, and backend profile isolation are implemented and tested. Remaining lifecycle gaps are renderer reconnect during pending pull/push and cross-profile pull/push integration coverage.
- Root-scoped post-action diff refresh and staged commit completion capture the originating root; branch/tag read responses check request generation and active root before assignment. Route-wide exact audit counts and manual accessibility/visual checks remain outstanding.

## Worker continuation (pull/push profile isolation)

- Added gated runtime tests for pull and push accepted concurrently in separate profiles with identical idempotency keys. Each action receives a distinct operation ID, and each terminal result carries the matching profile and workspace.
- Focused runtime tests pass (2 passed, 517 skipped); repository typecheck passes; focused ESLint has 0 errors / 130 existing warnings; Prettier and diff check pass. Renderer disconnect/reconnect acceptance, route audit coverage and the manual walkthrough remain open; WORK_LOCK stays.

## Worker continuation verification refresh (2026-10-21)

- Re-read `PROMPT.worker.md`, `TODO.md`, `WORKER.md`, `TASK.md`, `MANUAL_VERIFICATION.md`, the project `README.md`, and `CLAUDE.md`.
- `npm run typecheck` passes on the current tree. `CLAUDE.md` warns against plain builds while the user's watcher may be active; no build, app, or dev server was launched in this continuation.
- No source changes were needed after the latest focused lifecycle additions. The automated coverage now includes persisted and unsaved review drafts across pane unmounts and busy operation state across view toggles. Remaining renderer disconnect/reconnect integration, broad route audit, and narrow/keyboard visual acceptance remain recorded above.
- The required `MANUAL_VERIFICATION.md` walkthrough must be performed by the user in their existing `dev.ps1` session, so `WORK_LOCK` remains present and TODO's user-owned visual review item stays open.

## Worker continuation (History root/profile switch lifecycle)

- Added a mounted History picker regression that restores distinct saved refs across repository roots and profiles, and restores the original visible ref when switching back. This strengthens requirement 86 and closes the automated root/profile-switch portion noted in TODO; keyboard/narrow visuals remain manual.
- `npm run test:ui -- src/components/workspace/git/GitBranchesTab.test.ts`: PASS, 17 tests. `npm run typecheck`: PASS. Touched-file Prettier, ESLint (0 errors; one existing security warning), and `git diff --check`: PASS.
- `WORK_LOCK` remains because renderer disconnect/reconnect integration, route/audit inventory completeness, and the user-owned visual walkthrough are still open.

## Worker continuation (reconnect outcome snapshot)

- Extended the app-store remote revision-gate tests with a missed `git.pull` completion: after disconnect/reconnect resets the core revision baseline, a restarted server's lower-revision snapshot applies and its persisted `operations.lastResults` produces the action-specific Git Pull failure notification. This verifies the renderer app-state/reconnect boundary; a single end-to-end test spanning a pending `git-ui` action through actual transport reconnect remains open under items 78/79/92.
- `npm run test:ui -- src/stores/app.test.ts`: PASS, 48 tests. `npm run typecheck`: PASS. Prettier and `git diff --check`: PASS. Focused ESLint: 0 errors, 14 pre-existing warnings.
- `WORK_LOCK` remains; route-level audit completeness and the user-owned manual walkthrough also remain outstanding.

## Worker continuation (index mutation route dispatch)

- Added a runtime integration regression calling the stage-file, unstage-file, and commit-staged handlers. It asserts each manager mutation is invoked exactly once with the workspace and validated root. This adds route-boundary evidence to requirement 91; the GitManager real-repository audit test still proves the audit entry behavior at the manager boundary.
- Focused runtime test: 1 passed / 519 skipped. Repository `npm run typecheck`: PASS. Touched-file Prettier: PASS; ESLint: 0 errors / 130 existing warnings; `git diff --check`: PASS.
- Full menu/shortcut mapping, renderer reconnect end-to-end, and manual visual acceptance remain open, so keep `WORK_LOCK`.

## Worker continuation (Settings toggle and unsaved Review editor)

- Added a GitPane integration regression that mounts the actual `SettingsGitTab` checkbox and app-level `DialogOverlay`, edits an unsaved TextAreaDialog comment, applies the off/on setting transitions to the saved settings snapshot, and confirms the editor remains open with its text after both transitions. This closes the automated portion of requirement 84; duplicate subscription/mutation checks and visual confirmation remain manual.
- `npm run test:ui -- src/components/workspace/GitPane.test.ts`: PASS, 22 tests. `npm run typecheck`: PASS. Prettier and `git diff --check`: PASS. Focused ESLint: 0 errors / 2 pre-existing warnings.
- `WORK_LOCK` remains because the user visual walkthrough and broader menu/shortcut and reconnect audit are still open.

## Worker continuation (More destinations)

- Added a `test.each` component regression covering all More destinations exposed by current repository state: Overview, Branches, Stashes, Pull Request, Worktrees, Bulk (multi-root only), and Conflicts (only while conflicts exist). Changes remains a primary view and is intentionally absent from More. This adds automated evidence for requirements 72, 94, and TODO inventory routing.
- `npm run test:ui -- src/components/workspace/GitPane.test.ts`: PASS, 29 tests. `npm run typecheck`: PASS. Prettier and `git diff --check`: PASS. Focused ESLint: 0 errors / 3 pre-existing warnings.
- `WORK_LOCK` stays because visual acceptance, full shortcut/menu inventory, and end-to-end reconnect work remain open.

## Worker continuation (pre-push diagnostics UI regression)

- Focused GitOperationCard and git-ui suites pass 59 tests. Repository typecheck and touched-file Prettier pass; ESLint reports 0 errors and 15 existing warnings in git-ui.test.ts. `git diff --check` passes. Hook diagnostics reach the operation card; pending disconnect-through-action, broad route/menu audit, and user-owned `MANUAL_VERIFICATION.md` walkthrough remain open, so WORK_LOCK stays.

## Worker continuation (scoped operation diagnostics)

- OperationRegistry failure logs now include effective profile, origin workspace, optional root path, elapsed duration, operation identity, step, and stable error code. The regression verifies these fields without including operation inputs or credentials. Backend suite: 10 tests pass; repository typecheck passes; touched-file Prettier passes; ESLint reports zero errors with existing warnings; `git diff --check` passes.
- Remaining long-runner classification gaps, route/menu audit, and user-owned manual walkthrough stay open; WORK_LOCK remains.

## Worker continuation (structured long Git failures)

- Long Git failures now retain stable `git_operation_failed` classification, bounded warnings, conflict paths, and raw output in the generic operation outcome. Those diagnostics pass through the shared operation event schema and store to the Git status card. OperationRegistry tests pass 10; the focused runtime failure regression passes; `git-ui.test.ts` passes 59; repository typecheck, touched-file Prettier, ESLint (0 errors; existing warnings), and `git diff --check` pass.
- Other long-operation result classifications and remaining manual/inventory audit items remain open. WORK_LOCK stays.

## Worker continuation (long Git outcome propagation)

- Re-audited requirements 51, 78, 89, and 92. Long Git failures preserve bounded diagnostic metadata from the structured manager result through OperationRegistry persistence, event/payload validation, Git UI store mapping, and the shared operation card. Targeted runtime, registry, and store tests pass; repository typecheck and touched-file format/lint checks pass. Full renderer transport reconnect and other long-runner classification remain separate open requirements.
- Manual `MANUAL_VERIFICATION.md` remains user-owned in the existing `dev.ps1` session. WORK_LOCK remains present.

## Worker continuation (Review draft file switch)

- Extended the unsaved Review editor lifecycle regression with two changed files. It selects the second file while the TextAreaDialog is open and confirms the text remains unchanged; focused AzureReviewPane test passes. Repository typecheck, touched-file Prettier, ESLint (0 errors; 8 existing warnings), and `git diff --check` pass.
- The user-owned visual walkthrough and broader lifecycle/reconnect/inventory audit remain open. WORK_LOCK stays present.

## Worker continuation (cross-view conflict action)

- Added a mounted `test.each` across the three primary views. With a conflict in the current Git snapshot, the shared “Resolve conflicts” toolbar action remains exposed in History, Changes, and Review. Three focused GitPane cases pass; repository typecheck, touched-file Prettier, ESLint (0 errors; 4 existing warnings), and `git diff --check` pass.
- Reconciled requirement 10's cross-view conflict evidence and requirement 35's Review file-switch evidence. Manual visual verification and broader audit remain open; WORK_LOCK stays.

## Worker continuation (History empty-search and read-error states)

- Added a compact History regression confirming an unmatched commit search shows a no-match status, then a graph read failure suppresses that empty-result message and shows the query error. `GitBranchesTab.test.ts` passes 18 tests; repository typecheck, touched-file Prettier, ESLint (0 errors; one existing warning), and `git diff --check` pass. This updates requirement 22's error/empty-state evidence.
- Path-filter file history, keyboard/narrow human review, broader route and reconnect audits, and the user walkthrough remain open; WORK_LOCK stays.

## Worker continuation (full Git header details)

- Added a native `<details>` control to the shared Git toolbar. Keyboard users can reveal the full active root path and working branch; long paths wrap within the disclosure. The mounted GitPane regression verifies the disclosure content for a long root. Focused GitPane test and repository typecheck pass; touched-file Prettier passes; ESLint reports 0 errors and 4 existing warnings; `git diff --check` passes.
- Requirement 9 still needs human narrow-layout review. Route/menu inventory, reconnect, and other scoped lifecycle requirements also remain open. WORK_LOCK stays.

## Worker continuation (network failure keeps staged draft)

- Expanded the fetch/pull/push terminal failure regression to seed a root-scoped staged commit message and assert it remains after the action error, warnings, and raw output are surfaced. All three focused cases pass; repository typecheck and touched-file Prettier pass; ESLint reports 0 errors and 17 existing warnings; `git diff --check` passes.
- Renderer disconnect behavior and user visual acceptance remain open with the broader route/lifecycle audit; WORK_LOCK stays.

## Worker continuation verification refresh (current tree)

- Full UI: 214 files and 3,072 tests passed; one existing transport temporary-pause reconnect-timer assertion failed under full-suite load. The exact test passes alone (1 passed / 122 skipped).
- Full backend at four workers: 224 files, 5,468 passed, 7 skipped.
- `npm run typecheck`: pass. `npm run lint`: pass, 0 errors / 4,685 warnings; full Prettier check clean. `git diff --check`: pass. No app/dev server/build was launched; CLAUDE.md recommends typecheck and only a watch-compatible build when necessary.
- The remaining numbered audit and user-owned manual walkthrough are incomplete. WORK_LOCK remains.

## Worker continuation (History picker focus and management route)

- Added a mounted accessibility regression verifying the compact History reference select has native tab order, is focusable, and has an accessible label. Existing GitPane tests verify More exposes and routes to Branches management. Focused picker test passes; repository typecheck, touched-file Prettier, ESLint (0 errors; one existing warning), and `git diff --check` pass.
- Corrected stale audit text claiming More→Branches was absent. Full open/keyboard/Escape interaction and narrow visual behavior remain assigned to the user's manual walkthrough; complete shortcut/context-menu inventory remains open, so WORK_LOCK stays.

## Worker continuation (action entry-point index)

- Expanded `IMPLEMENTATION_INVENTORY.md` with the inspected toolbar, branch/commit/file context menu, Changes, stash, worktree, conflict, bulk, and provider routes, noting dispatch/guard, result surface, and new-view destination where verified. `git diff --check` and Prettier pass.
- Requirement 36 remains partial: some grouped action classes still need per-action audit/result mapping; the user's visual walkthrough remains open. WORK_LOCK stays.
- Current-tree verification after this continuation: `npm run typecheck` passes; `npm run lint` passes with 0 errors / 4,685 warnings and full Prettier clean; `git diff --check` passes. Documentation-only edits were committed as `70b6b454` (`docs map Git action entry points`). WORK_LOCK remains.

## Worker continuation (long-operation failure coverage)

- Added nine table-driven runtime cases covering structured diagnostics across every registered long Git action family: fetch, push, force push, remote branch/tag writes, merge, and rebase. `npm run test:backend -- electron/backend/runtime.test.ts -t "preserves structured diagnostics for long Git"` passes 9 tests; `npm run typecheck`, focused ESLint (0 errors), Prettier, and `git diff --check` pass.
- Requirement 51's structured manager failure propagation is now checked across all long Git routes. Generic rejected-promise classification, detailed per-action audit mapping, and user visual verification remain open; WORK_LOCK stays present.

## Worker continuation (renderer reconnect and profile lifecycle)

- Added an integration test using actual `createRemoteTransport`, `useAppStore`, and `useGitUiStore`. Pending pull and push each survive WebSocket disconnect/reconnect, remain pending when the renderer switches to profile p2, then resolve once from p1's persisted result after switching back. The test asserts the operation's workspace/root, unique idempotency key, and one start request per action.
- Full `npm run test:ui -- src/transport.test.ts` passes 125 tests; `npm run typecheck` passes; focused ESLint has 0 errors / 69 existing warnings; Prettier and `git diff --check` pass. This closes the end-to-end reconnect/profile-switch test gap recorded under 45/60/78/79/89/92/119; visual acceptance and wider route/audit inventory remain open.

## Worker continuation (index and local-tag route/audit pairing)

- Extended runtime routing coverage to stage-file, unstage-file, commit-staged, local-tag create, and local-tag delete; every manager method is called once with the explicit resolved root. Extended the real temporary-repository audit test to assert exactly one successful/failed audit row per index action and one successful row for each local tag action.
- `npm run test:backend -- electron/backend/runtime.test.ts electron/backend/git-manager.test.ts -t "index and local-tag routes dispatch one manager write|records successful and failed index and local-tag writes"` passes 2 tests. Remaining route families and full visual/manual acceptance remain open.
- Lost-start-response retry audit: ordinary fetch, pull, and push now retain an idempotency key scoped to workspace state + root + action (and pull stash mode). A null response keeps the key; any returned response clears it. The Git UI regression simulates a lost fetch start response and verifies retry reuses the key. Store suite: 60 passed; repository typecheck passes. Other mutation route audits and the user-owned manual walkthrough remain open; WORK_LOCK stays.
- Expanded requirement 77 route dispatch assertions: branch checkout/create/delete/rename, cherry-pick/squash/continue/abort, stash/save/pop/apply/drop/branch/import, and commit-all each dispatch one manager write with the resolved root. Focused `runtime.test.ts` regression passes (1 passed / 529 skipped), repository typecheck passes. Manager audit-row coverage for every remaining mutation family and user visual acceptance remain open; WORK_LOCK stays.

## Worker continuation (lifecycle self-audit reconciliation)

- Re-read the task prompt, TODO, worker checklist, source plan, and the numbered audit. Corrected requirement 45's stale note: the unsaved review editor now has automated pane-unmount, file-switch, and Settings-toggle coverage; the running fetch and staged draft/result retention also have mounted/store regressions. Pending transport disconnect-through-action and visual walkthrough are still distinct open requirements.
- Current tree retains the prior verification record: full backend passes 224 files / 5,468 tests (7 skipped); full lint 0 errors / 4,685 warnings with Prettier clean; typecheck passes. Full UI has one load-sensitive transport test failure that passes in isolation. No app, dev server, or build launched.

## Worker continuation verification refresh (provider audit)

- Re-read `PROMPT.worker.md`, TODO, WORKER, TASK, the current source plan, implementation inventory, and the 122-item ledger. Reconciled provider PR creation and Azure thread status audit statements in requirements 47, 77, and 91; focused assertions now cover GitHub PR creation/review/comment and Azure PR creation/thread update/comment/vote writes.
- Re-ran `npm run test:backend -- electron/backend/github-manager.test.ts electron/backend/azure-devops-manager.test.ts -t "audit"`: 5 passed, 67 skipped. `npm run typecheck`: pass. Earlier touched-file Prettier/ESLint and `git diff --check` passed after the test addition.
- Open work remains: user-owned `MANUAL_VERIFICATION.md` walkthrough, per-entry-point menu/shortcut/result/audit reconciliation, remaining long-operation uncertainty and lifecycle acceptance. No application or dev server was launched. Keep WORK_LOCK.

## Worker continuation (long Git lost-start retry keys)

- Added one shared long-action runner that keeps each scoped idempotency key when a start response is lost and clears it only after a known response. Applied it to remote branch deletion, force push, merge/rebase, remote tag push/push-all/delete, and bulk fetch/pull; the existing fetch/pull/push path follows the same retention rule. The tag-push regression checks retry key reuse and cleanup after a known result. Existing merge/rebase lifecycle cases now wait for API dispatch explicitly.
- `npm run test:ui -- src/stores/git-ui.test.ts`: 61 passed. `npm run typecheck`: pass. Touched-file Prettier passes; ESLint 0 errors / 70 existing warnings; `git diff --check` passes. Renderer reconnect tests, unverified-result recovery, route-wide audit and the manual walkthrough remain open; WORK_LOCK stays.

## Worker continuation (retry route regression and matrix reconciliation)

- Added a lost-start-response retry test for remote branch deletion and asserted merge/rebase starts carry an idempotency key. Expanded the context matrix from three grouped rows to explicit classic/new × standard/PR-linked × Electron/remote combinations plus the common History query behavior, with root/view scoping and provider/remote route notes.
- `npm run test:ui -- src/stores/git-ui.test.ts`: 62 passed. `npm run typecheck`: pass. Prettier and `git diff --check` pass. Detailed per-entry permissions/audit/results, other lifecycle gaps, and user visual verification remain open; WORK_LOCK stays.

## Worker continuation (action index and stash import audit)

- Expanded the action inventory into individual UI entry-point rows across toolbar, branches, commits, Changes, stashes, worktrees, conflicts, bulk and provider panes. The client/context matrix records classic/new, normal/PR-linked and Electron/remote combinations.
- Routed stash patch import through the shared per-worktree lock and Git audit wrapper. A real-repository test checks one audit row for success and one for rejected path traversal.
- Focused backend regression passes (1 passed / 34 skipped); repository typecheck passes. Detailed remaining mutation-family audits and user visual acceptance remain open; WORK_LOCK stays.

## Worker continuation (local branch mutation audit)

- Added a real-repository audit test for branch create, checkout, rename, delete success and delete failure. It asserts exactly one system Git write audit outcome per attempted mutation and the resolved repository root.
- `npm run test:backend -- electron/backend/git-manager.test.ts -t "local branch mutation"`: 1 passed / 180 skipped. `npm run typecheck` passes. Full `npm run lint` passes with 0 errors / 4,700 warnings and Prettier clean. The app was not launched; user visual acceptance and remaining mutation-family coverage stay open, so WORK_LOCK remains.

## Worker continuation (conflict mutation lock and audit)

- Routed conflict resolve and unresolve through the shared per-worktree write lock and system Git audit wrapper. A real merge-conflict regression verifies one resolved-root audit row for success and failure on each route.
- Conflict detail, resolve, and unresolve now reject `../` paths using the existing stage-path normalizer; a real-repository test confirms an outside file cannot be read or overwritten through these routes.
- Focused conflict regressions pass (2 passed / 181 skipped), and the full GitManager test file passes (181 passed / 2 skipped). Typecheck, touched-file ESLint (0 errors / 131 warnings), Prettier, and `git diff --check` pass. Full visual walkthrough and other audit families remain open; WORK_LOCK stays.

## Worker continuation (rejected Git start diagnostics)

- When a long-operation start promise rejects, `runGitAction` now sends the standard Git failure notification in addition to retaining its inline result. The notification path persists the raw failure to `strideterm.log`.
- `npm run test:ui -- src/stores/git-ui.test.ts -t "rejected long-operation start"`: 1 passed / 62 skipped. Typecheck passes; touched-file ESLint reports 0 errors / 70 warnings; Prettier and `git diff --check` pass. Remaining audit/lifecycle coverage and user visual walkthrough stay open; WORK_LOCK remains.

## Worker continuation (remote branch checkout audit)

- Extended the real-repository branch audit test to cover remote-tracking branch checkout success and a missing remote-tracking ref failure. Each attempt produces exactly one resolved-root system Git audit row.
- `npm run test:backend -- electron/backend/git-manager.test.ts -t "local and remote branch mutation"`: 1 passed / 182 skipped. `npm run typecheck` passes; touched-file ESLint has 0 errors / 93 warnings; Prettier and `git diff --check` pass. Remaining audit route families and user visual acceptance remain open; WORK_LOCK stays.

## Worker continuation (remote branch deletion audit)

- Added a local bare-remote integration test for successful remote branch deletion and a failed deletion after changing the remote URL to an unavailable path. Each attempt records one system Git write audit outcome with the resolved root.
- `npm run test:backend -- electron/backend/git-manager.test.ts -t "successful and failed remote branch deletion"`: 1 passed / 183 skipped. Other audit families and user visual acceptance remain open; WORK_LOCK stays.

- Verification: `npm run typecheck` passes; focused ESLint reports 0 errors / 93 warnings; Prettier and `git diff --check` pass.

## Worker continuation (pull/push uncertain start response)

- Added pull and push store regressions for a rejected start request: the action runs once, busy clears, and the idempotency key is retained. An explicit retry reuses that key and clears it only after a known result. Focused cases pass; broader synchronous-write uncertainty and user visual acceptance remain open; WORK_LOCK stays present.
- Verification: focused pull/push cases pass (2 passed); `npm run typecheck` passes; touched-file ESLint reports 0 errors / 17 warnings; Prettier and `git diff --check` pass.

## Worker continuation (classic Changes root-scoped draft lifecycle)

- Corrected requirement 63: classic commit text and selected paths already use the Git UI store, and new mounted coverage proves they remain isolated across repository roots and restore when returning to the original root. Focused test: 1 passed / 17 skipped. User visual walkthrough remains open; WORK_LOCK stays present.
- Verification: focused GitChangesTab case passes (1 passed); `npm run typecheck` passes; ESLint 0 errors / 2 warnings; Prettier and `git diff --check` pass.

## Worker continuation (History path filter contract)

- Added a compact History regression for entering a relative path filter. It verifies the graph query receives the path and the active filter chip is rendered. Focused case passes (1 passed / 19 skipped). Narrow human review and broader acceptance remain open; WORK_LOCK stays.
- Verification: focused GitBranchesTab path-filter case passes (1 passed / 19 skipped); `npm run typecheck` passes; ESLint reports 0 errors / 1 warning; Prettier and `git diff --check` pass.

## Worker continuation (remote tag mutation audit)

- Added a local bare-remote integration test covering push-tag, push-all-tags, and remote-tag deletion. Each of the three operations is exercised once successfully and once against an unavailable remote; the six attempts each produce exactly one system Git write audit row with the workspace root. Focused backend case passes (1 passed / 184 skipped). Other mutation families and manual review remain open; WORK_LOCK stays present.
- Verification: bare-remote tag audit case passes (1 passed / 184 skipped); `npm run typecheck` passes; focused ESLint 0 errors / 93 warnings; Prettier and `git diff --check` pass.

## Worker continuation (commit-all lock and audit)

- The custom serialized commit-all path bypassed the shared per-worktree lock and system Git audit. It now takes that lock while preserving per-root commit serialization, records one write audit outcome with the resolved root for success and structured rejection, and remains audit-best-effort. Real repository regression passes (1 passed / 185 skipped). Other audit families and user visual walkthrough remain open; WORK_LOCK stays present.
- Verification: scoped commit-all audit regression passes (1 passed / 185 skipped); `npm run typecheck` passes; focused ESLint 0 errors / 132 warnings across the two backend files; Prettier and `git diff --check` pass.

## Worker continuation (merge-into-base lock and audit)

- Routed synchronous merge-into-base through the shared target-worktree lock and Git audit helper while retaining the local sibling-worktree behavior. A real sibling-worktree test verifies successful merge and dirty-target rejection each emit one system Git write audit row with the resolved target root. Focused test passes (1 passed / 186 skipped). Other audit families and user visual review remain open; WORK_LOCK stays present.
- Verification: merge-into-base sibling-worktree audit test passes (1 passed / 186 skipped); `npm run typecheck` passes; focused ESLint 0 errors / 134 warnings; Prettier and `git diff --check` pass.
- Full GitManager regression after commit-all and merge-into-base lock/audit changes: 185 passed / 2 skipped. `npm run typecheck` passes; touched-file ESLint 0 errors / 134 warnings; Prettier and diff checks pass.
- Expanded the index/local-tag audit regression to include file unstage plus create/delete tag Git failures, confirming one audit row per attempted route. Focused case passes (1 passed / 186 skipped); `npm run typecheck`, touched-file ESLint (0 errors / 96 warnings), Prettier, and diff check pass.
- Corrected the shared mutation helper's fallback error summary so merge-into-base and other non-stash operations no longer report a stash failure. Focused merge audit case passes (1 passed / 186 skipped); `npm run typecheck`, focused ESLint (0 errors / 38 warnings), Prettier, and `git diff --check` pass.

## Worker continuation (bisect audit classification)

- Found that continue/abort/skip log using the operation-state kind `bisect`, but the system Git audit write classifier omitted that kind. Added `bisect` to the write set and a regression asserting successful and failed outcomes are both write entries with the root path. This closes the classification gap for bisect lifecycle mutations; other action-route audit coverage and manual review remain open.
- Focused backend test passes (1 passed / 187 skipped); `npm run typecheck` passes; touched-file ESLint reports 0 errors / 134 warnings; Prettier and `git diff --check` pass.

## Worker continuation (History cherry-pick audit outcomes)

- Added a real-repository regression for the History cherry-pick manager path. A valid source commit succeeds, a valid-format missing hash fails in Git, and both attempts emit exactly one system Git write audit entry with the resolved root.
- Focused backend test passes (1 passed / 188 skipped); `npm run typecheck` passes; touched-file ESLint reports 0 errors / 97 existing warnings; Prettier and `git diff --check` pass. Other action-route audit checks and the user's visual walkthrough remain open.

## Worker continuation (History squash audit outcome)

- Added a real-repository History squash regression. Squashing two commits creates the requested single commit and emits exactly one `gitSquash` write audit entry with the resolved root.
- Focused backend test passes (1 passed / 189 skipped); `npm run typecheck` passes; touched-file ESLint reports 0 errors / 99 existing warnings; Prettier and `git diff --check` pass. Other action-route audit checks and the user's visual walkthrough remain open.

## Worker continuation verification refresh (GitManager)

- Re-ran the full GitManager backend test file after recent audit coverage additions: 188 passed / 2 skipped. Repository typecheck passes; touched-file Prettier passes; ESLint reports 0 errors / 99 existing warnings; `git diff --check` passes.
- Re-read the current prompt, TODO, worker verification checklist, manual walkthrough and the numbered audit. Outstanding requirements remain the user-owned visual walkthrough, keyboard/narrow human acceptance, and several inventory-wide routes and uncertain synchronous-write lifecycle behaviors; WORK_LOCK stays present.

## Worker continuation (failed Git audit duration)

- Fixed `runWriteAction` to include elapsed duration in audit rows when the Git command rejects. Strengthened the real-repository cherry-pick audit test to assert duration is present for both success and failure.
- Focused cherry-pick audit test passes (1 passed / 189 skipped); full GitManager suite passes (188 passed / 2 skipped); `npm run typecheck` passes; touched-file ESLint reports 0 errors / 137 existing warnings; Prettier and `git diff --check` pass.
- Re-audited requirements 47, 51, and 77 against current manager paths and real-repository evidence. These remain partial because full route inventory and uncertain synchronous-write outcome recovery are not complete; manual visual acceptance remains user-owned. WORK_LOCK stays present.

## Worker continuation (generic write failure timing)

- Rechecked `runWriteAction` diagnostics and found failed `execGit` actions omitted duration even though successful actions included it. Failure audit records now include elapsed milliseconds. The cherry-pick success/failure audit test verifies both entries have a nonnegative duration.
- Focused cherry-pick case passes; full GitManager suite passes (188 passed / 2 skipped); repository typecheck passes; touched-file ESLint reports 0 errors / 137 existing warnings; Prettier and `git diff --check` pass. Requirements 47/51/77 remain partial for inventory-wide route and uncertain synchronous-write recovery; WORK_LOCK remains.
- OperationRegistry now applies the shared logger credential redactor before persisting and emitting rejected-operation message, warning, and raw-output diagnostics. Regression verifies known token and bearer shapes do not appear in the durable outcome or finish event. The focused OperationRegistry suite passes (11 tests); repository typecheck and safe production build pass; repository lint passes (0 errors, 4,712 warnings; Prettier clean); touched-file lint/format and `git diff --check` pass. Requirement 51's generic diagnostic redaction gap is closed; route-by-route classification, blocked/cancelled/partial distinctions, inventory-wide audit mapping, and the user visual review remain open. WORK_LOCK remains.
- Fetch-first merge/rebase now includes warnings from the successful fetch step alongside warnings attached to an integration failure, so the terminal outcome retains diagnostics from both phases. The focused regression and full runtime suite pass (531 tests); repository typecheck, touched-file Prettier, ESLint (0 errors), and `git diff --check` pass. Requirement 51's multi-step partial-diagnostic path is covered; broader route classification and visual acceptance remain open. WORK_LOCK remains.

## Worker continuation (uncertain index/commit response recovery)

- Added a root-scoped uncertainty guard for stage/unstage file, stage/unstage hunk, commit-staged, and classic commit-all. When their request rejects without a known Git result, the store records the uncertain action, displays a warning, and blocks retry of that same action/root until an explicit refresh returns a usable Git snapshot. A refresh of another root leaves the guard in place.
- `git-ui.test.ts` passes all 66 tests, including lost-response/retry suppression/root-refresh coverage; `npm run typecheck` passes; touched-file ESLint reports 0 errors; Prettier and `git diff --check` pass. Other synchronous writes and manual visual acceptance remain open; WORK_LOCK stays.

## Worker continuation (uncertain local Git mutation recovery)

- Extended refresh-before-retry uncertainty handling to synchronous branch checkout/create/delete/rename, remote-branch checkout, cherry-pick/squash, local tag create/delete, stash-pop, worktree removal, conflict resolve/unresolve/continue/skip/abort, and merge-into-base actions. A rejected IPC response records the root/action and blocks that action from being repeated until a usable snapshot is returned by explicit refresh.
- Added a branch checkout lost-response regression covering rejection, retry suppression, and retry after successful verification. `npm run test:ui -- src/stores/git-ui.test.ts` passes 67/67; `npm run typecheck` passes; touched-file ESLint and Prettier pass; `git diff --check` passes. Provider-review synchronous writes, broader route audit, and user visual acceptance remain open; WORK_LOCK stays present.

## Worker continuation (captured conflict root for uncertainty recovery)

- `runGitAction` now accepts an explicit root for uncertainty tracking. Conflict resolve/unresolve/continue/skip/abort supply the root captured by their dialog, so switching the workspace's active root cannot move the uncertain write marker or let a refresh of another repository clear it.
- Added a regression that opens a conflict dialog on root A, switches to root B after a rejected resolution response, verifies B's refresh leaves the marker in place, and confirms A's successful refresh permits retry. Focused Git UI store suite passes 68/68; typecheck, touched-file ESLint, Prettier and `git diff --check` pass. The user visual pass and other numbered audit requirements remain open; WORK_LOCK stays present.

## Worker continuation (bulk root refresh recovery)

- The bulk `refreshRoot` action now identifies itself as a refresh for uncertainty recovery and passes the requested root through the store action context. This lets a successful refresh of a non-active root clear only that root's lost-response markers; refreshing a different active root continues to leave them intact.
- Strengthened the conflict-root regression to verify active root B cannot clear root A's marker, then `refreshRoot(A)` clears it without switching active roots and permits the retry. Git UI store suite passes 68/68 and repository typecheck passes. Provider review, route audit, and user visual acceptance remain open; WORK_LOCK stays present.

## Worker continuation (real bisect mutation audit)

- Added a real-repository test that creates a three-commit history, starts bisect with a known good/bad range, verifies GitManager detects the in-progress bisect, aborts through `abortOperation`, and confirms the operation ends with exactly one `gitBisect` write audit row containing the resolved root and duration.
- Focused backend case passes (1 passed / 190 skipped). Broader action-route audit and user visual verification remain open; WORK_LOCK stays present.

## Worker continuation (post-mutation preview refresh failure)

- When a Git action's automatic selected-file preview refresh rejects, the store now replaces the old preview with an error result containing the selected path and scope. The diff text is empty, so a stale pre-mutation diff is not left looking current. Added a store regression for success followed by a rejected preview refresh.
- `npm run test:ui -- src/stores/git-ui.test.ts` passes 69/69. Visual treatment remains part of the user's manual walkthrough; other reads, routes and manual acceptance remain open; WORK_LOCK stays present.

## Worker continuation (post-mutation preview root lifecycle)

- Added a deferred-response test proving the automatic diff refresh started for a mutation in root A cannot replace the selected file preview after the user switches to root B. The root-B selected path and diff remain in the store after root A's response settles.
- Git UI store suite passes 70/70. Other lifecycle cases and visual acceptance remain open; WORK_LOCK stays present.
