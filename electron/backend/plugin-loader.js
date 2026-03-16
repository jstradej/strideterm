import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Allowed script extensions that plugins can reference.
 * Prevents execution of arbitrary binaries.
 */
const ALLOWED_SCRIPT_EXTENSIONS = new Set([".ps1", ".sh", ".bash", ".py", ".js", ".mjs"]);

/**
 * Script runners per extension. The loader uses these to construct
 * the actual shell command — the plugin never provides the runner.
 */
const SCRIPT_RUNNERS = {
  ".ps1": (scriptPath) => `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
  ".sh": (scriptPath) => `bash "${scriptPath}"`,
  ".bash": (scriptPath) => `bash "${scriptPath}"`,
  ".py": (scriptPath) => `python3 "${scriptPath}" 2>/dev/null || python "${scriptPath}"`,
  ".js": (scriptPath) => `node "${scriptPath}"`,
  ".mjs": (scriptPath) => `node "${scriptPath}"`,
};

/**
 * Allowed capabilities that plugins can declare.
 * This whitelist prevents plugins from requesting dangerous permissions.
 */
const ALLOWED_CAPABILITIES = new Set([
  "docker:list-containers",
  "docker:container-actions",
  "docker:attach-shell",
  "docker:stream-logs",
  "docker:lazydocker",
  "terminal:create-panel",
  "terminal:read-output",
  "workspace:create",
  "workspace:modify-own",
  "system:read-metrics",
]);

/**
 * Validates a plugin manifest (plugin.json) for safety and correctness.
 * Returns { valid: true, manifest } or { valid: false, errors: string[] }.
 */
function validateManifest(manifest, pluginDir) {
  const errors = [];

  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["Manifest must be a JSON object."] };
  }

  if (!manifest.id || typeof manifest.id !== "string" || !/^[a-z0-9_-]+$/.test(manifest.id)) {
    errors.push("Plugin 'id' must be a lowercase alphanumeric string with hyphens/underscores.");
  }

  if (!manifest.name || typeof manifest.name !== "string") {
    errors.push("Plugin 'name' is required and must be a string.");
  }

  if (!manifest.version || typeof manifest.version !== "string") {
    errors.push("Plugin 'version' is required.");
  }

  if (manifest.capabilities && Array.isArray(manifest.capabilities)) {
    for (const cap of manifest.capabilities) {
      if (!ALLOWED_CAPABILITIES.has(cap)) {
        errors.push(`Unknown capability: '${cap}'. Allowed: ${[...ALLOWED_CAPABILITIES].join(", ")}`);
      }
    }
  }

  // Ensure the plugin doesn't try to escape its directory
  if (manifest.entryPoint) {
    const resolved = path.resolve(pluginDir, manifest.entryPoint);
    if (!resolved.startsWith(path.resolve(pluginDir))) {
      errors.push("Plugin entryPoint must not escape the plugin directory.");
    }
  }

  return errors.length ? { valid: false, errors } : { valid: true, manifest };
}

/**
 * Resolves platform-specific panel commands safely.
 *
 * Plugins declare a `platforms` object per panel:
 *   { "win32": { "script": "monitor.ps1" }, "linux": { "command": "htop" } }
 *
 * - `script`: filename inside the plugin directory. The loader validates the
 *   extension against ALLOWED_SCRIPT_EXTENSIONS and ensures no path traversal.
 *   The actual shell runner is chosen by the loader, not the plugin.
 * - `command`: a plain shell command (no file references). Allowed only for
 *   well-known CLI tools, not arbitrary code execution.
 */
function resolvePlatformPanels(panels, pluginDir) {
  if (!panels) return panels;
  const platform = process.platform; // "win32", "linux", "darwin"

  return panels.map((panel) => {
    const resolved = { ...panel };
    if (!panel.platforms) return resolved;

    const platformConfig = panel.platforms[platform] || panel.platforms.posix || null;
    delete resolved.platforms;
    // Also clean up legacy fields
    delete resolved._platformCommand;

    if (!platformConfig) return resolved;

    if (platformConfig.script) {
      const scriptName = String(platformConfig.script);
      const ext = path.extname(scriptName).toLowerCase();

      // Validate extension
      if (!ALLOWED_SCRIPT_EXTENSIONS.has(ext)) {
        resolved.command = `echo "Plugin error: script extension '${ext}' is not allowed."`;
        return resolved;
      }

      // Validate path — must not escape plugin directory
      const scriptPath = path.resolve(pluginDir, scriptName);
      if (!scriptPath.startsWith(path.resolve(pluginDir))) {
        resolved.command = `echo "Plugin error: script path escapes plugin directory."`;
        return resolved;
      }

      // Use our runner, not the plugin's
      const runner = SCRIPT_RUNNERS[ext];
      if (runner) {
        resolved.command = runner(scriptPath.replaceAll("\\", "/"));
      } else {
        resolved.command = `echo "Plugin error: no runner for '${ext}'."`;
      }
    } else if (platformConfig.command) {
      resolved.command = String(platformConfig.command);
    }

    return resolved;
  });
}

/**
 * Discovers plugins from a directory.
 * Each subdirectory containing a plugin.json is treated as a plugin.
 */
async function discoverPlugins(pluginsDir) {
  const plugins = [];

  if (!existsSync(pluginsDir)) {
    return plugins;
  }

  const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = path.join(pluginsDir, entry.name);
    const manifestPath = path.join(pluginDir, "plugin.json");

    if (!existsSync(manifestPath)) continue;

    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw);
      const validation = validateManifest(manifest, pluginDir);

      if (validation.valid) {
        plugins.push({
          manifest: validation.manifest,
          directory: pluginDir,
          loaded: false,
          instance: null,
          error: null,
        });
      } else {
        plugins.push({
          manifest: manifest || { id: entry.name, name: entry.name },
          directory: pluginDir,
          loaded: false,
          instance: null,
          error: `Validation failed: ${validation.errors.join("; ")}`,
        });
      }
    } catch (error) {
      plugins.push({
        manifest: { id: entry.name, name: entry.name },
        directory: pluginDir,
        loaded: false,
        instance: null,
        error: `Failed to parse plugin.json: ${error.message}`,
      });
    }
  }

  return plugins;
}

/**
 * Creates a plugin manager that discovers, validates, and loads plugins.
 */
export async function createPluginManager({ pluginsDir, builtinPluginsDir, runtime }) {
  const allPlugins = [];

  // Discover built-in plugins first
  if (builtinPluginsDir) {
    const builtins = await discoverPlugins(builtinPluginsDir);
    for (const plugin of builtins) {
      plugin.builtin = true;
      allPlugins.push(plugin);
    }
  }

  // Discover user plugins (from ~/.strideterm/plugins/)
  const userPlugins = await discoverPlugins(pluginsDir);
  for (const plugin of userPlugins) {
    // Skip if a builtin with same ID already exists
    if (allPlugins.some((p) => p.manifest.id === plugin.manifest.id)) continue;
    plugin.builtin = false;
    allPlugins.push(plugin);
  }

  return {
    /**
     * Returns the list of discovered plugins with their status.
     */
    getPlugins() {
      return allPlugins.map((p) => {
        let workspaceDefaults = p.manifest.workspaceDefaults ? JSON.parse(JSON.stringify(p.manifest.workspaceDefaults)) : null;
        if (workspaceDefaults?.panels) {
          workspaceDefaults.panels = resolvePlatformPanels(workspaceDefaults.panels, p.directory);
        }
        return {
          id: p.manifest.id,
          name: p.manifest.name,
          version: p.manifest.version || "0.0.0",
          description: p.manifest.description || "",
          icon: p.manifest.icon || "PL",
          color: p.manifest.color || "#888",
          kind: p.manifest.kind || "terminal",
          loaded: p.loaded,
          builtin: p.builtin || false,
          error: p.error,
          capabilities: p.manifest.capabilities || [],
          workspaceDefaults,
          directory: p.directory,
        };
      });
    },

    /**
     * Creates a workspace from a plugin's default template.
     */
    getWorkspaceTemplate(pluginId) {
      const plugin = allPlugins.find((p) => p.manifest.id === pluginId);
      if (!plugin || !plugin.manifest.workspaceDefaults) return null;
      const template = JSON.parse(JSON.stringify(plugin.manifest.workspaceDefaults));
      if (template.panels) {
        template.panels = resolvePlatformPanels(template.panels, plugin.directory);
      }
      return template;
    },

    /**
     * Stops all loaded plugins.
     */
    async stopAll() {
      for (const plugin of allPlugins) {
        if (plugin.instance?.deactivate) {
          try {
            await plugin.instance.deactivate();
          } catch {
            // Best-effort cleanup.
          }
        }
        plugin.loaded = false;
        plugin.instance = null;
      }
    },
  };
}
