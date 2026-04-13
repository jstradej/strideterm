import path from "node:path";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { execFileText, quotePosixArg } from "./process-utils.js";
import { encodeAuthHeader, sanitizeGitEnvironment } from "./shared/git-auth-utils.js";
import { APP_CONFIG } from "../../config/app-config.js";
import { getLogger } from "./logger.js";
import {
  DEFAULT_DIFF_STAT,
  DEFAULT_OPERATION_STATE,
  createUnavailableSnapshot,
  toWslPath,
  normalizeBranchName,
  parseIntSafe,
  resolveGitPath,
  parseDiffStatLine,
  mergeDiffStats,
  summarizeNameStatusEntries,
  parseGitLog,
  parseNameStatus,
  parseGitRemotes,
  parseRevListCount,
  parseStatusEntries,
  parsePorcelainV2,
  parseWorktreeList,
  readBranchList,
  preferBaseBranch,
  buildBaseBranchCandidates,
  buildOperationState,
  extractErrorMessage,
  createOperationWarnings,
  createStructuredResult,
  resolveContinueArgs,
  resolveAbortArgs,
  inspectWorktreeDirtyState,
  joinRawOutput,
  uniqueByPath,
  mapStatusForLegacy,
  trimDiffPreview,
  renderUntrackedDiffPreview,
  getFetchTimestamp,
} from "./git-parsers.js";

const log = getLogger("git");

const WORKTREE_DIRTY_CACHE_TTL_MS = 1500;
const SNAPSHOT_CACHE_TTL_MS = 8000;

export class GitManager extends EventEmitter {
  constructor({
    execGitImpl = null,
    now = null,
    snapshotCacheTtlMs = SNAPSHOT_CACHE_TTL_MS,
    credentialStore = null,
    auditLogStore = null,
  } = {}) {
    super();
    this.snapshots = new Map();
    this.execGitImpl = execGitImpl;
    this.now = now || (() => new Date());
    this.worktreeDirtyCache = new Map();
    this.snapshotCache = new Map();
    this.snapshotCacheTtlMs = snapshotCacheTtlMs;
    this.credentialStore = credentialStore;
    this.auditLogStore = auditLogStore;
  }

  async execGit(cwd, args) {
    if (this.execGitImpl) {
      return this.execGitImpl(cwd, args);
    }
    return execFileText("git", args, { cwd });
  }

  /**
   * Run a git command with optional token-based authentication.
   * When a connection provides login + tokenRef, the PAT is injected via
   * `git -c http.extraheader=…` so the operation is audited under the
   * correct Azure DevOps / provider identity.
   */
  async execAuthGit(cwd, args, { connection = null } = {}) {
    if (!connection?.tokenRef || !this.credentialStore) {
      return this.execGit(cwd, args);
    }

    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      return this.execGit(cwd, args);
    }

    const extraArgs = [];
    if (process.platform === "win32") {
      extraArgs.push("-c", "core.longpaths=true");
    }
    const login = connection.login || connection.currentUserLogin || "x-access-token";
    extraArgs.push("-c", `http.extraheader=${encodeAuthHeader(login, token)}`);

    if (this.execGitImpl) {
      return this.execGitImpl(cwd, [...extraArgs, ...args]);
    }
    return execFileText("git", [...extraArgs, ...args], { cwd, env: sanitizeGitEnvironment() });
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

  async getCachedWorktreeDirtyState(worktreePath, fallbackDirty = false) {
    const cacheKey = path.resolve(worktreePath);
    const cached = this.worktreeDirtyCache.get(cacheKey);
    const now = this.now().getTime();

    if (cached && now - cached.at < WORKTREE_DIRTY_CACHE_TTL_MS) {
      return cached.value;
    }

    const value = await inspectWorktreeDirtyState(this.execGit.bind(this), worktreePath, fallbackDirty);
    this.worktreeDirtyCache.set(cacheKey, { at: now, value });
    return value;
  }

  async detectLazygit(workspace) {
    const hostBinary = this.resolveLazygitBinary();
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
      // Fall through to WSL detection.
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

  resolveLazygitBinary() {
    const wingetRoot = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
    if (wingetRoot && existsSync(wingetRoot)) {
      const packageDir = readdirSync(wingetRoot, { withFileTypes: true }).find(
        (entry) => entry.isDirectory() && entry.name.startsWith(APP_CONFIG.git.lazygitWingetPackagePrefix),
      );
      if (packageDir) {
        const binaryPath = path.join(wingetRoot, packageDir.name, "lazygit.exe");
        if (existsSync(binaryPath)) {
          return binaryPath;
        }
      }
    }

    return "lazygit";
  }

  async inspectWorkspace(workspace) {
    if (!workspace || workspace.kind === "docker" || !workspace.cwd) {
      return createUnavailableSnapshot(
        workspace || { id: "", cwd: "" },
        "Git metadata is available only for file-backed workspaces.",
      );
    }

    try {
      const rootResult = await this.execGit(workspace.cwd, ["rev-parse", "--show-toplevel"]);
      const root = rootResult.stdout.trim();
      const [
        branchResult,
        remoteResult,
        commitCountResult,
        statusV2Result,
        statusShortResult,
        logResult,
        lazygit,
        gitDirResult,
        gitCommonDirResult,
        worktreeListResult,
        branchListResult,
      ] = await Promise.all([
        this.execGit(workspace.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({
          stdout: "HEAD",
          stderr: "",
        })),
        this.execGit(workspace.cwd, ["remote", "-v"]).catch(() => ({ stdout: "", stderr: "" })),
        this.execGit(workspace.cwd, ["rev-list", "--count", "HEAD"]).catch(() => ({ stdout: "0", stderr: "" })),
        this.execGit(workspace.cwd, ["status", "--porcelain=v2", "--branch"]).catch(() => ({ stdout: "", stderr: "" })),
        this.execGit(workspace.cwd, ["status", "--short"]).catch(() => ({ stdout: "", stderr: "" })),
        this.execGit(workspace.cwd, [
          "log",
          "--date=relative",
          "--pretty=format:%h%x09%ad%x09%an%x09%d%x09%s",
          "-n",
          String(APP_CONFIG.git.recentLogLimit),
        ]).catch(() => ({ stdout: "", stderr: "" })),
        this.detectLazygit(workspace),
        this.execGit(workspace.cwd, ["rev-parse", "--git-dir"]).catch(() => ({ stdout: ".git", stderr: "" })),
        this.execGit(workspace.cwd, ["rev-parse", "--git-common-dir"]).catch(() => ({ stdout: ".git", stderr: "" })),
        this.execGit(workspace.cwd, ["worktree", "list", "--porcelain"]).catch(() => ({ stdout: "", stderr: "" })),
        this.execGit(workspace.cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]).catch(
          () => ({ stdout: "", stderr: "" }),
        ),
      ]);

      const gitDir = resolveGitPath(workspace.cwd, gitDirResult.stdout);
      const gitCommonDir = resolveGitPath(workspace.cwd, gitCommonDirResult.stdout);
      const parsedStatus = parsePorcelainV2(statusV2Result.stdout);
      const staged = parsedStatus.staged;
      const unstaged = parsedStatus.unstaged;
      const untracked = parsedStatus.untracked;
      const conflicts = parsedStatus.conflicts;
      const dirtyCount = uniqueByPath([...staged, ...unstaged, ...untracked, ...conflicts]).length;
      const status = mapStatusForLegacy(staged, unstaged, untracked);
      const worktrees = parseWorktreeList(worktreeListResult.stdout);
      const mainWorktree = worktrees[0] || null;
      const branchNames = readBranchList(branchListResult.stdout);
      const branch =
        parsedStatus.branch && parsedStatus.branch !== "(detached)"
          ? parsedStatus.branch
          : branchResult.stdout.trim() || "HEAD";
      const upstream = parsedStatus.upstream || (await this.readUpstream(workspace.cwd));
      // For review workspaces, compare against the remote source branch (where we push to).
      // The target branch (where the PR merges into) is handled by the Summary tab's "Rebase on target".
      const reviewSourceRef = String(workspace.review?.pullRequest?.sourceRefName || "")
        .replace(/^refs\/heads\//, "")
        .trim();
      const baseBranch = reviewSourceRef
        ? `origin/${reviewSourceRef}`
        : await this.detectBestBaseBranch(workspace.cwd, branch, upstream, branchNames);
      const [compareWithBase, stashCount] = await Promise.all([
        this.readBaseComparison(workspace.cwd, baseBranch, branch),
        this.getStashCount(workspace.cwd),
      ]);
      const operationState = await this.inspectOperationState(workspace.cwd, { gitDir, gitCommonDir });
      const stagedDiffStat = await this.readDiffStat(workspace.cwd, ["diff", "--cached", "--shortstat"]);
      const unstagedDiffStat = await this.readDiffStat(workspace.cwd, ["diff", "--shortstat"]);
      const untrackedDiffStat = summarizeNameStatusEntries(untracked.map((entry) => ({ code: "?", path: entry.path })));
      // Check if this worktree's branch has been merged into the base branch.
      // Only mark as merged if: not the main worktree, not dirty, HEAD is ancestor of baseBranch,
      // and the branch actually had commits (behindCount > 0 means baseBranch moved ahead, e.g. via merge).
      const isMainWorktree =
        worktrees.length > 1 && worktrees[0]?.path && path.resolve(worktrees[0].path) === path.resolve(root);
      let branchMerged = false;
      if (worktrees.length > 1 && !isMainWorktree && baseBranch && branch !== baseBranch && dirtyCount === 0) {
        try {
          await this.execGit(root, ["merge-base", "--is-ancestor", "HEAD", baseBranch]);
          // HEAD is in baseBranch — mark merged if baseBranch is ahead (non-fast-forward merge)
          // or if the workspace was explicitly marked as merged (fast-forward merge case where
          // HEAD and baseBranch point to the same commit, making behindCount === 0)
          const countResult = await this.execGit(root, ["rev-list", "--count", `HEAD..${baseBranch}`]);
          const behindCount = parseInt(countResult.stdout.trim(), 10) || 0;
          branchMerged = behindCount > 0 || !!workspace.branchMerged;
        } catch {
          // exit code 1 = not merged, or command failed — also clears any stale workspace flag
        }
      }

      const siblingWorktrees = await Promise.all(
        worktrees.map(async (entry, index) => {
          const isCurrent = path.resolve(entry.path) === path.resolve(root);
          const dirtyState = isCurrent
            ? { dirty: dirtyCount > 0, dirtyCount }
            : await this.getCachedWorktreeDirtyState(entry.path);
          return {
            path: entry.path,
            branch: entry.branch || (entry.detached ? "detached" : ""),
            head: entry.head || "",
            isCurrent,
            isMainWorktree: index === 0,
            dirty: dirtyState.dirty,
            dirtyCount: dirtyState.dirtyCount,
            detached: entry.detached,
            bare: entry.bare,
            locked: entry.locked,
            prunable: entry.prunable,
          };
        }),
      );

      return {
        workspaceId: workspace.id,
        projectId: workspace.id,
        cwd: workspace.cwd,
        available: true,
        root,
        repository: path.basename(root),
        branch,
        remotes: parseGitRemotes(remoteResult.stdout),
        commitCount: parseIntSafe(commitCountResult.stdout),
        dirty: dirtyCount > 0,
        dirtyCount,
        status: status.length ? status : parseStatusEntries(statusShortResult.stdout),
        staged,
        unstaged,
        untracked,
        changes: {
          staged: { name: "Staged", files: staged, diffStat: stagedDiffStat },
          unstaged: { name: "Unstaged", files: [...unstaged, ...conflicts], diffStat: unstagedDiffStat },
          untracked: { name: "Untracked", files: untracked, diffStat: untrackedDiffStat },
        },
        diffStat: mergeDiffStats(stagedDiffStat, unstagedDiffStat, untrackedDiffStat),
        log: parseGitLog(logResult.stdout),
        lazygit,
        gitDir,
        gitCommonDir,
        isWorktree: worktrees.length > 1,
        isMainWorktree: siblingWorktrees.find((entry) => entry.isCurrent)?.isMainWorktree || false,
        branchMerged,
        worktreePath: root,
        mainWorktreePath: mainWorktree?.path || root,
        siblingWorktrees,
        upstream,
        baseBranch,
        branchNames,
        stashCount,
        aheadCount: parsedStatus.aheadCount,
        behindCount: parsedStatus.behindCount,
        compareWithBase,
        lastFetchAt: getFetchTimestamp(gitCommonDir),
        operationState: operationState.inProgress
          ? buildOperationState({ kind: operationState.kind, conflicts: operationState.conflicts })
          : { ...DEFAULT_OPERATION_STATE },
        error: "",
        lastUpdatedAt: this.now().toISOString(),
      };
    } catch (error) {
      return createUnavailableSnapshot(workspace, extractErrorMessage(error));
    }
  }

  async inspectProject(project) {
    return this.inspectWorkspace(project);
  }

  async readUpstream(cwd) {
    try {
      const result = await this.execGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
      return result.stdout.trim();
    } catch {
      return "";
    }
  }

  async readDiffStat(cwd, args) {
    try {
      const result = await this.execGit(cwd, args);
      return parseDiffStatLine(result.stdout.trim());
    } catch {
      return { ...DEFAULT_DIFF_STAT };
    }
  }

  async readBaseComparison(cwd, baseBranch, currentBranch) {
    if (!baseBranch) {
      return {
        baseBranch: "",
        aheadCount: 0,
        behindCount: 0,
        commits: [],
        files: [],
        diffStat: { ...DEFAULT_DIFF_STAT },
        potentialConflicts: [],
        baseChangedFiles: [],
      };
    }

    if (normalizeBranchName(baseBranch) === normalizeBranchName(currentBranch)) {
      return {
        baseBranch,
        aheadCount: 0,
        behindCount: 0,
        commits: [],
        files: [],
        diffStat: { ...DEFAULT_DIFF_STAT },
        potentialConflicts: [],
        baseChangedFiles: [],
      };
    }

    const compareTarget = baseBranch;
    const [countResult, logResult, filesResult, diffStatResult] = await Promise.all([
      this.execGit(cwd, ["rev-list", "--left-right", "--count", `HEAD...${compareTarget}`]).catch(() => ({
        stdout: "0\t0",
        stderr: "",
      })),
      this.execGit(cwd, [
        "log",
        "--date=relative",
        "--pretty=format:%h%x09%ad%x09%an%x09%d%x09%s",
        "-n",
        String(APP_CONFIG.git.recentLogLimit),
        `${compareTarget}..HEAD`,
      ]).catch(() => ({ stdout: "", stderr: "" })),
      this.execGit(cwd, ["diff", "--name-status", `${compareTarget}...HEAD`]).catch(() => ({ stdout: "", stderr: "" })),
      this.execGit(cwd, ["diff", "--shortstat", `${compareTarget}...HEAD`]).catch(() => ({ stdout: "", stderr: "" })),
    ]);

    const counts = parseRevListCount(countResult.stdout);
    const files = parseNameStatus(filesResult.stdout);
    const diffStatSummary = parseDiffStatLine(diffStatResult.stdout.trim());
    const fileSummary = summarizeNameStatusEntries(files);

    const branchFilePaths = new Set(files.map((entry) => entry.path));
    let potentialConflicts = [];
    let baseChangedFiles = [];
    try {
      const baseChangesResult = await this.execGit(cwd, ["diff", "--name-only", `HEAD...${compareTarget}`]);
      const baseFiles = String(baseChangesResult.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      baseChangedFiles = baseFiles;
      potentialConflicts = baseFiles.filter((filePath) => branchFilePaths.has(filePath));
    } catch {
      // base comparison failed, skip conflict detection
    }

    return {
      baseBranch,
      aheadCount: counts.left,
      behindCount: counts.right,
      commits: parseGitLog(logResult.stdout),
      files,
      diffStat: {
        ...fileSummary,
        insertions: diffStatSummary.insertions,
        deletions: diffStatSummary.deletions,
      },
      potentialConflicts,
      baseChangedFiles,
    };
  }

  async inspectOperationState(cwd, { gitDir, gitCommonDir }) {
    const mergeHeadPath = path.join(gitDir, "MERGE_HEAD");
    const cherryPickHeadPath = path.join(gitDir, "CHERRY_PICK_HEAD");
    const rebaseMergePath = path.join(gitDir, "rebase-merge");
    const rebaseApplyPath = path.join(gitDir, "rebase-apply");
    const bisectPath = path.join(gitCommonDir || gitDir, "BISECT_LOG");
    const conflicts = await this.readConflicts(cwd);

    if (existsSync(mergeHeadPath)) {
      return { kind: "merge", inProgress: true, conflicts };
    }
    if (existsSync(rebaseMergePath) || existsSync(rebaseApplyPath)) {
      return { kind: "rebase", inProgress: true, conflicts };
    }
    if (existsSync(cherryPickHeadPath)) {
      return { kind: "cherry-pick", inProgress: true, conflicts };
    }
    if (existsSync(bisectPath)) {
      return { kind: "bisect", inProgress: true, conflicts };
    }

    return { kind: "idle", inProgress: false, conflicts: [] };
  }

  async readConflicts(cwd) {
    try {
      const result = await this.execGit(cwd, ["diff", "--name-only", "--diff-filter=U"]);
      return String(result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  invalidateSnapshotCache(workspaceId = null) {
    if (workspaceId) {
      this.snapshotCache.delete(workspaceId);
    } else {
      this.snapshotCache.clear();
    }
  }

  async refreshWorkspaces(workspaces = []) {
    const now = this.now().getTime();
    const nextSnapshots = new Map();
    const results = await Promise.all(
      workspaces.map(async (workspace) => {
        const cached = this.snapshotCache.get(workspace.id);
        if (cached && now - cached.at < this.snapshotCacheTtlMs) {
          return [workspace.id, cached.snapshot];
        }
        const snapshot = await this.inspectWorkspace(workspace);
        this.snapshotCache.set(workspace.id, { at: this.now().getTime(), snapshot });
        return [workspace.id, snapshot];
      }),
    );

    for (const [workspaceId, snapshot] of results) {
      nextSnapshots.set(workspaceId, snapshot);
    }

    // Merge into existing snapshots — don't discard snapshots for workspaces not in this refresh
    for (const [workspaceId, snapshot] of nextSnapshots) {
      this.snapshots.set(workspaceId, snapshot);
    }
    this.emit("updated", this.getWorkspaceMap());
    return this.getWorkspaceMap();
  }

  async refreshProjects(projects = []) {
    return this.refreshWorkspaces(projects);
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

  async fetch(workspace, { connection = null } = {}) {
    return this.runWriteAction(workspace, {
      type: "fetch",
      label: "Fetch",
      run: async (cwd) => this.execAuthGit(cwd, ["fetch", "--all", "--prune"], { connection }),
      allowDirty: true,
      connection,
    });
  }

  async pull(workspace, { connection = null } = {}) {
    return this.runWriteAction(workspace, {
      type: "pull",
      label: "Pull",
      run: async (cwd) => this.execAuthGit(cwd, ["pull", "--ff-only"], { connection }),
      allowDirty: true,
      connection,
    });
  }

  async push(workspace, { connection = null } = {}) {
    const snapshot = await this.inspectWorkspace(workspace);
    if (!snapshot.available) {
      return createStructuredResult({ ok: false, summary: snapshot.error || "Git workspace is unavailable." });
    }

    const branch = snapshot.branch;
    if (!branch) {
      return createStructuredResult({ ok: false, summary: "Cannot push: no branch is checked out (detached HEAD)." });
    }

    const upstream = snapshot.upstream || "";
    // Extract remote name from upstream (e.g. "origin/feature-1" → "origin")
    // For worktrees or repos with non-"origin" remotes, this picks the right one.
    const remoteNames = Object.keys(snapshot.remotes || {}).filter((k) => !k.includes(":"));
    const remote = remoteNames.find((r) => upstream.startsWith(`${r}/`)) || remoteNames[0] || "origin";
    const upstreamBranch = upstream.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : "";
    const upstreamMatchesBranch = upstreamBranch === branch;

    // Decide push strategy:
    // - upstream tracks same branch name on remote: simple push
    // - upstream missing or tracks different branch: set-upstream to fix tracking
    const pushArgs = upstreamMatchesBranch ? ["push", remote, "HEAD"] : ["push", "--set-upstream", remote, branch];
    const target = `${remote}/${branch}`;

    return this.runWriteAction(workspace, {
      type: "push",
      label: `Push to ${target}`,
      baseBranch: " ",
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execAuthGit(cwd, pushArgs, { connection }),
      connection,
    });
  }

  async checkoutBranch(workspace, { branch } = {}) {
    const targetBranch = String(branch || "").trim();
    if (!targetBranch) {
      return createStructuredResult({ ok: false, summary: "Branch name is required." });
    }

    return this.runWriteAction(workspace, {
      type: "checkout",
      label: "Checkout",
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, ["checkout", targetBranch]),
    });
  }

  async createBranch(workspace, { branch, startPoint = "" } = {}) {
    const newBranch = String(branch || "").trim();
    if (!newBranch) {
      return createStructuredResult({ ok: false, summary: "Branch name is required." });
    }

    const args = ["checkout", "-b", newBranch];
    if (startPoint) {
      args.push(startPoint);
    }

    return this.runWriteAction(workspace, {
      type: "create-branch",
      label: "Create branch",
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, args),
    });
  }

  async mergeIntoCurrent(workspace, { baseBranch, stashDirty = false } = {}) {
    return this.runWriteAction(workspace, {
      type: "merge",
      label: "Merge",
      baseBranch,
      stashDirty,
      run: async (cwd, resolvedBaseBranch) => this.execGit(cwd, ["merge", "--no-edit", resolvedBaseBranch]),
    });
  }

  async rebaseOnto(workspace, { baseBranch, stashDirty = false } = {}) {
    return this.runWriteAction(workspace, {
      type: "rebase",
      label: "Rebase",
      baseBranch,
      stashDirty,
      run: async (cwd, resolvedBaseBranch) => this.execGit(cwd, ["rebase", resolvedBaseBranch]),
    });
  }

  async continueOperation(workspace) {
    const snapshot = await this.inspectWorkspace(workspace);
    if (!snapshot.available) {
      return createStructuredResult({
        ok: false,
        summary: snapshot.error || "Git workspace is unavailable.",
      });
    }

    const args = resolveContinueArgs(snapshot.operationState.kind);
    if (!args) {
      return createStructuredResult({
        ok: false,
        summary: "No Git operation can be continued in this workspace.",
      });
    }

    return this.runWriteAction(workspace, {
      type: snapshot.operationState.kind,
      label: "Continue",
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, args),
    });
  }

  async abortOperation(workspace) {
    const snapshot = await this.inspectWorkspace(workspace);
    if (!snapshot.available) {
      return createStructuredResult({
        ok: false,
        summary: snapshot.error || "Git workspace is unavailable.",
      });
    }

    const args = resolveAbortArgs(snapshot.operationState.kind);
    if (!args) {
      return createStructuredResult({
        ok: false,
        summary: "No Git operation can be aborted in this workspace.",
      });
    }

    const result = await this.runWriteAction(workspace, {
      type: snapshot.operationState.kind,
      label: "Abort",
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, args),
    });

    if (result.ok) {
      const stashRestore = await this.restoreStridetermStash(workspace.cwd);
      if (stashRestore) {
        result.rawOutput = joinRawOutput(result.rawOutput, stashRestore);
        result.warnings.push("Restored previously stashed local changes.");
      }
    }

    return result;
  }

  async diffPreview(workspace, { path: targetPath, scope = "unstaged", baseBranch = "" } = {}) {
    if (!workspace?.cwd || !targetPath) {
      return {
        ok: false,
        scope,
        path: targetPath || "",
        diff: "",
        summary: "File path is required for diff preview.",
      };
    }

    const normalizedScope = ["staged", "unstaged", "branch", "conflict", "untracked"].includes(scope)
      ? scope
      : "unstaged";
    if (normalizedScope === "untracked") {
      const preview = await renderUntrackedDiffPreview(this.execGit.bind(this), workspace.cwd, targetPath);
      return {
        ok: preview.ok,
        scope: normalizedScope,
        path: targetPath,
        diff: preview.diff,
        summary: preview.summary || (preview.diff ? "" : "No diff output for the selected file."),
      };
    }

    const args =
      normalizedScope === "staged"
        ? ["diff", "--cached", "--", targetPath]
        : normalizedScope === "branch"
          ? ["diff", `${baseBranch || "HEAD"}...HEAD`, "--", targetPath]
          : ["diff", "--", targetPath];

    try {
      const result = await this.execGit(workspace.cwd, args);
      const diff = trimDiffPreview(result.stdout || result.stderr || "");
      return {
        ok: true,
        scope: normalizedScope,
        path: targetPath,
        diff,
        summary: diff ? "" : "No diff output for the selected file.",
      };
    } catch (error) {
      return {
        ok: false,
        scope: normalizedScope,
        path: targetPath,
        diff: trimDiffPreview(error.stdout || error.stderr || ""),
        summary: extractErrorMessage(error),
      };
    }
  }

  async commitDiff(workspace, { hash } = {}) {
    if (!workspace?.cwd || !hash) {
      return { ok: false, hash: hash || "", diff: "", summary: "Workspace cwd and commit hash are required." };
    }

    try {
      const result = await this.execGit(workspace.cwd, ["show", "--stat", "--patch", hash]);
      return {
        ok: true,
        hash,
        diff: trimDiffPreview(result.stdout || "", 600),
        summary: "",
      };
    } catch (error) {
      return {
        ok: false,
        hash,
        diff: "",
        summary: extractErrorMessage(error),
      };
    }
  }

  async runWriteAction(
    workspace,
    {
      type,
      label,
      baseBranch = "",
      stashDirty = false,
      allowDirty = false,
      skipPreflight = false,
      run,
      connection = null,
    },
  ) {
    this.invalidateSnapshotCache(workspace.id);
    const snapshot = await this.inspectWorkspace(workspace);
    if (!snapshot.available) {
      return createStructuredResult({
        ok: false,
        summary: snapshot.error || "Git workspace is unavailable.",
      });
    }

    const resolvedBaseBranch = String(baseBranch || snapshot.baseBranch || snapshot.upstream || "").trim();
    const warnings = createOperationWarnings(snapshot, { type, baseBranch: resolvedBaseBranch, stashDirty });

    if (!skipPreflight) {
      if (snapshot.operationState.inProgress) {
        return createStructuredResult({
          ok: false,
          summary: `${snapshot.operationState.label}. Finish or abort it before starting another Git action.`,
          warnings,
          conflicts: snapshot.operationState.conflicts,
          operationState: snapshot.operationState,
        });
      }

      if (!allowDirty && snapshot.dirty && !stashDirty) {
        return createStructuredResult({
          ok: false,
          summary: "Working tree is dirty. Commit or stash local changes before starting this Git action.",
          warnings,
        });
      }
    }

    if (["merge", "rebase"].includes(type) && !resolvedBaseBranch) {
      return createStructuredResult({
        ok: false,
        summary: "A base branch could not be determined for this repository.",
        warnings,
      });
    }

    let stashLabel = "";
    let stashOutput = "";

    try {
      if (stashDirty && snapshot.dirty) {
        stashLabel = `strideterm-${type}-${this.now().toISOString()}`;
        const stashResult = await this.execGit(workspace.cwd, [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          stashLabel,
        ]);
        stashOutput = stashResult.stdout || stashResult.stderr || "";
      }

      log.debug("git action starting", { type, label, cwd: workspace.cwd, baseBranch: resolvedBaseBranch });
      const startTime = Date.now();
      const actionResult = await run(workspace.cwd, resolvedBaseBranch);
      let restoreOutput = "";
      if (stashLabel) {
        restoreOutput = await this.restoreStash(workspace.cwd);
      }
      const durationMs = Date.now() - startTime;
      log.info("git action completed", { type, label, durationMs });
      this._logGitAudit({ type, connection, success: true, durationMs });
      return createStructuredResult({
        ok: true,
        summary: resolvedBaseBranch
          ? `${label} completed against ${resolvedBaseBranch}.`
          : `${label} completed successfully.`,
        warnings,
        rawOutput: joinRawOutput(stashOutput, actionResult.stdout, actionResult.stderr, restoreOutput),
      });
    } catch (error) {
      log.warn("git action failed", { type, label, err: extractErrorMessage(error) });
      this._logGitAudit({ type, connection, success: false, errorMessage: extractErrorMessage(error) });
      const operationSnapshot = await this.inspectWorkspace(workspace);
      let restoreOutput = "";
      if (stashLabel && !operationSnapshot.operationState.inProgress) {
        restoreOutput = await this.restoreStash(workspace.cwd);
      } else if (stashLabel) {
        warnings.push("Stashed local changes were kept because the Git operation needs manual resolution.");
      }

      const hasConflictState =
        operationSnapshot.operationState.inProgress || operationSnapshot.operationState.conflicts.length > 0;
      return createStructuredResult({
        ok: false,
        summary: hasConflictState
          ? `${label} stopped because Git reported conflicts or requires manual resolution.`
          : `${label} failed.`,
        warnings,
        conflicts: operationSnapshot.operationState.conflicts,
        rawOutput: joinRawOutput(stashOutput, error.stdout, error.stderr, restoreOutput),
        operationState: operationSnapshot.operationState,
      });
    }
  }

  _logGitAudit({ type, connection, success, durationMs, errorMessage }) {
    if (!connection?.id || !this.auditLogStore) {
      return;
    }
    try {
      // Use orgUrl (Azure), or future provider base URLs, falling back to label.
      const organization = connection.orgUrl || connection.baseUrl || connection.label || "";
      this.auditLogStore.logEntry({
        timestamp: new Date().toISOString(),
        connectionId: connection.id,
        organization,
        project: "",
        operation: `git${type.charAt(0).toUpperCase()}${type.slice(1)}`,
        category: ["push", "push-tag", "push-all-tags", "delete-remote-tag"].includes(type) ? "write" : "read",
        method: "GIT",
        url: "",
        statusCode: null,
        success,
        errorMessage: errorMessage || null,
        durationMs: durationMs ?? null,
        resourceType: "git",
        resourceId: "",
        summary: `git ${type} (${connection.provider || "unknown"})`,
        userInitiated: true,
      });
    } catch {
      // Never let audit logging break the main flow
    }
  }

  async restoreStash(cwd) {
    try {
      const result = await this.execGit(cwd, ["stash", "pop"]);
      return joinRawOutput(result.stdout, result.stderr);
    } catch (error) {
      return joinRawOutput(error.stdout, error.stderr);
    }
  }

  async mergeCurrentIntoBase(workspace, { baseBranch } = {}) {
    const snapshot = await this.inspectWorkspace(workspace);
    if (!snapshot.available) {
      return createStructuredResult({ ok: false, summary: snapshot.error || "Git workspace is unavailable." });
    }

    const resolvedBase = baseBranch || snapshot.baseBranch;
    if (!resolvedBase) {
      return createStructuredResult({ ok: false, summary: "Base branch could not be determined." });
    }

    if (normalizeBranchName(resolvedBase) === normalizeBranchName(snapshot.branch)) {
      return createStructuredResult({ ok: false, summary: "Current branch is already the base branch." });
    }

    const mainWorktree = (snapshot.siblingWorktrees || []).find(
      (entry) => entry.branch === resolvedBase || (entry.isMainWorktree && !entry.isCurrent),
    );
    const targetCwd = mainWorktree?.path || snapshot.mainWorktreePath;
    if (!targetCwd) {
      return createStructuredResult({
        ok: false,
        summary: `No worktree found for ${resolvedBase}. Switch to it manually.`,
      });
    }

    const dirtyState = await inspectWorktreeDirtyState(this.execGit.bind(this), targetCwd);
    if (dirtyState.dirty) {
      return createStructuredResult({
        ok: false,
        summary: `The ${resolvedBase} worktree has uncommitted changes. Commit or stash them first.`,
      });
    }

    try {
      const result = await this.execGit(targetCwd, ["merge", "--no-edit", snapshot.branch]);
      return createStructuredResult({
        ok: true,
        summary: `Merged ${snapshot.branch} into ${resolvedBase}.`,
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const postSnapshot = await this.inspectOperationState(targetCwd, {
        gitDir: path.join(targetCwd, ".git"),
        gitCommonDir: snapshot.gitCommonDir || path.join(targetCwd, ".git"),
      });
      return createStructuredResult({
        ok: false,
        summary: postSnapshot.inProgress
          ? `Merge stopped due to conflicts in the ${resolvedBase} worktree. Resolve them there.`
          : `Merge of ${snapshot.branch} into ${resolvedBase} failed.`,
        conflicts: postSnapshot.conflicts,
        rawOutput: joinRawOutput(error.stdout, error.stderr),
        operationState: postSnapshot.inProgress ? buildOperationState(postSnapshot) : undefined,
      });
    }
  }

  async commitAll(workspace, { message } = {}) {
    const commitMessage = String(message || "").trim();
    if (!commitMessage) {
      return createStructuredResult({ ok: false, summary: "Commit message is required." });
    }

    if (!workspace?.cwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }

    try {
      await this.execGit(workspace.cwd, ["add", "-A"]);
      const result = await this.execGit(workspace.cwd, ["commit", "-m", commitMessage]);
      return createStructuredResult({
        ok: true,
        summary: "Changes committed successfully.",
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      return createStructuredResult({
        ok: false,
        summary: "Commit failed.",
        rawOutput: joinRawOutput(error.stdout, error.stderr),
      });
    }
  }

  async removeWorktree(workspace, { worktreePath, deleteBranch = false } = {}) {
    if (!workspace?.cwd || !worktreePath) {
      return createStructuredResult({ ok: false, summary: "Worktree path is required." });
    }

    const resolvedPath = path.resolve(worktreePath);
    const mainPath = path.resolve(workspace.cwd);
    if (resolvedPath === mainPath) {
      return createStructuredResult({ ok: false, summary: "Cannot remove the main worktree." });
    }

    let branchName = "";
    if (deleteBranch) {
      try {
        const worktrees = parseWorktreeList(
          (await this.execGit(workspace.cwd, ["worktree", "list", "--porcelain"])).stdout,
        );
        branchName = worktrees.find((entry) => path.resolve(entry.path) === resolvedPath)?.branch || "";
      } catch {
        // branch detection failed, skip branch deletion
      }
    }

    try {
      await this.execGit(workspace.cwd, ["worktree", "remove", "--force", resolvedPath]);
    } catch (error) {
      return createStructuredResult({
        ok: false,
        summary: `Failed to remove worktree at ${resolvedPath}.`,
        rawOutput: joinRawOutput(error.stdout, error.stderr),
      });
    }

    let branchOutput = "";
    if (deleteBranch && branchName) {
      try {
        const result = await this.execGit(workspace.cwd, ["branch", "-d", branchName]);
        branchOutput = joinRawOutput(result.stdout, result.stderr);
      } catch (error) {
        branchOutput = `Branch ${branchName} could not be deleted (may not be fully merged): ${joinRawOutput(error.stdout, error.stderr)}`;
      }
    }

    return createStructuredResult({
      ok: true,
      summary: `Worktree removed.${branchName && deleteBranch ? ` Branch ${branchName} deleted.` : ""}`,
      rawOutput: branchOutput,
    });
  }

  async detectBestBaseBranch(cwd, currentBranch, upstream, branchNames = []) {
    const candidates = buildBaseBranchCandidates(currentBranch, upstream, branchNames);
    if (!candidates.length) {
      return preferBaseBranch(currentBranch, upstream, branchNames);
    }

    const distances = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const result = await this.execGit(cwd, ["merge-base", "HEAD", candidate]);
          const mergeBase = result.stdout.trim();
          if (!mergeBase) return { candidate, distance: Infinity };

          const countResult = await this.execGit(cwd, ["rev-list", "--count", `${mergeBase}..HEAD`]);
          return { candidate, distance: parseInt(countResult.stdout.trim(), 10) || Infinity };
        } catch {
          return { candidate, distance: Infinity };
        }
      }),
    );

    const best = distances.reduce((a, b) => (a.distance <= b.distance ? a : b));
    return best.distance < Infinity ? best.candidate : preferBaseBranch(currentBranch, upstream, branchNames);
  }

  async getStashCount(cwd) {
    try {
      const result = await this.execGit(cwd, ["stash", "list"]);
      const lines = String(result.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean);
      return lines.length;
    } catch {
      return 0;
    }
  }

  async stash(workspace, { message = "" } = {}) {
    if (!workspace?.cwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const args = ["stash", "push"];
      if (message) args.push("-m", message);
      const result = await this.execGit(workspace.cwd, args);
      return createStructuredResult({
        ok: true,
        summary: "Changes stashed successfully.",
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      return createStructuredResult({
        ok: false,
        summary: "Stash failed.",
        rawOutput: joinRawOutput(error.stdout, error.stderr),
      });
    }
  }

  async stashPop(workspace) {
    if (!workspace?.cwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const result = await this.execGit(workspace.cwd, ["stash", "pop"]);
      return createStructuredResult({
        ok: true,
        summary: "Stash applied and removed.",
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      return createStructuredResult({
        ok: false,
        summary: "Stash pop failed.",
        rawOutput: joinRawOutput(error.stdout, error.stderr),
      });
    }
  }

  // ─── Tag operations ───────────────────────────────────────────────

  async listTags(workspace, { connection = null } = {}) {
    if (!workspace?.cwd) {
      return { ok: false, tags: [], summary: "Workspace has no working directory." };
    }
    try {
      // Format: refname, objecttype, creatordate, taggername/authorname, subject, objectname
      const fmt = [
        "%(refname:short)",
        "%(objecttype)",
        "%(creatordate:iso8601)",
        "%(if)%(taggername)%(then)%(taggername)%(else)%(authorname)%(end)",
        "%(subject)",
        "%(objectname:short)",
      ].join("%09");
      const result = await this.execGit(workspace.cwd, [
        "for-each-ref",
        `--format=${fmt}`,
        "--sort=-creatordate",
        "refs/tags",
      ]);
      const lines = String(result.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean);
      const tags = lines.map((line) => {
        const [name, type, date, author, message, hash] = line.split("\t");
        return {
          name: name || "",
          annotated: type === "tag",
          date: date || "",
          author: author || "",
          message: message || "",
          hash: hash || "",
        };
      });

      // Check which tags exist on remote
      const remoteTags = new Set();
      try {
        const remoteResult = await this.execAuthGit(workspace.cwd, ["ls-remote", "--tags", "origin"], { connection });
        const remoteLines = String(remoteResult.stdout || "")
          .split(/\r?\n/)
          .filter(Boolean);
        for (const rl of remoteLines) {
          const ref = rl.split("\t")[1] || "";
          const tagName = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
          if (tagName) remoteTags.add(tagName);
        }
      } catch {
        // remote lookup failed — not fatal
      }

      const localTagNames = new Set(tags.map((t) => t.name));
      for (const tag of tags) {
        tag.pushed = remoteTags.has(tag.name);
        tag.local = true;
      }

      // Add remote-only tags (exist on remote but not locally)
      for (const remoteTagName of remoteTags) {
        if (!localTagNames.has(remoteTagName)) {
          tags.push({
            name: remoteTagName,
            annotated: false,
            date: "",
            author: "",
            message: "",
            hash: "",
            pushed: true,
            local: false,
          });
        }
      }

      return { ok: true, tags, summary: `${tags.length} tag(s) found.` };
    } catch (error) {
      return { ok: false, tags: [], summary: joinRawOutput(error.stdout, error.stderr) || "Failed to list tags." };
    }
  }

  async createTag(workspace, { tagName, message = "", commit = "" } = {}) {
    const name = String(tagName || "").trim();
    if (!name) {
      return createStructuredResult({ ok: false, summary: "Tag name is required." });
    }
    if (!workspace?.cwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const args = message ? ["tag", "-a", name, "-m", message] : ["tag", name];
      if (commit) args.push(commit);
      const result = await this.execGit(workspace.cwd, args);
      return createStructuredResult({
        ok: true,
        summary: `Tag '${name}' created.`,
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      return createStructuredResult({
        ok: false,
        summary: `Failed to create tag '${name}'.`,
        rawOutput: joinRawOutput(error.stdout, error.stderr),
      });
    }
  }

  async deleteTag(workspace, { tagName } = {}) {
    const name = String(tagName || "").trim();
    if (!name) {
      return createStructuredResult({ ok: false, summary: "Tag name is required." });
    }
    if (!workspace?.cwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const result = await this.execGit(workspace.cwd, ["tag", "-d", name]);
      return createStructuredResult({
        ok: true,
        summary: `Tag '${name}' deleted.`,
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      return createStructuredResult({
        ok: false,
        summary: `Failed to delete tag '${name}'.`,
        rawOutput: joinRawOutput(error.stdout, error.stderr),
      });
    }
  }

  async pushTag(workspace, { tagName, connection = null } = {}) {
    const name = String(tagName || "").trim();
    if (!name) {
      return createStructuredResult({ ok: false, summary: "Tag name is required." });
    }
    return this.runWriteAction(workspace, {
      type: "push-tag",
      label: `Push tag ${name}`,
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execAuthGit(cwd, ["push", "origin", `refs/tags/${name}`], { connection }),
      connection,
    });
  }

  async pushAllTags(workspace, { connection = null } = {}) {
    return this.runWriteAction(workspace, {
      type: "push-all-tags",
      label: "Push all tags",
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execAuthGit(cwd, ["push", "origin", "--tags"], { connection }),
      connection,
    });
  }

  async deleteRemoteTag(workspace, { tagName, connection = null } = {}) {
    const name = String(tagName || "").trim();
    if (!name) {
      return createStructuredResult({ ok: false, summary: "Tag name is required." });
    }
    return this.runWriteAction(workspace, {
      type: "delete-remote-tag",
      label: `Delete remote tag ${name}`,
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execAuthGit(cwd, ["push", "origin", `:refs/tags/${name}`], { connection }),
      connection,
    });
  }

  async restoreStridetermStash(cwd) {
    try {
      const result = await this.execGit(cwd, ["stash", "list"]);
      const lines = String(result.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean);
      const index = lines.findIndex((line) => line.includes("strideterm-"));
      if (index < 0) {
        return "";
      }
      const popResult = await this.execGit(cwd, ["stash", "pop", `stash@{${index}}`]);
      return joinRawOutput(popResult.stdout, popResult.stderr);
    } catch (error) {
      return joinRawOutput(error?.stdout, error?.stderr);
    }
  }
}
