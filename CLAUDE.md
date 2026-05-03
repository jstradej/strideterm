# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

strIDEterm — multi-workspace Electron terminal app (Vue 3, Pinia, xterm.js) with Docker, Git, Azure DevOps PR review, plugins, and remote LAN/tunnel access. The Electron shell is a thin adapter over a headless runtime that also serves a remote web client.

## Commands

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

3. **Start the backend TypeScript watcher**:
   ```bash
   npm run dev:backend &   # background, compiles electron/ on change
   ```

4. **Start Electron after Vite is listening** (needs ~3s):
   ```bash
   sleep 3 && npm run dev:electron &   # background, exits when window closes
   ```

Do NOT use `npm run dev` (the concurrent script) from Bash — it uses `concurrently -k` which kills both when either exits, and the process management doesn't work well from non-interactive shells. Start them separately.

If port 1420 is already in use, kill the old node.exe process holding it before restarting Vite.

## Architecture (3 layers)

### 1. Headless Runtime (`electron/backend/`)

Pure TypeScript — no Electron imports. Owns all state (persisted + runtime), PTY sessions, git/docker/azure/github managers, plugin loader, and the remote HTTP/WS server. Broadcasts events to any number of connected clients.

### 2. Electron Adapter (`electron/main.ts`, `electron/preload.ts`)

Thin shell: creates BrowserWindow, wires IPC, manages native attention (overlay icon, taskbar flash, badge count, system notifications). Preload exposes `window.strideterm` via contextBridge.

### 3. Vue Renderer (`src/`)

Vue 3 + Pinia SPA. The `transport.ts` module abstracts Electron IPC vs remote HTTP/WS so all stores work identically in both modes.


## Configuration

`config/app-config.ts` — central config with env var overrides for ports, hosts, terminal defaults, polling intervals, theme, and command paths.


## Testing

- UI tests (`src/**/*.test.ts`): jsdom environment, import Vue components and Pinia stores directly
- Backend tests (`electron/backend/**/*.test.ts`): node environment, test runtime/managers in isolation
- Both use Vitest. `npm run smoke` does a headless startup check.
- E2E tests: `npm run test:e2e` (Playwright, remote HTTP/WS client against a live backend) and `npm run test:e2e:electron` (full Electron stack). Do not run these from Claude Code — they require an interactive display or are slow.


# Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.