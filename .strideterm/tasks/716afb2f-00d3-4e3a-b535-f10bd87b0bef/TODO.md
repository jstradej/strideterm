# TODO

> Created: 2026-10-21 11:19:10
>
> The Worker updates this file as it progresses. You can pre-fill items before starting.
> The Task Runner checks that "In Progress" and "Blocked" sections are empty before completion.

## To Do

- [ ] Finish the full seven-stage implementation and every acceptance criterion in `sources/01-plan-git-new-view.md`.
- [ ] Complete remaining profile/workspace/root/PR state details and stale query handling for non-graph read requests.
- [ ] Build a dedicated provider PR review layout with the true source/target/base, dominant diff, compact file navigation, and preserved drafts.
- [ ] Add comprehensive staged hunk coverage for multiple hunks, rename/delete and conflict edge cases.
- [ ] Integrate long-running Git actions with a suitable generic operation contract for Electron and remote clients, including event/payload dedupe and profile scoping.
- [ ] Complete Changes layout and retain/verify every action, conflict path, keyboard behavior, narrow layout, and operation state.
- [ ] Complete query error/stale distinctions, adjustable commit detail, and remaining acceptance coverage.
- [ ] Run final focused checks, scan the complete diff, update this checklist, and commit all changes.

## In Progress

- [x] Add opt-in setting defaulting off, normalization, explicit boolean schema validation, Settings control, and safe nested merge coverage.
- [x] Add separate new-view selection and opt-in History / Changes / Review shell with a More path to preserved existing tools.
- [x] Add searchable read-only history ref selection and verify it filters graph history without checkout or branch creation.
- [x] Record existing action/capability inventory and explicit uncovered requirements in `IMPLEMENTATION_INVENTORY.md`.
- [x] Add audited stage/unstage file and commit-staged endpoints across Electron and remote transport; verify the commit consumes only the index.
- [x] Add a diff-token-guarded first-hunk staging flow using backend diff preview, repository write lock and best-effort audit.
- [x] Persist selected view through workspace UI state; normalize only supported preference values and scope by profile/workspace/root/PR.
- [x] Ignore out-of-order graph reads; add root-scoped favorite and recent ref picker groups.
- [x] Support untracked file staging and reverse cached hunk application for explicit hunk unstaging.
- [x] Add input/result tests for new index operations, formatter and lint checks for changed files.
- [ ] Finish remaining plan work, final checks and commit this implementation slice.

## Done
