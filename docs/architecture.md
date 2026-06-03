# strIDEterm Architecture

## Direction

strIDEterm is a terminal-first workspace hub with a reusable backend runtime.

Target shape:

- one or more desktop windows, each showing a single profile at a time (the SAME profile may be open in any number of windows — every window is an independent viewer with its own active workspace/session and grid)
- left workspace rail for switching and control inside each window
- right workspace surface for the active workspace, optionally split into a workspace grid of up to four cells
- terminal sessions running inside the app
- optional remote access to the same runtime over LAN or tunnel

The important shift is:

`Electron is one client of the architecture, not the architecture itself.`

## Core Stack

- `Electron` for the desktop shell
- `TypeScript` for all source files (frontend: vue-tsc; backend: tsc)
- `Vite` for the renderer build pipeline
- `node-pty` for PTY-backed terminal sessions
- `xterm.js` for terminal rendering
- `ws` for remote event streaming
- `qrcode` for desktop-to-mobile handoff
- `Vue 3` + `Pinia` for the renderer UI (Composition API, single-file components)

## High-Level Architecture

### 1. Headless Runtime Core

Files:

- `electron/backend/runtime.ts`
- `electron/backend/store.ts`
- `electron/backend/session-manager.ts`
- `electron/backend/default-state.ts`

Responsibilities:

- own persisted state
- normalize and recover config
- manage PTY sessions
- define workspace/session activation rules
- broadcast runtime events independently of a specific UI client

### 2. Local Desktop Adapter

Files:

- `electron/main.ts`
- `electron/backend/ipc.ts`
- `electron/preload.ts`

Responsibilities:

- manage N `BrowserWindow` instances via an in-process `windowRegistry`, each bound to one profile from `AppState.windowSlots`
- create and restore window bounds + display assignment per slot; persist on move/resize/maximize
- route IPC by source window: `emitToWindow(windowId, …)` for window-targeted events (e.g. shortcut intercepts, navigation), `emitToRenderer(…)` to broadcast to every window
- intercept window-level shortcuts before Chromium / xterm consumes them (`Ctrl+1..9`, `Ctrl+Shift+N`)
- coordinate a cross-window file lock via `proper-lockfile` so two instances on the same data directory cannot race on state writes
- connect the runtime core to preload IPC
- keep terminal input and resize on fire-and-forget IPC
- expose request/response actions only where needed

### 3. Remote Access Adapter

File:

- `electron/backend/remote-server.ts`

Responsibilities:

- expose runtime state over local HTTP
- stream runtime and terminal events over WebSocket
- accept remote terminal input and resize commands
- serve the built web UI for LAN access

Current model:

- token-protected LAN access
- built renderer served from the same host
- intended for monitoring and lightweight interaction from another device

### 4. Shared Renderer (Vue 3 + Pinia)

Files:

- `src/main.ts` — Vue app mount, Pinia init, transport provide
- `src/App.vue` — root component (sidebar, workspace, dialogs)
- `src/transport.ts` — Electron IPC / WebSocket remote transport
- `src/stores/` — Pinia stores (app, git-ui, terminal + action modules)
- `src/components/` — Vue single-file components
- `src/composables/` — reusable Composition API hooks
- `src/app/` — pure utilities (selectors, helpers, terminal-controller)
- `src/styles/main.css` — global stylesheet

Responsibilities:

- render the same UI against Electron preload or remote HTTP/WebSocket transport
- keep the workspace rail compact
- keep one dominant terminal viewport visible
- preserve space for the active workspace
- expose remote URL, token rotation, and QR handoff from the desktop shell
- render the Docker manager workspace with container actions and attach flows

Renderer design:

- Vue 3 Composition API with `<script setup>` single-file components
- Pinia store for centralized state (`payload` as `shallowRef` for performance)
- Store split into focused modules: `app.ts` (core), `app-dialog-actions.ts`, `app-workspace-actions.ts`, `app-api-actions.ts`
- Composables for reusable logic: `useTerminal`, `useDragDrop`, `useSidebarResize`, `useReviewComments`, etc.
- `xterm.js` lifecycle stays imperative in `src/app/terminal-controller.ts`
- Terminal data flows outside Vue reactivity for performance (direct controller calls)

## Runtime Model

### Persisted State

Persisted data includes:

- app settings (theme, cloudflared path)
- remote access config and token
- profiles with color, workspace bindings, and a legacy/default `workspaceGrid` (the AUTHORITATIVE grid is per-window on the slot; the profile field only seeds a fresh viewer and keeps downgrade compat)
- tab templates (user-editable presets)
- ordered workspaces with profile assignment
- per-workspace notes, path, color, and badge
- per-workspace `gitRoots` (for multi-repo workspaces) and `uiState.activeRootPath` (last-selected repo in the Git pane switcher)
- per-workspace tabs (terminal and browser), each with an optional `cwd` override to target a specific git root
- per-workspace active tab
- per-tab startup policy
- `windowSlots`: one entry per opened window with `profileId` (NOT unique — the same profile may be open in any number of windows), `activeWorkspaceId`, `activeSessionId`, a per-window `workspaceGrid`, last bounds, display ID, and `lastFocusedAt` for window selection

### Runtime State

Runtime-only data includes:

- PTY process handles
- session status
- terminal size
- event streams
- connected remote clients

This split lets the UI reconnect to the same logical workspace without serializing raw process state.

## Window Management

Files:

- `electron/main.ts` (`windowRegistry`, `createWindowSlot`, `persistWindowSlot`, `emitToWindow`)
- `electron/shared/types/state.ts` (`WindowSlot`, `WindowSlotBounds`)

Responsibilities:

- own the in-process registry mapping `windowId` → `BrowserWindow`
- treat every window as an independent **viewer**: a profile may be open in any number of windows at once (and in remote clients). Each window owns its view selection — active workspace, active session, workspace grid — while workspaces, sessions, and runtime managers stay shared per profile/install. Window selection for actions goes explicit-window → window already showing the target workspace → most recently focused profile window → any live profile window → create a new one (`findWindowsForProfile` / `selectWindowForProfile` / `ensureWindowForProfile`).
- restore window bounds and target display from the previous session, with multi-monitor awareness (`screen.getDisplayNearestPoint`)
- route attention/alert navigation to the window that owns the relevant profile (`navigateWindowToAlert`)
- pick a "primary window" by `lastFocusedAt` for app-level events that don't belong to a specific window (legacy tray actions, global shortcuts triggered outside any window)

Cross-instance safety:

- `proper-lockfile` guards the data directory so two instances on the same `STRIDETERM_DATA_DIR` cannot race. Within one instance, all writes go through a single runtime regardless of how many windows are open.

## Workspace Grid

Files:

- `electron/shared/types/state.ts` (`WorkspaceGridState`, `WorkspaceGridLayout`)
- `src/components/workspace/WorkspaceGridStage.vue`
- `src/components/layout/LayoutPicker.vue`, `WorkspacePickerPopover.vue`, `WorkspaceCellHeader.vue`
- `src/composables/useKeyboardShortcuts.ts`
- `src/app/layout-geometry.ts`

Responsibilities:

- pin up to four workspaces visible simultaneously inside one window
- five layouts: `cols`, `rows`, `top-split`, `left-split`, `grid` (2×2). Each layout dictates the cell count and shape.
- `cellWorkspaceIds: (string | null)[]` maps each cell index to a workspace (or null for an empty cell)
- per-viewer state: the authoritative grid lives on the window slot (`WindowSlot.workspaceGrid`) / remote client context — two windows of the same profile keep independent layouts, and switching a window's profile swaps that window's grid. `Profile.workspaceGrid` is only the legacy/default seed for a fresh viewer; a global `AppState.workspaceGrid` is kept only as a deprecated downgrade-compat field.
- focusing a cell activates the underlying workspace (and re-binds the active terminal); the per-workspace tab state is preserved when a workspace appears in the grid
- driven by keyboard shortcuts (`Ctrl+Shift+G`, `Alt+1..4`, `Alt+Shift+1..4`, `Ctrl+\`) and drag-from-sidebar in the renderer

The grid is a UI overlay on top of the regular workspace model — workspaces remain individually addressable from the sidebar and via per-window IPC.

## Git Manager Runtime

Files:

- `electron/backend/git-manager.ts`
- `electron/backend/fs-probe.ts`
- `electron/backend/runtime-git-handlers.ts`

Responsibilities:

- produce a `GitSnapshot` per tracked git root (branch, upstream, ahead/behind, dirty counts, operation state, worktrees with `lastActivityMs`, tags)
- execute write actions (fetch, pull, push, checkout, branch, merge, rebase, stash, tag, commit, diff preview, log pagination, worktree add/remove) with Azure DevOps / GitHub credential injection and audit logging
- worktree removal uses Node's `fs.rm` with retries to delete the directory and `git worktree prune` to clean metadata; falls back to `git worktree remove --force` when the platform leaves locked files behind
- probe a parent directory for sibling git repositories to power multi-repo workspace detection
- back the renderer's Git pane, Bulk sub-tab, and Lazygit launch point via a stable IPC contract

Current behavior:

- event-driven: `inspectWorkspace` fans out to ~10 git subprocesses per root on user actions, workspace switch, or OSC 133;D shell completion signal; results cached for 8 s
- the periodic `gitPoll` loop only calls `syncWorktrees()` (filesystem stat, no git subprocesses) every 60 s as a backstop; full snapshots are never polled on a timer
- multi-repo: `inspectWorkspaceRoots(workspace)` iterates over `workspace.gitRoots` and returns N snapshots keyed by `(workspaceId, rootPath)`; `inspectWorkspace` is a thin back-compat wrapper that returns the primary root's snapshot
- every git write-action method accepts an optional `rootPath`; omitted = primary root (`gitRoots[0]` or `workspace.cwd`)
- review workspaces (Azure DevOps / GitHub PR) are pinned single-root and bypass multi-repo routing
- audit log entries for Azure-authed operations include the target `rootPath` so per-repo activity is traceable
- the Git pane exposes a searchable branch picker (filter as you type) and a base-compare chip; in review workspaces the chip can detach the comparison from the PR's tracked base for ad-hoc diffs

Detection flow for multi-repo workspaces:

- `fs-probe.ts#probeDirectory(path)` walks up to two directory levels under a candidate parent, ignores `.git`, `node_modules`, dotfiles, and a small denylist, and stops at each detected repo boundary
- pure filesystem — no git subprocess calls during the probe
- hard budget caps runtime (`readdir` count + wall-clock); on exhaustion returns `truncated: true` so the Workspace dialog can warn

## Docker Manager Runtime

Files:

- `electron/backend/docker-manager.ts`
- `electron/backend/process-utils.ts`

Responsibilities:

- detect whether Docker is available natively or only through WSL
- poll live container and context snapshots
- expose start, stop, restart, and remove actions
- create attachable shell and logs sessions

Current behavior:

- prefer native Windows `docker` if present
- fall back to `wsl.exe -e sh -lc ...` if Docker is only reachable via WSL
- present Docker as a special workspace rather than as a generic tab
- support both a structured manager surface and an optional `lazydocker` TUI

## Azure DevOps Review Runtime

Relevant files:

- `electron/backend/azure-devops-manager.ts`
- `electron/backend/azure-devops-api.ts`
- `electron/backend/azure-devops-pr-summary.ts`
- `electron/backend/azure-devops-utils.ts`
- `electron/backend/credential-store.ts`
- `electron/backend/azure-review-store.ts`
- `electron/backend/azure-audit-log-store.ts`
- `electron/backend/review-bridge-store.ts`
- `electron/backend/review-bridge-mcp.ts`

Responsibilities:

- manage Azure DevOps pull request polling and inbox state
- store connection metadata and credentials separately
- create managed review worktrees
- expose Azure inbox and review UI surfaces
- bridge cloud PR metadata with local Git-backed workspaces
- audit log every Azure DevOps API call with transparent interception in the API layer

Detailed workflow and usage notes live in [Azure DevOps Pull Request Review](./azure-devops-review.md).

## Session Model

A session is keyed by:

- `workspaceId:panelId`

Current behavior:

- workspace activation selects the workspace (per window — each window has its own `activeWorkspaceId` in its `WindowSlot`)
- all tabs with `startup: "default"` are started on workspace activation
- one visible tab is considered active per workspace; when the workspace grid is enabled, up to four workspaces can be visible at once in one window, each with its own active tab
- any number of viewers (windows, remote clients) may WATCH the same PTY session; typed input has a single runtime-only lease owner (short TTL, renewed per keystroke). A second viewer's typing is blocked with a "Take control?" prompt instead of interleaving keystrokes — task dashboard buttons are never gated by the lease
- browser panels (URL commands) do not create PTY sessions; they render as embedded webviews

## Remote Access Model

Current remote access is LAN-first and locally hosted:

- off by default — the server is not started until the user enables remote access in Settings (or sets `STRIDETERM_REMOTE_ENABLED=true` before launch)
- when enabled, the runtime server binds to `0.0.0.0:43123` by default
- a random token is persisted in the state file
- desktop and remote clients talk to the same runtime core
- each remote browser session is an independent VIEWER (`RemoteClientContext`): it owns its active profile, workspace, session and workspace grid, may open a profile that has no desktop window, and never flips a desktop window's view (nor vice versa). Runtime methods accept remote viewer ids (`remote:<sessionId>`) wherever they take a `windowId`, so cross-profile guards and per-viewer mutations work for remote callers too.
- the desktop sidebar surfaces LAN URLs, token state, and a QR code
- desktop can optionally prefer a custom public URL
- desktop can optionally launch a Cloudflare Quick Tunnel when `cloudflared` is available

Settings sanitizer:

- `remote-server.ts` filters every settings update and HTTP/WS request from remote clients through a denylist: `autoTunnel`, `cloudflaredPath`, `customPublicUrl`, remote-access `enabled` / `host` / `port`, `token`, and top-level `externalPathOpener` are dropped before reaching the runtime. The desktop owner can change these only via local IPC. Endpoints that accept JSON payloads (workspace grid, task description, etc.) validate against shared Zod schemas; mismatches return 400 instead of being silently coerced.

Use cases:

- check progress from a phone
- open the same workspace state in a browser on the LAN
- attach to an active terminal session for lightweight interaction

This is still a controlled-network feature, not a hardened internet-facing product.

## Performance Shape

- Electron carries the desktop-shell baseline cost
- PTY workloads usually dominate CPU and memory use
- only the visible terminal panes should stay mounted
- remote access adds relatively low overhead compared with the workloads themselves

Practical rule:

`Do not optimize the terminal renderer first if the real cost is the spawned workload.`

## Current Limits

Known limitations:

- remote auth is token-based (no user accounts)
- terminal panes use imperative DOM attachment (xterm.js requires stable mount points)
- the renderer adapts the sidebar, Git pane, Azure DevOps / GitHub inbox, and review pane chrome to phone widths via popovers — but desktop remains the primary target, so dense workspace dialogs may still need a wider viewport
- Docker manager is container-centric rather than compose-centric
- browser tabs use `<webview>` in Electron (bypasses X-Frame-Options) but `<iframe>` in remote mode (subject to site restrictions)
- `node-pty` native rebuild may fail on some Windows setups

## Guiding Principle

`Treat the runtime as a reusable service and the UI as one or more clients.`
