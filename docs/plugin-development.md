# Plugin Development Guide

This guide explains how to create plugins for strIDEterm. **Plugins are currently manifest-only**: a plugin declares a workspace template and metadata, and the loader executes no plugin code. A runtime entry point (`activate(...)`) is reserved in the manifest but not wired into the loader.

## Quick Start

```bash
# 1. Create the plugin directory
mkdir -p ~/.strideterm/plugins/my-plugin

# 2. Create the manifest
cat > ~/.strideterm/plugins/my-plugin/plugin.json << 'EOF'
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "A short description of what this plugin does.",
  "author": "Your Name",
  "license": "MIT",
  "icon": "MP",
  "color": "#ff6600",
  "kind": "terminal",
  "capabilities": ["terminal:create-panel"],
  "workspaceDefaults": {
    "name": "My Plugin Workspace",
    "icon": "MP",
    "color": "#ff6600",
    "kind": "terminal",
    "notes": "Created by My Plugin.",
    "panels": [
      {
        "id": "main",
        "title": "Main",
        "command": "echo 'Hello from my plugin!'",
        "shell": true,
        "startup": "default"
      }
    ]
  }
}
EOF

# 3. Restart strIDEterm
```

The plugin appears in the plugin list if its manifest validates; a manifest that fails validation is not loaded.

## Plugin Locations

| Location                         | Type           | Priority      |
| -------------------------------- | -------------- | ------------- |
| `plugins/` inside the app bundle | Built-in       | Loaded first  |
| `~/.strideterm/plugins/`         | User-installed | Loaded second |

Every direct subdirectory containing a `plugin.json` is a plugin; discovery is not recursive. If a user plugin has the same `id` as a built-in one, the built-in wins.

```text
~/.strideterm/plugins/my-plugin/
|- plugin.json
|- README.md
`- assets/
```

Only `plugin.json` is required. See `plugins/system-monitor/` for a real example.

## Manifest Reference

### Required Fields

| Field     | Type     | Description                                                      |
| --------- | -------- | ---------------------------------------------------------------- |
| `id`      | `string` | Lowercase alphanumeric with `-` or `_`. Pattern: `^[a-z0-9_-]+$` |
| `name`    | `string` | Human-readable display name                                      |
| `version` | `string` | Semantic version string                                          |

### Optional Fields

| Field                 | Type       | Default      | Description                                                                                                                      |
| --------------------- | ---------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `description`         | `string`   | `""`         | Short description shown in the UI                                                                                                |
| `author`              | `string`   | `""`         | Plugin author name                                                                                                               |
| `license`             | `string`   | `""`         | License identifier such as `"MIT"`                                                                                               |
| `icon`                | `string`   | `"PL"`       | 1-4 character badge shown on the workspace card                                                                                  |
| `color`               | `string`   | `"#888"`     | Hex color for the workspace accent                                                                                               |
| `kind`                | `string`   | `"terminal"` | Workspace type. The renderer knows `"terminal"`, `"docker"`, `"azure"` and `"github"`; other strings are accepted but not useful |
| `capabilities`        | `string[]` | `[]`         | Declared capabilities, validated against the list below                                                                          |
| `workspaceDefaults`   | `object`   | `null`       | Default workspace template                                                                                                       |
| `entryPoint`          | `string`   | —            | Reserved. Must stay inside the plugin directory; the file is **not imported or executed** today                                  |
| `recommendedPackages` | `object[]` | `[]`         | Informational list of suggested packages; not used by the runtime                                                                |

## Workspace Template

`workspaceDefaults` is the template a user adds from the **+ Add Workspace** picker.

```json
{
  "workspaceDefaults": {
    "name": "My Tool",
    "icon": "MT",
    "color": "#e06040",
    "kind": "terminal",
    "notes": "Description of what this workspace does.",
    "panels": [
      {
        "id": "main",
        "title": "Main",
        "command": "my-tool --interactive",
        "shell": true,
        "startup": "default"
      },
      {
        "id": "logs",
        "title": "Logs",
        "command": "tail -f /var/log/my-tool.log",
        "shell": true,
        "startup": "manual"
      }
    ]
  }
}
```

### Panel Fields

| Field       | Type      | Default        | Description                                    |
| ----------- | --------- | -------------- | ---------------------------------------------- |
| `id`        | `string`  | auto-generated | Unique panel identifier within the workspace   |
| `title`     | `string`  | `"Shell"`      | Tab title                                      |
| `command`   | `string`  | `""`           | Startup command. Empty means interactive shell |
| `shell`     | `boolean` | `true`         | Whether to run the command in a shell          |
| `startup`   | `string`  | `"default"`    | `"default"` or `"manual"`                      |
| `platforms` | `object`  | `null`         | Platform-specific overrides                    |

## Cross-Platform Panels

A panel can override its startup per platform. Keys: `win32`, `linux`, `darwin`, and `posix`, used when the current platform has no entry of its own.

```json
{
  "id": "monitor",
  "title": "Monitor",
  "command": "",
  "shell": true,
  "startup": "default",
  "platforms": {
    "win32": { "script": "monitor.ps1" },
    "posix": { "script": "monitor.sh" }
  }
}
```

| Field     | Description                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| `script`  | Filename inside the plugin directory, with one of `.ps1`, `.sh`, `.bash`, `.py`, `.js`, `.mjs`                   |
| `command` | A plain shell command for that platform. **Honoured only for built-in plugins**; a user plugin must use `script` |

The loader, not the plugin, chooses how a script runs (e.g. `.ps1` becomes `powershell -ExecutionPolicy Bypass -File …`), and refuses a script whose extension is not allowed or whose path leaves the plugin directory. A refused panel shows the reason in its terminal.

## Capabilities

`capabilities` must name only these; an unknown one fails validation and the plugin does not load:

- `docker:list-containers`, `docker:container-actions`, `docker:attach-shell`, `docker:stream-logs`, `docker:lazydocker`
- `terminal:create-panel`, `terminal:read-output`
- `workspace:create`, `workspace:modify-own`
- `system:read-metrics`

Declare only what you need. Capabilities are metadata, not a permission system (see below).

## Plugin Lifecycle (today)

1. **Discovery** — built-in plugins, then user plugins, as above.
2. **Manifest validation** — `id` format, required fields, capability list, `entryPoint` containment.
3. **Template surfacing** — `workspaceDefaults` appears in the **+ Add Workspace** picker; choosing it creates the workspace with platform panels resolved for the current OS.

There is no module import, no `activate()` and no `deactivate()`. Runtime behaviour that a plugin cannot express as a template belongs in `electron/backend/` today.

## Security Model

What is enforced:

- manifest validation, including the capability list;
- `entryPoint` and platform scripts must stay inside the plugin directory, and scripts must have an allowed extension;
- a user plugin cannot supply a per-platform inline `command`.

What is not:

- **The loader executes no plugin code today.** A plugin's panels and scripts run as ordinary terminal sessions under your user account, with the same access as anything you type in a shell — so a plugin's commands and scripts are code you are choosing to run.
- **There is no sandbox.** If entry points are wired up later, they would run unsandboxed in the backend's Node.js process.
- **Capabilities are not permissions.** They are validated names, not an enforced boundary.

Treat plugin authors as trusted code authors, and read a plugin's manifest and scripts before installing it.
