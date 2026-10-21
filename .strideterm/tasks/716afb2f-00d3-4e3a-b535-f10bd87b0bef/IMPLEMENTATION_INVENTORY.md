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
| PR/provider actions, review comments and drafts | Pull Request tab, provider review panes/stores | Review → existing PR surface only when linked; More retains PR tools. Unlinked Review shows a non-mutating explanatory empty state. | Reuses provider actions and draft stores. No viewed/unreviewed state is invented. |
| External lazygit | Shared toolbar | Shared toolbar | Existing detection and action remain. |
| Stage/unstage file or hunk; commit staged | No supported ordinary Git pane API found. Existing `gitCommitAll` commits selected paths with its own preservation semantics. | Not added | Must not be represented as commit staged until a backend operation uses the real index and common write lock/audit wrapper. |

## Client/context matrix

| View | Workspace | Client | Root behavior |
| --- | --- | --- | --- |
| Classic | Standard or review-linked | Electron or existing web/remote renderer | Existing workspace store/root selector and existing operation route. |
| New opt-in | Standard or review-linked | Electron or existing web/remote renderer | New selected view is distinct from legacy `activeTab`; legacy tools remain in More. |
| New history picker | Standard or review-linked | Electron or existing web/remote renderer | Selection sets only the graph query; backend `logGraph` supports a single ref or all branches/remotes/tags/HEAD query. |

The picker currently shares the legacy branch-history component/data path. It does not yet persist favorites/recent refs per profile/workspace/root, and the global graph/ref cache remains bucketed by workspace in the existing store.

## Explicit gaps against the plan

- Review is still the existing Pull Request surface, not a new dominant PR diff layout with a compact file navigator.
- Changes is still the current changes tab; index-safe stage/unstage and commit-staged APIs do not exist.
- Generic `OperationRegistry` is used for durable task/workspace creation and has no compatible Git action idempotency or running-result consumer contract. Existing fetch/pull/push handlers still await completion on remote routes.
- Current compact ref selector is a native accessible select plus search. Favorites, recent refs, full commit message/layout refinements and a profile/root-specific history preference store remain unimplemented.
- Existing view state is workspace-keyed. Profile/root scoping and stale in-flight query cancellation require a broader store-key/data-request change.

These are not completed acceptance items. They remain visible here for the independent judge and next implementation pass.
