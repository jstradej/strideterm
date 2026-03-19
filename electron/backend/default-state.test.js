import { describe, expect, test } from "vitest";
import { createAccessToken, createDefaultState, normalizeWorkspace, normalizeState } from "./default-state.js";

describe("default state", () => {
  test("createAccessToken returns a non-trivial token", () => {
    const token = createAccessToken();
    expect(token.length).toBeGreaterThan(20);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("default state includes remote access enabled and empty workspaces", () => {
    const state = createDefaultState();
    expect(state.settings.remoteAccess.enabled).toBe(true);
    expect(state.workspaces).toEqual([]);
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

  test("default state includes Azure DevOps integration settings", () => {
    const state = createDefaultState();
    expect(state.settings.integrations.azureDevops.enabled).toBe(true);
    expect(state.settings.integrations.azureDevops.connections).toEqual([]);
  });

  test("normalizeWorkspace preserves review metadata", () => {
    const workspace = normalizeWorkspace({
      id: "review-1",
      name: "Review",
      cwd: "C:/work/review",
      panels: [{ id: "shell", title: "Shell", command: "" }],
      review: {
        provider: "azure-devops",
        prKey: "ado-main:repo-1:123",
        connectionId: "ado-main",
        orgUrl: "https://dev.azure.com/acme",
        parentWorkspaceId: "azure-root",
        project: { id: "project-1", name: "Platform" },
        repository: { id: "repo-1", name: "web-app", remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app" },
        pullRequest: { id: 123, title: "Fix login redirect", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main" },
        checkout: { mode: "managed-worktree", rootPath: "C:/work/review", cacheRepoPath: "C:/cache/repo" },
      },
    });

    expect(workspace.review.prKey).toBe("ado-main:repo-1:123");
    expect(workspace.review.parentWorkspaceId).toBe("azure-root");
    expect(workspace.review.checkout.cacheRepoPath).toBe("C:/cache/repo");
  });

  test("normalizeState preserves Azure connection config", () => {
    const state = normalizeState({
      settings: {
        integrations: {
          azureDevops: {
            reviewRoot: "C:/reviews",
            connections: [
              {
                id: "ado-main",
                label: "Acme",
                orgUrl: "https://dev.azure.com/acme",
                login: "me@example.com",
                tokenRef: "cred:ado-main",
                projectFilters: ["Platform"],
                repositoryFilters: ["repo-1"],
                pollSeconds: 45,
              },
            ],
          },
        },
      },
    });

    expect(state.settings.integrations.azureDevops.reviewRoot).toBe("C:/reviews");
    expect(state.settings.integrations.azureDevops.connections[0]).toMatchObject({
      id: "ado-main",
      tokenRef: "cred:ado-main",
      pollSeconds: 45,
    });
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

  test("normalizeState groups worktrees right after their parent", () => {
    const state = normalizeState({
      workspaces: [
        { id: "mhub", name: "mhub" },
        { id: "ide", name: "IDE" },
        { id: "ale", name: "ALE" },
        { id: "ide-meta", name: "IDE / metaterm", notes: "Worktree of IDE" },
      ],
    });

    const names = state.workspaces.map((w) => w.name);
    expect(names).toEqual(["mhub", "IDE", "IDE / metaterm", "ALE"]);
  });

  test("normalizeState groups managed Azure review workspaces under the Azure parent", () => {
    const state = normalizeState({
      settings: {
        integrations: {
          azureDevops: {
            reviewRoot: "C:/reviews",
          },
        },
      },
      workspaces: [
        { id: "backend", name: "Backend" },
        { id: "azure-root", name: "Azure DevOps", kind: "azure", cwd: "" },
        {
          id: "review-1",
          name: "web-app PR #123",
          cwd: "C:/reviews/reviews/ado-main/pr-123",
          panels: [{ id: "shell", title: "Shell", command: "" }],
          review: {
            provider: "azure-devops",
            parentWorkspaceId: "azure-root",
            checkout: { mode: "managed-worktree" },
          },
        },
      ],
    });

    expect(state.workspaces.map((workspace) => workspace.id)).toEqual(["backend", "azure-root", "review-1"]);
    expect(state.workspaces.find((workspace) => workspace.id === "azure-root")?.cwd).toBe("C:/reviews");
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

  test("normalizeState repairs mojibake icons and panel titles from persisted state", () => {
    const state = normalizeState({
      tabTemplates: [
        {
          id: "claude",
          title: "Claude Code",
          command: "claude",
          icon: "\u0111\u017A\u00A4\u2013",
        },
      ],
      workspaces: [
        {
          id: "ide",
          name: "IDE",
          icon: "\u00E2\u015B\u00A8",
          panels: [
            {
              id: "claude",
              title: "\u0111\u017A\u00A4\u2013 Claude Code",
              command: "claude",
            },
          ],
        },
      ],
    });

    expect(state.tabTemplates[0].icon).toBe("\u{1F916}");
    expect(state.workspaces[0].icon).toBe("\u2728");
    expect(state.workspaces[0].panels[0].title).toBe("\u{1F916} Claude Code");
  });
});
