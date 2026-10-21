# Git view implementation inventory

This task snapshot is the working contract for the opt-in Git layout. The first implementation slice keeps existing actions on their existing components and handlers; it does not claim the full redesign is complete.

## Current action and capability map

| Capability | Existing UI and action path | New view availability | Current guard/audit notes |
| --- | --- | --- | --- |
| Refresh, fetch, pull, push, publish | Shared GitPane toolbar → `git-ui` store → Electron IPC or remote transport → runtime Git handlers → GitManager | Shared toolbar remains visible in every view | Fetch/pull/push use `OperationRegistry` with profile/workspace/root intent, same-input deduplication, durable terminal outcomes, and operation events/payload replay. Pull/push and tag network writes use the audited mutation wrapper; fetch records an action without a write audit. Publish uses the provider review operation path. |
| Checkout, create/rename/delete local or remote branch, create/delete local or remote tag, cherry-pick, squash, revert/reset, compare | Branches / Overview → `git-ui` store → typed transport → runtime handler → GitManager | More → Branches / Overview | Mutations retain their existing confirmation and manager guard/audit path. Read-only History reference selection only calls `gitLoadGraph`; it never checks out, fetches, or publishes. Remote-tag push, push-all-tags and delete-remote-tag are accepted through `OperationRegistry`. |
| Stashes and worktrees | Stashes and Worktrees tabs; Overview worktree actions → store → transport/runtime → GitManager | More selector → Stashes / Worktrees / Overview | More selection takes precedence over History, Changes, and Review. Stash apply/pop/drop/branch/import and worktree add/remove remain existing mutations; export/list/file detail are reads. |
| Conflicts | Conditional Conflicts tab, operation card and conflict dialog → store → runtime → GitManager | Shared conflict resolution action in the Git frame; More selector → Conflicts | The common conflict action is rendered outside More. Conflict details/resolution remain root-scoped. Operation/conflict status cards render in History, Changes, Review and relevant More destinations. |
| Multi-root/bulk | Root picker and Bulk tab → per-root store methods → runtime operations | Shared root picker; More → Bulk | Bulk fetch/pull fans out through the per-root generic long-operation paths and retains per-row status. Requested roots are validated against workspace roots before accepted writes. |
| PR/provider actions, review comments and drafts | Pull Request tab, provider review panes/stores | Review mounts the existing provider review pane for the matching PR/profile, with the provider's true base/source/target diff and existing comment/draft controls. Unlinked Review explains the missing link. | Provider pane owns durable comment drafts. No viewed/unreviewed state is invented. |
| External lazygit | Shared toolbar | Shared toolbar | Existing detection and action remain. |
| Stage/unstage file or hunk; commit staged | New `git-ui` methods → schema-validated Electron/remote IPC → runtime mutation wrapper → GitManager repository write lock/system Git audit. Hunk requests use a backend diff token and must match one exact server-returned hunk and its diff header under lock. | New Changes view offers stage/unstage file (including untracked), individual text hunk stage/unstage, and commit staged at desktop and narrow widths. Classic keeps selected-path commit. | `git commit` reads the existing index only. Stale or forged hunks fail explicitly; binary/conflict hunk staging is unavailable. Structured mutation failures reach the Changes result card and standard notification path. Local write audit entries include resolved root, action, path where relevant, outcome, and duration. |

## Client/context matrix

| View | Workspace | Client | Root behavior |
| --- | --- | --- | --- |
| Classic | Standard or review-linked | Electron or existing web/remote renderer | Existing workspace store/root selector and existing operation route. |
| New opt-in | Standard or review-linked | Electron or existing web/remote renderer | New selected view is distinct from legacy `activeTab`; legacy tools remain in More. |
| New history picker | Standard or review-linked | Electron or existing web/remote renderer | Selection sets only the graph query; backend `logGraph` supports a single ref or all branches/remotes/tags/HEAD query. |

The picker currently shares the legacy branch-history component/data path. Favorites and recent refs persist in browser storage scoped by profile/workspace/root. Selected History ref and commit search are kept by the Git UI store scoped by profile/workspace/root. Graph, branch, tag, compare, commit diff, and working diff results have request/context guards; post-action preview refreshes capture their originating root/path/scope and cannot replace another root's selection. Compact History keeps commit text search by message, author, or hash and reports no-match state. `HEAD` and all-refs are distinct graph queries.

The narrow Changes diff also provides the layer label, stage/unstage file and hunk actions, and Commit staged. These controls use the same store APIs as desktop Changes.

## Remaining verification boundaries

- Human visual verification remains with the user: the plan explicitly keeps Electron and the dev server out of agent verification. No app process has been launched.
- The existing classic tabs remain the destination for specialized branch, stash, worktree, bulk, and conflict tools; More routing prioritizes these destinations over the selected new view. Verify each via the More selector in the user's visual pass.
- The native ref select provides keyboard search/selection/escape behavior; a user visual pass should still check long refs, a large branch list, and narrow-window sizing.
- Latest recorded verification: full UI (214 files / 3,038 tests), full backend at four workers (224 files / 5,463 passed, 7 skipped), `npm run typecheck`, `npm run lint` (0 errors; existing warnings; Prettier clean), and the watch-compatible safe production build pass. See `JUDGE_TODO.md` for continuation evidence and user-owned manual review status.
- The runtime operation coverage includes long fetch/pull/push, merge/rebase (including fetch-first), and network-backed tag push/delete actions. Remote slot routes are profile/session guarded; slot-aware merge/rebase and tag mutation routes validate their payload schemas before dispatch.
