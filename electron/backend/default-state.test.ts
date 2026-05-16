import { describe, expect, test } from "vitest";
import {
  createAccessToken,
  createDefaultState,
  normalizeWorkspace,
  normalizeState,
  normalizeWorkspaceGrid,
} from "./default-state.js";

describe("default state", () => {
  test("createAccessToken returns a non-trivial token", () => {
    const token = createAccessToken();
    // 32 random bytes base64url-encoded = 43 chars (no padding). Anything
    // shorter than that would mean we have downgraded the entropy budget.
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("default state ships with remote access disabled and empty workspaces", () => {
    // Remote access binds the LAN port the moment the app launches. Defaulting
    // to disabled keeps the auth-protected endpoint off the network until the
    // user opts in via Settings.
    const state = createDefaultState();
    expect(state.settings.remoteAccess.enabled).toBe(false);
    expect(state.workspaces).toEqual([]);
  });

  test("normalizeState migrates legacy tabTemplates by adding copilot after gemini", () => {
    // Simulate a pre-Copilot user whose state was saved before the provider was added.
    const state = normalizeState({
      tabTemplates: [
        { id: "shell", title: "Shell", command: "", icon: "\u{1F4BB}" },
        { id: "claude", title: "Claude Code", command: "claude", icon: "\u{1F916}" },
        { id: "codex", title: "Codex", command: "codex", icon: "\u{1F9E0}" },
        { id: "gemini", title: "Gemini CLI", command: "gemini", icon: "\u2728" },
        { id: "devserver", title: "Dev Server", command: "npm run dev", icon: "\u{1F680}" },
      ],
    });

    const ids = state.tabTemplates.map((t) => t.id);
    expect(ids).toContain("copilot");
    // Must sit right after the last built-in agent (gemini) for a tidy group
    const geminiIdx = ids.indexOf("gemini");
    const copilotIdx = ids.indexOf("copilot");
    expect(copilotIdx).toBe(geminiIdx + 1);

    const copilot = state.tabTemplates[copilotIdx];
    expect(copilot).toMatchObject({ id: "copilot", title: "GitHub Copilot", command: "copilot" });
  });

  test("normalizeState does not duplicate copilot template if user already has one", () => {
    const state = normalizeState({
      tabTemplates: [
        { id: "shell", title: "Shell", command: "" },
        { id: "copilot", title: "My Copilot", command: "copilot --model gpt-5.4" },
      ],
    });
    const copilotEntries = state.tabTemplates.filter((t) => t.id === "copilot" || t.command?.startsWith("copilot"));
    expect(copilotEntries).toHaveLength(1);
    // User's customized entry is preserved — not clobbered by the default
    expect(copilotEntries[0].title).toBe("My Copilot");
  });

  test("normalizeState falls back to appending copilot when no agent anchors exist", () => {
    const state = normalizeState({
      tabTemplates: [
        { id: "shell", title: "Shell", command: "" },
        { id: "devserver", title: "Dev Server", command: "npm run dev" },
      ],
    });
    // No claude/codex/gemini anchor — copilot should still be added (appended).
    const ids = state.tabTemplates.map((t) => t.id);
    expect(ids).toContain("copilot");
  });

  test("default tab templates include every built-in agent provider", () => {
    const state = createDefaultState();
    const ids = state.tabTemplates.map((tpl) => tpl.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("gemini");
    expect(ids).toContain("copilot");

    const copilot = state.tabTemplates.find((tpl) => tpl.id === "copilot");
    expect(copilot).toMatchObject({ title: "GitHub Copilot", command: "copilot" });
    expect(copilot!.icon).toBeTruthy();
  });

  test("default tab templates include PowerShell right after Shell", () => {
    const state = createDefaultState();
    const ids = state.tabTemplates.map((tpl) => tpl.id);
    const shellIdx = ids.indexOf("shell");
    const psIdx = ids.indexOf("powershell");
    expect(shellIdx).toBeGreaterThanOrEqual(0);
    expect(psIdx).toBe(shellIdx + 1);

    const ps = state.tabTemplates[psIdx];
    expect(ps).toMatchObject({ id: "powershell", title: "PowerShell", command: "powershell" });
    expect(ps.icon).toBeTruthy();
  });

  const isWindows = process.platform === "win32";

  test.runIf(isWindows)("normalizeState on Windows adds powershell/pwsh/git-bash/wsl after shell", () => {
    const state = normalizeState({
      tabTemplates: [
        { id: "shell", title: "Shell", command: "", icon: "\u{1F4BB}" },
        { id: "claude", title: "Claude Code", command: "claude", icon: "\u{1F916}" },
      ],
    });
    const ids = state.tabTemplates.map((t) => t.id);
    expect(ids).toContain("powershell");
    expect(ids).toContain("pwsh");
    expect(ids).toContain("git-bash");
    expect(ids).toContain("wsl");
  });

  test.runIf(isWindows)("normalizeState does not duplicate powershell template if user already has one", () => {
    const state = normalizeState({
      tabTemplates: [
        { id: "shell", title: "Shell", command: "" },
        { id: "powershell", title: "PS 7", command: "pwsh -NoLogo" },
      ],
    });
    const psEntries = state.tabTemplates.filter((t) => t.id === "powershell");
    expect(psEntries).toHaveLength(1);
    expect(psEntries[0].title).toBe("PS 7");
  });

  test.runIf(!isWindows)("normalizeState on non-Windows adds bash/zsh/fish after shell", () => {
    const state = normalizeState({
      tabTemplates: [
        { id: "shell", title: "Shell", command: "", icon: "\u{1F4BB}" },
        { id: "claude", title: "Claude Code", command: "claude", icon: "\u{1F916}" },
      ],
    });
    const ids = state.tabTemplates.map((t) => t.id);
    expect(ids).toContain("bash");
    expect(ids).toContain("zsh");
    expect(ids).toContain("fish");
    expect(ids).not.toContain("powershell");
    expect(ids).not.toContain("wsl");
  });

  test("normalizeState preserves the platforms field on templates", () => {
    const state = normalizeState({
      tabTemplates: [{ id: "custom", title: "Win-only", command: "foo", platforms: ["win32"] }],
    });
    const custom = state.tabTemplates.find((t) => t.id === "custom");
    expect(custom?.platforms).toEqual(["win32"]);
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
    expect(logsPanel!.launch!.file).toBe("wsl.exe");
    expect(logsPanel!.launch!.args![3]).toContain("docker logs -f api");
  });

  test("normalizeWorkspace preserves plugin workspace metadata", () => {
    const workspace = normalizeWorkspace({
      id: "system-monitor",
      kind: "terminal",
      source: "plugin",
      pluginId: "system-monitor",
      panels: [{ id: "monitor", title: "Monitor", command: "btm" }],
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
        pullRequest: {
          id: 123,
          title: "Fix login redirect",
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
        },
        checkout: { mode: "managed-worktree", rootPath: "C:/work/review", cacheRepoPath: "C:/cache/repo" },
      },
    });

    expect(workspace.review!.prKey).toBe("ado-main:repo-1:123");
    expect(workspace.review!.parentWorkspaceId).toBe("azure-root");
    expect(workspace.review!.checkout!.cacheRepoPath).toBe("C:/cache/repo");
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
          panels: [{ id: "lazydocker", title: "Lazydocker", command: "lazydocker" }],
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

  test("normalizeState groups worktrees under same-profile parent when duplicates exist", () => {
    const state = normalizeState({
      profiles: [
        { id: "profile-a", name: "A" },
        { id: "profile-b", name: "B" },
      ],
      workspaces: [
        { id: "st-other", name: "strideterm", profileId: "profile-a", cwd: "C:/work/strideterm" },
        {
          id: "st-child1",
          name: "strideterm / filemanager",
          notes: "Worktree of strideterm",
          profileId: "profile-b",
          cwd: "C:/work/strideterm/.strideterm/tree/filemanager",
        },
        { id: "ide-other", name: "IDE", profileId: "profile-a", cwd: "C:/work/strideterm" },
        {
          id: "ide-child1",
          name: "IDE / metaterm",
          notes: "Worktree of IDE",
          profileId: "profile-b",
          cwd: "C:/work/strideterm/.strideterm/tree/metaterm",
        },
        { id: "admin", name: "Admin FE", profileId: "profile-b", cwd: "C:/work/admin" },
        { id: "st-parent", name: "strideterm", profileId: "profile-b", cwd: "C:/work/strideterm" },
      ],
    });

    const names = state.workspaces.map((w) => w.name);
    // Children must follow their same-profile parent via cwd matching, not the other-profile duplicate
    expect(names).toEqual([
      "strideterm", // st-other (profile-a)
      "IDE", // ide-other (profile-a)
      "Admin FE", // admin (profile-b)
      "strideterm", // st-parent (profile-b)
      "strideterm / filemanager", // cwd-matched to st-parent (same profile)
      "IDE / metaterm", // cwd-matched to st-parent (same profile, no IDE in profile-b)
    ]);
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

  test("normalizeWorkspace preserves task runtime properties through store.mutate()", () => {
    const workspace = normalizeWorkspace({
      id: "task-ws",
      kind: "task",
      panels: [
        { id: "dash", title: "Dashboard", command: "__task-dashboard__" },
        { id: "worker", title: "Worker", command: "claude" },
        { id: "judge", title: "Judge", command: "claude" },
      ],
      task: {
        taskId: "test-task-id",
        description: "test task",
        workerPanelId: "worker",
        judgePanelId: "judge",
        state: "running",
        currentRound: 2,
        // Runtime-only properties set by task runner during execution
        promptSent: true,
        pausedFromState: "evaluating",
        showerResumePrompt: "Resume: continue working on the task",
      },
    });

    expect(workspace.task!.promptSent).toBe(true);
    expect(workspace.task!.pausedFromState).toBe("evaluating");
    expect(workspace.task!.showerResumePrompt).toBe("Resume: continue working on the task");
  });

  test("normalizeWorkspace defaults task runtime properties to safe values", () => {
    const workspace = normalizeWorkspace({
      id: "task-ws",
      kind: "task",
      panels: [{ id: "worker", title: "Worker", command: "claude" }],
      task: {
        taskId: "test-task-id",
        description: "test",
        // Runtime properties NOT set (undefined) — should default safely
      },
    });

    expect(workspace.task!.promptSent).toBe(false);
    expect(workspace.task!.pausedFromState).toBe("");
    expect(workspace.task!.showerResumePrompt).toBe("");
  });

  test("workspace with gitRoots round-trips through normalize", () => {
    const workspace = normalizeWorkspace({
      id: "monorepo",
      name: "Monorepo",
      cwd: "C:/work/monorepo",
      panels: [{ id: "shell", title: "Shell", command: "" }],
      gitRoots: ["C:/work/monorepo/web", "C:/work/monorepo/api", "C:/work/monorepo/infra"],
    });

    // Paths are normalized to forward slashes and sorted alphabetically
    expect(workspace.gitRoots).toEqual(["C:/work/monorepo/api", "C:/work/monorepo/infra", "C:/work/monorepo/web"]);
    expect(workspace.gitRoots.length).toBe(3);
  });

  test("missing gitRoots normalizes to []", () => {
    const workspace = normalizeWorkspace({
      id: "single-repo",
      name: "Single Repo",
      cwd: "C:/work/app",
      panels: [{ id: "shell", title: "Shell", command: "" }],
    });

    expect(workspace.gitRoots).toEqual([]);
  });

  test("azure workspace gitRoots forced to []", () => {
    const workspace = normalizeWorkspace({
      id: "azure-root",
      kind: "azure",
      name: "Azure",
      gitRoots: ["C:/work/repo1", "C:/work/repo2"],
    });

    expect(workspace.gitRoots).toEqual([]);
  });

  test("panel cwd is preserved", () => {
    const workspace = normalizeWorkspace({
      id: "ws1",
      name: "WS1",
      cwd: "C:/work/parent",
      panels: [
        { id: "api", title: "API", command: "", cwd: "C:/work/parent/api" },
        { id: "web", title: "Web", command: "" },
      ],
    });

    const apiPanel = workspace.panels.find((p) => p.id === "api");
    const webPanel = workspace.panels.find((p) => p.id === "web");
    expect(apiPanel!.cwd).toBe("C:/work/parent/api");
    expect(webPanel!.cwd).toBe("");
  });

  test("activeRootPath is preserved in workspace uiState", () => {
    const workspace = normalizeWorkspace({
      id: "ws-multi",
      name: "Multi",
      cwd: "C:/work/ms",
      panels: [{ id: "shell", title: "Shell", command: "" }],
      activeRootPath: "C:/work/ms/api",
    });

    expect(workspace.activeRootPath).toBe("C:/work/ms/api");
  });

  test("normalizeState indexes gitRoots in byCwd so worktree children find multi-repo parent", () => {
    const state = normalizeState({
      workspaces: [
        {
          id: "parent",
          name: "monorepo",
          cwd: "C:/work/monorepo",
          gitRoots: ["C:/work/monorepo/api", "C:/work/monorepo/web"],
        },
        {
          id: "child-task",
          name: "monorepo / feature",
          notes: "Worktree of monorepo",
          cwd: "C:/work/monorepo/.strideterm/tree/feature",
        },
      ],
    });

    const ids = state.workspaces.map((w) => w.id);
    // Child should be grouped right after parent
    expect(ids.indexOf("child-task")).toBe(ids.indexOf("parent") + 1);
  });

  describe("terminalFontSize settings", () => {
    test("createDefaultState sets both font size keys to 13", () => {
      const state = createDefaultState();
      expect(state.settings.terminalFontSizeLocal).toBe(13);
      expect(state.settings.terminalFontSizeRemote).toBe(13);
    });

    test("normalizeState backfills missing font size keys to 13", () => {
      const state = normalizeState({ settings: { theme: "dark" } });
      expect(state.settings.terminalFontSizeLocal).toBe(13);
      expect(state.settings.terminalFontSizeRemote).toBe(13);
    });

    test("normalizeState preserves valid font size values", () => {
      const state = normalizeState({
        settings: { terminalFontSizeLocal: 18, terminalFontSizeRemote: 20 },
      });
      expect(state.settings.terminalFontSizeLocal).toBe(18);
      expect(state.settings.terminalFontSizeRemote).toBe(20);
    });

    test("normalizeState clamps values below 8 up to 8", () => {
      const state = normalizeState({
        settings: { terminalFontSizeLocal: 4, terminalFontSizeRemote: 0 },
      });
      expect(state.settings.terminalFontSizeLocal).toBe(8);
      expect(state.settings.terminalFontSizeRemote).toBe(8);
    });

    test("normalizeState clamps values above 32 down to 32", () => {
      const state = normalizeState({
        settings: { terminalFontSizeLocal: 100, terminalFontSizeRemote: 999 },
      });
      expect(state.settings.terminalFontSizeLocal).toBe(32);
      expect(state.settings.terminalFontSizeRemote).toBe(32);
    });

    test("normalizeState falls back to 13 for non-numeric values", () => {
      const state = normalizeState({
        settings: { terminalFontSizeLocal: "big", terminalFontSizeRemote: null },
      });
      expect(state.settings.terminalFontSizeLocal).toBe(13);
      expect(state.settings.terminalFontSizeRemote).toBe(13);
    });
  });
});

describe("normalizeWorkspaceGrid", () => {
  const ws = (id: string, profileId = "default") =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ id, profileId, name: id, command: "", panels: [], icon: "" }) as any;

  test("returns null for null/non-object input", () => {
    expect(normalizeWorkspaceGrid(null, [], "default")).toBeNull();
    expect(normalizeWorkspaceGrid(undefined, [], "default")).toBeNull();
    expect(normalizeWorkspaceGrid("cols", [], "default")).toBeNull();
  });

  test("returns null for invalid layout", () => {
    expect(normalizeWorkspaceGrid({ layout: "unknown", cellWorkspaceIds: ["a"] }, [ws("a")], "default")).toBeNull();
  });

  test("returns null when all cells are null after normalisation", () => {
    expect(normalizeWorkspaceGrid({ layout: "cols", cellWorkspaceIds: [null, null] }, [], "default")).toBeNull();
  });

  test("filters out workspace IDs not in the active profile", () => {
    const result = normalizeWorkspaceGrid(
      { layout: "cols", cellWorkspaceIds: ["ws1", "ws2"] },
      [ws("ws1", "profile-a"), ws("ws2", "profile-b")],
      "profile-a",
    );
    expect(result).not.toBeNull();
    expect(result!.cellWorkspaceIds).toEqual(["ws1", null]);
  });

  test("removes duplicate IDs — keeps first occurrence, nulls subsequent", () => {
    const result = normalizeWorkspaceGrid(
      { layout: "grid", cellWorkspaceIds: ["ws1", "ws1", "ws2", "ws1"] },
      [ws("ws1"), ws("ws2")],
      "default",
    );
    expect(result).not.toBeNull();
    expect(result!.cellWorkspaceIds).toEqual(["ws1", null, "ws2", null]);
  });

  test("trims cellWorkspaceIds to the number of slots for the layout", () => {
    const result = normalizeWorkspaceGrid(
      { layout: "cols", cellWorkspaceIds: ["ws1", "ws2", "ws3", "ws4"] },
      [ws("ws1"), ws("ws2"), ws("ws3"), ws("ws4")],
      "default",
    );
    expect(result).not.toBeNull();
    expect(result!.cellWorkspaceIds).toHaveLength(2);
    expect(result!.cellWorkspaceIds).toEqual(["ws1", "ws2"]);
  });

  test("pads missing slots with null", () => {
    const result = normalizeWorkspaceGrid({ layout: "cols", cellWorkspaceIds: ["ws1"] }, [ws("ws1")], "default");
    expect(result).not.toBeNull();
    expect(result!.cellWorkspaceIds).toEqual(["ws1", null]);
  });

  test("returns a valid result for all supported layouts", () => {
    const workspaces = ["a", "b", "c", "d"].map((id) => ws(id));
    for (const layout of ["cols", "rows", "top-split", "left-split", "grid"]) {
      const result = normalizeWorkspaceGrid({ layout, cellWorkspaceIds: ["a", "b", "c", "d"] }, workspaces, "default");
      expect(result).not.toBeNull();
      expect(result!.layout).toBe(layout);
    }
  });
});
