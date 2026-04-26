/// <reference types="node" />
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Allowed script extensions that plugins can reference.
 * Prevents execution of arbitrary binaries.
 */
const ALLOWED_SCRIPT_EXTENSIONS = new Set([".ps1", ".sh", ".bash", ".py", ".js", ".mjs"]);

/**
 * Escape a file path for safe embedding in a shell command string.
 * Uses single quotes on POSIX (prevents all expansion) and double
 * quotes on Windows PowerShell (with internal double-quote escaping).
 */
function shellQuote(filePath: string): string {
  if (process.platform === "win32") {
    return `"${filePath.replace(/"/g, '`"')}"`;
  }
  return `'${filePath.replace(/'/g, "'\\''")}'`;
}

/**
 * Script runners per extension. The loader uses these to construct
 * the actual shell command — the plugin never provides the runner.
 * Paths are shell-quoted to prevent injection via crafted directory names.
 */
const SCRIPT_RUNNERS: Record<string, (scriptPath: string) => string> = {
  ".ps1": (scriptPath) => `powershell -ExecutionPolicy Bypass -File ${shellQuote(scriptPath)}`,
  ".sh": (scriptPath) => `bash ${shellQuote(scriptPath)}`,
  ".bash": (scriptPath) => `bash ${shellQuote(scriptPath)}`,
  ".py": (scriptPath) => `python3 ${shellQuote(scriptPath)} 2>/dev/null || python ${shellQuote(scriptPath)}`,
  ".js": (scriptPath) => `node ${shellQuote(scriptPath)}`,
  ".mjs": (scriptPath) => `node ${shellQuote(scriptPath)}`,
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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawManifest {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  capabilities?: unknown;
  entryPoint?: unknown;
  description?: unknown;
  icon?: unknown;
  color?: unknown;
  kind?: unknown;
  workspaceDefaults?: {
    panels?: RawPanel[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RawPanel {
  id?: string;
  title?: string;
  command?: string;
  platforms?: Record<string, { script?: string; command?: string }>;
  _platformCommand?: unknown;
  [key: string]: unknown;
}

interface ValidatedManifest {
  id: string;
  name: string;
  version: string;
  capabilities?: string[];
  entryPoint?: string;
  description?: string;
  icon?: string;
  color?: string;
  kind?: string;
  workspaceDefaults?: {
    panels?: RawPanel[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type ValidationResult =
  | { valid: true; manifest: ValidatedManifest; errors?: undefined }
  | { valid: false; errors: string[]; manifest?: undefined };

interface PluginEntry {
  manifest: ValidatedManifest | RawManifest;
  directory: string;
  loaded: boolean;
  instance: { deactivate?: () => Promise<void> } | null;
  error: string | null;
  builtin?: boolean;
}

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string;
  color: string;
  kind: string;
  loaded: boolean;
  builtin: boolean;
  error: string | null;
  capabilities: string[];
  workspaceDefaults: { panels?: RawPanel[]; [key: string]: unknown } | null;
  directory: string;
}

interface PluginManagerOptions {
  pluginsDir: string;
  builtinPluginsDir?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runtime: any;
}

interface PluginManager {
  getPlugins(): PluginInfo[];
  getWorkspaceTemplate(pluginId: string): { panels?: RawPanel[]; [key: string]: unknown } | null;
  stopAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Validates a plugin manifest (plugin.json) for safety and correctness.
 * Returns { valid: true, manifest } or { valid: false, errors: string[] }.
 */
function validateManifest(manifest: unknown, pluginDir: string): ValidationResult {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["Manifest must be a JSON object."] };
  }

  const m = manifest as RawManifest;

  if (!m.id || typeof m.id !== "string" || !/^[a-z0-9_-]+$/.test(m.id)) {
    errors.push("Plugin 'id' must be a lowercase alphanumeric string with hyphens/underscores.");
  }

  if (!m.name || typeof m.name !== "string") {
    errors.push("Plugin 'name' is required and must be a string.");
  }

  if (!m.version || typeof m.version !== "string") {
    errors.push("Plugin 'version' is required.");
  }

  if (m.capabilities && Array.isArray(m.capabilities)) {
    for (const cap of m.capabilities) {
      if (!ALLOWED_CAPABILITIES.has(cap as string)) {
        errors.push(`Unknown capability: '${cap}'. Allowed: ${[...ALLOWED_CAPABILITIES].join(", ")}`);
      }
    }
  }

  // Ensure the plugin doesn't try to escape its directory
  if (m.entryPoint) {
    const resolved = path.resolve(pluginDir, String(m.entryPoint));
    if (!resolved.startsWith(path.resolve(pluginDir))) {
      errors.push("Plugin entryPoint must not escape the plugin directory.");
    }
  }

  if (errors.length) {
    return { valid: false, errors };
  }

  return { valid: true, manifest: m as ValidatedManifest };
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
function resolvePlatformPanels(
  panels: RawPanel[] | undefined | null,
  pluginDir: string,
): RawPanel[] | undefined | null {
  if (!panels) return panels;
  const platform = process.platform; // "win32", "linux", "darwin"

  return panels.map((panel) => {
    const resolved: RawPanel = { ...panel };
    if (!panel.platforms) return resolved;

    const platformConfig = panel.platforms[platform] || panel.platforms["posix"] || null;
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
async function discoverPlugins(pluginsDir: string): Promise<PluginEntry[]> {
  const plugins: PluginEntry[] = [];

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
      const manifest = JSON.parse(raw) as unknown;
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
          manifest: (manifest as RawManifest) || { id: entry.name, name: entry.name },
          directory: pluginDir,
          loaded: false,
          instance: null,
          error: `Validation failed: ${validation.errors.join("; ")}`,
        });
      }
    } catch (error) {
      const err = error as Error;
      plugins.push({
        manifest: { id: entry.name, name: entry.name },
        directory: pluginDir,
        loaded: false,
        instance: null,
        error: `Failed to parse plugin.json: ${err.message}`,
      });
    }
  }

  return plugins;
}

/**
 * Creates a plugin manager that discovers, validates, and loads plugins.
 */
export async function createPluginManager({
  pluginsDir,
  builtinPluginsDir,
  runtime: _runtime,
}: PluginManagerOptions): Promise<PluginManager> {
  const allPlugins: PluginEntry[] = [];

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
    if (allPlugins.some((p) => (p.manifest as ValidatedManifest).id === (plugin.manifest as ValidatedManifest).id))
      continue;
    plugin.builtin = false;
    allPlugins.push(plugin);
  }

  return {
    /**
     * Returns the list of discovered plugins with their status.
     */
    getPlugins(): PluginInfo[] {
      return allPlugins.map((p) => {
        const m = p.manifest as ValidatedManifest;
        const workspaceDefaults = m.workspaceDefaults
          ? (JSON.parse(JSON.stringify(m.workspaceDefaults)) as { panels?: RawPanel[]; [key: string]: unknown })
          : null;
        if (workspaceDefaults?.panels) {
          workspaceDefaults.panels = resolvePlatformPanels(workspaceDefaults.panels, p.directory) ?? [];
        }
        return {
          id: m.id,
          name: m.name,
          version: m.version || "0.0.0",
          description: m.description || "",
          icon: m.icon || "PL",
          color: m.color || "#888",
          kind: m.kind || "terminal",
          loaded: p.loaded,
          builtin: p.builtin || false,
          error: p.error,
          capabilities: (m.capabilities as string[]) || [],
          workspaceDefaults,
          directory: p.directory,
        };
      });
    },

    /**
     * Creates a workspace from a plugin's default template.
     */
    getWorkspaceTemplate(pluginId: string): { panels?: RawPanel[]; [key: string]: unknown } | null {
      const plugin = allPlugins.find((p) => (p.manifest as ValidatedManifest).id === pluginId);
      if (!plugin || !(plugin.manifest as ValidatedManifest).workspaceDefaults) return null;
      const template = JSON.parse(JSON.stringify((plugin.manifest as ValidatedManifest).workspaceDefaults)) as {
        panels?: RawPanel[];
        [key: string]: unknown;
      };
      if (template.panels) {
        template.panels = resolvePlatformPanels(template.panels, plugin.directory) ?? [];
      }
      return template;
    },

    /**
     * Stops all loaded plugins.
     */
    async stopAll(): Promise<void> {
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
