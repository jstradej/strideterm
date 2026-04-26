/// <reference types="node" />
import path from "node:path";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { Effect } from "effect";
import { execFileText, quotePosixArg } from "./process-utils.js";
import { encodeAuthHeader, sanitizeGitEnvironment } from "./shared/git-auth-utils.js";
import { APP_CONFIG } from "../../config/app-config.js";
import { getLogger } from "./logger.js";
import { runEffect } from "./effect/runtime.js";
import { GitCommandError, GitAuthError } from "./effect/errors/git-errors.js";
import { httpRetry } from "./effect/schedules.js";
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

interface GitExecResult {
  stdout: string;
  stderr: string;
}

type ExecGitImpl = (cwd: string, args: string[]) => Promise<GitExecResult>;

interface Connection {
  id?: string;
  tokenRef?: string;
  login?: string;
  currentUserLogin?: string;
  orgUrl?: string;
  baseUrl?: string;
  label?: string;
  provider?: string;
  [key: string]: unknown;
}

interface AuditLogStore {
  logEntry(entry: Record<string, unknown>): void;
}

interface CredentialStore {
  getSecret(ref: string): string | null | undefined;
}

interface WorktreeDirtyCacheEntry {
  at: number;
  value: { dirty: boolean; dirtyCount: number };
}

interface SnapshotCacheEntry {
  at: number;
  snapshot: Record<string, unknown>;
}

interface GitManagerOptions {
  execGitImpl?: ExecGitImpl | null;
  now?: (() => Date) | null;
  snapshotCacheTtlMs?: number;
  credentialStore?: CredentialStore | null;
  auditLogStore?: AuditLogStore | null;
  gitAuditLogStore?: AuditLogStore | null;
}

interface WriteActionOptions {
  type: string;
  label: string;
  baseBranch?: string;
  stashDirty?: boolean;
  allowDirty?: boolean;
  skipPreflight?: boolean;
  run: (cwd: string, resolvedBaseBranch: string) => Promise<GitExecResult>;
  connection?: Connection | null;
  extraAudit?: Record<string, unknown>;
  rootPath?: string;
}

interface LogGitAuditOptions {
  type: string;
  connection: Connection | null | undefined;
  success: boolean;
  durationMs?: number;
  errorMessage?: string;
  workspaceId: string;
  remoteUrl: string;
  extra?: Record<string, unknown>;
}

interface WorkspaceRef {
  id: string;
  cwd?: string;
  kind?: string;
  gitRoots?: string[];
  review?: {
    pullRequest?: {
      sourceRefName?: string;
    } | null;
  } | null;
  branchMerged?: boolean;
  [key: string]: unknown;
}

export class GitManager extends EventEmitter {
  snapshots: Map<string, Record<string, unknown>>;
  execGitImpl: ExecGitImpl | null;
  now: () => Date;
  worktreeDirtyCache: Map<string, WorktreeDirtyCacheEntry>;
  snapshotCache: Map<string, SnapshotCacheEntry>;
  snapshotCacheTtlMs: number;
  credentialStore: CredentialStore | null;
  auditLogStore: AuditLogStore | null;
  gitAuditLogStore: AuditLogStore | null;

  constructor({
    execGitImpl = null,
    now = null,
    snapshotCacheTtlMs = SNAPSHOT_CACHE_TTL_MS,
    credentialStore = null,
    auditLogStore = null,
    gitAuditLogStore = null,
  }: GitManagerOptions = {}) {
    super();
    this.snapshots = new Map();
    this.execGitImpl = execGitImpl ?? null;
    this.now = now || (() => new Date());
    this.worktreeDirtyCache = new Map();
    this.snapshotCache = new Map();
    this.snapshotCacheTtlMs = snapshotCacheTtlMs;
    this.credentialStore = credentialStore ?? null;
    this.auditLogStore = auditLogStore ?? null;
    this.gitAuditLogStore = gitAuditLogStore ?? null;
  }

  async execGit(cwd: string, args: string[]): Promise<GitExecResult> {
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
  async execAuthGit(cwd: string, args: string[], { connection = null }: { connection?: Connection | null } = {}): Promise<GitExecResult> {
    if (!connection?.tokenRef || !this.credentialStore) {
      return this.execGit(cwd, args);
    }

    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      return this.execGit(cwd, args);
    }

    const extraArgs: string[] = [];
    if (process.platform === "win32") {
      extraArgs.push("-c", "core.longpaths=true");
    }
    const login = connection.login || connection.currentUserLogin || "x-access-token";
    extraArgs.push("-c", `http.extraheader=${encodeAuthHeader(String(login), token)}`);

    if (this.execGitImpl) {
      return this.execGitImpl(cwd, [...extraArgs, ...args]);
    }
    return execFileText("git", [...extraArgs, ...args], { cwd, env: sanitizeGitEnvironment() });
  }

  // Effect-based wrapper for git subprocess calls with tagged error typing.
  execGitEffect(cwd: string, args: string[]): Effect.Effect<GitExecResult, GitCommandError> {
    return Effect.tryPromise({
      try: () => this.execGit(cwd, args),
      catch: (e) => {
        const err = e as { stderr?: string; exitCode?: number; message?: string };
        return new GitCommandError({ cwd, cmd: "git", args, stderr: err.stderr ?? String(e), exitCode: err.exitCode ?? 1 });
      },
    });
  }

  // Effect-based wrapper with auth support and HTTP retry policy.
  execAuthGitEffect(
    cwd: string,
    args: string[],
    { connection = null }: { connection?: Connection | null } = {},
  ): Effect.Effect<GitExecResult, GitCommandError | GitAuthError> {
    return Effect.retry(
      Effect.tryPromise({
        try: () => this.execAuthGit(cwd, args, { connection }),
        catch: (e) => {
          const err = e as { stderr?: string; exitCode?: number; message?: string };
          const stderr = err.stderr ?? String(e);
          if (/authentication failed|401|403|invalid credentials/i.test(stderr)) {
            return new GitAuthError({ cwd, remote: cwd, cause: e });
          }
          return new GitCommandError({ cwd, cmd: "git", args, stderr, exitCode: err.exitCode ?? 1 });
        },
      }),
      {
        schedule: httpRetry,
        while: (error) => error._tag === "GitCommandError" && !/authentication failed|401|403/i.test(error.stderr),
      },
    );
  }

  _cacheKey(workspaceId: string, rootPath: string | null): string {
    return rootPath ? `${workspaceId}:${path.resolve(rootPath)}` : workspaceId;
  }

  getWorkspaceMap(): Record<string, unknown> {
    // Build { [workspaceId]: { primaryRoot, roots: { [rootPath]: snapshot } } }
    // Also duplicate primary snapshot fields at top level for back-compat.
    const workspaceIds = new Set<string>();
    for (const key of this.snapshots.keys()) {
      const colonIdx = key.indexOf(":");
      workspaceIds.add(colonIdx >= 0 ? key.slice(0, colonIdx) : key);
    }

    const result: Record<string, unknown> = {};
    for (const workspaceId of workspaceIds) {
      const snapshotEntries: Array<Record<string, unknown>> = [];
      for (const [key, snapshot] of this.snapshots.entries()) {
        const colonIdx = key.indexOf(":");
        const wid = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
        if (wid === workspaceId) {
          snapshotEntries.push(snapshot);
        }
      }
      if (!snapshotEntries.length) continue;

      const primarySnapshot = snapshotEntries[0];
      if (snapshotEntries.length === 1 && !snapshotEntries[0]?.rootPath) {
        // Single-root back-compat: emit flat snapshot (no roots map)
        result[workspaceId] = primarySnapshot;
      } else {
        // Multi-root: emit structured object
        const roots: Record<string, unknown> = {};
        let primaryRoot = "";
        for (const snap of snapshotEntries) {
          const rp = String(snap?.rootPath || snap?.cwd || "");
          if (rp) {
            roots[rp] = snap;
            if (!primaryRoot) primaryRoot = rp;
          }
        }
        result[workspaceId] = {
          ...primarySnapshot, // back-compat: duplicate primary fields at top level
          primaryRoot,
          roots,
        };
      }
    }
    return result;
  }

  getProjectMap(): Record<string, unknown> {
    return this.getWorkspaceMap();
  }

  getSnapshot(workspaceId: string, rootPath: string | null = null): Record<string, unknown> | null {
    if (rootPath) {
      return this.snapshots.get(this._cacheKey(workspaceId, rootPath)) || null;
    }
    return this.snapshots.get(workspaceId) || this.getSnapshots(workspaceId)[0] || null;
  }

  getSnapshots(workspaceId: string): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    for (const [key, value] of this.snapshots.entries()) {
      if (key === workspaceId || key.startsWith(`${workspaceId}:`)) {
        result.push(value);
      }
    }
    return result;
  }

  async getCachedWorktreeDirtyState(worktreePath: string, fallbackDirty = false): Promise<{ dirty: boolean; dirtyCount: number }> {
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

  async detectLazygit(workspace: WorkspaceRef, rootPath: string | null = null): Promise<Record<string, unknown>> {
    const cwd = rootPath || workspace.cwd;
    const hostBinary = this.resolveLazygitBinary();
    try {
      await execFileText(hostBinary, ["--version"], { cwd });
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

    const wslCwd = toWslPath(cwd || "");
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

  resolveLazygitBinary(): string {
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

  async _inspectRoot(workspace: WorkspaceRef, rootPath: string | null): Promise<Record<string, unknown>> {
    if (!workspace || workspace.kind === "docker" || !rootPath) {
      return createUnavailableSnapshot(
        workspace || { id: "", cwd: "" },
        "Git metadata is available only for file-backed workspaces.",
      );
    }

    try {
      const rootResult = await this.execGit(rootPath, ["rev-parse", "--show-toplevel"]);
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
        this.execGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({
          stdout: "HEAD",
          stderr: "",
        })),
        this.execGit(rootPath, ["remote", "-v"]).catch(() => ({ stdout: "", stderr: "" })),
        this.execGit(rootPath, ["rev-list", "--count", "HEAD"]).catch(() => ({ stdout: "0", stderr: "" })),
        this.execGit(rootPath, ["status", "--porcelain=v2", "--branch"]).catch(() => ({ stdout: "", stderr: "" })),
        this.execGit(rootPath, ["status", "--short"]).catch(() => ({ stdout: "", stderr: "" })),
        this.execGit(rootPath, [
          "log",
          "--date=relative",
          "--pretty=format:%h%x09%ad%x09%an%x09%d%x09%s",
          "-n",
          String(APP_CONFIG.git.recentLogLimit),
        ]).catch(() => ({ stdout: "", stderr: "" })),
        this.detectLazygit(workspace, rootPath),
        this.execGit(rootPath, ["rev-parse", "--git-dir"]).catch(() => ({ stdout: ".git", stderr: "" })),
        this.execGit(rootPath, ["rev-parse", "--git-common-dir"]).catch(() => ({ stdout: ".git", stderr: "" })),
        this.execGit(rootPath, ["worktree", "list", "--porcelain"]).catch(() => ({ stdout: "", stderr: "" })),
        this.execGit(rootPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]).catch(
          () => ({ stdout: "", stderr: "" }),
        ),
      ]);

      const gitDir = resolveGitPath(rootPath, gitDirResult.stdout);
      const gitCommonDir = resolveGitPath(rootPath, gitCommonDirResult.stdout);
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
      const upstream = parsedStatus.upstream || (await this.readUpstream(rootPath));
      // For review workspaces, compare against the remote source branch (where we push to).
      // The target branch (where the PR merges into) is handled by the Summary tab's "Rebase on target".
      const reviewSourceRef = String(workspace.review?.pullRequest?.sourceRefName || "")
        .replace(/^refs\/heads\//, "")
        .trim();
      const baseBranch = reviewSourceRef
        ? `origin/${reviewSourceRef}`
        : await this.detectBestBaseBranch(rootPath, branch, upstream, branchNames);
      const [compareWithBase, stashCount] = await Promise.all([
        this.readBaseComparison(rootPath, baseBranch, branch),
        this.getStashCount(rootPath),
      ]);
      const operationState = await this.inspectOperationState(rootPath, { gitDir, gitCommonDir });
      const stagedDiffStat = await this.readDiffStat(rootPath, ["diff", "--cached", "--shortstat"]);
      const unstagedDiffStat = await this.readDiffStat(rootPath, ["diff", "--shortstat"]);
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

      // Per-sibling branchMerged detection: `git branch --merged <baseBranch>` lists
      // local branches whose tip is reachable from baseBranch (i.e. already merged in).
      // One extra subprocess per snapshot, covered by the 8 s cache.
      let mergedBranchesSet = new Set<string>();
      if (baseBranch && worktrees.length > 1) {
        try {
          const mergedResult = await this.execGit(root, [
            "branch",
            "--merged",
            baseBranch,
            "--format=%(refname:short)",
          ]);
          mergedBranchesSet = new Set(
            mergedResult.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          );
        } catch {
          // baseBranch not resolvable locally — leave set empty
        }
      }

      const siblingWorktrees = await Promise.all(
        worktrees.map(async (entry, index) => {
          const isCurrent = path.resolve(entry.path) === path.resolve(root);
          const dirtyState = isCurrent
            ? { dirty: dirtyCount > 0, dirtyCount }
            : await this.getCachedWorktreeDirtyState(entry.path);
          const entryBranch = entry.branch || "";
          return {
            path: entry.path,
            branch: entryBranch || (entry.detached ? "detached" : ""),
            head: entry.head || "",
            isCurrent,
            isMainWorktree: index === 0,
            dirty: dirtyState.dirty,
            dirtyCount: dirtyState.dirtyCount,
            detached: entry.detached,
            bare: entry.bare,
            locked: entry.locked,
            prunable: entry.prunable,
            branchMerged:
              !!entryBranch && !entry.detached && entryBranch !== baseBranch && mergedBranchesSet.has(entryBranch),
          };
        }),
      );

      return {
        workspaceId: workspace.id,
        projectId: workspace.id,
        cwd: rootPath,
        rootPath,
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

  async inspectWorkspaceRoots(workspace: WorkspaceRef): Promise<{ roots: Array<Record<string, unknown>>; primaryRoot: string }> {
    if (!workspace || workspace.kind === "docker") {
      return { roots: [], primaryRoot: "" };
    }
    const roots = (workspace.gitRoots?.length ? workspace.gitRoots : [workspace.cwd]).filter(Boolean) as string[];
    if (!roots.length) return { roots: [], primaryRoot: "" };
    const snapshots = await Promise.all(roots.map((root) => this._inspectRoot(workspace, root)));
    return { roots: snapshots, primaryRoot: roots[0] };
  }

  async inspectWorkspace(workspace: WorkspaceRef): Promise<Record<string, unknown>> {
    if (!workspace || workspace.kind === "docker" || !workspace.cwd) {
      return createUnavailableSnapshot(
        workspace || { id: "", cwd: "" },
        "Git metadata is available only for file-backed workspaces.",
      );
    }
    const { roots } = await this.inspectWorkspaceRoots(workspace);
    return roots[0] || createUnavailableSnapshot(workspace, "No git roots detected.");
  }

  async inspectProject(project: WorkspaceRef): Promise<Record<string, unknown>> {
    return this.inspectWorkspace(project);
  }

  async readUpstream(cwd: string): Promise<string> {
    try {
      const result = await this.execGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
      return result.stdout.trim();
    } catch {
      return "";
    }
  }

  async readDiffStat(cwd: string, args: string[]): Promise<ReturnType<typeof parseDiffStatLine>> {
    try {
      const result = await this.execGit(cwd, args);
      return parseDiffStatLine(result.stdout.trim());
    } catch {
      return { ...DEFAULT_DIFF_STAT };
    }
  }

  async readBaseComparison(cwd: string, baseBranch: string, currentBranch: string): Promise<Record<string, unknown>> {
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
    let potentialConflicts: string[] = [];
    let baseChangedFiles: string[] = [];
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

  async inspectOperationState(cwd: string, { gitDir, gitCommonDir }: { gitDir: string; gitCommonDir: string }): Promise<{ kind: string; inProgress: boolean; conflicts: string[] }> {
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

  async readConflicts(cwd: string): Promise<string[]> {
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

  invalidateSnapshotCache(workspaceId: string | null = null, rootPath: string | null = null): void {
    if (!workspaceId) {
      this.snapshotCache.clear();
      return;
    }
    if (rootPath) {
      this.snapshotCache.delete(this._cacheKey(workspaceId, rootPath));
    } else {
      // Delete all cache entries for this workspace (prefix match)
      for (const key of this.snapshotCache.keys()) {
        if (key === workspaceId || key.startsWith(`${workspaceId}:`)) {
          this.snapshotCache.delete(key);
        }
      }
    }
  }

  async refreshWorkspaces(workspaces: WorkspaceRef[] = []): Promise<Record<string, unknown>> {
    const now = this.now().getTime();
    const nextSnapshots = new Map<string, Record<string, unknown>>();

    await Promise.all(
      workspaces.map(async (workspace) => {
        const roots = (workspace.gitRoots?.length ? workspace.gitRoots : [workspace.cwd]).filter(Boolean) as string[];
        if (!roots.length) {
          // Docker or cwd-less workspace
          const cacheKey = workspace.id;
          const cached = this.snapshotCache.get(cacheKey);
          if (cached && now - cached.at < this.snapshotCacheTtlMs) {
            nextSnapshots.set(cacheKey, cached.snapshot);
            return;
          }
          const snapshot = await this._inspectRoot(workspace, workspace.cwd || null);
          this.snapshotCache.set(cacheKey, { at: this.now().getTime(), snapshot });
          nextSnapshots.set(cacheKey, snapshot);
          return;
        }

        await Promise.all(
          roots.map(async (rootPath) => {
            const cacheKey = this._cacheKey(workspace.id, rootPath);
            const cached = this.snapshotCache.get(cacheKey);
            if (cached && now - cached.at < this.snapshotCacheTtlMs) {
              nextSnapshots.set(cacheKey, cached.snapshot);
              return;
            }
            const snapshot = await this._inspectRoot(workspace, rootPath);
            this.snapshotCache.set(cacheKey, { at: this.now().getTime(), snapshot });
            nextSnapshots.set(cacheKey, snapshot);
          }),
        );
      }),
    );

    for (const [key, snapshot] of nextSnapshots) {
      this.snapshots.set(key, snapshot);
    }
    this.emit("updated", this.getWorkspaceMap());
    return this.getWorkspaceMap();
  }

  async refreshProjects(projects: WorkspaceRef[] = []): Promise<Record<string, unknown>> {
    return this.refreshWorkspaces(projects);
  }

  createLazygitLaunch(workspaceId: string, rootPath: string | null = null): { file: string; args: string[] } | null {
    const snapshot = this.getSnapshot(workspaceId, rootPath);
    const lazygit = snapshot?.lazygit as { launch?: { file: string; args: string[] } } | undefined;
    return lazygit?.launch
      ? { file: lazygit.launch.file, args: [...lazygit.launch.args] }
      : null;
  }

  async fetch(workspace: WorkspaceRef, { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    return this.runWriteAction(workspace, {
      type: "fetch",
      label: "Fetch",
      run: (cwd) => runEffect(this.execAuthGitEffect(cwd, ["fetch", "--all", "--prune"], { connection })),
      allowDirty: true,
      connection,
      rootPath,
    });
  }

  async pull(workspace: WorkspaceRef, { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    return this.runWriteAction(workspace, {
      type: "pull",
      label: "Pull",
      run: (cwd) => runEffect(this.execAuthGitEffect(cwd, ["pull", "--ff-only"], { connection })),
      allowDirty: true,
      connection,
      rootPath,
    });
  }

  async push(workspace: WorkspaceRef, { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const snapshot = await (rootPath ? this._inspectRoot(workspace, rootPath) : this.inspectWorkspace(workspace));
    if (!snapshot.available) {
      return createStructuredResult({ ok: false, summary: String(snapshot.error || "Git workspace is unavailable.") });
    }

    const branch = String(snapshot.branch || "");
    if (!branch) {
      return createStructuredResult({ ok: false, summary: "Cannot push: no branch is checked out (detached HEAD)." });
    }

    const upstream = String(snapshot.upstream || "");
    // Extract remote name from upstream (e.g. "origin/feature-1" → "origin")
    // For worktrees or repos with non-"origin" remotes, this picks the right one.
    const remoteNames = Object.keys((snapshot.remotes as Record<string, unknown>) || {}).filter((k) => !k.includes(":"));
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
      run: (cwd) => runEffect(this.execAuthGitEffect(cwd, pushArgs, { connection })),
      connection,
      rootPath,
    });
  }

  async forcePushWithLease(workspace: WorkspaceRef, { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const snapshot = await (rootPath ? this._inspectRoot(workspace, rootPath) : this.inspectWorkspace(workspace));
    if (!snapshot.available) {
      return createStructuredResult({ ok: false, summary: String(snapshot.error || "Git workspace is unavailable.") });
    }
    const branch = String(snapshot.branch || "");
    if (!branch) {
      return createStructuredResult({
        ok: false,
        summary: "Cannot force-push: no branch is checked out (detached HEAD).",
      });
    }
    if (!(Number(snapshot.aheadCount) > 0 && Number(snapshot.behindCount) > 0)) {
      return createStructuredResult({
        ok: false,
        summary: "Force-push with lease is only available when the branch has diverged from upstream.",
      });
    }
    const remoteNames = Object.keys((snapshot.remotes as Record<string, unknown>) || {}).filter((k) => !k.includes(":"));
    const upstream = String(snapshot.upstream || "");
    const remote = remoteNames.find((r) => upstream.startsWith(`${r}/`)) || remoteNames[0] || "origin";
    const target = `${remote}/${branch}`;
    const effectiveCwd = rootPath || String(workspace.cwd || "");

    // Resolve expected ref hash (current remote tracking ref = what --force-with-lease checks)
    const extraAudit: Record<string, unknown> = { expectedRef: "", previousRemoteRef: "", newRemoteRef: "" };
    if (upstream) {
      try {
        const refResult = await this.execGit(effectiveCwd, ["rev-parse", upstream]);
        extraAudit.expectedRef = refResult.stdout.trim();
        extraAudit.previousRemoteRef = refResult.stdout.trim();
      } catch {
        // Not fatal — push will still use bare --force-with-lease
      }
    }

    const leaseArg = extraAudit.expectedRef
      ? `--force-with-lease=${branch}:${extraAudit.expectedRef}`
      : "--force-with-lease";

    return this.runWriteAction(workspace, {
      type: "force-push",
      label: `Force push (with lease) to ${target}`,
      baseBranch: " ",
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => {
        const r = await runEffect(this.execAuthGitEffect(cwd, ["push", leaseArg, remote, branch], { connection }));
        try {
          const headResult = await this.execGit(cwd, ["rev-parse", "HEAD"]);
          extraAudit.newRemoteRef = headResult.stdout.trim();
        } catch {
          // Non-fatal
        }
        return r;
      },
      connection,
      extraAudit,
      rootPath,
    });
  }

  async checkoutBranch(workspace: WorkspaceRef, { branch, rootPath = "" }: { branch?: string; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const targetBranch = String(branch || "").trim();
    if (!targetBranch) {
      return createStructuredResult({ ok: false, summary: "Branch name is required." });
    }
    if (targetBranch.startsWith("-")) {
      return createStructuredResult({ ok: false, summary: "Invalid branch name." });
    }

    return this.runWriteAction(workspace, {
      type: "checkout",
      label: "Checkout",
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, ["checkout", targetBranch]),
      rootPath,
    });
  }

  async createBranch(workspace: WorkspaceRef, { branch, startPoint = "", rootPath = "" }: { branch?: string; startPoint?: string; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const newBranch = String(branch || "").trim();
    if (!newBranch) {
      return createStructuredResult({ ok: false, summary: "Branch name is required." });
    }

    if (newBranch.startsWith("-")) {
      return createStructuredResult({ ok: false, summary: "Invalid branch name." });
    }
    const args = ["checkout", "-b", newBranch];
    if (startPoint) {
      if (String(startPoint).startsWith("-")) {
        return createStructuredResult({ ok: false, summary: "Invalid start point." });
      }
      args.push(startPoint);
    }

    return this.runWriteAction(workspace, {
      type: "create-branch",
      label: "Create branch",
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, args),
      rootPath,
    });
  }

  async mergeIntoCurrent(workspace: WorkspaceRef, { baseBranch, stashDirty = false, rootPath = "" }: { baseBranch?: string; stashDirty?: boolean; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    return this.runWriteAction(workspace, {
      type: "merge",
      label: "Merge",
      baseBranch,
      stashDirty,
      run: (cwd, resolvedBaseBranch) => runEffect(this.execGitEffect(cwd, ["merge", "--no-edit", resolvedBaseBranch])),
      rootPath,
    });
  }

  async rebaseOnto(workspace: WorkspaceRef, { baseBranch, stashDirty = false, rootPath = "" }: { baseBranch?: string; stashDirty?: boolean; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    return this.runWriteAction(workspace, {
      type: "rebase",
      label: "Rebase",
      baseBranch,
      stashDirty,
      run: (cwd, resolvedBaseBranch) => runEffect(this.execGitEffect(cwd, ["rebase", resolvedBaseBranch])),
      rootPath,
    });
  }

  async continueOperation(workspace: WorkspaceRef, { rootPath = "" }: { rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const snapshot = await (rootPath ? this._inspectRoot(workspace, rootPath) : this.inspectWorkspace(workspace));
    if (!snapshot.available) {
      return createStructuredResult({
        ok: false,
        summary: String(snapshot.error || "Git workspace is unavailable."),
      });
    }

    const operationState = snapshot.operationState as { kind: string; inProgress: boolean; conflicts: string[] };
    const args = resolveContinueArgs(operationState.kind);
    if (!args) {
      return createStructuredResult({
        ok: false,
        summary: "No Git operation can be continued in this workspace.",
      });
    }

    return this.runWriteAction(workspace, {
      type: operationState.kind,
      label: "Continue",
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, args),
      rootPath,
    });
  }

  async abortOperation(workspace: WorkspaceRef, { rootPath = "" }: { rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const snapshot = await (rootPath ? this._inspectRoot(workspace, rootPath) : this.inspectWorkspace(workspace));
    if (!snapshot.available) {
      return createStructuredResult({
        ok: false,
        summary: String(snapshot.error || "Git workspace is unavailable."),
      });
    }

    const operationState = snapshot.operationState as { kind: string; inProgress: boolean; conflicts: string[] };
    const args = resolveAbortArgs(operationState.kind);
    if (!args) {
      return createStructuredResult({
        ok: false,
        summary: "No Git operation can be aborted in this workspace.",
      });
    }

    const effectiveCwd = rootPath || String(workspace.cwd || "");
    const result = await this.runWriteAction(workspace, {
      type: operationState.kind,
      label: "Abort",
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, args),
      rootPath,
    });

    if (result.ok) {
      const stashRestore = await this.restoreStridetermStash(effectiveCwd);
      if (stashRestore) {
        result.rawOutput = joinRawOutput(result.rawOutput, stashRestore);
        (result.warnings as string[]).push("Restored previously stashed local changes.");
      }
    }

    return result;
  }

  async diffPreview(workspace: WorkspaceRef | null, { path: targetPath, scope = "unstaged", baseBranch = "", rootPath = "" }: { path?: string; scope?: string; baseBranch?: string; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd || !targetPath) {
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
      const preview = await renderUntrackedDiffPreview(this.execGit.bind(this), effectiveCwd, targetPath);
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
      const result = await this.execGit(effectiveCwd, args);
      const diff = trimDiffPreview(result.stdout || result.stderr || "");
      return {
        ok: true,
        scope: normalizedScope,
        path: targetPath,
        diff,
        summary: diff ? "" : "No diff output for the selected file.",
      };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return {
        ok: false,
        scope: normalizedScope,
        path: targetPath,
        diff: trimDiffPreview(err.stdout || err.stderr || ""),
        summary: extractErrorMessage(error),
      };
    }
  }

  async commitDiff(workspace: WorkspaceRef | null, { hash, rootPath = "" }: { hash?: string; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd || !hash) {
      return { ok: false, hash: hash || "", diff: "", summary: "Workspace cwd and commit hash are required." };
    }

    try {
      const result = await this.execGit(effectiveCwd, ["show", "--stat", "--patch", hash]);
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
    workspace: WorkspaceRef,
    {
      type,
      label,
      baseBranch = "",
      stashDirty = false,
      allowDirty = false,
      skipPreflight = false,
      run,
      connection = null,
      extraAudit = {},
      rootPath = "",
    }: WriteActionOptions,
  ): Promise<Record<string, unknown>> {
    this.invalidateSnapshotCache(workspace.id, rootPath || null);
    const snapshot = await (rootPath ? this._inspectRoot(workspace, rootPath) : this.inspectWorkspace(workspace));
    if (!snapshot.available) {
      return createStructuredResult({
        ok: false,
        summary: String(snapshot.error || "Git workspace is unavailable."),
      });
    }

    const operationState = snapshot.operationState as { kind: string; inProgress: boolean; label?: string; conflicts: string[] };
    const resolvedBaseBranch = String(baseBranch || snapshot.baseBranch || snapshot.upstream || "").trim();
    const warnings = createOperationWarnings(snapshot as Parameters<typeof createOperationWarnings>[0], { type, baseBranch: resolvedBaseBranch, stashDirty });

    if (!skipPreflight) {
      if (operationState.inProgress) {
        return createStructuredResult({
          ok: false,
          summary: `${operationState.label}. Finish or abort it before starting another Git action.`,
          warnings,
          conflicts: operationState.conflicts,
          operationState: operationState as typeof DEFAULT_OPERATION_STATE,
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

    if (["merge", "rebase"].includes(type) && resolvedBaseBranch.startsWith("-")) {
      return createStructuredResult({
        ok: false,
        summary: "Invalid base branch.",
        warnings,
      });
    }

    let stashLabel = "";
    let stashOutput = "";

    const effectiveCwd = rootPath || String(workspace.cwd || "");
    try {
      if (stashDirty && snapshot.dirty) {
        stashLabel = `strideterm-${type}-${this.now().toISOString()}`;
        const stashResult = await this.execGit(effectiveCwd, [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          stashLabel,
        ]);
        stashOutput = stashResult.stdout || stashResult.stderr || "";
      }

      log.debug("git action starting", { type, label, cwd: effectiveCwd, baseBranch: resolvedBaseBranch });
      const startTime = Date.now();
      const actionResult = await run(effectiveCwd, resolvedBaseBranch);
      let restoreOutput = "";
      if (stashLabel) {
        restoreOutput = await this.restoreStash(effectiveCwd);
      }
      const durationMs = Date.now() - startTime;
      log.info("git action completed", { type, label, durationMs });
      const remoteUrl = String(Object.values((snapshot.remotes as Record<string, unknown>) || {})[0] || "");
      const auditExtra = rootPath ? { ...extraAudit, rootPath } : extraAudit;
      this._logGitAudit({
        type,
        connection,
        success: true,
        durationMs,
        workspaceId: workspace.id,
        remoteUrl,
        extra: auditExtra,
      });
      return createStructuredResult({
        ok: true,
        summary: resolvedBaseBranch
          ? `${label} completed against ${resolvedBaseBranch}.`
          : `${label} completed successfully.`,
        warnings,
        rawOutput: joinRawOutput(stashOutput, actionResult.stdout, actionResult.stderr, restoreOutput),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      log.warn("git action failed", { type, label, err: extractErrorMessage(error) });
      const remoteUrlOnError = String(Object.values((snapshot.remotes as Record<string, unknown>) || {})[0] || "");
      const auditExtraOnError = rootPath ? { ...extraAudit, rootPath } : extraAudit;
      this._logGitAudit({
        type,
        connection,
        success: false,
        errorMessage: extractErrorMessage(error),
        workspaceId: workspace.id,
        remoteUrl: remoteUrlOnError,
        extra: auditExtraOnError,
      });
      const operationSnapshot = await (rootPath
        ? this._inspectRoot(workspace, rootPath)
        : this.inspectWorkspace(workspace));
      const opState = operationSnapshot.operationState as { kind: string; inProgress: boolean; conflicts: string[] };
      let restoreOutput = "";
      if (stashLabel && !opState.inProgress) {
        restoreOutput = await this.restoreStash(effectiveCwd);
      } else if (stashLabel) {
        (warnings as string[]).push("Stashed local changes were kept because the Git operation needs manual resolution.");
      }

      const hasConflictState = opState.inProgress || opState.conflicts.length > 0;
      return createStructuredResult({
        ok: false,
        summary: hasConflictState
          ? `${label} stopped because Git reported conflicts or requires manual resolution.`
          : `${label} failed.`,
        warnings,
        conflicts: opState.conflicts,
        rawOutput: joinRawOutput(stashOutput, err.stdout, err.stderr, restoreOutput),
        operationState: opState as typeof DEFAULT_OPERATION_STATE,
      });
    }
  }

  _logGitAudit({ type, connection, success, durationMs, errorMessage, workspaceId, remoteUrl, extra = {} }: LogGitAuditOptions): void {
    const REMOTE_OPS = new Set([
      "push",
      "pull",
      "fetch",
      "force-push",
      "push-tag",
      "push-all-tags",
      "delete-remote-tag",
    ]);
    const isRemoteOp = REMOTE_OPS.has(type);
    const writeOps = new Set(["push", "push-tag", "push-all-tags", "delete-remote-tag", "force-push"]);

    try {
      if (connection?.id && this.auditLogStore) {
        const organization = String(connection.orgUrl || connection.baseUrl || connection.label || "");
        this.auditLogStore.logEntry({
          timestamp: new Date().toISOString(),
          connectionId: connection.id,
          organization,
          project: "",
          operation: `git${type.charAt(0).toUpperCase()}${type.slice(1)}`,
          category: writeOps.has(type) ? "write" : "read",
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
          ...extra,
        });
      } else if (!connection?.id && isRemoteOp && this.gitAuditLogStore) {
        this.gitAuditLogStore.logEntry({
          timestamp: new Date().toISOString(),
          connectionId: `system-${workspaceId || "unknown"}`,
          remoteUrl: remoteUrl || "",
          operation: `git${type.charAt(0).toUpperCase()}${type.slice(1)}`,
          category: writeOps.has(type) ? "write" : "read",
          method: "GIT",
          url: "",
          statusCode: null,
          success,
          errorMessage: errorMessage || null,
          durationMs: durationMs ?? null,
          resourceType: "git",
          resourceId: `${type}@${remoteUrl || "unknown"}`,
          summary: `git ${type} (system credentials)`,
          userInitiated: true,
          ...extra,
        });
      }
    } catch {
      // Never let audit logging break the main flow
    }
  }

  async restoreStash(cwd: string): Promise<string> {
    try {
      const result = await this.execGit(cwd, ["stash", "pop"]);
      return joinRawOutput(result.stdout, result.stderr);
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return joinRawOutput(err.stdout, err.stderr);
    }
  }

  async mergeCurrentIntoBase(workspace: WorkspaceRef, { baseBranch, rootPath = "" }: { baseBranch?: string; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const snapshot = await (rootPath ? this._inspectRoot(workspace, rootPath) : this.inspectWorkspace(workspace));
    if (!snapshot.available) {
      return createStructuredResult({ ok: false, summary: String(snapshot.error || "Git workspace is unavailable.") });
    }

    const resolvedBase = baseBranch || String(snapshot.baseBranch || "");
    if (!resolvedBase) {
      return createStructuredResult({ ok: false, summary: "Base branch could not be determined." });
    }

    if (normalizeBranchName(resolvedBase) === normalizeBranchName(String(snapshot.branch || ""))) {
      return createStructuredResult({ ok: false, summary: "Current branch is already the base branch." });
    }

    const siblingWorktrees = (snapshot.siblingWorktrees as Array<{ branch: string; path: string; isMainWorktree: boolean; isCurrent: boolean }>) || [];
    const mainWorktree = siblingWorktrees.find(
      (entry) => entry.branch === resolvedBase || (entry.isMainWorktree && !entry.isCurrent),
    );
    const targetCwd = mainWorktree?.path || String(snapshot.mainWorktreePath || "");
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
      const result = await this.execGit(targetCwd, ["merge", "--no-edit", String(snapshot.branch || "")]);
      return createStructuredResult({
        ok: true,
        summary: `Merged ${snapshot.branch} into ${resolvedBase}.`,
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      const postSnapshot = await this.inspectOperationState(targetCwd, {
        gitDir: path.join(targetCwd, ".git"),
        gitCommonDir: String(snapshot.gitCommonDir || path.join(targetCwd, ".git")),
      });
      return createStructuredResult({
        ok: false,
        summary: postSnapshot.inProgress
          ? `Merge stopped due to conflicts in the ${resolvedBase} worktree. Resolve them there.`
          : `Merge of ${snapshot.branch} into ${resolvedBase} failed.`,
        conflicts: postSnapshot.conflicts,
        rawOutput: joinRawOutput(err.stdout, err.stderr),
        operationState: postSnapshot.inProgress ? buildOperationState(postSnapshot) : undefined,
      });
    }
  }

  async commitAll(workspace: WorkspaceRef | null, { message, rootPath = "" }: { message?: string; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const commitMessage = String(message || "").trim();
    if (!commitMessage) {
      return createStructuredResult({ ok: false, summary: "Commit message is required." });
    }

    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }

    try {
      await this.execGit(effectiveCwd, ["add", "-A"]);
      const result = await this.execGit(effectiveCwd, ["commit", "-m", commitMessage]);
      return createStructuredResult({
        ok: true,
        summary: "Changes committed successfully.",
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return createStructuredResult({
        ok: false,
        summary: "Commit failed.",
        rawOutput: joinRawOutput(err.stdout, err.stderr),
      });
    }
  }

  async removeWorktree(workspace: WorkspaceRef | null, { worktreePath, deleteBranch = false, rootPath = "" }: { worktreePath?: string; deleteBranch?: boolean; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd || !worktreePath) {
      return createStructuredResult({ ok: false, summary: "Worktree path is required." });
    }

    const resolvedPath = path.resolve(worktreePath);
    const mainPath = path.resolve(effectiveCwd);
    if (resolvedPath === mainPath) {
      return createStructuredResult({ ok: false, summary: "Cannot remove the main worktree." });
    }

    let branchName = "";
    if (deleteBranch) {
      try {
        const worktrees = parseWorktreeList(
          (await this.execGit(effectiveCwd, ["worktree", "list", "--porcelain"])).stdout,
        );
        branchName = worktrees.find((entry) => path.resolve(entry.path) === resolvedPath)?.branch || "";
      } catch {
        // branch detection failed, skip branch deletion
      }
    }

    try {
      await this.execGit(effectiveCwd, ["worktree", "remove", "--force", resolvedPath]);
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return createStructuredResult({
        ok: false,
        summary: `Failed to remove worktree at ${resolvedPath}.`,
        rawOutput: joinRawOutput(err.stdout, err.stderr),
      });
    }

    let branchOutput = "";
    if (deleteBranch && branchName) {
      try {
        const result = await this.execGit(effectiveCwd, ["branch", "-d", branchName]);
        branchOutput = joinRawOutput(result.stdout, result.stderr);
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string };
        branchOutput = `Branch ${branchName} could not be deleted (may not be fully merged): ${joinRawOutput(err.stdout, err.stderr)}`;
      }
    }

    return createStructuredResult({
      ok: true,
      summary: `Worktree removed.${branchName && deleteBranch ? ` Branch ${branchName} deleted.` : ""}`,
      rawOutput: branchOutput,
    });
  }

  async detectBestBaseBranch(cwd: string, currentBranch: string, upstream: string, branchNames: string[] = []): Promise<string> {
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

  async getStashCount(cwd: string): Promise<number> {
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

  async stash(workspace: WorkspaceRef | null, { message = "", rootPath = "" }: { message?: string; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const args = ["stash", "push", "--include-untracked"];
      if (message) args.push("-m", message);
      const result = await this.execGit(effectiveCwd, args);
      const combined = joinRawOutput(result.stdout, result.stderr);
      if (/no local changes to save/i.test(combined)) {
        return createStructuredResult({
          ok: false,
          summary: "No local changes to stash.",
          rawOutput: combined,
        });
      }
      return createStructuredResult({
        ok: true,
        summary: "Changes stashed successfully.",
        rawOutput: combined,
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return createStructuredResult({
        ok: false,
        summary: "Stash failed.",
        rawOutput: joinRawOutput(err.stdout, err.stderr),
      });
    }
  }

  async stashPop(workspace: WorkspaceRef | null, { rootPath = "" }: { rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const result = await this.execGit(effectiveCwd, ["stash", "pop"]);
      return createStructuredResult({
        ok: true,
        summary: "Stash applied and removed.",
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return createStructuredResult({
        ok: false,
        summary: "Stash pop failed.",
        rawOutput: joinRawOutput(err.stdout, err.stderr),
      });
    }
  }

  // ─── Tag operations ───────────────────────────────────────────────

  async listTags(workspace: WorkspaceRef | null, { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
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
      const result = await this.execGit(effectiveCwd, [
        "for-each-ref",
        `--format=${fmt}`,
        "--sort=-creatordate",
        "refs/tags",
      ]);
      const lines = String(result.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean);
      const tags: Array<Record<string, unknown>> = lines.map((line) => {
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
      const remoteTags = new Set<string>();
      try {
        const remoteResult = await this.execAuthGit(effectiveCwd, ["ls-remote", "--tags", "origin"], { connection });
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

      const localTagNames = new Set(tags.map((t) => String(t.name)));
      for (const tag of tags) {
        tag.pushed = remoteTags.has(String(tag.name));
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
      const err = error as { stdout?: string; stderr?: string };
      return { ok: false, tags: [], summary: joinRawOutput(err.stdout, err.stderr) || "Failed to list tags." };
    }
  }

  async createTag(workspace: WorkspaceRef | null, { tagName, message = "", commit = "", rootPath = "" }: { tagName?: string; message?: string; commit?: string; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const name = String(tagName || "").trim();
    if (!name) {
      return createStructuredResult({ ok: false, summary: "Tag name is required." });
    }
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const args = message ? ["tag", "-a", name, "-m", message] : ["tag", name];
      if (commit) args.push(commit);
      const result = await this.execGit(effectiveCwd, args);
      return createStructuredResult({
        ok: true,
        summary: `Tag '${name}' created.`,
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return createStructuredResult({
        ok: false,
        summary: `Failed to create tag '${name}'.`,
        rawOutput: joinRawOutput(err.stdout, err.stderr),
      });
    }
  }

  async deleteTag(workspace: WorkspaceRef | null, { tagName, rootPath = "" }: { tagName?: string; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    const name = String(tagName || "").trim();
    if (!name) {
      return createStructuredResult({ ok: false, summary: "Tag name is required." });
    }
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const result = await this.execGit(effectiveCwd, ["tag", "-d", name]);
      return createStructuredResult({
        ok: true,
        summary: `Tag '${name}' deleted.`,
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return createStructuredResult({
        ok: false,
        summary: `Failed to delete tag '${name}'.`,
        rawOutput: joinRawOutput(err.stdout, err.stderr),
      });
    }
  }

  async pushTag(workspace: WorkspaceRef, { tagName, connection = null, rootPath = "" }: { tagName?: string; connection?: Connection | null; rootPath?: string } = {}): Promise<Record<string, unknown>> {
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
      rootPath,
    });
  }

  async pushAllTags(workspace: WorkspaceRef, { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {}): Promise<Record<string, unknown>> {
    return this.runWriteAction(workspace, {
      type: "push-all-tags",
      label: "Push all tags",
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execAuthGit(cwd, ["push", "origin", "--tags"], { connection }),
      connection,
      rootPath,
    });
  }

  async deleteRemoteTag(workspace: WorkspaceRef, { tagName, connection = null, rootPath = "" }: { tagName?: string; connection?: Connection | null; rootPath?: string } = {}): Promise<Record<string, unknown>> {
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
      rootPath,
    });
  }

  async restoreStridetermStash(cwd: string): Promise<string> {
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
      const err = error as { stdout?: string; stderr?: string } | null;
      return joinRawOutput(err?.stdout, err?.stderr);
    }
  }
}
