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
