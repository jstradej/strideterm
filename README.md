# strIDEterm

A multi-workspace terminal hub for developers. Run shells, AI coding agents, Docker, Git, and embedded browsers side by side in one app.

![Workspace](docs/images/screenshot-workspace.png)

## Features

- **Workspaces** - organize projects into separate workspaces, each with its own terminal tabs, working directory, and settings
- **Tab Templates** - quickly add Shell, Claude Code, Codex, Gemini CLI, Dev Server, and other preset tabs
- **Embedded Browser** - open web pages directly in a tab with URL bar and navigation controls
- **Profiles** - switch between different sets of workspaces (e.g. Work, Personal, Client projects) with colored profile bar
- **Split Layouts** - view multiple terminals side by side in columns, rows, or grid
- **Git Integration** - branch info, dirty count, commit log, worktree creation, and Lazygit support
- **Docker Manager** - list containers, run actions, open shells, and stream logs
- **Remote Access** - access your workspace from any device via LAN or Cloudflare tunnel with QR code
- **Plugins** - extend functionality with plugins (Docker Ops and System Monitor built-in)
- **Light/Dark Theme** - full theme support including terminal colors and title bar
- **Drag & Drop** - reorder workspaces and tabs by dragging

## Screenshots

| Welcome Screen | Add Workspace | Create Workspace |
|---|---|---|
| ![Welcome](docs/images/screenshot-welcome.png) | ![Add](docs/images/screenshot-add-workspace.png) | ![Create](docs/images/screenshot-create-workspace.gif) |

| Notifications | Remote Access | Lazydocker |
|---|---|---|
| ![Notifications](docs/images/screenshot-notifications.png) | ![Remote](docs/images/screenshot-remote-access.png) | ![Lazydocker](docs/images/screenshot-lazydocker.png) |

## Platform Support

- Windows (NSIS installer + portable)
- macOS (DMG, x64 + arm64)
- Linux (AppImage + deb)

## Requirements

**Required:**
- Node.js 20+
- npm

**Optional:**
- `git` - for Git integration
- Docker CLI - for Docker workspaces
- `lazygit` - for Git TUI
- `cloudflared` - for Cloudflare tunnel remote access

**Native build note:** `node-pty` requires local build tools (Visual Studio Build Tools on Windows, Xcode CLT on macOS, `build-essential` + `python3` on Linux).

## Quick Start

```bash
# Install dependencies
npm install

# Development mode (hot reload)
npm run dev

# Run packaged app
npm start

# Build distributables
npm run dist
```

Platform-specific packaging:

```bash
npm run dist:win
npm run dist:mac
npm run dist:linux
```

**Windows build note:** `node-pty` native rebuild may fail locally. Production builds are handled by [GitHub Actions CI](.github/workflows/release.yml) which has the correct build environment. For local development, `npm run dev` and `npm start` work without rebuilding.

## Configuration

All state is stored in `~/.strideterm/`:

- `strideterm-state.json` - workspaces, profiles, settings, tab templates
- `plugins/` - user plugins directory

Settings are accessible via the gear icon in the sidebar (General, Tab Templates, About tabs).

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

## Plugins

Built-in plugins:
- **Docker Ops** - container management workspace
- **System Monitor** - system dashboard

User plugins: `~/.strideterm/plugins/`

See [Plugin Development Guide](docs/plugin-development.md) for details.

## Testing

```bash
npm test        # Unit tests (UI + backend)
npm run smoke   # Startup smoke test
```

## Architecture

The app is split into:
- **Electron backend** (`electron/`) - runtime, session manager, store, Docker/Git/tunnel managers
- **Renderer** (`src/`) - modular JS with Lit components for UI
- **Shared config** (`config/`) - app-wide configuration

See [Architecture](docs/architecture.md) for details.

## Contributing

```bash
npm install
npm test
```

If you change packaging, remote access, plugins, or runtime behavior, update the relevant docs.

## License

[MIT](LICENSE)
