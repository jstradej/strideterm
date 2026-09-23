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

Third transport — the managed relay (mobile app only):

- behind its own flag, `settings.integrations.mobile.relay.enabled`, off by default. With it off no
  connector, listener, socket or key is created — not a connector in a disabled state, none.
- the desktop dials OUT to a Cloudflare Worker over WSS and proves possession of its installation
  Ed25519 key against a server challenge. There is no inbound port and no LAN listener: the relay
  neither opens nor closes the one `remoteAccess.enabled` governs.
- the Worker routes to one Durable Object per desktop installation, derived from the verified claims
  of a grant the mobile control plane signed. Nothing in a request selects a desktop.
- the connector bridges HTTP and WebSocket streams into a SECOND instance of `remote-server.ts`,
  started with `loopbackOrigin`: bound to `127.0.0.1` on an OS-chosen port, reachable only by a
  caller holding this process’s random guard secret, with a master token this process never emits.
  Same handlers, same registry, same runtime — a mobile relay session is a viewer like any other.
- exactly one connector per installation whatever the window count, because the manager is built
  once by `createRuntime`, which is itself built once per data directory.
- a relay response is stripped harder than a LAN one. `payload.remoteAccess.urls[*]` embeds
  `?token=<master>` and that is accepted on the user’s own listener (“Copy share URL” hand-off), on
  the premise that the URL only travels desktop → the owner’s own browser. The relay puts a
  TLS-terminating hop on that path, so `stripSecretsForRemote(..., { stripShareUrls: true })` blanks
  the URL list for the loopback-origin server only — the token is long-lived and keeps unlocking the
  remote API over the LAN after the session ends, and a phone never reaches this desktop through a
  LAN share URL anyway.
- **the relay viewer path is end-to-end encrypted** between a desktop and app that both support it
  (plan `.private/plan-relay-e2e-2026-09-23.md`; ADR `0034-relay-end-to-end-encryption.md` in the
  sibling repo). The session key is agreed over the ALREADY end-to-end-encrypted Firebase envelope
  channel — never over the relay — during `remote.endpoint.request` /
  `remote.webSession.issue`: both sides mint a fresh X25519 ephemeral pair, and HKDF-SHA-256 over the
  ephemeral ECDH output _and_ the long-term pairing-key ECDH output yields two directional
  AES-256-GCM keys. Every HTTP request/response and WebSocket message the WebView exchanges with
  this desktop travels as an `e2e.data` outer frame whose payload is a whole inner relay frame,
  sealed under those keys; the relay Worker (`relay/worker/src/durable-object.ts`) only ever reads
  the OUTER header — routing id, sequence, ciphertext length for flow control and the
  attachment-traffic budget — and there is no code path in it that decrypts or even parses an
  `e2e.*` payload (pinned by `relay-e2e-source-shape.test.mts`, a test over the Worker's own source,
  not a comment). `mobile-relay-connector.ts` is the desktop's other end: it wraps every
  outgoing viewer-bound frame and unwraps every incoming one, keyed by
  `mobile-relay-e2e-session-store.ts` (in memory only, TTL-bound to the ticket, never logged or
  persisted); a bad AEAD tag or a replayed/reordered nonce counter ends the stream, never a
  plaintext fallback.
- **compatibility, not a switch.** An endpoint response with no `e2e` offer (an old desktop) or a
  `remote.webSession.issue` with no `e2e` acceptance (an old app) both fall back to today's
  plaintext viewer path byte-for-byte unchanged. The mobile proxy, desktop connector and Worker
  source implementations now include the encrypted path. This source status does not establish
  which app or Worker build is currently released; verify release versions and each tier's reported
  Worker build separately before making a deployment claim.
- `electron/backend/mobile/mobile-relay-{manager,connector,identity,protocol}.ts`; the decision and
  its limits are in the sibling repo’s `docs/adr/0023-managed-relay-mvp.md` and `docs/RELAY-MVP.md`.

Use cases:

- check progress from a phone
- open the same workspace state in a browser on the LAN
- attach to an active terminal session for lightweight interaction

This is still a controlled-network feature, not a hardened internet-facing product.

## The Free/Paid Boundary and the Account

Everything above this section is free and always will be: the terminal, the workspaces, the agents,
the git/docker/Azure/GitHub managers, LAN remote access and the Cloudflare Quick Tunnel. None of it
consults an account, an entitlement or a subscription, and no code path in `remote-server.ts` or
`tunnel-manager.ts` can — `electron/backend/mobile/local-transports-are-free.test.ts` is a
source-shape test that fails if one appears.

What is paid for is the **hosted control plane**: the pairing handshake, the Firebase event and
command path, push delivery, and the managed relay with its signed grants. That boundary is the whole
of the decision; the sibling repo's `docs/adr/0025-entitlement-boundary-and-merchant-of-record.md`
records why it is drawn there. The Firebase event/command path is read over an RTDB server-sent-event
stream (`mobile-firebase-rest.ts`'s `consumeEventStream`), watched by an idle timer so a connection a
NAT or proxy drops silently (never closing, never erroring) is noticed and reconnected rather than
left open forever with nothing arriving.

### The account manager

`electron/backend/account/` is a self-contained module, mirroring the shape of the mobile one beside
it:

- `account-client.ts` — the identity, over Firebase's REST Auth API: ask for a one-time sign-in link,
  redeem one, refresh a token, look an account up, and start a login-address change. Two identities
  are kept apart on purpose — the OWNER (an email address, proved by opening a link) and the
  INSTALLATION (an anonymous session bound to a key this machine holds) — because the enrolment
  handshake is only meaningful if neither can name the other's.
- `authlink-config.ts` — where a sign-in link is allowed to come back to. The environment comes from
  the same call the bootstrap trust set uses (`bootstrapEnvironmentFor`, which reads the configured
  Firebase project), and maps to two fixed hosts. A deployed build cannot be pointed elsewhere by
  anything in its environment; a dev build must name a loopback origin explicitly or it gets no
  broker at all. It also holds the pasted-link parser, which accepts one shape, unwraps exactly one
  level of `continueUrl`, and never fetches what it was given.
- `email-signin-broker.ts` — one attempt at a time: the attempt id, the claim secret (only its
  SHA-256 leaves this process), the pinned address, the pinned PURPOSE, the deadline, the polling
  schedule, the manual paste and the cancel/ack. Every await is followed by a generation check, so a
  late answer from a cancelled or resent attempt is dropped rather than applied. A `429` from the
  broker is waited out for as long as its `Retry-After` asks — but only ever LATER than the band, and
  never past the attempt's own deadline, so a wait cannot become an extension.
- `account-transport.ts` — the callables, and nothing else. It takes a `MobileFirebaseConfig` and a
  `tokenFor(kind)` function, which is what lets a signed control-plane bootstrap move this desktop to
  a different project without touching a line of it.
- `account-state.ts` — the projection the renderer sees, including a closed set of error codes. A
  refusal from the control plane is mapped to one of ours; a remote string shown to a user is a string
  another system writes and can change without warning.
- `account-manager.ts` — the orchestration, the idempotency keys, and a bounded diagnostics ring.
  It is also where a redeemed link becomes an identity, in an order where each step proves something
  the one before it does not: `signInWithEmailLink` proves an address, `accounts:lookup` must return
  the SAME uid, and on an already-enrolled machine `confirmOwnerForInstallation` is the only thing
  that can say the identity owns the account this MACHINE is in.
- `account-diagnostics.ts` — the opt-in report, built and shown to the user before it is sent.

The `account:*` IPC handlers all reach it, and all of them are **desktop-only**: `remote-server.ts`
registers no counterpart and a source-shape parity test says so. The reasoning is the same one that
keeps `autoApprovePermissions` desktop-only — the consequences of an account action land at the
machine that performs it, and a remote caller cannot see them. The sign-in channels sharpen it: the
flow holds a live sign-in code and a claim secret in the backend for minutes at a time, and the manual
fallback carries a whole email link across one IPC hop.

### Signing in has no password, and the last step happens here

The strIDEterm ACCOUNT has no password — nobody creates, types or resets one, and nothing generates
a hidden one as a way around that. (SSH credentials are a different thing entirely; see `docs/ssh.md`.)
Settings → Account asks for an address and one
explicitly chosen intention; Firebase emails a one-time link; whichever browser opens it confirms
through a small Cloudflare Worker (`authlink/worker` in the cloud repository), and this desktop
collects the code from that Worker with a secret only it holds.

Three properties of that are worth knowing before reading the code:

- **The purpose is pinned locally and travels nowhere.** Not in the link, not to the broker, not to
  Firebase. A URL somebody constructs cannot change what this desktop was about to do, because the
  only copy of that intention is in this process.
- **The last step is on this machine.** The person confirms "sign this computer in as …" here, after
  the link has been opened somewhere else. A link that completed itself would be a link a stranger
  could complete.
- **One authentication per intention.** Registering this machine and starting its trial are one link:
  the nested steps never release the owner credential, and the outer operation drops it in a
  `finally`. A partial success leaves the machine registered rather than rolled back.

Waiting for a link is a SUBSTATE, not a phase, for a machine that is already enrolled — reauthenticating
must not hide the device list and the entitlement this page exists to show. Nothing about an attempt
except the address, the deadline and the resend time reaches the renderer: no code, no claim secret,
no token.

### Billing happens in the system browser

`createCheckout` and `createPortalSession` return a URL, and the desktop opens it with the OS browser.
There is no embedded checkout, no payment form in a `BrowserWindow` and no card field anywhere in this
process. Two reasons, and both are load-bearing: Paddle is the Merchant of Record and its own hosted
checkout is what makes that true, and an Electron window rendering a payment page is a phishing
surface with our chrome around it.

The returned URL's host is checked against an exact allowlist before it is opened — a merchant's
answer is still an answer from outside.

### Identity is per data directory

The installation key, the account session and the bootstrap state all live under the data directory,
so dev (`~/.strideterm-dev`) and prod (`~/.strideterm`) are two independent installations of the
product: two Ed25519 keys, two enrolments, two entries against the account's device cap. That is the
same rule the credential store and the single-instance lock already follow, and it is deliberate — a
developer running both should be visible as two machines, because that is what they are.

One consequence worth knowing before it surprises somebody: enrolling both costs two device slots.
Re-enrolling either one after a crash costs none, because the key is the identity and the server
recognises it.

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
