# TODO

> Created: 2026-10-21 11:19:10
>
> The Worker updates this file as it progresses. You can pre-fill items before starting.
> The Task Runner checks that "In Progress" and "Blocked" sections are empty before completion.

## To Do

- [ ] Complete the user's visual review using `MANUAL_VERIFICATION.md` in their `dev.ps1` session; adjust anything they report.
- [ ] Finish remaining audit findings in `JUDGE_TODO.md`, including the compact History flow, scoped reads/drafts, long operations and regression coverage.
- [ ] Re-run the full numbered self-audit against the current tree and update each requirement with verifiable evidence.
- [ ] Resolve the full typecheck failures and run the project checks required by `WORKER.md` after implementation changes.
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
- [x] Re-run focused GitPane/History UI and GitManager tag/hunk tests, full lint, formatting check and safe production build; all pass. Full typecheck remains failing in unrelated existing test typings (see `JUDGE_TODO.md`); remaining implementation work is still open.
- [x] Persist classic Changes commit text and selected paths by workspace/root, clear them only after successful commits, and clear staged-message completion against the captured root. Lifecycle tests pass.
- [x] Restore compact History commit-text search across message, author and hash, with a distinct no-match status; picker and GitPane UI suites pass.
- [x] Add the narrow Changes diff layer label, stage/unstage file and hunk actions, and commit-staged controls; its focused UI test passes.
- [x] Classify stage/unstage/commit-staged remote routes for mobile policy and correct the tag failure assertion; route policy (50), runtime/remote (212), focused GitManager (3), and GitPane/History/Changes/Review/store UI (110) tests pass.
- [x] Re-run project lint (0 errors; 4651 existing warnings, Prettier clean), watch-compatible production build, and focused UI/backend checks. Full typecheck still fails in unrelated test typings; the full Git backend run found and fixed the route-policy failure plus stale tag assertion.
