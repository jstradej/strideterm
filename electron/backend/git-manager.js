import path from "node:path";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { execFileText, quotePosixArg } from "./process-utils.js";
import { APP_CONFIG } from "../../config/app-config.js";

function createUnavailableSnapshot(workspace, error = "") {
  return {
    workspaceId: workspace.id,
    projectId: workspace.id,
    cwd: workspace.cwd || "",
    available: false,
    root: "",
    repository: "",
    branch: "",
    commitCount: 0,
    dirty: false,
    dirtyCount: 0,
    status: [],
    log: [],
    lazygit: {
      available: false,
      backend: null,
      error: "",
      launch: null,
    },
    error,
    lastUpdatedAt: null,
  };
}

function toWslPath(cwd) {
  const normalized = String(cwd || "").replaceAll("\\", "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) {
    return null;
  }

  const [, drive, rest] = match;
  return `/mnt/${drive.toLowerCase()}/${rest}`;
}

function parseStatusEntries(rawText) {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2).trim() || "??",
      path: line.slice(3).trim(),
    }));
}

function parseGitLog(rawText) {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [shortHash = "", relativeDate = "", author = "", refs = "", subject = ""] = line.split("\t");
      return {
        shortHash,
        relativeDate,
        author,
        refs: refs.trim(),
        subject,
      };
    });
}

async function execGit(cwd, args) {
  return execFileText("git", args, { cwd });
}

function resolveLazygitBinary() {
  const wingetRoot = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  if (wingetRoot && existsSync(wingetRoot)) {
    const packageDir = readdirSync(wingetRoot, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith(APP_CONFIG.git.lazygitWingetPackagePrefix));
    if (packageDir) {
      const binaryPath = path.join(wingetRoot, packageDir.name, "lazygit.exe");
      if (existsSync(binaryPath)) {
        return binaryPath;
      }
    }
  }

  return "lazygit";
}

export class GitManager extends EventEmitter {
  constructor() {
    super();
    this.snapshots = new Map();
  }

  getWorkspaceMap() {
    return Object.fromEntries(this.snapshots.entries());
  }

  getProjectMap() {
    return this.getWorkspaceMap();
  }

  getSnapshot(workspaceId) {
    return this.snapshots.get(workspaceId) || null;
  }

  async detectLazygit(workspace) {
    const hostBinary = resolveLazygitBinary();
    try {
      await execFileText(hostBinary, ["--version"], { cwd: workspace.cwd });
      return {
        available: true,
        backend: "host",
        error: "",
        launch: {
          file: hostBinary,
          args: [],
        },
      };
    } catch {
      // Continue to WSL fallback when the project path can be mapped there.
    }

    const wslCwd = toWslPath(workspace.cwd);
    if (!wslCwd) {
      return {
        available: false,
        backend: null,
        error: "Lazygit was not found on Windows PATH.",
        launch: null,
      };
    }

    try {
      await execFileText("wsl.exe", ["-e", "sh", "-lc", "command -v lazygit >/dev/null 2>&1 && lazygit --version"]);
      return {
        available: true,
        backend: "wsl",
        error: "",
        launch: {
          file: "wsl.exe",
          args: ["-e", "sh", "-lc", `cd ${quotePosixArg(wslCwd)} && exec lazygit`],
        },
      };
    } catch {
      return {
        available: false,
        backend: null,
        error: "Lazygit was not found on Windows PATH or inside WSL.",
        launch: null,
      };
    }
  }

  async inspectWorkspace(workspace) {
    if (!workspace || workspace.kind === "docker" || !workspace.cwd) {
      return createUnavailableSnapshot(workspace || { id: "", cwd: "" }, "Git metadata is available only for file-backed workspaces.");
    }

    try {
      const rootResult = await execGit(workspace.cwd, ["rev-parse", "--show-toplevel"]);
      const root = rootResult.stdout.trim();
      const [
        branchResult,
        commitCountResult,
        statusResult,
        logResult,
        lazygit,
      ] = await Promise.all([
        execGit(workspace.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({ stdout: "HEAD", stderr: "" })),
        execGit(workspace.cwd, ["rev-list", "--count", "HEAD"]).catch(() => ({ stdout: "0", stderr: "" })),
        execGit(workspace.cwd, ["status", "--short"]).catch(() => ({ stdout: "", stderr: "" })),
        execGit(workspace.cwd, [
          "log",
          "--date=relative",
          "--pretty=format:%h%x09%ad%x09%an%x09%d%x09%s",
          "-n",
          String(APP_CONFIG.git.recentLogLimit),
        ]).catch(() => ({ stdout: "", stderr: "" })),
        this.detectLazygit(workspace),
      ]);

      const status = parseStatusEntries(statusResult.stdout);

      return {
        workspaceId: workspace.id,
        projectId: workspace.id,
        cwd: workspace.cwd,
        available: true,
        root,
        repository: path.basename(root),
        branch: branchResult.stdout.trim() || "HEAD",
        commitCount: Number.parseInt(commitCountResult.stdout.trim(), 10) || 0,
        dirty: status.length > 0,
        dirtyCount: status.length,
        status,
        log: parseGitLog(logResult.stdout),
        lazygit,
        error: "",
        lastUpdatedAt: new Date().toISOString(),
      };
    } catch (error) {
      return createUnavailableSnapshot(workspace, error.stderr || error.error?.message || "Git repository not detected.");
    }
  }

  async inspectProject(project) {
    return this.inspectWorkspace(project);
  }

  async refreshWorkspaces(workspaces = []) {
    const nextSnapshots = new Map();
    const results = await Promise.all(
      workspaces.map(async (workspace) => [workspace.id, await this.inspectWorkspace(workspace)]),
    );

    for (const [workspaceId, snapshot] of results) {
      nextSnapshots.set(workspaceId, snapshot);
    }

    this.snapshots = nextSnapshots;
    this.emit("updated", this.getWorkspaceMap());
    return this.getWorkspaceMap();
  }

  async refreshProjects(projects = []) {
    const nextSnapshots = new Map();
    const results = await Promise.all(
      projects.map(async (project) => [project.id, await this.inspectProject(project)]),
    );

    for (const [projectId, snapshot] of results) {
      nextSnapshots.set(projectId, snapshot);
    }

    this.snapshots = nextSnapshots;
    this.emit("updated", this.getWorkspaceMap());
    return this.getWorkspaceMap();
  }

  createLazygitLaunch(workspaceId) {
    const snapshot = this.getSnapshot(workspaceId);
    return snapshot?.lazygit?.launch
      ? {
          file: snapshot.lazygit.launch.file,
          args: [...snapshot.lazygit.launch.args],
        }
      : null;
  }
}
