import { describe, expect, test } from "vitest";
import { createAccessToken, createDefaultState, normalizeWorkspace, normalizeState } from "./default-state.js";

describe("default state", () => {
  test("createAccessToken returns a non-trivial token", () => {
    const token = createAccessToken();
    expect(token.length).toBeGreaterThan(20);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("default state includes docker workspace and remote access", () => {
    const state = createDefaultState();
    expect(state.settings.remoteAccess.enabled).toBe(true);
    expect(state.workspaces.some((workspace) => workspace.kind === "docker")).toBe(true);
  });

  test("normalizeWorkspace preserves explicit launch config", () => {
    const workspace = normalizeWorkspace({
      id: "docker",
      kind: "docker",
      panels: [
        {
          id: "logs",
          title: "Logs",
          launch: {
            file: "wsl.exe",
            args: ["-e", "sh", "-lc", "docker logs -f api"],
          },
        },
      ],
    });

    const logsPanel = workspace.panels.find((panel) => panel.id === "logs");
    expect(logsPanel.launch.file).toBe("wsl.exe");
    expect(logsPanel.launch.args[3]).toContain("docker logs -f api");
  });

  test("normalizeWorkspace preserves plugin workspace metadata", () => {
    const workspace = normalizeWorkspace({
      id: "system-monitor",
      kind: "terminal",
      source: "plugin",
      pluginId: "system-monitor",
      panels: [
        { id: "monitor", title: "Monitor", command: "btm" },
      ],
    });

    expect(workspace.source).toBe("plugin");
    expect(workspace.pluginId).toBe("system-monitor");
  });

  test("normalizeState keeps configured remote token", () => {
    const state = normalizeState({
      settings: {
        remoteAccess: {
          token: "custom-token",
          customPublicUrl: "https://strideterm.example.com",
          cloudflaredPath: "C:/Tools/cloudflared.exe",
        },
      },
    });

    expect(state.settings.remoteAccess.token).toBe("custom-token");
    expect(state.settings.remoteAccess.customPublicUrl).toBe("https://strideterm.example.com");
    expect(state.settings.remoteAccess.cloudflaredPath).toBe("C:/Tools/cloudflared.exe");
  });

  test("normalizeState migrates legacy docker project into docker manager mode", () => {
    const state = normalizeState({
      projects: [
        {
          id: "docker",
          name: "Docker Ops",
          kind: "terminal",
          activePanelId: "lazydocker",
          panels: [
            { id: "lazydocker", title: "Lazydocker", command: "lazydocker" },
          ],
        },
      ],
    });

    expect(state.workspaces[0].kind).toBe("docker");
    expect(state.workspaces[0].panels.some((panel) => panel.id === "lazydocker")).toBe(false);
  });

  test("normalizeState preserves integrated lazydocker panel with launch config", () => {
    const state = normalizeState({
      projects: [
        {
          id: "docker",
          name: "Docker Ops",
          kind: "docker",
          activePanelId: "lazydocker",
          panels: [
            {
              id: "lazydocker",
              title: "Lazydocker",
              command: "lazydocker",
              launch: {
                file: "wsl.exe",
                args: ["-e", "sh", "-lc", "lazydocker"],
              },
            },
          ],
        },
      ],
    });

    expect(state.workspaces[0].panels.some((panel) => panel.id === "lazydocker")).toBe(true);
    expect(state.workspaces[0].activePanelId).toBe("lazydocker");
  });

  test("normalizeState removes legacy empty git panel from terminal workspaces", () => {
    const state = normalizeState({
      projects: [
        {
          id: "frontend",
          kind: "terminal",
          activePanelId: "git",
          panels: [
            { id: "shell", title: "Shell", command: "npm run dev" },
            { id: "git", title: "Git", command: "" },
          ],
        },
      ],
    });

    expect(state.workspaces[0].panels.some((panel) => panel.id === "git")).toBe(false);
    expect(state.workspaces[0].activePanelId).toBe("shell");
  });
});
