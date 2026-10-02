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

The preferred way on Windows is `dev.ps1` in the project root, from an interactive PowerShell:

```powershell
.\dev.ps1
```

It:

- uses an isolated data directory, `~/.strideterm-dev` (`-DataDir` overrides it), so a dev build runs beside a production install without sharing state, credentials, logs or the single-instance lock;
- frees port 1420, clears the Electron disk cache, and starts the Vite dev server, the backend and preload `tsc --watch`, and a `vite build --watch` that keeps `dist/` (served to remote/mobile clients) fresh;
- restarts Electron when the backend recompiles (`-NoAutoRestart` turns that off) and restarts Vite if it crashes;
- uses remote-access port `43124` (production uses `43123`) and `STRIDETERM_LOG_LEVEL=trace`.

Without `dev.ps1` (non-Windows, or manual control):

```bash
# Free port 1420 if a previous session left something behind:
#   macOS / Linux: lsof -ti:1420 | xargs -r kill -9
#   Windows:       taskkill //F //IM electron.exe; taskkill //F //IM node.exe

npm run dev:web &        # wait until it prints "ready in ..."
npm run dev:backend &
npm run dev:preload &
sleep 3 && npm run dev:electron &
```

Avoid `npm run dev` from a non-interactive shell — `concurrently -k` kills all four processes when any one exits.

### Which remote environment a desktop launch talks to

`STRIDETERM_ENV` — `local`, `dev`, `qa` or `prod` — is the **one** declaration of which backend a
desktop uses. The Firebase configuration, the bootstrap trust set and the sign-in broker all read
it, so they cannot disagree.

- `dev.ps1` sets `local` unless something else is declared, so the normal development loop uses no
  real server.
- Any other launch, packaged or from source, is `prod` when the variable is absent. A value already
  set by the user or a launcher is kept.
- It is never inferred from the data directory, a project id or a Git branch. The data directory says
  where an installation keeps its files, nothing more — which is also why a second production
  instance with `--data-dir` signs in normally.
- An unrecognised value (including the retired `staging` / `production`) blocks a **new** sign-in
  with `environment-unresolved`. It never falls back to `prod` and never disconnects a working
  installation.

Declaring the environment does not contact anything by itself. On a fresh installation online setup
starts when the user submits a valid sign-in form.

#### Running against dev, qa or prod

`STRIDETERM_ENV` alone is not a complete configuration for a deployed tier. It picks the broker and
the bootstrap trust set; the Firebase **project id, Web API key and database URL** are three more
values, and they must come from that tier's own project. `dev.ps1` auto-imports only the committed
synthetic `local` demo `google-services.json` from the sibling `strideterm-mobile` repository; for
any other tier it imports only what it is told to and stops before Electron starts if the three
values are missing. Private ops wrappers for interactive QA/prod desktop runs live outside this
repository.

Start from a **fresh console** (nothing from the local configuration below may still be set) and
name the tier's `google-services.json`, downloaded from that project's Firebase console:

```powershell
$env:STRIDETERM_ENV = "qa"
.\dev.ps1 -DataDir "$env:USERPROFILE\.strideterm-qa" -MobileFirebaseConfigPath "<path to the qa project's google-services.json>"
```

Or set the three variables yourself instead of naming the file:
`STRIDETERM_MOBILE_FIREBASE_PROJECT_ID`, `STRIDETERM_MOBILE_FIREBASE_API_KEY`,
`STRIDETERM_MOBILE_FIREBASE_DATABASE_URL`. If the file has no `project_info.firebase_url`, the default
Realtime Database URL is derived from the project id; a non-default instance needs the URL set
explicitly.

Rules for a deployed tier:

- **The values must be that tier's project.** A desktop configured with another project's values
  fails when Firebase refuses to redeem the sign-in code.
- **No emulator variable and no `http://` database URL.** `FIREBASE_AUTH_EMULATOR_HOST`,
  `FIREBASE_DATABASE_EMULATOR_HOST`, `FIREBASE_FUNCTIONS_EMULATOR_HOST` and a plain-HTTP database URL
  are honoured only in `local`. Elsewhere they are a contradiction: the whole Firebase configuration
  is refused (`environment-contradiction`) and the process talks to no backend rather than to a
  mixture. Unset them, or declare `local`.
- **A `demo-` project id outside `local`** is the same contradiction — a demo project exists in no
  cloud.
- **The dev, qa and prod broker origins are fixed in the build** (`authlink-config.ts`). Nothing in
  the environment points a deployed tier at another broker.

A packaged production desktop gets its public client values from a signed bootstrap instead; see
[Production desktop bootstrap](production-bootstrap.md).

`electron/backend/mobile/dev-script-firebase-import.test.ts` runs the launcher against the command
above, so the document and the launcher cannot drift apart.

#### QA checkout (Paddle sandbox)

Until a signed bootstrap provides them, a `qa` desktop on the `strideterm-mobile-qa` project allows
the checkout hosts `strideterm.com` and `sandbox-customer-portal.paddle.com`; an accepted bootstrap
replaces that list. The QA backend must use `https://sandbox-api.paddle.com`. To verify, **Account →
Subscribe** must open a checkout marked **Test Mode**; pay with a Paddle test card. A passing backend
configuration check alone does not prove this flow.

### Exercising passwordless sign-in in a local build

A `local` build has **no sign-in broker until you name one**. Defaulting it to the production broker
is how a test address ends up in a real account. Without one, Settings → Account says sign-in is
unavailable and why; an enrolled desktop keeps its credential, pairings and device list.

The one local configuration is **emulator only**: the Auth, Database and Functions emulators on
`127.0.0.1`, plus the broker Worker's `wrangler dev --local` defaults. Nothing leaves the machine and
no message is delivered — the emulator prints the link. Its setup steps live beside the Worker in the
sibling `strideterm-mobile` repository (`docs/PASSWORDLESS-LOCAL-TESTING.md`, checked there by
`npm run check:authlink-local-config`).

```powershell
# STRIDETERM_ENV defaults to "local" in dev.ps1; the broker origin must still be named.
$env:STRIDETERM_MOBILE_AUTHLINK_ORIGIN = "http://127.0.0.1:8788"
.\dev.ps1
```

The origin is `127.0.0.1`, not `localhost`, because the Worker compares the browser's `Origin`
byte for byte against its configured one.

A local build is **the whole Emulator Suite on this machine, or no Firebase configuration at all**:

- All three emulator variables are required. A missing one is reported as not configured, naming
  the variable; there is no cloud fallback for a single service.
- Every host must be a loopback `host:port` (`127.0.0.1`, `localhost`, `[::1]`). LAN addresses,
  lookalikes such as `localhost.example`, `https://`, credentials, paths and queries are refused as
  `local-endpoint-invalid`, which names the variable, never its value.
- An explicit `STRIDETERM_MOBILE_FIREBASE_DATABASE_URL` may only be the database emulator's own URL
  for the demo project (`http://<FIREBASE_DATABASE_EMULATOR_HOST>?ns=<project>-default-rtdb`), or
  unset so it is derived.
- `dev.ps1` fills unset `STRIDETERM_MOBILE_FIREBASE_*` values from the committed `local` demo
  fixture and refuses to import a different project's key or database URL.

The broker does not have to run: with nothing listening the attempt falls back to manual-only and
"Paste the link from the email" finishes it. **Copy the link's address, not its text** — the
plain-text part of the message carries the anchor's words and no URL, so pasting what you see gives
`invalid-code`.

Finishing the sign-in on a phone does not work locally: `127.0.0.1` on a phone is the phone. It needs
a reachable HTTPS origin listed in Firebase's Authorized domains, i.e. a deployed tier.
Do not point a local build at the prod broker to get an HTTPS origin. A deployed tier ignores
`STRIDETERM_MOBILE_AUTHLINK_ORIGIN` entirely.

The manual test pass is [`PASSWORDLESS-MANUAL-TESTS.md`](PASSWORDLESS-MANUAL-TESTS.md).

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

- **Headless runtime** (`electron/backend/`) — pure TypeScript, no Electron dependency. Owns PTYs, state and the Git/Docker/Azure DevOps/GitHub managers, and serves the same API to the Electron IPC layer and the remote HTTP/WS server.
- **Electron adapter** (`electron/main.ts`, `electron/preload.cts`) — thin shell: windows, native attention, per-window IPC routing, the data-directory lock.
- **Vue renderer** (`src/`) — Vue 3 + Pinia. `transport.ts` hides whether it talks over Electron IPC or remote HTTP/WS.

See [architecture.md](architecture.md) for the principles behind it.

## Plugin development

Built-in plugins live in `plugins/`; user plugins live in `~/.strideterm/plugins/`. See [plugin-development.md](plugin-development.md).

## Pull requests

- Branch from `master`
- `npm run lint` and `npm run typecheck` must pass with 0 errors
- `npm run test` and `npm run test:e2e` must pass
- Describe what changed and why in the PR body
