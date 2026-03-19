# strIDEterm Architecture

## Direction

strIDEterm is a terminal-first workspace hub with a reusable backend runtime.

Target shape:

- one main desktop window
- left workspace rail for switching and control
- right workspace surface for the active workspace
- terminal sessions running inside the app
- optional remote access to the same runtime over LAN or tunnel

The important shift is:

`Electron is one client of the architecture, not the architecture itself.`

## Core Stack

- `Electron` for the desktop shell
- `Vite` for the renderer build pipeline
- `node-pty` for PTY-backed terminal sessions
- `xterm.js` for terminal rendering
- `ws` for remote event streaming
- `qrcode` for desktop-to-mobile handoff
- `lit` as a lightweight renderer templating layer

## High-Level Architecture

### 1. Headless Runtime Core

Files:

- `electron/backend/runtime.js`
- `electron/backend/store.js`
- `electron/backend/session-manager.js`
- `electron/backend/default-state.js`

Responsibilities:

- own persisted state
- normalize and recover config
- manage PTY sessions
- define workspace/session activation rules
- broadcast runtime events independently of a specific UI client

### 2. Local Desktop Adapter

Files:

- `electron/main.js`
- `electron/backend/ipc.js`
- `electron/preload.js`

Responsibilities:

- create the Electron window
- connect the runtime core to preload IPC
- keep terminal input and resize on fire-and-forget IPC
- expose request/response actions only where needed

### 3. Remote Access Adapter

File:

- `electron/backend/remote-server.js`

Responsibilities:

- expose runtime state over local HTTP
- stream runtime and terminal events over WebSocket
- accept remote terminal input and resize commands
- serve the built web UI for LAN access

Current model:

- token-protected LAN access
- built renderer served from the same host
- intended for monitoring and lightweight interaction from another device

### 4. Shared Renderer

Files:

- `src/main.js`
- `src/transport.js`
- `src/app.js`
- `src/app-legacy.js`
- `src/app/*.js`
- `src/ui/*.js`
- `src/styles/main.css`

Responsibilities:

- render the same UI against Electron preload or remote HTTP/WebSocket transport
- keep the workspace rail compact
- keep one dominant terminal viewport visible
- preserve space for the active workspace
- expose remote URL, token rotation, and QR handoff from the desktop shell
- render the Docker manager workspace with container actions and attach flows

Renderer design:

- `src/app.js` is the bootstrap entry
- `src/app-legacy.js` holds top-level orchestration glue
- `src/app/` contains controllers, selectors, actions, and helpers
- `src/ui/` contains Lit-based render modules
- `xterm` lifecycle stays imperative in `src/app/terminal-controller.js`

## Runtime Model

### Persisted State

Persisted data includes:

- app settings (theme, cloudflared path)
- remote access config and token
- profiles with color and workspace bindings
- tab templates (user-editable presets)
- ordered workspaces with profile assignment
- per-workspace notes, path, color, and badge
- per-workspace tabs (terminal and browser)
- per-workspace active tab
- per-tab startup policy

### Runtime State

Runtime-only data includes:

- PTY process handles
- session status
- terminal size
- event streams
- connected remote clients

This split lets the UI reconnect to the same logical workspace without serializing raw process state.

## Docker Manager Runtime

Files:

- `electron/backend/docker-manager.js`
- `electron/backend/process-utils.js`

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

- `electron/backend/azure-devops-manager.js`
- `electron/backend/azure-devops-api.js`
- `electron/backend/azure-devops-pr-summary.js`
- `electron/backend/azure-devops-utils.js`
- `electron/backend/credential-store.js`
- `electron/backend/azure-review-store.js`
- `electron/backend/review-bridge-store.js`
- `electron/backend/review-bridge-mcp.js`
- `src/app/pane-markup.js`
- `src/app/workspace-ui-controller.js`

Responsibilities:

- manage Azure DevOps pull request polling and inbox state
- store connection metadata and credentials separately
- create managed review worktrees
- expose Azure inbox and review UI surfaces
- bridge cloud PR metadata with local Git-backed workspaces

Detailed workflow and usage notes live in [Azure DevOps Pull Request Review](./azure-devops-review.md).

## Session Model

A session is keyed by:

- `workspaceId:panelId`

Current behavior:

- workspace activation selects the workspace
- all tabs with `startup: "default"` are started on workspace activation
- one visible tab is considered active per workspace
- browser panels (URL commands) do not create PTY sessions; they render as embedded webviews

## Remote Access Model

Current remote access is LAN-first and locally hosted:

- runtime server binds to `0.0.0.0:43123` by default
- a random token is persisted in the state file
- desktop and remote clients talk to the same runtime core
- the desktop sidebar surfaces LAN URLs, token state, and a QR code
- desktop can optionally prefer a custom public URL
- desktop can optionally launch a Cloudflare Quick Tunnel when `cloudflared` is available

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
- renderer still has some imperative DOM orchestration alongside Lit
- remote UI is usable on mobile but not phone-first optimized
- Docker manager is container-centric rather than compose-centric
- browser tabs use `<webview>` in Electron (bypasses X-Frame-Options) but `<iframe>` in remote mode (subject to site restrictions)
- `node-pty` native rebuild may fail on some Windows setups

## Guiding Principle

`Treat the runtime as a reusable service and the UI as one or more clients.`
