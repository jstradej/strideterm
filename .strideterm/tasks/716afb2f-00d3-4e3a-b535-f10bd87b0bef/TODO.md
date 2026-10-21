# TODO

> Created: 2026-10-21 11:19:10
>
> The Worker updates this file as it progresses. You can pre-fill items before starting.
> The Task Runner checks that "In Progress" and "Blocked" sections are empty before completion.

## To Do

- [ ] Complete the user's visual review using `MANUAL_VERIFICATION.md` in their `dev.ps1` session; adjust anything they report.
- [ ] Finish remaining audit findings in `JUDGE_TODO.md`, including Review diff source, Changes draft/context persistence, narrow workflows, audit/error paths, long operations and regression coverage.
- [ ] Re-run the full numbered self-audit against the current tree and update each requirement with verifiable evidence.
- [ ] Resolve the full typecheck failures and run the project checks required by `WORKER.md` after implementation changes.
- [x] Commit implementation changes locally without pushing.

## In Progress

- [ ] Repair and verify the judge-confirmed More routing and staged-hunk validation gaps; commit `7aad383b` contains the initial fixes.

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
