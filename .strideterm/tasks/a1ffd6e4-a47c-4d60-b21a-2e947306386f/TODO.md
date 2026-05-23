# TODO

> Created: 2026-05-23 19:20:42
>
> The Worker updates this file as it progresses. You can pre-fill items before starting.
> The Task Runner checks that "In Progress" and "Blocked" sections are empty before completion.

## To Do

## In Progress

## Done

- [x] Step 1: Fix bug — double disk-delete failure now surfaces via deleteWorkspaceError (runtime.ts, runtime.test.ts)
- [x] Step 2: Zod schema for workspace:delete IPC boundary (ipc-schemas.ts, ipc.ts, remote-server.ts, *.test.ts)
- [x] Step 3: Managed-path guard for deleteFromDisk — only known worktree types allowed (runtime.ts, runtime.test.ts)
  - [x] #20: Tests for managed-review, quickfix, task worktree, and legacy 'Worktree of …' delete variants
  - [x] Fixed resolveManagedDeletePath for quickfix workspaces (use workspace.cwd, not quickfix.rootPath which is stripped by normalizeWorkspace)
- [x] Step 4: Targeted git refresh after workspace delete via resolveDeleteRefreshTargets (runtime.ts, runtime.test.ts)
- [x] Step 5: Docker poll in-flight guard + backend detection cache + demand-aware interval (docker-manager.ts, runtime.ts, *.test.ts)
  - [x] #27: invalidateBackendDetectionCache() wired into updateSettings() in production code
  - [x] #28: hasActiveDockerConsumer uses two predicates — active/shown docker workspace OR active docker stream
  - [x] #30: activateWorkspace / activateWorkspaceInWindow: refreshDocker() called before broadcastState()
  - [x] #33: Test — without active docker consumer, poll stays at slow 5-min interval
  - [x] #34: Test — activating docker workspace calls refreshDocker() before first state:updated broadcast
- [x] Step 6: Worktree sync Map/Set indexes + syncTreeDirWatchers resync after save/delete (runtime.ts, runtime.test.ts)
  - [x] #40: Snapshot test of syncWorktreesImpl (detects on-disk tree directories on init)
  - [x] #41: Spy test — saveWorkspace triggers syncTreeDirWatchers (new tree entries detected after git poll)
  - [x] #42: Spy test — deleteWorkspace triggers syncTreeDirWatchers (removed parent's tree no longer re-added)
- [x] Step 7: broadcastState() microtask coalescing verified — already in place, regression tests added (runtime.test.ts)
  - [x] #48: Test — getPayload() called only once per coalesced broadcastState() batch
- [x] Step 8: Frontend notification timers merged into one, demand-aware start/stop (NotificationCenter.vue)
- [x] Final regression: typecheck clean, 0 lint errors, 55 test files / 1371 tests pass (1 skipped)
