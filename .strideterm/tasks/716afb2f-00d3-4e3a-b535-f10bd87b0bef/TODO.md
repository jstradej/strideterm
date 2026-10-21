# TODO

> Created: 2026-10-21 11:19:10
>
> The Worker updates this file as it progresses. You can pre-fill items before starting.
> The Task Runner checks that "In Progress" and "Blocked" sections are empty before completion.

## To Do

- [ ] Finish the full seven-stage implementation and every acceptance criterion in `sources/01-plan-git-new-view.md`.
- [ ] Add profile/workspace/root-scoped new-view state and stale read-query protection.
- [ ] Build a dedicated PR review layout with correct provider source/target/base, dominant diff, compact file navigation, and preserved drafts.
- [ ] Implement real index-safe stage/unstage file/hunk and commit-staged backend/store/transport operations with tests and audited locks.
- [ ] Integrate long-running Git actions with a suitable generic operation contract for Electron and remote clients, including event/payload dedupe and profile scoping.
- [ ] Complete Changes layout and retain/verify every action, conflict path, keyboard behavior, narrow layout, and operation state.
- [ ] Complete history favorites/recent refs, query-state persistence, error/stale distinctions, adjustable commit detail, and remaining acceptance coverage.
- [ ] Run final lint, all relevant tests, production build, update this checklist, and commit all changes.

## In Progress

- [x] Add opt-in setting defaulting off, normalization, explicit boolean schema validation, Settings control, and safe nested merge coverage.
- [x] Add separate new-view selection and opt-in History / Changes / Review shell with a More path to preserved existing tools.
- [x] Add searchable read-only history ref selection and verify it filters graph history without checkout or branch creation.
- [x] Record existing action/capability inventory and explicit uncovered requirements in `IMPLEMENTATION_INVENTORY.md`.
- [ ] Finish final checks and commit this implementation slice.

## Done
