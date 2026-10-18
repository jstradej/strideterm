# Plugin Development

strIDEterm plugins currently provide workspace templates through a `plugin.json` manifest. The manifest does not load JavaScript plugin code. Panel startup commands and scripts run as normal terminal commands under the signed-in user's account, so install only plugins you trust.

## Create a plugin

Create a folder for your plugin inside the app data directory's `plugins` folder. By default, this is `~/.strideterm/plugins/`; if you use a custom app data directory, put the folder there instead. Each plugin must be a direct child folder with its own `plugin.json`.

```text
plugins/
└── my-tool/
    ├── plugin.json
    ├── start.sh
    └── start.ps1
```

Use a separate startup script for each operating system. For example, this manifest describes a terminal workspace with an automatically started panel:

```json
{
  "id": "my-tool",
  "name": "My Tool",
  "version": "1.0.0",
  "description": "A workspace for My Tool",
  "icon": "MT",
  "color": "#e06040",
  "kind": "terminal",
  "workspaceDefaults": {
    "name": "My Tool",
    "icon": "MT",
    "color": "#e06040",
    "kind": "terminal",
    "panels": [
      {
        "id": "main",
        "title": "My Tool",
        "command": "",
        "shell": true,
        "startup": "default",
        "platforms": {
          "win32": { "script": "start.ps1" },
          "posix": { "script": "start.sh" }
        }
      }
    ]
  }
}
```

The `posix` override applies to macOS and Linux. Supported script extensions are `.ps1`, `.sh`, `.bash`, `.py`, `.js`, and `.mjs`. Script paths must stay inside the plugin folder. User plugins must use script files in platform overrides; inline per-platform commands are reserved for built-in plugins.

Restart strIDEterm after adding or changing a plugin. If its template does not appear in **+ → Add Workspace**, check the app's plugin list for validation errors. Choose the template to create a workspace, then review and edit the resulting panels like other workspaces.

## Manifest fields

| Field               | Purpose                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                | Required unique identifier; use lowercase letters, numbers, `-`, or `_`.                       |
| `name`              | Required display name.                                                                         |
| `version`           | Required version string.                                                                       |
| `description`       | Optional short text shown in the UI.                                                           |
| `icon`              | Optional 1–4 character badge for the workspace.                                                |
| `color`             | Optional hex color for the workspace accent.                                                   |
| `kind`              | Workspace kind such as `terminal`, `docker`, `azure`, or `github`.                             |
| `workspaceDefaults` | Optional workspace template, including name, icon, color, notes, and panels.                   |
| `capabilities`      | Optional list of recognized capability labels. These labels are metadata, not access controls. |

Each panel can set `id`, `title`, `command`, `shell`, and `startup`. Use `startup: "default"` to start the command with the workspace, or `"manual"` to open it on demand. An empty command starts an interactive shell. Platform overrides can choose an allowed script for `win32`, `linux`, `darwin`, or `posix`.

## Safety and limitations

Plugins are local to one installation and are not synchronized to other computers. strIDEterm does not sandbox terminal commands: a command or script from a plugin can access files and programs with the same permissions as your normal shell. Review its manifest and scripts before using it.

The manifest's `capabilities` list does not grant or restrict permissions. Plugin templates can launch terminal commands, but plugins cannot currently add new app interfaces or backend features through JavaScript code.
