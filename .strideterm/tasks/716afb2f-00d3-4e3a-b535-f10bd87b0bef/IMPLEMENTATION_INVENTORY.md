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
| PR/provider actions, review comments and drafts | Pull Request tab, provider review panes/stores | Review shows an explicit handoff to the linked provider review workspace when available; More retains PR tools. Unlinked Review explains the missing link. | Provider review pane owns comment/draft state and must stay keyed to its provider workspace. No viewed/unreviewed state is invented. |
| External lazygit | Shared toolbar | Shared toolbar | Existing detection and action remain. |
| Stage/unstage file or hunk; commit staged | New `git-ui` methods → validated Electron/remote IPC → runtime mutation wrapper → GitManager write lock/audit. Hunk uses backend diff token checked under lock. | New Changes view offers stage/unstage file (including untracked), first text hunk stage/unstage, and commit staged. Classic keeps selected-path commit. | `git commit` reads existing index only. Hunk stale changes fail with an explicit error. Binary/conflict hunk staging is unavailable. |

## Client/context matrix

| View | Workspace | Client | Root behavior |
| --- | --- | --- | --- |
| Classic | Standard or review-linked | Electron or existing web/remote renderer | Existing workspace store/root selector and existing operation route. |
| New opt-in | Standard or review-linked | Electron or existing web/remote renderer | New selected view is distinct from legacy `activeTab`; legacy tools remain in More. |
| New history picker | Standard or review-linked | Electron or existing web/remote renderer | Selection sets only the graph query; backend `logGraph` supports a single ref or all branches/remotes/tags/HEAD query. |

The picker currently shares the legacy branch-history component/data path. Favorites and recent refs persist in browser storage scoped by profile/workspace/root. Graph result application now has a request-generation guard and rejects a response when the active root changed.

## Explicit gaps against the plan

- Review is a handoff to the existing provider review workspace, not yet a dominant PR diff layout within GitPane. Workspace-level PR-link metadata alone does not identify the provider-owned comment/draft session.
- Changes still uses the existing two-pane changes layout and exposes the first verified text hunk rather than a per-hunk selector. Additional multi-hunk and rename/delete staging coverage remains.
- Generic `OperationRegistry` is used for durable task/workspace creation and has no compatible Git action idempotency or running-result consumer contract. Existing fetch/pull/push handlers still await completion on remote routes.
- Current compact ref selector is a native accessible select plus search. Favorites/recent refs now persist on the client per profile/workspace/root. Full commit message/layout refinements remain unimplemented.
- New view state is persisted through workspace UI state and keyed by profile/workspace/root/PR. Legacy destination and graph data remain workspace-keyed; graph requests have stale-response protection, while other read requests still need the same treatment.
- Broad lint reports four existing repo errors outside this change. Focused ESLint and Prettier checks on changed files pass. Repo-wide typecheck reports unrelated existing test typing failures.

These are not completed acceptance items. They remain visible here for the independent judge and next implementation pass.
