# Development Guide

This document is for contributors building strIDEterm from source. **Most users should use the [pre-built binaries](https://github.com/jstradej/strideterm/releases/latest)** — they are signed, ready to run, and auto-update.

## Requirements

**Required:**

- Node.js 22+
- npm 10+

**Optional (enables specific features at runtime):**

- `git` — Git integration
- Docker CLI — Docker workspaces
- `lazygit` — Git TUI
- `cloudflared` — Cloudflare tunnel for remote access
- `claude`, `codex`, `gemini`, `copilot`, or `opencode` CLI — for the Agent Task Runner

**Native build tools** (required for `node-pty`):

- **Windows** — Visual Studio Build Tools with the C++ workload
- **macOS** — Xcode Command Line Tools (`xcode-select --install`)
- **Linux** — `build-essential` and `python3`

## Quick start

```bash
git clone https://github.com/jstradej/strideterm.git
cd strideterm
npm install
npm run dev
```

## Starting the dev environment

The preferred way to start the dev environment on Windows is `dev.ps1` in the project root:

```powershell
.\dev.ps1
```

What it does:

- Forces an isolated data directory at `~/.strideterm-dev` (via `STRIDETERM_DATA_DIR`) so a dev build can run side-by-side with a production install without clobbering state, credentials, logs, or the single-instance lock.
- Kills stale Electron/Node processes, clears the Electron disk cache, and frees port 1420.
- Starts four watchers in parallel — Vite dev server, backend `tsc --watch`, preload `tsc --watch`, and a `vite build --watch` for `dist/` so the bundle served to remote/mobile clients stays fresh — and launches Electron once `dist-electron/electron/main.js` is on disk.
- **Auto-restarts Electron when the backend recompiles** (debounced) so new IPC handlers, runtime methods, and manager changes take effect without a manual restart. Disable with `-NoAutoRestart`.
- Restarts Vite if it crashes, and cleans up everything on `Ctrl+C`.
- Defaults the remote-access port to `43124` to avoid colliding with a running production instance on `43123`, and sets `STRIDETERM_LOG_LEVEL=trace` for verbose logs.

Requires an interactive PowerShell session.

If `dev.ps1` is not an option (non-Windows, or you prefer manual control):

```bash
# Free port 1420 if a previous session left something behind:
#   macOS / Linux: lsof -ti:1420 | xargs -r kill -9
#   Windows:       taskkill //F //IM electron.exe; taskkill //F //IM node.exe

# Start Vite (background), wait until it prints "ready in ..."
npm run dev:web &

# Then start the backend + preload tsc watchers and Electron
npm run dev:backend &
npm run dev:preload &
sleep 3 && npm run dev:electron &
```

Avoid `npm run dev` from a non-interactive shell — `concurrently -k` kills all four processes when any one exits, which fights with backgrounded shells.

## Commands

```bash
npm run dev              # Concurrent Vite + backend tsc + preload tsc + Electron (hot reload)
npm run dev:web          # Vite dev server only (port 1420)
npm run dev:backend      # TypeScript backend watch
npm run dev:preload      # TypeScript preload watch (electron/preload.cts)
npm run dev:electron     # Electron only (connects to Vite dev server)
npm start                # Build + run packaged Electron app

npm run lint             # ESLint + Prettier check
npm run lint:fix         # Auto-fix lint + formatting issues
npm run typecheck        # Type-check all TS/Vue files

npm test                 # All tests (UI + backend)
npm run test:ui          # Vitest jsdom — src/**/*.test.ts
npm run test:backend     # Vitest node  — electron/backend/**/*.test.ts
npm run test:e2e         # Playwright E2E (mock backend)
npm run test:e2e:electron         # Playwright E2E against a real Electron build
npm run test:e2e:electron:visual  # Visual regression — compare against committed screenshots
npm run test:e2e:electron:update  # Visual regression — update the committed screenshots
npm run perf             # Renderer performance probe
npm run audit:security   # Dependency security audit
npm run audit:package-age # Flag stale npm dependencies

npm run build            # vue-tsc + Vite + tsc backend → dist/ + dist-electron/
npm run dist             # Build + electron-builder (current platform)
npm run dist:win         # Windows installer + portable
npm run dist:mac         # macOS DMG (x64 + arm64)
npm run dist:linux       # Linux AppImage + .deb
npm run smoke            # Build + headless startup test
```

Single test file:

```bash
npx vitest run --config vite.config.ts src/stores/notifications.test.ts
npx vitest run --config vitest.backend.config.ts electron/backend/store.test.ts
```

E2E tests use fixture JSON files in `test/fixtures/` and a mock server that serves them on the same API as the real backend. No Electron required.

## Packaging notes

**Windows:** local `node-pty` rebuilds occasionally fail. Production builds are cut by [GitHub Actions CI](../.github/workflows/release.yml), which has the correct toolchain. For day-to-day development, `npm run dev` and `npm start` work without a manual rebuild.

## Architecture

The app has three layers:

- **Headless runtime** (`electron/backend/`) — pure TypeScript, no Electron dependency. Owns PTYs, state, Git/Docker/Azure DevOps/GitHub managers, and exposes the same API to both the Electron IPC layer and a remote HTTP/WS server.
- **Electron adapter** (`electron/main.ts`, `electron/preload.ts`) — thin shell: a window registry of one or more `BrowserWindow` instances (each pinned to a profile via a `WindowSlot`), native attention (taskbar flash, badge), per-window IPC routing, cross-instance data-directory lock.
- **Vue renderer** (`src/`) — Vue 3 + Pinia SPA. The `transport.ts` module abstracts Electron IPC vs remote HTTP/WS so stores work identically in both modes.

See [architecture.md](architecture.md) for the full breakdown and key patterns.

## Plugin development

Built-in plugins live in `plugins/`; user plugins live in `~/.strideterm/plugins/`. See [plugin-development.md](plugin-development.md).

## Pull requests

- Branch from `master`
- `npm run lint` and `npm run typecheck` must pass with 0 errors
- `npm run test` and `npm run test:e2e` must pass
- Describe what changed and why in the PR body
