# Development Guide

## QA sandbox checkout

Before signed bootstrap activation, the desktop pins billing hosts for the declared `qa`
environment and `strideterm-mobile-qa` project to `strideterm.com` and
`sandbox-customer-portal.paddle.com`. An accepted bootstrap replaces this list, including
an explicitly empty list; other environments and projects receive no fallback.
The QA backend must use `https://sandbox-api.paddle.com`. After changing backend code,
restart through the QA launcher if its watcher has not restarted the desktop. Verify
that **Account → Subscribe** opens a checkout marked **Test Mode**, then use a Paddle
test card. A successful backend configuration check alone does not verify this UI flow.

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
- Sets the remote-access port to `43124` to avoid colliding with a running production instance on `43123`, and sets `STRIDETERM_LOG_LEVEL=trace` for verbose logs. `STRIDETERM_REMOTE_PORT` overrides whatever the settings file holds (it used to seed only a _new_ settings file, so on a dev build that had already run it silently did nothing and both instances fought over 43123).

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

### Which remote environment a desktop launch talks to

`STRIDETERM_ENV` — `local`, `dev`, `qa` or `prod` — is the **one** declaration of which backend this
desktop uses. It is read by the Firebase configuration, the bootstrap trust set and the sign-in
broker, so those three cannot disagree. `dev.ps1` explicitly sets it to `local` when nothing else
names one, so the normal development loop does not use a real server. Other Electron launches,
including source launches such as `npm start`, default to `prod` only when the variable is absent.
The environment default itself does not fetch configuration or contact online services. On a fresh
installation, online setup begins when the user submits a valid sign-in form; an existing registered
installation can restore online services it previously enabled.

It exists because the answer used to be inferred from `STRIDETERM_DATA_DIR`, which is a statement
about where an installation keeps its **files**. Two different questions:

- `dev.ps1` sets the data directory to keep a developer's state out of the way, and that used to
  silently declare the remote backend to be `dev` — so a desktop pointed at the qa Firebase project
  still chose the dev broker and still announced itself as environment `local`, which the qa Worker
  refuses.
- `--data-dir`, which exists so a **second production** instance can keep separate state, made that
  instance's sign-in unavailable for the same reason.

A value this build does not recognise — including the retired `staging`/`production` spellings —
blocks a **new** sign-in and says so (the refusal is `environment-unresolved`); it never falls back to
`prod`, and it never disconnects a working installation. When the variable is absent, Electron's
launch entry point sets `STRIDETERM_ENV=prod` for both packaged and source launches. A declaration
already supplied by the user or launcher is preserved. This default is never inferred from a project
id, a data directory or a Git branch.

#### Running against dev, qa or prod

On the test workstation, use the wrappers in `C:\work\strideterm-ops\dev\` for an interactive
desktop dev run against QA or production. `run-prod-desktop.ps1` selects the production Firebase
config, `STRIDETERM_ENV=prod`, an isolated `~/.strideterm-prod-dev` data directory and remote port 43126. It verifies the named config belongs to `strideterm-mobile-prod` before launching:

```powershell
& C:\work\strideterm-ops\dev\run-prod-desktop.ps1
```

This launcher exercises the desktop client only. The production Firebase Functions and operator
identity must be deployed and verified separately before production sign-in or pairing can succeed.

`STRIDETERM_ENV=dev` (or `qa`, or `prod`) on its own is **not** a complete configuration for that
tier, and the launcher refuses it. The declaration chooses the broker (`https://auth-dev.strideterm.com`,
`https://auth-qa.strideterm.com` or `https://auth.strideterm.com`) and the bootstrap trust set; the
Firebase **project, Web API key and database** are three more values, and `dev.ps1`'s auto-import —
the sibling `strideterm-mobile/app/android/app/src/local/google-services.json` — is for `local` alone,
and it is a committed synthetic `demo-` fixture with no real project or secret in it. Outside `local`
the launcher imports nothing it was not told to, and stops before Electron starts if the three values
are not supplied.

This paragraph describes the **development launcher**. A packaged production desktop is expected to
obtain those public client values from a signed bootstrap before pairing; see
[Production mobile bootstrap](production-bootstrap.md). The release gate refuses a build while the
production bootstrap URL, public trust keys, or hosted envelope are missing.

The complete procedure, in a **fresh console** (nothing from configuration A below may still be set):

```powershell
# The target tier's own google-services.json, downloaded from the Firebase console for that project.
# It is NOT checked in for dev/qa/prod — app/android/app/src/{dev,qa}/ carry none — so name it.
$env:STRIDETERM_ENV = "qa"
.\dev.ps1 -DataDir "$env:USERPROFILE\.strideterm-qa" -MobileFirebaseConfigPath "C:\secrets\strideterm-qa\google-services.json"
```

The downloaded Android file may omit `project_info.firebase_url`. In that case the desktop derives
the default Realtime Database URL from the project ID, as the mobile app does. A non-default database
instance still needs an explicit `STRIDETERM_MOBILE_FIREBASE_DATABASE_URL`.

Or set the three variables yourself instead of naming the file (`STRIDETERM_MOBILE_FIREBASE_PROJECT_ID`,
`STRIDETERM_MOBILE_FIREBASE_API_KEY`, `STRIDETERM_MOBILE_FIREBASE_DATABASE_URL`, all three, all from
the target project). Either way:

- **They have to be that tier's project's values.** `GET /c` no longer compares the link's `apiKey`
  against anything (security review 2026-09-13, I2) — a client key never proved which project minted
  a code, and the Worker no longer reads `AUTHLINK_FIREBASE_PROJECT_ID`/`AUTHLINK_FIREBASE_API_KEY` at
  all. What actually establishes project identity is the desktop's own allowlisted action-handler
  check (`parseSignInLink`, `authlink-config.ts`) plus Firebase's own redemption of the `oobCode`
  against the pinned project: a desktop configured for the wrong tier's project has its code refused
  by Firebase when it tries to redeem it, not by the broker comparing keys. Configure the three
  values from the target project's own `google-services.json` regardless — a mismatch still fails,
  just later and from Firebase rather than from a broker-side key comparison.
- **No emulator variable, no plain-HTTP database URL.** `FIREBASE_AUTH_EMULATOR_HOST`,
  `FIREBASE_DATABASE_EMULATOR_HOST`, `FIREBASE_FUNCTIONS_EMULATOR_HOST` and an
  `http://` `STRIDETERM_MOBILE_FIREBASE_DATABASE_URL` are honoured **only** in a `local` build. Outside
  one they are not ignored — they are a **contradiction**, and the whole Firebase configuration is
  refused: Settings → Account says `environment-contradiction`, no sign-in can start, and the
  process talks to no backend at all rather than to a mixture (the old behaviour dropped the
  emulator hosts and kept the emulator's database URL, so a "qa" desktop wrote to a loopback
  database while its identity calls went to the cloud). The fix is one line: unset them, or declare
  `local`.
- **Nothing is inferred from the project's name.** A recovery can restore a tier into a project called
  anything; the declaration and the explicit values are the only inputs, which is why the launcher asks
  for them rather than guessing from `-qa` in an id.

`electron/backend/mobile/dev-script-firebase-import.test.ts` runs the launcher's import function
against these documented commands — a clean qa console, the named file, and the two contradictions —
and fails if the document and the launcher drift apart.

The dev, qa and prod **broker origins are fixed in the build** (`authlink-config.ts`) and cannot be
pointed elsewhere by anything in the environment.

### Exercising passwordless sign-in in a local build

A `local` build has **no sign-in broker until you name one**, and that is deliberate rather than an
oversight: defaulting it to `https://auth.strideterm.com` is how a test address ends up in a real
account. Without a broker origin, Settings → Account reports that sign-in is unavailable, says which
of the reasons it is, and nothing else is affected — an already-enrolled desktop keeps its
installation credential, its pairings and its device list.

**There is one configuration exercisable from this desktop today.** Its exact steps live in the cloud
repository, beside the Worker whose configuration they pin, and a CI check keeps them honest:

> **`docs/PASSWORDLESS-LOCAL-TESTING.md`** in `C:/work/strideterm-mobile`, verified by
> `npm run check:authlink-local-config` there.

**A — emulator only.** The Auth, database and Functions emulators, all on `127.0.0.1`, plus the
Worker's own `wrangler dev --local` defaults. Nothing leaves the machine and no message is delivered
anywhere: the emulator prints the link. The origin is **`http://127.0.0.1:8788`**, because `POST /c`
compares the browser's `Origin` against the Worker's `AUTHLINK_ORIGIN` byte for byte and that file's
default says `127.0.0.1`. **All three `STRIDETERM_MOBILE_FIREBASE_*` variables have to be assigned**,
and that is what the procedure there does: `dev.ps1` imports every one it finds unset from the
committed `local` demo `google-services.json` fixture, so an omission is not a default but the demo
project's own value — a fake project id and key with no live quota behind them. The launcher refuses
to import a _different_ project's key or database URL at all, and warns; the assignments are what
make the configuration complete.

```powershell
# STRIDETERM_ENV defaults to "local"; the broker origin still has to be named explicitly (F11 — a
# local build is not defaulted to a broker either, only the ONE loopback address a real one may be).
$env:STRIDETERM_MOBILE_AUTHLINK_ORIGIN = "http://127.0.0.1:8788"
.\dev.ps1
```

**A local build is the whole Emulator Suite on this machine, or no Firebase configuration at all**
(follow-up 2026-09-11, item 1; `electron/backend/mobile/mobile-firebase-config.ts`):

- **All three emulator variables are required** — `FIREBASE_AUTH_EMULATOR_HOST`,
  `FIREBASE_DATABASE_EMULATOR_HOST` and `FIREBASE_FUNCTIONS_EMULATOR_HOST`. A `local` build with two of
  them set used to send the third service's calls to Google (`identitytoolkit.googleapis.com` for a
  missing Auth host, `cloudfunctions.net` for a missing Functions host). Now a missing one is reported
  as _not configured_, naming exactly that variable, and nothing is built: there is no cloud fallback
  for `local`.
- **Every host is validated as a loopback `host:port`.** `127.0.0.1`, `localhost` and `[::1]` with a
  port in 1–65535, an optional `http://` and trailing slash tolerated. A LAN address is not this
  machine; `127.0.0.1.evil.example` and `localhost.example` are lookalikes, not loopback; `https://`,
  credentials, a path or a query in the value are refused. The refusal is
  `local-endpoint-invalid` (Settings → Account says so), and it names the variable, never its value.
- **An explicit `STRIDETERM_MOBILE_FIREBASE_DATABASE_URL` may only be the database emulator's own URL
  for the declared demo project** — `http://<FIREBASE_DATABASE_EMULATOR_HOST>?ns=<project>-default-rtdb`
  — or unset, in which case it is derived. A cloud `firebasedatabase.app` URL inherited from a
  `google-services.json`, a different host or port, or another project's namespace is the same
  `local-endpoint-invalid` refusal.
- **A `demo-` project id outside `local` is an `environment-contradiction`**, for the mirror-image
  reason: a demo project exists in no cloud, so a `dev`/`qa`/`prod` declaration naming one has no
  endpoint that could answer, and deriving cloud URLs for it — which the old resolver did — could only
  send requests off the machine for a project that lives only on one.

**There is no configuration B against a real project any more, and that is deliberate rather than a
gap.** The real dev Firebase project reached through a LOCALLY run authlink Worker — what this section
used to call configuration B — is exactly the combination plan §2.1 rules out: `dev` now means a
personal test against `https://auth-dev.strideterm.com`, a REMOTE broker, and pointing a
`local`-declared desktop at the real dev project's data through a locally-run Worker would need its
own, separately-described diagnostic mode and its own HTTP policy — v2 does not introduce one. Until
`dev` is activated (plan §7 — the Worker deployed, the project provisioned, the Authorized domain set),
there is no way to exercise a real e-mail end to end from this desktop: `STRIDETERM_ENV=dev` with no
reachable `https://auth-dev.strideterm.com` fails at `/start` rather than falling back to anything
local.

Configuration A does not need the broker running at all: with nothing listening the attempt falls back
to **manual-only**, the emulator's line still carries the link, and "Paste the link from the email"
finishes it. **Copy the link's address, not the words.** The message's plain-text part carries the
anchor's text and no URL at all (measured — `docs/PASSWORDLESS-PHASE0.md` row 31), so selecting what
you can see and pasting it gets you `invalid-code`; right-click the "Sign in to …" link and copy the
address.

**The manual pass itself — the concrete steps and the result each should produce — is
[`docs/PASSWORDLESS-MANUAL-TESTS.md`](PASSWORDLESS-MANUAL-TESTS.md).**

**Configuration A does not support finishing the sign-in from a phone**, and not because of a missing
feature: `127.0.0.1`/`localhost` on a phone is _the phone_. That route needs a reachable HTTPS origin,
the same origin on both sides, and that origin's host in Firebase's Authorized domains — so it waits
for a deployment rather than being approximated locally. Do not point a local build at the prod broker
to get an HTTPS origin.

A dev, qa or prod build ignores `STRIDETERM_MOBILE_AUTHLINK_ORIGIN` entirely; it is not a way to point
a real build at another broker.

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
