# Development Guide

This guide is for contributors building strIDEterm from source. Most users should install a [pre-built release](https://github.com/jstradej/strideterm/releases/latest).

## Requirements

The versions below are the ranges currently supported by the project:

- Node.js 22.22.2 or later in the Node 22 series, 24.15 or later in the Node 24 series, or Node 26 or later
- npm 10 or later
- Native build tools for `node-pty`: Visual Studio Build Tools with the C++ workload on Windows; Xcode Command Line Tools on macOS; or `build-essential` and Python 3 on Linux

Install Git for source checkout and Git features. Docker CLI, `lazygit`, `cloudflared`, and supported AI coding CLIs are optional and enable their corresponding features. Each AI tool must also be signed in before you can use it from strIDEterm.

## Get the source and install dependencies

```bash
git clone https://github.com/jstradej/strideterm.git
cd strideterm
npm ci
```

`npm ci` installs the exact dependency versions recorded in the lockfile. If installation of `node-pty` fails, install the native build tools for your platform and rerun `npm ci`.

## Start the development app

### Windows

From an interactive PowerShell in the repository directory, run:

```powershell
.\dev.ps1
```

The launcher uses a separate `~/.strideterm-dev` data directory, so your development workspaces and settings do not mix with a normal installation. Use `-DataDir <path>` to choose another development data directory. Stop the development session with Ctrl+C in the same PowerShell.

### macOS and Linux

Run the app from a terminal with local development mode and a separate data directory:

```bash
STRIDETERM_ENV=local STRIDETERM_DATA_DIR="$HOME/.strideterm-dev" npm run dev
```

Stop the development session with Ctrl+C. Setting a separate data directory keeps development state apart from a normal installation.

### Local account and mobile features

The Windows launcher selects local development mode by default. It looks for the local demo Firebase client configuration in a companion `strideterm-mobile` checkout beside strIDEterm. If it is not present, the desktop app can still start and be developed normally, but account and mobile commands that need that configuration are unavailable. Passwordless sign-in also needs the companion project's local authentication emulator setup; it is not enabled by the basic desktop checkout. Do not point a local build at a production account or service.

## Checks and tests

Run these from the project directory:

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
```

`npm test` runs the UI and backend unit tests plus packaging configuration tests. `npm run test:e2e` runs the browser end-to-end suite against a mock backend. `npm run test:e2e:electron` runs the desktop Electron end-to-end suite and builds the app first. Use `npm run test:e2e:electron:visual` for visual regression checks; `npm run test:e2e:electron:update` refreshes their reference images.

## Build and package

`npm run build` type-checks and compiles the renderer and desktop application into build output; it does not create an installer. `npm start` builds and launches the app from that output outside the Vite development server; it is useful for checking packaged-mode behavior, but does not create a distributable installer. To create a distributable package, run the platform-specific command on the target operating system:

| Command              | Output                                        |
| -------------------- | --------------------------------------------- |
| `npm run dist:win`   | Windows installer and portable app            |
| `npm run dist:mac`   | macOS disk images for Intel and Apple silicon |
| `npm run dist:linux` | Linux AppImage and Debian package for x64     |

`npm run dist` packages for the current platform. Packaging requires the native build tools listed above; Windows, macOS, and Linux packages are built on their respective platforms. The first build can take several minutes while dependencies compile.

## Contributing

Run the relevant checks before opening a pull request. Keep changes focused, describe their purpose, and include any user-visible behavior or limitations. See [Contributing](../CONTRIBUTING.md) for the project's pull-request conventions.
