# strIDEterm Architecture

## Direction

strIDEterm is a terminal-first workspace hub built around a reusable backend runtime:

- one or more desktop windows, each showing one profile at a time
- a workspace rail on the left, the active workspace (optionally a grid of up to four) on the right
- terminal sessions running inside the app
- optional remote access to the same runtime from a browser or a phone

`Electron is one client of the architecture, not the architecture itself.`

## Core Stack

Electron (desktop shell), TypeScript everywhere, Vite (renderer build), `node-pty` (PTYs), `xterm.js`
(terminal rendering), `ws` (remote event streaming), Vue 3 + Pinia (renderer).

## Layers

### 1. Headless runtime core — `electron/backend/`

Owns persisted state and its normalisation, PTY sessions, workspace/session activation rules, the
git, docker, Azure DevOps and GitHub managers, and broadcasts runtime events independently of any UI.
It imports nothing from Electron, so it also runs headless. Entry point: `runtime.ts`.

### 2. Local desktop adapter — `electron/main.ts`, `electron/backend/ipc.ts`, `electron/preload.cts`

A thin shell: a registry of `BrowserWindow`s, native attention (taskbar flash, badge), window-level
shortcuts, per-window IPC routing, and a data-directory lock so two instances on the same directory
cannot race on state writes. Terminal input and resize use fire-and-forget IPC; request/response only
where an answer is needed.

### 3. Remote access adapter — `electron/backend/remote-server.ts`

Exposes the runtime over HTTP and streams state and terminal events over WebSocket, and serves the
built web UI from the same host. It talks to the same runtime as the desktop.

Browser sessions created from a master-token URL expire after 24 hours idle or 7 days total by
default; Settings → Remote access can change both limits and revoke one or all live browser sessions.
Telegram `/tunnel` links use separate one-use tickets that expire after 5 minutes.

### 4. Shared renderer — `src/`

One Vue 3 + Pinia app, rendered against either Electron preload or the remote HTTP/WebSocket
transport (`src/transport.ts`), so stores behave identically in both. `xterm.js` lifecycle stays
imperative, and terminal data flows outside Vue reactivity for performance.

## Runtime Model

- **Persisted state** — settings, profiles, workspaces with their tabs, notes and git roots, tab
  templates, and one `windowSlots` entry per opened window. It lives in `strideterm-state.json` under
  the data directory.
- **Secrets are never in the state file.** Tokens, PATs, SSH keys, bot tokens and the remote-access
  master token live in the credential store (`credentials.json`, encrypted with Electron
  `safeStorage` where the OS provides it). The state file is copied to backups and attached to bug
  reports; the credential store is not.
- **Runtime-only state** — PTY handles, session status, terminal size, event streams, connected
  clients. Nothing about a live process is serialised, so a UI can reconnect to the same logical
  workspace without it.

## Windows and Viewers

Every window, and every remote browser session, is an independent **viewer**: it owns its active
profile, workspace, session and workspace grid, while workspaces, sessions and the runtime managers
are shared per installation. The same profile may be open in any number of viewers, and none of them
changes another's view. When an action needs a window, the choice goes: the window it was asked from
→ a window already showing the target workspace → the most recently focused window of the profile →
any window of the profile → a new one.

The **workspace grid** (up to four workspaces, five layouts) is per viewer and is a UI overlay:
workspaces stay individually addressable from the sidebar.

## Sessions

A session is keyed `workspaceId:panelId`. Activating a workspace starts its `startup: "default"`
tabs. Any number of authorized viewers may watch and type into one PTY. A mobile composer submits
text and Enter as one queued operation; competing raw writes wait until that operation finishes.
Meaningful manual input applies the existing task pause rules and cancels pending automatic prompt
writes. Browser panels render as webviews and create no PTY.

## Managers

- **Git** (`git-manager.ts`) — snapshots per git root and every write action. Event-driven: snapshots
  are taken on user actions, workspace switches and shell-completion signals, never on a timer. A
  workspace can track several repositories; review workspaces are pinned to one.
- **Docker** (`docker-manager.ts`) — uses native `docker` when present, otherwise reaches it through
  WSL; presented as a special workspace.
- **Azure DevOps / GitHub review** — PR inboxes, managed review worktrees and a local review bridge
  that agents write drafts into; every provider API call is audited. See
  [Azure DevOps](./azure-devops-review.md) and [GitHub](./github-pr-review.md).

## Remote Access

- **Off by default.** When enabled the server listens on port `43123`, on all interfaces or only on
  loopback (Settings → Remote Access). A random master token, kept in the credential store, protects
  it; a Cloudflare quick tunnel can expose it publicly.
- **Security posture is desktop-only.** A remote client cannot change the token, the listener, the
  tunnel, the external path opener or the auto-approve setting: `remote-server.ts` drops those
  settings before they reach the runtime. JSON bodies are validated against shared Zod schemas.
- **A phone is confined to its profile.** A session minted from a mobile pairing ticket sees and
  touches only its own profile's workspaces, terminals and files, and what it does is audited
  (metadata only). That is an application boundary, not an OS one.

### The managed relay (mobile app only)

- Behind its own flag, off by default; with it off nothing relay-related exists.
- The desktop dials **out** to a Cloudflare Worker over WSS and proves possession of its installation
  key. There is no inbound port. The Worker routes to one Durable Object per installation, chosen from
  claims the control plane signed — nothing in a request selects a desktop.
- The connector feeds a second, loopback-only instance of `remote-server.ts` (same handlers, same
  runtime), reachable only with this process's guard secret. Share URLs, which embed the master
  token, are stripped from everything that instance answers.
- **End-to-end encrypted.** The session key is agreed over the already end-to-end-encrypted Firebase
  channel, never over the relay, and every HTTP and WebSocket frame between the phone's WebView and
  the desktop is sealed under it (AES-256-GCM). The Worker reads only routing metadata and has no code
  path that decrypts a payload (a source-shape test pins that). A bad tag or an out-of-sequence counter
  ends the stream; there is no plaintext fallback.
- **A plaintext relay session is refused**, unless the user explicitly turned "require end-to-end
  encryption" off and the phone has never used it.

Remote access is meant for checking progress and light interaction from another device. It is a
controlled-network feature, not a hardened internet-facing product.

## The Free/Paid Boundary and the Account

Everything above is free: terminals, workspaces, agents, the managers, LAN remote access and the
Cloudflare quick tunnel. None of it consults an account or entitlement, and a source-shape test
(`local-transports-are-free.test.ts`) fails if `remote-server.ts` or the tunnel manager ever does.
What is paid for is the **hosted control plane**: pairing, the Firebase event and command path, push
delivery and the managed relay.

### The account (`electron/backend/account/`)

- **Two identities, kept apart.** The OWNER is an email address proved by opening a link; the
  INSTALLATION is an anonymous session bound to a key this machine holds. Enrolment is meaningful only
  because neither can name the other.
- **No password, and the last step happens here.** A one-time link is confirmed in whatever browser
  opens it, but the sign-in completes only after the person confirms it on this desktop. The purpose
  of the sign-in (enrol, trial, checkout, …) is pinned in this process and travels nowhere, so a
  crafted URL cannot change what the desktop does.
- **One authentication per intention.** The owner credential is transient and dropped as soon as the
  operation that needed it finishes; a partial success leaves the machine registered, not rolled back.
- **Account IPC is desktop-only.** No remote route reaches it: the consequences of an account action
  land on the machine that performs it.
- **Billing happens in the system browser.** Checkout and the customer portal open in the OS browser
  after an exact host allowlist check; no payment page is ever rendered inside the app.
- **Identity is per data directory.** Dev (`~/.strideterm-dev`) and prod (`~/.strideterm`) are two
  installations with two keys and two device slots. Re-enrolling after a crash costs none, because the
  key is the identity.

Sign-in mail delivery is described in [authentication email delivery](auth-email-delivery.md), the
signed bootstrap in [production bootstrap](production-bootstrap.md).

## Performance Shape

PTY workloads usually dominate CPU and memory; Electron carries the shell baseline, and remote access
adds little on top. Only visible terminal panes stay mounted.

`Do not optimize the terminal renderer first if the real cost is the spawned workload.`

## Current Limits

- LAN and tunnel access use one master token, with no per-user accounts.
- The renderer adapts to phone widths, but the desktop remains the primary target.
- The Docker manager is container-centric rather than compose-centric.
- Browser tabs use `<webview>` in Electron but `<iframe>` remotely, where sites may refuse framing.
- `node-pty` native rebuilds may fail on some Windows setups.

## Guiding Principle

`Treat the runtime as a reusable service and the UI as one or more clients.`
