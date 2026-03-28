# Plugin Development Guide

This guide explains how to create plugins for strIDEterm. Plugins can provide workspace templates and optional runtime hooks.

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
|- index.js
|- README.md
`- assets/
```

Only `plugin.json` is required. `index.js` is optional.

## Manifest Reference

### Required Fields

| Field     | Type     | Description                                                      |
| --------- | -------- | ---------------------------------------------------------------- |
| `id`      | `string` | Lowercase alphanumeric with `-` or `_`. Pattern: `^[a-z0-9_-]+$` |
| `name`    | `string` | Human-readable display name                                      |
| `version` | `string` | Semantic version string                                          |

### Optional Fields

| Field                 | Type       | Default      | Description                                      |
| --------------------- | ---------- | ------------ | ------------------------------------------------ |
| `description`         | `string`   | `""`         | Short description shown in the UI                |
| `author`              | `string`   | `""`         | Plugin author name                               |
| `license`             | `string`   | `""`         | License identifier such as `"MIT"`               |
| `icon`                | `string`   | `"PL"`       | 1-4 character badge shown on the workspace card  |
| `color`               | `string`   | `"#888"`     | Hex color for the workspace accent               |
| `kind`                | `string`   | `"terminal"` | Workspace type: `"terminal"` or `"docker"`       |
| `capabilities`        | `string[]` | `[]`         | Declared capabilities                            |
| `workspaceDefaults`   | `object`   | `null`       | Default workspace template                       |
| `entryPoint`          | `string`   | `"index.js"` | Relative path to the JS entry point              |
| `recommendedPackages` | `object[]` | `[]`         | Optional list of recommended npm/system packages |

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

## Entry Point

If present, the entry point must be an ES module that exports `activate`:

```javascript
export const id = "my-plugin";

export function activate({ runtime }) {
  console.log("My plugin activated");

  return {
    deactivate() {
      console.log("My plugin deactivated");
    },
  };
}
```

Lifecycle:

1. Discovery
2. Manifest validation
3. Optional module import
4. `activate()` call
5. Running until shutdown
6. Optional `deactivate()` call on shutdown

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
3. Prefer `workspaceDefaults` if you only need a template.
4. Clean up timers, listeners, and subprocesses in `deactivate()`.
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

- Plugin settings UI
- Hot reload
- Shared plugin schema module
- More runtime hooks
- Custom renderer surfaces for trusted plugins
