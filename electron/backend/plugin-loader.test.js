import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createPluginManager } from "./plugin-loader.js";

const createdPaths = [];

async function createTempDir(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("plugin-loader", () => {
  test("discovers valid plugin from directory", async () => {
    const pluginsDir = await createTempDir("strideterm-plugins-");
    const pluginDir = path.join(pluginsDir, "test-plugin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      capabilities: ["terminal:create-panel"],
      workspaceDefaults: { name: "Test", icon: "TP", kind: "terminal", panels: [] },
    }));

    const manager = await createPluginManager({ pluginsDir, runtime: null });
    const plugins = manager.getPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("test-plugin");
    expect(plugins[0].name).toBe("Test Plugin");
    expect(plugins[0].workspaceDefaults.icon).toBe("TP");
  });

  test("rejects plugin with disallowed capability", async () => {
    const pluginsDir = await createTempDir("strideterm-plugins-");
    const pluginDir = path.join(pluginsDir, "bad-plugin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
      id: "bad-plugin",
      name: "Bad Plugin",
      version: "1.0.0",
      capabilities: ["system:execute-arbitrary-code"],
    }));

    const manager = await createPluginManager({ pluginsDir, runtime: null });
    const plugins = manager.getPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0].error).toContain("Unknown capability");
  });

  test("returns workspace template from plugin", async () => {
    const pluginsDir = await createTempDir("strideterm-plugins-");
    const pluginDir = path.join(pluginsDir, "tmpl-plugin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
      id: "tmpl-plugin",
      name: "Template Plugin",
      version: "1.0.0",
      workspaceDefaults: { name: "My Workspace", icon: "MP", color: "#ff0000", kind: "terminal", panels: [] },
    }));

    const manager = await createPluginManager({ pluginsDir, runtime: null });
    const template = manager.getWorkspaceTemplate("tmpl-plugin");

    expect(template).not.toBeNull();
    expect(template.name).toBe("My Workspace");
    expect(template.icon).toBe("MP");
  });

  test("platform script runner applies shell quoting to paths", async () => {
    const pluginsDir = await createTempDir("strideterm-plugins-");
    const pluginDir = path.join(pluginsDir, "script-plugin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, "monitor.sh"), "#!/bin/bash\necho ok");
    await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
      id: "script-plugin",
      name: "Script Plugin",
      version: "1.0.0",
      workspaceDefaults: {
        name: "Script WS",
        icon: "SC",
        kind: "terminal",
        panels: [{
          id: "p1",
          title: "Monitor",
          platforms: {
            linux: { script: "monitor.sh" },
            win32: { script: "monitor.sh" },
            darwin: { script: "monitor.sh" },
          },
        }],
      },
    }));

    const manager = await createPluginManager({ pluginsDir, runtime: null });
    const plugins = manager.getPlugins();

    expect(plugins).toHaveLength(1);
    const panel = plugins[0].workspaceDefaults?.panels?.[0];
    expect(panel).toBeTruthy();
    // The command should contain proper quoting (single or double quotes depending on platform)
    expect(panel.command).toMatch(/bash\s+['"].*monitor\.sh['"]/);
  });

  test("discovers builtin plugins from builtinPluginsDir", async () => {
    const builtinDir = await createTempDir("strideterm-builtin-");
    const pluginsDir = await createTempDir("strideterm-user-");
    const pluginDir = path.join(builtinDir, "builtin-one");
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
      id: "builtin-one",
      name: "Builtin One",
      version: "1.0.0",
    }));

    const manager = await createPluginManager({ pluginsDir, builtinPluginsDir: builtinDir, runtime: null });
    const plugins = manager.getPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("builtin-one");
    expect(plugins[0].builtin).toBe(true);
  });
});
