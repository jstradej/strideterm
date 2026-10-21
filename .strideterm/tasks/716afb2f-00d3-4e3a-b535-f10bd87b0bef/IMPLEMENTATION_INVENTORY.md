# Git view implementation inventory

This task snapshot is the working contract for the opt-in Git layout. The first implementation slice keeps existing actions on their existing components and handlers; it does not claim the full redesign is complete.

## Current action and capability map

| Capability | Existing UI and action path | New view availability | Current guard/audit notes |
| --- | --- | --- | --- |
| Refresh, fetch, pull, push, publish | Shared GitPane toolbar → `git-ui` store → runtime Git handlers → GitManager | Shared toolbar remains visible | Fetch/pull/push use runtime workspace action; pull/push are mutation wrappers; GitManager write path audits. Remote routes are slot/profile scoped. |
| Checkout, create/rename/delete branch, remote branch actions, tags, cherry-pick, revert/reset, compare | Branches tab / Overview → `git-ui` store → runtime handlers | More → Branches / Overview | Existing confirmation and mutation wrappers remain; read-only ref selection uses `gitLoadGraph`, not checkout. |
| Stashes and worktrees | Stashes and Worktrees tabs; Overview worktree actions | More → Stashes / Worktrees / Overview | Existing handlers remain available. |
| Conflicts | Conditional Conflicts tab and operation card | More → Conflicts; operation card stays pane level | Conflict visibility continues to depend on current operation state. |
| Multi-root/bulk | Root picker and Bulk tab | Shared root picker; More → Bulk | Uses current per-root store methods. |
| PR/provider actions, review comments and drafts | Pull Request tab, provider review panes/stores | Review mounts the existing provider review pane for the matching PR/profile, with the provider's true base/source/target diff and existing comment/draft controls. Unlinked Review explains the missing link. | Provider pane owns durable comment drafts. No viewed/unreviewed state is invented. |
| External lazygit | Shared toolbar | Shared toolbar | Existing detection and action remain. |
| Stage/unstage file or hunk; commit staged | New `git-ui` methods → validated Electron/remote IPC → runtime mutation wrapper → GitManager write lock/audit. Hunk uses backend diff token checked under lock. | New Changes view offers stage/unstage file (including untracked), individual text hunk stage/unstage, and commit staged. Classic keeps selected-path commit. | `git commit` reads existing index only. Hunk stale changes fail with an explicit error. Binary/conflict hunk staging is unavailable. |

## Client/context matrix

| View | Workspace | Client | Root behavior |
| --- | --- | --- | --- |
| Classic | Standard or review-linked | Electron or existing web/remote renderer | Existing workspace store/root selector and existing operation route. |
| New opt-in | Standard or review-linked | Electron or existing web/remote renderer | New selected view is distinct from legacy `activeTab`; legacy tools remain in More. |
| New history picker | Standard or review-linked | Electron or existing web/remote renderer | Selection sets only the graph query; backend `logGraph` supports a single ref or all branches/remotes/tags/HEAD query. |

The picker currently shares the legacy branch-history component/data path. Favorites and recent refs persist in browser storage scoped by profile/workspace/root. Graph, branch, tag, compare, commit diff, and working diff results have request/context guards; root changes clear root-specific selection and stale preview data.

## Remaining verification boundaries

- Human visual verification remains with the user: the plan explicitly keeps Electron and the dev server out of agent verification. No app process has been launched.
- The existing classic tabs remain the destination for specialized branch, stash, worktree, bulk, and conflict tools; verify each via the More selector in the user's visual pass.
- The native ref select provides keyboard search/selection/escape behavior; a user visual pass should still check long refs, a large branch list, and narrow-window sizing.
- Focused UI/backend suites, changed-file ESLint, direct frontend/backend typechecks, and a safe production build were run. The repository-wide typecheck still reports existing unrelated errors under `tsconfig.tests.json`.
