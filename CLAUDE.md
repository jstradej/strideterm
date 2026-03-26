# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

strIDEterm — multi-workspace Electron terminal app (Vue 3, Pinia, xterm.js) with Docker, Git, Azure DevOps PR review, plugins, and remote LAN/tunnel access. The Electron shell is a thin adapter over a headless runtime that also serves a remote web client.

## Commands

```bash
npm run dev              # Concurrent Vite + Electron dev (hot reload)
npm run dev:web          # Vite dev server only (port 1420)
npm run dev:electron     # Electron only (connects to Vite dev server)
npm start                # Build + run packaged Electron app

npm test                 # All tests (UI + backend)
npm run test:ui          # Vitest jsdom — src/**/*.test.js
npm run test:backend     # Vitest node  — electron/backend/**/*.test.js

npm run build            # Vite production build → dist/
npm run dist             # Build + electron-builder (all platforms)
npm run smoke            # Build + headless startup test
npm run perf             # Node GC profiling
```

Single test file: `npx vitest run --config vite.config.js src/stores/notifications.test.js`

Backend single test: `npx vitest run --config vitest.backend.config.js electron/backend/store.test.js`

## Starting Dev Servers (important)

`dev:electron` waits for Vite on port 1420 and then spawns Electron. When Electron exits (user closes window, crash, etc.), the `dev:electron` process also exits immediately. This means **if you run it via Bash `run_in_background`, you'll get a "completed" notification and lose the process silently**.

Correct procedure:

1. **Kill existing processes first** — old Electron/Node may hold port 1420:
   ```bash
   taskkill //F //IM electron.exe 2>/dev/null; taskkill //F //IM node.exe 2>/dev/null
   ```

2. **Start Vite first**, wait for it to be ready (look for "ready in" output):
   ```bash
   npm run dev:web &          # background, stays alive
   ```

3. **Start Electron after Vite is listening** (needs ~3s):
   ```bash
   sleep 3 && npm run dev:electron &   # background, exits when window closes
   ```

Do NOT use `npm run dev` (the concurrent script) from Bash — it uses `concurrently -k` which kills both when either exits, and the process management doesn't work well from non-interactive shells. Start them separately.

If port 1420 is already in use, kill the old node.exe process holding it before restarting Vite.

## Architecture (3 layers)

### 1. Headless Runtime (`electron/backend/`)

The core — no Electron dependency. Can be driven by Electron IPC or the remote HTTP/WS server.

- **runtime.js** — orchestrator: owns all state, broadcasts events, delegates to managers
- **session-manager.js** — PTY lifecycle (spawn/resize/kill via node-pty)
- **store.js** — atomic JSON persistence (~/.strideterm/strideterm-state.json, write-to-tmp-then-rename)
- **ipc.js** — registers all `ipcMain.handle()` handlers; returns cleanup function
- **ipc-schemas.js** — Zod validation for every IPC payload
- **remote-server.js** — HTTP + WebSocket server for remote/LAN access (token auth)
- **git-manager.js** — polling (20s), branch/status/log/worktree parsing, merge/rebase/stash/commit ops
- **docker-manager.js** — polling (15s), container list, start/stop/restart/remove/shell/logs
- **azure-devops-manager.js** — Azure DevOps PR inbox polling, review workspace creation, audit logging
- **github-manager.js** — GitHub PR inbox polling, review workspace creation, audit logging (same architecture as Azure DevOps)
- **review-bridge-mcp.js** — MCP server exposing review context to AI agents (provider-agnostic, works with both Azure DevOps and GitHub)
- **plugin-loader.js** — manifest validation, capability whitelist, safe script execution
- **file-manager.js** — file tree, read/write/rename/delete/move/copy operations

### 2. Electron Adapter (`electron/main.js`, `electron/preload.js`)

Thin shell: creates BrowserWindow, wires IPC, manages native attention (overlay icon, taskbar flash, badge count, system notifications). Preload exposes `window.strideterm` via contextBridge.

### 3. Vue Renderer (`src/`)

- **transport.js** — abstracts Electron IPC vs Remote HTTP/WS. All stores use this, never raw IPC.
- **stores/app.js** — main Pinia store: `payload` (shallowRef of full server state), active workspace/tab/session, split layout, overlay/dialog state. Uses memoized computed to avoid unnecessary rerenders.
- **stores/app-*-actions.js** — modular action groups (dialog, workspace, api) mixed into the app store
- **stores/terminal.js** — xterm.js controller instances, mount/unmount lifecycle
- **stores/git-ui.js** — git snapshot cache, diff preview state
- **stores/file-manager.js** — file browser tree, preview, edit state
- **stores/notifications.js** — notification queue with localStorage persistence
- **composables/** — reusable hooks (useTerminal, useNotificationCapture, useNotificationSound, useAttentionSync, useDragDrop, etc.)
- **app/terminal-controller.js** — imperative xterm.js lifecycle management (attach/detach/dispose)

## Key Patterns

- **Session ID** = `workspaceId:panelId`. This composite key is used everywhere.
- **shallowRef for payload** — the server state blob is large; shallowRef avoids deep reactivity overhead. Computed properties derive slices.
- **Workspace payload cache** — on workspace switch-away, the current payload is cached; on switch-back it restores instantly while the server catches up.
- **Fire-and-forget IPC** — terminal:resize and terminal:input use `ipcRenderer.send()` (not invoke) for low latency.
- **Transport abstraction** — stores call `api.someMethod()` which works identically in Electron (IPC) and remote (HTTP POST) mode. `api.isRemote` distinguishes them.
- **IPC validation** — every complex IPC payload goes through `validateIpc(schema, payload, channel)` using Zod schemas before reaching runtime methods.

## State Persistence

All state lives in `~/.strideterm/strideterm-state.json`: workspaces, projects, profiles, tab templates, settings, Azure DevOps and GitHub connections. Written atomically (tmp + rename). Runtime-only state (PTY handles, terminal size, WS connections) is never persisted.

## Configuration

`config/app-config.js` — central config with env var overrides for ports, hosts, terminal defaults, polling intervals, theme, and command paths.

## Testing

- UI tests (`src/**/*.test.js`): jsdom environment, import Vue components and Pinia stores directly
- Backend tests (`electron/backend/**/*.test.js`): node environment, test runtime/managers in isolation
- Both use Vitest. No E2E framework — `npm run smoke` does a basic startup check.
