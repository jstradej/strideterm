# Plugin Development Guide

This guide explains how to create plugins for strIDEterm. **Plugins are currently manifest-only** — they declare a workspace template and optional metadata. Runtime hooks (an `activate(...)` entry point) are not yet wired into the loader; see [Future Ideas](#future-ideas).

## Quick Start

Create a plugin in 3 steps:

```bash
# 1. Create plugin directory
mkdir -p ~/.strideterm/plugins/my-plugin

# 2. Create manifest
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

Your plugin will appear in the plugin list if the manifest validates successfully.

## Plugin Locations

Plugins are discovered from:

| Location                         | Type           | Priority      |
| -------------------------------- | -------------- | ------------- |
| `plugins/` inside the app bundle | Built-in       | Loaded first  |
| `~/.strideterm/plugins/`         | User-installed | Loaded second |

If a user plugin has the same `id` as a built-in plugin, the built-in plugin wins.

## Directory Structure

```text
~/.strideterm/plugins/my-plugin/
|- plugin.json
|- README.md
`- assets/
```

Only `plugin.json` is required. The plugin loader does not currently import or execute any code from the plugin directory (see [Future Ideas](#future-ideas)). Platform scripts referenced from `panels[].platforms[].script` are an exception — they're invoked as part of a panel's startup command.

## Manifest Reference

### Required Fields

| Field     | Type     | Description                                                      |
| --------- | -------- | ---------------------------------------------------------------- |
| `id`      | `string` | Lowercase alphanumeric with `-` or `_`. Pattern: `^[a-z0-9_-]+$` |
| `name`    | `string` | Human-readable display name                                      |
| `version` | `string` | Semantic version string                                          |

### Optional Fields

| Field                 | Type       | Default      | Description                                                                                                                                                                                            |
| --------------------- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `description`         | `string`   | `""`         | Short description shown in the UI                                                                                                                                                                      |
| `author`              | `string`   | `""`         | Plugin author name                                                                                                                                                                                     |
| `license`             | `string`   | `""`         | License identifier such as `"MIT"`                                                                                                                                                                     |
| `icon`                | `string`   | `"PL"`       | 1-4 character badge shown on the workspace card                                                                                                                                                        |
| `color`               | `string`   | `"#888"`     | Hex color for the workspace accent                                                                                                                                                                     |
| `kind`                | `string`   | `"terminal"` | Workspace type. Built-ins use `"terminal"`, `"docker"`, `"azure"`, `"github"`. The loader does not validate this field, so any string is accepted, but renderer code only knows the four values above. |
| `capabilities`        | `string[]` | `[]`         | Declared capabilities (validated against a whitelist)                                                                                                                                                  |
| `workspaceDefaults`   | `object`   | `null`       | Default workspace template                                                                                                                                                                             |
| `entryPoint`          | `string`   | —            | Reserved for future runtime hooks. The loader validates the path stays inside the plugin directory but **does not import or execute the file** today.                                                  |
| `recommendedPackages` | `object[]` | `[]`         | Free-form list of suggested packages. Informational only — not surfaced anywhere by the runtime currently.                                                                                             |

## Workspace Template

`workspaceDefaults` defines the template users can add from the plugin list.

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

Panels can declare per-platform behavior:

```json
{
  "id": "monitor",
  "title": "Monitor",
  "command": "",
  "shell": true,
  "startup": "default",
  "platforms": {
    "win32": { "script": "monitor.ps1" },
    "linux": { "command": "btop 2>/dev/null || htop" },
    "darwin": { "command": "btop 2>/dev/null || htop" }
  }
}
```

Platform keys: `win32`, `linux`, `darwin`.

| Field     | Description                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `script`  | Filename inside the plugin directory. Allowed extensions are `.ps1`, `.sh`, `.bash`, `.py`, `.js`, `.mjs` |
| `command` | Plain shell command for that platform                                                                     |

The loader chooses the runner for `script` automatically. For example, `.ps1` becomes `powershell -ExecutionPolicy Bypass -File ...`.

## Capabilities

The loader validates declared capabilities against a whitelist.

Available capabilities:

- `docker:list-containers`
- `docker:container-actions`
- `docker:attach-shell`
- `docker:stream-logs`
- `docker:lazydocker`
- `terminal:create-panel`
- `terminal:read-output`
- `workspace:create`
- `workspace:modify-own`
- `system:read-metrics`

Unknown capabilities fail validation and the plugin will not load.

Minimal static plugin example:

```json
{
  "id": "my-static-plugin",
  "name": "My Static Plugin",
  "version": "1.0.0",
  "capabilities": [],
  "workspaceDefaults": {}
}
```

## Plugin Lifecycle (today)

The loader is intentionally minimal:

1. Discovery — every direct subdirectory of `plugins/` (built-in) and `~/.strideterm/plugins/` (user) that contains a `plugin.json` is picked up. Discovery is **not recursive** — nested plugin directories are ignored.
2. Manifest validation — `id` regex, required fields, capability whitelist, and `entryPoint` path containment.
3. Workspace-template surfacing — the renderer reads `workspaceDefaults` so the plugin appears in the **+ Add Workspace** picker. Selecting it materialises the template with platform panels resolved (`win32` / `linux` / `darwin`, falling back to `posix` if defined).

There is no module import, no `activate()` invocation, and no `deactivate()` callback. If you need plugin-driven runtime behaviour today, fork the relevant manager in `electron/backend/` rather than depending on the entry point.

## Security Model

Be explicit about what is and is not enforced:

- Manifest validation is enforced.
- Capability names are validated.
- `entryPoint` path containment is validated.
- Platform script filenames are validated and constrained to the plugin directory.

Important limitation:

- Plugins run in the same Node.js process as the backend.
- There is no OS sandbox or capability sandbox around arbitrary plugin code.
- Declared capabilities are metadata and validation hints, not a hardened permission system.

That means plugin authors should be treated as trusted code authors.

## Best Practices

1. Keep plugin scope small and obvious.
2. Declare only capabilities you actually need.
3. Prefer `workspaceDefaults` if you only need a template — that's the supported path today.
4. Look at `plugins/system-monitor/` for a real example of `platforms` + `recommendedPackages`.
5. Include a `README.md` that explains prerequisites and commands.
6. Use semantic versioning.

## Common Errors

| Error                                                 | Cause               | Fix                                      |
| ----------------------------------------------------- | ------------------- | ---------------------------------------- |
| `Plugin 'id' must be a lowercase alphanumeric string` | Invalid `id` format | Use only `a-z`, `0-9`, `-`, `_`          |
| `Plugin 'name' is required`                           | Missing `name`      | Add `"name"`                             |
| `Plugin 'version' is required`                        | Missing `version`   | Add `"version"`                          |
| `Unknown capability: 'xxx'`                           | Invalid capability  | Remove or replace it                     |
| `Failed to parse plugin.json`                         | Invalid JSON        | Fix syntax                               |
| `entryPoint must not escape the plugin directory`     | `../` traversal     | Keep it relative to the plugin directory |

## Future Ideas

- **Entry-point activation** — wire `activate({ runtime })` / `deactivate()` into the loader so plugins can register listeners, timers, and IPC handlers. The manifest already validates `entryPoint` for path containment, but the loader doesn't import it yet.
- Plugin settings UI
- Hot reload
- Shared plugin schema module
- Custom renderer surfaces for trusted plugins
