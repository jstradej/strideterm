# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

strIDEterm — multi-workspace Electron terminal app (Vue 3, Pinia, xterm.js) with Docker, Git, Azure DevOps PR review, plugins, and remote LAN/tunnel access. The Electron shell is a thin adapter over a headless runtime that also serves a remote web client.

## Commands

```bash
npm run dev              # Concurrent Vite + TS backend watch + Electron dev (hot reload)
npm run dev:web          # Vite dev server only (port 1420)
npm run dev:backend      # TypeScript backend watch (tsc -p tsconfig.backend.json --watch)
npm run dev:electron     # Electron only (connects to Vite dev server)
npm start                # Build + run packaged Electron app

npm run lint             # ESLint + Prettier check
npm run lint:fix         # Auto-fix lint + formatting issues
npm run typecheck        # Type-check all TS/Vue files (frontend + backend + tests + scripts)
npm test                 # All tests (UI + backend)
npm run test:ui          # Vitest jsdom — src/**/*.test.ts
npm run test:backend     # Vitest node  — electron/backend/**/*.test.ts
npm run test:e2e         # Playwright E2E — mock server + fixture data

npm run build            # vue-tsc + Vite + tsc backend → dist/ + dist-electron/
npm run dist             # Build + electron-builder (all platforms)
npm run smoke            # Build + headless startup test
npm run perf             # Node GC profiling
```

Single test file: `npx vitest run --config vite.config.ts src/stores/notifications.test.ts`

Backend single test: `npx vitest run --config vitest.backend.config.ts electron/backend/store.test.ts`

## Starting Dev Servers (important)

The preferred way to start the dev environment is `dev.ps1` in the project root:

```powershell
.\dev.ps1                # PowerShell — recommended
```

This script handles everything: kills stale Electron/Node processes, clears Electron cache, frees port 1420, starts Vite, starts the backend `tsc --watch` and waits for `dist-electron/electron/main.js`, starts Electron, auto-restarts Vite if it crashes, and cleans up on Ctrl+C. It requires an interactive PowerShell session — **do not run it from Claude Code's Bash tool** (background process management won't work).

If `dev.ps1` is not an option (e.g. non-Windows), fall back to manual startup:

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

- **runtime.ts** — orchestrator: owns all state, broadcasts events, delegates to managers
- **session-manager.ts** — PTY lifecycle (spawn/resize/kill via node-pty), shell integration injection
- **store.ts** — atomic JSON persistence (~/.strideterm/strideterm-state.json, write-to-tmp-then-rename)
- **ipc.ts** — registers all `ipcMain.handle()` handlers; returns cleanup function
- **ipc-schemas.ts** — Zod validation for every IPC payload
- **remote-server.ts** — HTTP + WebSocket server for remote/LAN access (token auth)
- **git-manager.ts** — event-driven `inspectWorkspace` (~10 git subprocesses per call, 8 s snapshot cache); triggered on user actions, workspace switch, and OSC 133;D shell signal. The `gitPoll` loop in `runtime.ts` only calls `syncWorktrees()` (filesystem stat, no git subprocesses) every 60 s as a backstop for externally-added/removed worktrees. Full git snapshot is **never** polled periodically.
- **docker-manager.ts** — polling (15s), container list, start/stop/restart/remove/shell/logs
- **azure-devops-manager.ts** — Azure DevOps PR inbox polling, review workspace creation, audit logging
- **github-manager.ts** — GitHub PR inbox polling, review workspace creation, audit logging (same architecture as Azure DevOps)
- **review-bridge-mcp.ts** — MCP server exposing review context to AI agents (provider-agnostic, works with both Azure DevOps and GitHub)
- **plugin-loader.ts** — manifest validation, capability whitelist, safe script execution
- **file-manager.ts** — file tree, read/write/rename/delete/move/copy operations

### 2. Electron Adapter (`electron/main.ts`, `electron/preload.ts`)

Thin shell: creates BrowserWindow, wires IPC, manages native attention (overlay icon, taskbar flash, badge count, system notifications). Preload exposes `window.strideterm` via contextBridge.

### 3. Vue Renderer (`src/`)

- **transport.ts** — abstracts Electron IPC vs Remote HTTP/WS. All stores use this, never raw IPC.
- **stores/app.ts** — main Pinia store: `payload` (shallowRef of full server state), active workspace/tab/session, split layout, overlay/dialog state. Uses memoized computed to avoid unnecessary rerenders.
- **stores/app-*-actions.ts** — modular action groups (dialog, workspace, api) mixed into the app store
- **stores/terminal.ts** — xterm.js controller instances, mount/unmount lifecycle
- **stores/git-ui.ts** — git snapshot cache, diff preview state
- **stores/file-manager.ts** — file browser tree, preview, edit state
- **stores/notifications.ts** — notification queue with localStorage persistence
- **composables/** — reusable hooks (useTerminal, useNotificationCapture, useNotificationSound, useAttentionSync, useDragDrop, etc.)
- **app/terminal-controller.ts** — imperative xterm.js lifecycle management (attach/detach/dispose)

## Key Patterns

- **Profile-aware lookups** — workspaces can exist in multiple profiles with the same name/cwd. Any lookup by cwd or name (parent detection, grouping, auto-fill) **must** filter by the active profile first. Forgetting this causes cross-profile mismatches (e.g. a task workspace parented to the wrong "strideterm" in another profile). Key locations: `findParentByCwd` in `default-state.ts`, parent auto-detection in `app-dialog-actions.ts`.
- **Session ID** = `workspaceId:panelId`. This composite key is used everywhere.
- **shallowRef for payload** — the server state blob is large; shallowRef avoids deep reactivity overhead. Computed properties derive slices.
- **Workspace payload cache** — on workspace switch-away, the current payload is cached; on switch-back it restores instantly while the server catches up.
- **Fire-and-forget IPC** — terminal:resize and terminal:input use `ipcRenderer.send()` (not invoke) for low latency.
- **Transport abstraction** — stores call `api.someMethod()` which works identically in Electron (IPC) and remote (HTTP POST) mode. `api.isRemote` distinguishes them.
- **IPC validation** — every complex IPC payload goes through `validateIpc(schema, payload, channel)` using Zod schemas before reaching runtime methods.

## State Persistence

All state lives in `~/.strideterm/strideterm-state.json`: workspaces, projects, profiles, tab templates, settings, Azure DevOps and GitHub connections. Written atomically (tmp + rename). Runtime-only state (PTY handles, terminal size, WS connections) is never persisted.

## Configuration

`config/app-config.ts` — central config with env var overrides for ports, hosts, terminal defaults, polling intervals, theme, and command paths.

### Notification Timing

Configurable via `settings.notifications` (persisted per user) or env vars:

| Setting | Env var | Default | Purpose |
|---------|---------|---------|---------|
| `promptQuietMs` | `STRIDETERM_PROMPT_QUIET_MS` | 900 | Silence before shell prompt-return alert |
| `agentQuietMs` | `STRIDETERM_AGENT_QUIET_MS` | 20000 | Silence before agent idle alert |
| `agentQuietFastMs` | `STRIDETERM_AGENT_QUIET_FAST_MS` | 12000 | Agent idle alert after output bursts |
| `alertCooldownMs` | `STRIDETERM_ALERT_COOLDOWN_MS` | 15000 | Per-session alert cooldown |
| `shellIntegration` | `STRIDETERM_SHELL_INTEGRATION` | true | Auto-inject OSC 133 shell integration |

### Shell Integration

`config/shell-integration/` contains scripts (bash.sh, zsh.sh, pwsh.ps1) that emit OSC 133 escape sequences for command boundary detection. When `shellIntegration` is enabled, `session-manager.ts` auto-injects these into PTY sessions. OSC 133;D gives instant, zero-false-positive command completion detection.

For agent sessions (Claude Code, Codex, etc.), a silence-based heuristic is used instead, with a secondary check (`matchesAgentIdle`) verifying the last output line looks like an idle prompt before raising an alert.

## Testing

- UI tests (`src/**/*.test.ts`): jsdom environment, import Vue components and Pinia stores directly
- Backend tests (`electron/backend/**/*.test.ts`): node environment, test runtime/managers in isolation
- Both use Vitest. No E2E framework — `npm run smoke` does a basic startup check.
