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
- [x] Step 4: Targeted git refresh after workspace delete via resolveDeleteRefreshTargets (runtime.ts, runtime.test.ts)
- [x] Step 5: Docker poll in-flight guard + backend detection cache + demand-aware interval (docker-manager.ts, runtime.ts, *.test.ts)
- [x] Step 6: Worktree sync Map/Set indexes + syncTreeDirWatchers resync after save/delete (runtime.ts)
- [x] Step 7: broadcastState() microtask coalescing verified — already in place, regression tests added (runtime.test.ts)
- [x] Step 8: Frontend notification timers merged into one, demand-aware start/stop (NotificationCenter.vue)
- [x] Final regression: typecheck clean, 55 test files / 1362 tests pass
