# strIDEterm

**strIDEterm** organizes your shells, AI coding agents, code reviews, Docker, and Git into workspaces you can access from anywhere — no more chaos across terminals, just focused work.

![Workspace](docs/images/screenshot-workspace.png)

## Features

- **Workspaces** - organize projects into separate workspaces, each with its own terminal tabs, working directory, and settings
- **Tab Templates** - quickly add Shell, Claude Code, Codex, Gemini CLI, GitHub Copilot, Dev Server, Files, and other preset tabs
- **File Manager** - browse, preview, and edit files with an expandable tree, resizable panels, and right-click context menu (copy, rename, delete)
- **Embedded Browser** - open web pages directly in a tab with URL bar and navigation controls
- **Profiles** - switch between different sets of workspaces (e.g. Work, Personal, Client projects) with colored profile bar
- **Split Layouts** - arrange terminals in columns, rows, or a grid — see everything at once without switching tabs
- **Git Integration** - branch info, dirty count, commit log, worktree creation, and Lazygit support
- **Multi-repo Workspaces** - group sibling repositories (e.g. microservices) under one workspace via `gitRoots`; Git pane shows a repo switcher above the tabs, and a dedicated Bulk sub-tab runs Fetch all / Pull all (ff-only) across every repo with per-row status. Single-repo behavior is unchanged when `gitRoots` is empty or has a single entry.
- **Azure DevOps PR Review** - pull request inbox grouped by repo, managed review workspaces, AI agent integration (review + fix code), push & publish workflow, and MCP bridge — see [docs](docs/azure-devops-review.md)
- **GitHub PR Review** - pull request inbox, managed review workspaces with local checkout, comment and review submission (Approve / Request Changes / Comment), push & publish workflow, and MCP bridge for AI agents — see [docs](docs/github-pr-review.md)
- **Agent Task Runner** - supervised coding loop with Worker + Judge agents (Claude Code, Codex CLI, Gemini CLI, or GitHub Copilot for either role): auto-detects project verification commands, runs deterministic checks between rounds, git-aware judge evaluation, periodic context refresh (shower mode), and a Dashboard UI for monitoring progress — see [docs](docs/agent-task-runner.md)
- **Docker Manager** - list containers, run actions, open shells, and stream logs
- **SSH Support** - connect to remote machines from a saved host book or ad-hoc, with built-in key manager, host key TOFU verification, `~/.ssh/config` import, SSH agent support, jump hosts, and three launch modes (built-in, system `ssh`, or WSL) — see [docs](docs/ssh.md)
- **Remote Access** - access your workspace from any device via LAN or Cloudflare tunnel with QR code
- **Telegram Bot** - forward strIDEterm alerts to a Telegram chat and reply / tap inline buttons to drive the app from your phone — start a task, pause / resume agents, capture screenshots, fetch task files, open a PR review, grab the remote-access URL via `/tunnel`, all over Telegram's long-polling API (no webhook, no public tunnel) — see [docs](docs/telegram.md)
- **Plugins** - extend functionality with plugins (Docker Ops and System Monitor built-in)
- **Finish Notifications** - know when a command or agent finishes without watching the screen:
  - Audio ding when focused, system notification when in background
  - OSC 133 shell integration (auto-injected for bash/zsh/PowerShell) for instant detection
  - Silence-based heuristics for AI agents with configurable timing
  - Optional notification hooks for [Claude Code](https://docs.anthropic.com/en/docs/claude-code/hooks), [Gemini CLI](https://geminicli.com/docs/hooks/), [Codex CLI](https://developers.openai.com/codex/hooks), and GitHub Copilot CLI — one click in Settings enables instant idle/waiting alerts. Codex requires v0.121.0+ on Windows; Copilot requires v1.0.32+.
  - Tunable per user via settings or environment variables
- **Keyboard Shortcuts** - navigate workspaces, tabs, and layouts entirely from the keyboard for a fast, mouse-free workflow
- **Light/Dark Theme** - full theme support including terminal colors and title bar
- **Drag & Drop** - reorder workspaces and tabs by dragging
- **Mobile-Responsive Remote UI** - the web client served by the remote-access server adapts to phone-width viewports: the workspace sidebar, Git pane chrome, Azure DevOps / GitHub PR inbox and review panes, and per-tab actions all collapse into popovers and full-width controls so you can drive a workspace from a phone over LAN or a Cloudflare tunnel

## Screenshots

| Welcome Screen                                 | Add Workspace                                    | Create Workspace                                       |
| ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| ![Welcome](docs/images/screenshot-welcome.png) | ![Add](docs/images/screenshot-add-workspace.png) | ![Create](docs/images/screenshot-create-workspace.gif) |

| Notifications                                              | Remote Access                                       | Lazydocker                                           |
| ---------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| ![Notifications](docs/images/screenshot-notifications.png) | ![Remote](docs/images/screenshot-remote-access.png) | ![Lazydocker](docs/images/screenshot-lazydocker.png) |

## Installation

**[Download the latest release](https://github.com/jstradej/strideterm/releases/latest)** — pre-built installers are available for all major platforms:

| Platform | Format                                           |
| -------- | ------------------------------------------------ |
| Windows  | NSIS installer (`.exe`) + portable               |
| macOS    | DMG (`.dmg`) — x64 and arm64                     |
| Linux    | AppImage (`.AppImage`) + Debian package (`.deb`) |

Nightly builds from the latest `master` are also published on the [Releases page](https://github.com/jstradej/strideterm/releases).

> **Code signing:** the Windows installer is code-signed. macOS DMGs and Linux artifacts are not currently signed/notarized — on first launch macOS Gatekeeper will require **System Settings → Privacy & Security → Open Anyway** (or `xattr -dr com.apple.quarantine strIDEterm.app`), and Linux package managers may warn about the unsigned `.deb`.

### Quick install

The snippets below resolve the latest release tag from the GitHub API and download the matching artifact. They produce the same installers as clicking the buttons above.

<details>
<summary><b>Linux — AppImage</b> (universal)</summary>

```bash
VER=$(curl -fsSL https://api.github.com/repos/jstradej/strideterm/releases/latest | grep -m1 '"tag_name":' | cut -d'"' -f4 | sed 's/^v//')
curl -fL -o strIDEterm.AppImage \
  "https://github.com/jstradej/strideterm/releases/latest/download/strIDEterm-${VER}.AppImage"
chmod +x strIDEterm.AppImage
./strIDEterm.AppImage
```

AppImage requires FUSE. On Ubuntu 24.04+ install `libfuse2t64`, on older Debian/Ubuntu install `libfuse2`. To skip FUSE entirely, launch with `./strIDEterm.AppImage --appimage-extract-and-run`.

</details>

<details>
<summary><b>Linux — Debian / Ubuntu</b> (`.deb`)</summary>

```bash
VER=$(curl -fsSL https://api.github.com/repos/jstradej/strideterm/releases/latest | grep -m1 '"tag_name":' | cut -d'"' -f4 | sed 's/^v//')
curl -fL -o /tmp/strideterm.deb \
  "https://github.com/jstradej/strideterm/releases/latest/download/strideterm_${VER}_amd64.deb"
sudo apt install /tmp/strideterm.deb
strideterm
```

</details>

<details>
<summary><b>macOS — Apple Silicon (arm64)</b></summary>

```bash
VER=$(curl -fsSL https://api.github.com/repos/jstradej/strideterm/releases/latest | grep -m1 '"tag_name":' | cut -d'"' -f4 | sed 's/^v//')
curl -fL -o strIDEterm.dmg \
  "https://github.com/jstradej/strideterm/releases/latest/download/strIDEterm-${VER}-arm64.dmg"
open strIDEterm.dmg
```

</details>

<details>
<summary><b>macOS — Intel (x64)</b></summary>

```bash
VER=$(curl -fsSL https://api.github.com/repos/jstradej/strideterm/releases/latest | grep -m1 '"tag_name":' | cut -d'"' -f4 | sed 's/^v//')
curl -fL -o strIDEterm.dmg \
  "https://github.com/jstradej/strideterm/releases/latest/download/strIDEterm-${VER}.dmg"
open strIDEterm.dmg
```

</details>

<details>
<summary><b>Windows — installer</b> (PowerShell)</summary>

```powershell
$ver = (Invoke-RestMethod https://api.github.com/repos/jstradej/strideterm/releases/latest).tag_name.TrimStart('v')
Invoke-WebRequest -Uri "https://github.com/jstradej/strideterm/releases/latest/download/strIDEterm-Setup-$ver.exe" -OutFile strIDEterm-Setup.exe
Start-Process .\strIDEterm-Setup.exe
```

</details>

<details>
<summary><b>Windows — portable</b> (PowerShell)</summary>

```powershell
$ver = (Invoke-RestMethod https://api.github.com/repos/jstradej/strideterm/releases/latest).tag_name.TrimStart('v')
Invoke-WebRequest -Uri "https://github.com/jstradej/strideterm/releases/latest/download/strIDEterm-$ver-win-x64.exe" -OutFile strIDEterm.exe
.\strIDEterm.exe
```

</details>

Building from source is for contributors — see the [Development Guide](docs/development.md).

## Configuration

All state is stored in `~/.strideterm/`:

- `strideterm-state.json` - workspaces, profiles, settings, tab templates
- `logs/` - structured application logs (winston, configurable level)
- `plugins/` - user plugins directory

Settings are accessible via the gear icon in the sidebar (General, Tab Templates, About tabs). strIDEterm checks for updates on startup and shows available releases in the About tab.

### Multiple Instances (Custom Data Directory)

You can run multiple strIDEterm instances side by side (e.g. a packaged EXE and a dev build) by giving each its own data directory:

```bash
# Packaged app
strideterm.exe --data-dir C:\Users\me\.strideterm-dev

# Dev mode
STRIDETERM_DATA_DIR=~/.strideterm-dev npm run dev:electron

# Or pass it directly to Electron
npx electron . --data-dir ~/.strideterm-dev
```

Each data directory gets its own state file, logs, credentials, and single-instance lock. The window title shows the directory name as a suffix so you can tell instances apart. `--data-dir` takes precedence over the `STRIDETERM_DATA_DIR` environment variable.

### Terminal Renderer (WebGL)

The terminal pane uses a WebGL renderer by default — it draws the whole viewport in a single GPU call, which keeps scrolling smooth under heavy TUI traffic (Claude Code, htop, tig, lazygit, etc.). On startup strIDEterm probes WebGL2 support: it creates a test context with `failIfMajorPerformanceCaveat`, blacklists known software rasterizers (SwiftShader, llvmpipe, Microsoft Basic Render), and compiles a trivial shader. If any step fails, the terminal silently falls back to the built-in DOM renderer. Every probe result and load attempt is written to `logs/strideterm.log` under the `[renderer]` label so you can see why a fallback happened.

If WebGL renders incorrectly on your device (giant glyphs, blank canvas, or visual glitches — occasionally observed on older Macs and certain Intel iGPUs) you can force the DOM renderer:

```bash
# Per-launch (CLI flag — wins over the env var)
strideterm --no-webgl

# Globally (environment variable)
STRIDETERM_DISABLE_WEBGL=1 strideterm
```

`--no-webgl` is the recommended fix when only one machine is affected — add it to your shortcut, `.desktop` file, or launch command. The env var is convenient when you want the same behavior across every shell and shortcut on a host. Both are independent of remote-access clients (web/mobile), where WebGL is always disabled because mobile WebGL is too unreliable to validate.

## Remote Access

strIDEterm can expose the workspace over HTTP/WebSocket to another device.

```bash
# Default: accessible on LAN
npm start

# Desktop-only (no LAN access)
STRIDETERM_REMOTE_HOST=127.0.0.1 npm start
```

From another device: `http://<your-lan-ip>:43123/?token=<token>`

**Security:** treat the remote token like a password. Use LAN mode only on trusted networks.

## Telegram Bot

strIDEterm can forward workspace alerts to a Telegram chat and let you reply to act on them — start a task, pause / resume agents, capture screenshots, fetch task files, open a PR review. The whole feature uses Telegram's `getUpdates` long-polling API, so the strIDEterm machine only needs outbound HTTPS to `api.telegram.org` (no public webhook, no Cloudflare tunnel).

1. Talk to **[@BotFather](https://t.me/BotFather)** in Telegram → `/newbot` → copy the token
2. Send `/start` to your new bot from your account
3. Open **Settings → Telegram**, paste the token, click **Detect** to find the chat, save

The Telegram tab in the notification panel shows each connection's status, poll interval, and forward filter at a glance, with a one-click **Configure** shortcut. From the bot, `/menu` is the recommended entry point on mobile — it gives one-tap access to status, new task, screenshot, workspaces, and help.

The bot token is stored encrypted via the OS keychain, the chat-ID allowlist is enforced on every incoming update, and the Get-file flow refuses paths that resolve outside the task workspace's `cwd`. See [Telegram docs](docs/telegram.md) for the full feature reference, security model, and technical overview.

## Agent Task Runner

strIDEterm can run a supervised coding loop where a **Worker** agent implements your task while a **Judge** agent independently verifies the results. Worker and Judge can each be **Claude Code**, **Codex CLI**, **Gemini CLI**, or **GitHub Copilot** — mix and match (e.g. Claude worker + Copilot judge). Between rounds, the runner executes deterministic checks (tests, lint, build) and uses git diffs to give the judge full context.

1. Create a task workspace from the sidebar context menu
2. Pick the Worker and Judge providers and models (or use a custom CLI command)
3. Describe what you want built — verification commands are auto-detected from your project
4. Press Start — the Worker codes, checks run, the Judge reviews, repeat until done

Key features: auto-detected verify commands, TODO/WORK_LOCK file protocol, periodic context refresh (shower mode) for long tasks, and a Dashboard tab showing round-by-round progress with check results and judge feedback.

Requires at least one of [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`), [Codex CLI](https://developers.openai.com/codex/cli) (`codex`), [Gemini CLI](https://geminicli.com/) (`gemini`), [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) (`copilot`), or [OpenCode](https://opencode.ai/) (`opencode`) on your PATH. See [Agent Task Runner docs](docs/agent-task-runner.md) for full details.

## Agent Notification Hooks

strIDEterm integrates with each supported agent CLI's hook system so you get instant alerts when an agent finishes a turn or needs input — no polling, no silence timers. One-click setup per provider in **Settings → Notifications**:

| Provider       | Config location                                                                            | Events registered                                  | Notes                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | `~/.claude/settings.json`                                                                  | Notification, Stop, SubagentStop, UserPromptSubmit | Widest event coverage                                                                                                                                               |
| Gemini CLI     | `~/.gemini/settings.json`                                                                  | AfterAgent, Notification, BeforeAgent              | Event names auto-mapped to Claude aliases                                                                                                                           |
| Codex CLI      | `~/.codex/hooks.json` + `[features] hooks = true` in `~/.codex/config.toml`                | Stop, UserPromptSubmit                             | Requires Codex CLI **0.121.0+** on Windows ([PR #17268](https://github.com/openai/codex/pull/17268)); first run may require approving strIDEterm hooks via `/hooks` |
| GitHub Copilot | `~/.copilot/config.json` (top-level `hooks` key)                                           | sessionEnd, userPromptSubmitted                    | Requires Copilot CLI **1.0.32+**. Respects `COPILOT_HOME` env var override                                                                                          |
| OpenCode       | `~/.config/opencode/config.json` (Linux/macOS), `%AppData%\opencode\config.json` (Windows) | Stop, UserPromptSubmit                             | Respects `OPENCODE_HOME` env var override                                                                                                                           |

All providers share a single notification script (`~/.strideterm/hooks/notify.mjs`) that posts events to a local HTTP endpoint embedded in strIDEterm. The script is written automatically on startup, so you never need to edit it by hand. Settings also exposes a **Test hook** button that runs an end-to-end probe and reports delivery latency.

**Without hooks** the Task Runner falls back to a silence-based heuristic (8 s default) for all four providers. OSC 133 shell integration only fires when a _shell_ returns to its prompt, so for interactive agent sessions (which never return to a prompt between turns) it doesn't help — hooks carry the primary signal. Hooks are optional but strongly recommended for long Judge reasoning passes where silence timers add up. Codex may also show _"hooks need review"_ after configuration; open `/hooks` in Codex and approve the two strIDEterm entries once.

**Copilot note:** if the user has `disableAllHooks: true` set in `~/.copilot/config.json` (Copilot's global kill-switch), Settings shows a distinct _"Configured — hooks disabled"_ badge so you know installed entries won't fire until you clear the flag.

## Plugins

Built-in plugins (under `plugins/`):

- **Azure DevOps** — workspace template for the Azure DevOps PR inbox
- **GitHub** — workspace template for the GitHub PR inbox
- **Docker Ops** — container management workspace
- **System Monitor** — system dashboard

User plugins: `~/.strideterm/plugins/`

See [Plugin Development Guide](docs/plugin-development.md) for details.

## Development

Building from source, running tests, and the project architecture are documented separately so this README stays focused on using the app:

- [Development Guide](docs/development.md) — requirements, dev startup, build & test commands, packaging notes
- [Architecture](docs/architecture.md) — runtime/adapter/renderer breakdown and key patterns
- [Contributing](CONTRIBUTING.md) — commit and PR conventions

## License

[MIT](LICENSE)
