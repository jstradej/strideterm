# TODO

> Created: 2026-05-08 17:36:05
>
> The Worker updates this file as it progresses. You can pre-fill items before starting.
> The Task Runner checks that "In Progress" and "Blocked" sections are empty before completion.

## To Do

## In Progress

## Done

- [x] Phase 1: Data model (state.ts, default-state.ts, ipc-schemas.ts, runtime.ts, ipc.ts, remote-server.ts, ipc-bridge.ts, preload.cts, transport.ts)
- [x] Phase 2: Render skeleton (layout-geometry.ts, WorkspaceStage.vue, WorkspaceGridStage.vue, WorkspaceCell.vue, WorkspaceCellHeader.vue)
- [x] Phase 2 pane-resolver.ts: Extracted pane→component resolver to src/app/pane-resolver.ts; PaneStage.vue and WorkspaceCell.vue now import from it
- [x] Phase 3: TabStrip compact mode, per-cell tab strip, hide global tab strip in grid mode
- [x] Phase 4: Focus mechanics (mousedown→activateWorkspace, sidebar inGrid indicator)
- [x] Phase 5: WorkspacePickerPopover with tree+search+collapse+sort+starred+kind-counts+breadcrumbs, hamburger hookup, drag-to-cell
- [x] Phase 5 openInGrid: Sort children by activity (running task > attention > order), fill remaining slots with starred workspaces
- [x] Phase 5 swap mode: Global swapPendingCell in WorkspaceGridStage; first click sets source, second click calls store.swapGridCells; visual feedback on header button
- [x] Phase 6: Keyboard shortcuts (Ctrl+Shift+G, Alt+1-4, Alt+Shift+1-4, Ctrl+\), narrow/mobile degradation, CSS polish
- [x] Phase 6 LayoutPicker: Disabled with tooltip "Switch to solo workspace to use tab split" when isGridVisible
- [x] Phase 7: Unit tests (normalizeWorkspaceGrid 9 cases, isGridVisible reactivity 6 cases, store actions 7 cases, total 22 new tests)
- [x] Phase 7 E2E: workspace-grid.spec.ts + grid.json fixture covering grid show, cell render, solo toggle, grid restore, cell clear
- [x] Round 2 fixes: TypeScript errors (TabStrip onDragend, WorkspaceCell activeViewId null, WorkspaceGridStage Number(index)); ESLint errors (ipc.ts eslint-disable comments); test helper ws() cast; prettier formatting
- [x] Round 3 E2E: Added drag-drop describe block (synthetic DragEvent onto cell, verifies workspace name updates) and workspace-delete describe block (deleteWorkspace IPC, verifies slot cleared + workspace absent from sidebar)
- [x] Round 4 fixes: enableWorkspaceGrid defaults to [activeWsId,null,null,null]; Ctrl+Shift+G uses layout "grid"; PaneStage imports SLOT_BOXES/gridAreaStyle from layout-geometry.ts; WorkspacePickerPopover defaults collapsed to all parent IDs; unit test updated
- [x] Multi-instance Phase 1: proper-lockfile in store.ts + credential-store.ts; atomic tmp+rename for notify-urls.json
- [x] Multi-window Phase 2 state model: WindowSlot interface, windowSlots[] in AppState, per-profile workspaceGrid, normalizeWindowSlots migration (default-state.ts)
- [x] Multi-window Phase 2 window registry: Map<windowId,BrowserWindow> + reverse map, getPrimaryWindow, createWindow with UUID, per-window focus/move/resize/closed lifecycle (main.ts)
- [x] Multi-window Phase 2 IPC source-aware: activate handlers use event.sender.id → windowId, per-window slot updates, dialog ownership via fromWebContents (ipc.ts)
- [x] Multi-window Phase 2 preload + ipc-bridge: getWindowId, createWindow, closeWindow, onNewWindowShortcut, startupFlags.windowId
- [x] Multi-window Phase 2 renderer store: myWindowId, myWindowSlot, myActiveWorkspaceId, myActiveProfileId; per-window filteredWorkspaces, workspaceGrid, attentionSummary, handleBroadcastPayload, activateWorkspace, activateView
- [x] Multi-window Phase 2 New Window UX: NewWindowModal.vue (profile picker + occupied list), app-dialog-actions.ts openNewWindowModal, DialogOverlay.vue registration, App.vue onNewWindowShortcut wiring
- [x] Multi-window Phase 2 Telegram screenshot per-window: /screenshot N and /screenshot ws-name arg parsing, windowId field on TelegramCommandEvent, setWindowSlotsGetter, captureMainWindowPng(windowId?) in runtime.ts
- [x] Multi-window Phase 2 alert routing: updateNativeAttention per-window profile-scoped counts, flash only the window whose profile owns the alerts (main.ts)
- [x] Multi-window Phase 2 Cmd+W cascade: tab→workspace→window close in useKeyboardShortcuts.ts; Cmd+Shift+W for direct window close
- [x] Multi-window Phase 2 modal ownership audit: all dialog.showOpenDialog calls use fromWebContents(event.sender) (ipc.ts already correct)
- [x] Multi-window Phase 2 E2E test: multi-window.spec.ts + multi-profile.json fixture (profile exclusivity, second window creation, per-window workspace filtering)
- [x] Round 3 fix: persistWindowSlot saves displayId via screen.getDisplayNearestPoint; updateWindowSlotBounds accepts displayId
- [x] Round 3 fix: §4.2 alert:navigate IPC end-to-end (navigateWindowToAlert dep, App.vue activateWorkspace + pendingAlertSessionId, PaneStage scroll watcher)
- [x] Round 3 fix: profile-delete-while-open: onDelete in app-dialog-actions wraps in try/catch with clean error re-throw; ProfilesDialog shows inline error
- [x] Round 3 fix: E2E gaps — restart-restore describe, profile-delete-while-open describe, Cmd+W cascade describe, two-workspaces fixture, relaunchApp helper
- [x] Round 4 fix: ProfilesDialog.vue accepts windowSlots prop — Activate button disabled with "Open in Window N" tooltip for profiles occupied by another window; app-dialog-actions.ts passes windowSlots
- [x] Round 4 fix: Telegram screenshot routing unit tests — /screenshot 1 resolves to slot[0].id, /screenshot 2 to slot[1].id, /screenshot ws-name via profile lookup, out-of-range falls back to primary (4 new cases in telegram-manager.test.ts)
- [x] Round 4 fix: E2E per-window capture tests — two new describe blocks in multi-window.spec.ts: per-window screenshot capture (BrowserWindow.capturePage per index) + native badge count (app.getBadgeCount() global sum)
- [x] Task 1: agent-task-runner.ts — /clear before each new round (judge "continue" path) at lines 1977-1983
- [x] Task 2: briefDraft exposed via defineExpose in TaskDashboardStatusTab.vue:226; header Start button in TaskDashboardPane.vue uses statusTabRef?.briefDraft?.value
- [x] Task 3: starred-workspace priority removed from Ctrl+Shift+PgUp/PgDown — useKeyboardShortcuts.ts:164-169 and runtime-bindings.ts:401-407
- [x] Task 4: Cloudflare tunnel auto-reconnect — autoTunnel field in state.ts:33, default-state.ts:442; set/clear in runtime.ts createCloudflareTunnel/stopCloudflareTunnel; auto-start on startup at runtime.ts:3423-3438
- [x] Task 5: fast-uri >=3.1.2 override in package.json:199; npm audit --audit-level=high passes with 0 vulnerabilities
- [x] Task 6: review-bridge poll 3s→15s (runtime.ts:3076); docker poll default 15s→30s (app-config.ts:47)
- [x] Task 6 round2: Electron v42.0.0 / Chromium 132 — no known CPU regression; existing settings optimal (backgroundThrottling:false, contextIsolation:true, sandbox:true). Non-blocking git+docker refresh in activateWorkspace and activateWorkspaceInWindow (runtime.ts:3613-3625, 3815-3827) — IPC now returns immediately; git data follows via background "updated" event. spellcheck:false added to BrowserWindow webPreferences (main.ts:375) to eliminate per-keystroke spell-check overhead in terminals.
