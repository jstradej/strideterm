/// <reference types="node" />
import path from "node:path";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { rm as fsRm, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
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
  buildOperationState,
  extractErrorMessage,
  createOperationWarnings,
  createStructuredResult,
  resolveContinueArgs,
  resolveAbortArgs,
  resolveSkipArgs,
  parseLsFilesUntracked,
  inspectWorktreeDirtyState,
  joinRawOutput,
  uniqueByPath,
  mapStatusForLegacy,
  trimDiffPreview,
  renderUntrackedDiffPreview,
  getFetchTimestamp,
  parseStashNumstat,
  parseStashNameStatus,
  parseConflictPaths,
  EMPTY_TREE_SHA,
} from "./git-parsers.js";
import type {
  StashEntry,
  StashFile,
  OperationProgress,
  OperationSides,
  OperationCurrentCommit,
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
    return execFileText("git", args, { cwd, env: sanitizeGitEnvironment() });
  }

  /**
   * Run a git command with optional token-based authentication.
   * When a connection provides login + tokenRef, the PAT is injected via
   * `git -c http.extraheader=…` so the operation is audited under the
   * correct Azure DevOps / provider identity.
   */
  async execAuthGit(
    cwd: string,
    args: string[],
    { connection = null }: { connection?: Connection | null } = {},
  ): Promise<GitExecResult> {
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
        return new GitCommandError({
          cwd,
          cmd: "git",
          args,
          stderr: err.stderr ?? String(e),
          exitCode: err.exitCode ?? 1,
        });
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

  async getCachedWorktreeDirtyState(
    worktreePath: string,
    fallbackDirty = false,
  ): Promise<{ dirty: boolean; dirtyCount: number }> {
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

  /**
   * Resolve "last activity" for a worktree as a Unix timestamp (ms).
   *
   * We don't want a per-worktree subprocess on every snapshot, so we use the
   * mtime of the worktree's HEAD pointer file. Git updates HEAD on commit,
   * checkout, reset and friends — close enough to "last user activity" for
   * the worktree picker without burning a `git log -1` per row.
   *
   * Falls back to the worktree directory's own mtime, then to 0 (unknown).
   */
  async getWorktreeLastActivity(worktreePath: string, gitCommonDir: string, isMain: boolean): Promise<number> {
    const candidates: string[] = [];
    const safePath = String(worktreePath || "");
    if (!safePath) return 0;

    if (isMain) {
      if (gitCommonDir) candidates.push(path.join(gitCommonDir, "HEAD"));
      candidates.push(path.join(safePath, ".git", "HEAD"));
    } else {
      // Linked worktrees keep their HEAD inside <commonDir>/worktrees/<name>/HEAD.
      const wtName = path.basename(safePath);
      if (gitCommonDir && wtName) candidates.push(path.join(gitCommonDir, "worktrees", wtName, "HEAD"));
      // Some setups use a plain .git file pointing into the common dir; if that
      // exists, its mtime is a reasonable proxy too.
      candidates.push(path.join(safePath, ".git"));
    }
    candidates.push(safePath);

    const { stat } = await import("node:fs/promises");
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (info.mtimeMs) return Math.floor(info.mtimeMs);
      } catch {
        // try next
      }
    }
    return 0;
  }

  /**
   * Newest write to the worktree as an ISO string (or null). Combines the
   * HEAD/worktree mtime already gathered for the current worktree (commits,
   * checkouts, top-level add/remove) with the mtimes of uncommitted dirty
   * files, so a plain edit to an existing tracked file still counts as a
   * "change". Stats are capped so a massively dirty tree can't stall the
   * snapshot. Feeds the relative "last change" chip on the sidebar card.
   */
  async computeLastChangeAt(
    root: string,
    baseMs: number,
    dirtyEntries: Array<{ path?: string }>,
  ): Promise<string | null> {
    let bestMs = baseMs > 0 ? baseMs : 0;
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const entry of dirtyEntries) {
      const rel = entry?.path;
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      paths.push(rel);
      if (paths.length >= 500) break;
    }
    if (paths.length) {
      const { stat } = await import("node:fs/promises");
      await Promise.all(
        paths.map(async (rel) => {
          try {
            const info = await stat(path.join(root, rel));
            if (info.mtimeMs > bestMs) bestMs = Math.floor(info.mtimeMs);
          } catch {
            // file vanished mid-snapshot or unreadable — skip
          }
        }),
      );
    }
    return bestMs > 0 ? new Date(bestMs).toISOString() : null;
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
      // Batch every independent read into one Promise.all. Previously
      // getStashCount and the two readDiffStat calls ran sequentially after
      // this block — they don't depend on parsed status, so moving them up
      // shortens the per-workspace inspect chain by three awaits per
      // refreshGit cycle.
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
        stashCount,
        stagedDiffStat,
        unstagedDiffStat,
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
        this.getStashCount(rootPath),
        this.readDiffStat(rootPath, ["diff", "--cached", "--shortstat"]),
        this.readDiffStat(rootPath, ["diff", "--shortstat"]),
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
      const parsedRemotes = parseGitRemotes(remoteResult.stdout);
      // Surface the symbolic default branch on the snapshot — every consumer
      // (History, MergeBack, Compare picker on every tab) should be able to
      // read it without first running listBranches.
      const symbolicDefaultFull = await this.readSymbolicDefaultRemoteBranch(rootPath, parsedRemotes);
      let defaultRemoteName = "";
      let defaultBranchShort = "";
      if (symbolicDefaultFull) {
        // Split "origin/master" → ("origin", "master"). The remote name is
        // the prefix that matches an actual remote — handles remotes whose
        // names contain a slash by checking longest-prefix-first.
        const remoteKeys = Object.keys(parsedRemotes || {}).filter((k) => k && !k.includes(":"));
        remoteKeys.sort((a, b) => b.length - a.length);
        for (const r of remoteKeys) {
          if (symbolicDefaultFull.startsWith(`${r}/`)) {
            defaultRemoteName = r;
            defaultBranchShort = symbolicDefaultFull.slice(r.length + 1);
            break;
          }
        }
      }
      const baseBranch = reviewSourceRef
        ? `origin/${reviewSourceRef}`
        : await this.detectBestBaseBranch(
            rootPath,
            branch,
            upstream,
            branchNames,
            parsedRemotes,
            symbolicDefaultFull, // already resolved above; thread through to skip duplicate symbolic-ref calls
          );
      // readBaseComparison depends on baseBranch (resolved just above) so it
      // can't fold into the batched Promise.all up top; stashCount + diffStat
      // already happened there.
      const compareWithBase = await this.readBaseComparison(rootPath, baseBranch, branch);
      const operationState = await this.inspectOperationState(rootPath, { gitDir, gitCommonDir });
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
          const [dirtyState, lastActivity] = await Promise.all([
            isCurrent
              ? Promise.resolve({ dirty: dirtyCount > 0, dirtyCount })
              : this.getCachedWorktreeDirtyState(entry.path),
            this.getWorktreeLastActivity(entry.path, gitCommonDir, index === 0),
          ]);
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
            lastActivityMs: lastActivity,
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
        remotes: parsedRemotes,
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
        defaultBranch: defaultBranchShort,
        defaultRemote: defaultRemoteName,
        branchNames,
        stashCount,
        aheadCount: parsedStatus.aheadCount,
        behindCount: parsedStatus.behindCount,
        compareWithBase,
        lastFetchAt: getFetchTimestamp(gitCommonDir),
        operationState: operationState.inProgress
          ? buildOperationState({
              kind: operationState.kind,
              conflicts: operationState.conflicts,
              progress: operationState.progress,
              currentCommit: operationState.currentCommit,
              sides: operationState.sides,
            })
          : { ...DEFAULT_OPERATION_STATE, canSkip: false, progress: null, currentCommit: null, sides: null },
        error: "",
        lastUpdatedAt: this.now().toISOString(),
        lastChangeAt: await this.computeLastChangeAt(
          root,
          siblingWorktrees.find((entry) => entry.isCurrent)?.lastActivityMs || 0,
          [...staged, ...unstaged, ...untracked, ...conflicts],
        ),
      };
    } catch (error) {
      return createUnavailableSnapshot(workspace, extractErrorMessage(error));
    }
  }

  async inspectWorkspaceRoots(
    workspace: WorkspaceRef,
  ): Promise<{ roots: Array<Record<string, unknown>>; primaryRoot: string }> {
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

  async compareWithBranch(
    workspace: WorkspaceRef | null,
    { baseBranch = "", rootPath = "" }: { baseBranch?: string; rootPath?: string } = {},
  ): Promise<{ ok: boolean; baseBranch: string; aheadCount: number; behindCount: number; error?: string }> {
    const effectiveCwd = rootPath || workspace?.cwd || "";
    if (!effectiveCwd || !baseBranch) {
      return {
        ok: false,
        baseBranch,
        aheadCount: 0,
        behindCount: 0,
        error: "Working directory or base branch missing",
      };
    }
    try {
      const branchResult = await this.execGit(effectiveCwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const currentBranch = branchResult.stdout.trim();
      if (!currentBranch || currentBranch === "HEAD") {
        return { ok: false, baseBranch, aheadCount: 0, behindCount: 0, error: "Detached HEAD" };
      }
      if (normalizeBranchName(baseBranch) === normalizeBranchName(currentBranch)) {
        return { ok: true, baseBranch, aheadCount: 0, behindCount: 0 };
      }
      const result = await this.execGit(effectiveCwd, ["rev-list", "--left-right", "--count", `HEAD...${baseBranch}`]);
      const counts = parseRevListCount(result.stdout);
      return {
        ok: true,
        baseBranch,
        aheadCount: counts.left || 0,
        behindCount: counts.right || 0,
      };
    } catch (error) {
      return {
        ok: false,
        baseBranch,
        aheadCount: 0,
        behindCount: 0,
        error: extractErrorMessage(error),
      };
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

  async inspectOperationState(
    cwd: string,
    { gitDir, gitCommonDir }: { gitDir: string; gitCommonDir: string },
  ): Promise<{
    kind: string;
    inProgress: boolean;
    conflicts: string[];
    progress: OperationProgress | null;
    currentCommit: OperationCurrentCommit | null;
    sides: OperationSides | null;
  }> {
    const mergeHeadPath = path.join(gitDir, "MERGE_HEAD");
    const cherryPickHeadPath = path.join(gitDir, "CHERRY_PICK_HEAD");
    const rebaseMergePath = path.join(gitDir, "rebase-merge");
    const rebaseApplyPath = path.join(gitDir, "rebase-apply");
    const bisectPath = path.join(gitCommonDir || gitDir, "BISECT_LOG");
    const conflicts = await this.readConflicts(cwd);

    const readGitFile = async (filePath: string): Promise<string> => {
      try {
        return (await fsReadFile(filePath, "utf-8")).trim();
      } catch {
        return "";
      }
    };

    if (existsSync(mergeHeadPath)) {
      const mergeHead = await readGitFile(mergeHeadPath);
      const mergeMsg = await readGitFile(path.join(gitDir, "MERGE_MSG"));
      let branch = "";
      try {
        const r = await this.execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
        branch = r.stdout.trim();
      } catch {
        /* empty */
      }
      let mergeBranch = "";
      try {
        const r = await this.execGit(cwd, ["name-rev", "--name-only", mergeHead]);
        mergeBranch = r.stdout.trim().replace(/~\d+$/, "");
      } catch {
        /* empty */
      }
      const subject =
        mergeMsg
          .split(/\r?\n/)[0]
          ?.replace(/^Merge.*?into\s+\S+/, "")
          .trim() || mergeHead.slice(0, 7);
      return {
        kind: "merge",
        inProgress: true,
        conflicts,
        progress: null,
        currentCommit: mergeHead ? { sha: mergeHead.slice(0, 7), subject } : null,
        sides: { ours: branch || "HEAD", theirs: mergeBranch || mergeHead.slice(0, 7) },
      };
    }

    if (existsSync(rebaseMergePath) || existsSync(rebaseApplyPath)) {
      const rmDir = existsSync(rebaseMergePath) ? rebaseMergePath : rebaseApplyPath;
      const [msgnumStr, endStr, stoppedSha, msgContent, headName, ontoName] = await Promise.all([
        readGitFile(path.join(rmDir, "msgnum")),
        readGitFile(path.join(rmDir, "end")),
        readGitFile(path.join(rmDir, "stopped-sha")),
        readGitFile(path.join(rmDir, "message")),
        readGitFile(path.join(rmDir, "head-name")),
        readGitFile(path.join(rmDir, "onto_name")),
      ]);
      const current = parseInt(msgnumStr, 10) || 0;
      const total = parseInt(endStr, 10) || 0;
      const sha = stoppedSha.slice(0, 7);
      const subject = msgContent.split(/\r?\n/)[0] || sha;
      // rebase semantics: HEAD=new base (ours), replayed commit=theirs
      const oursLabel = headName.replace(/^refs\/heads\//, "") || "HEAD";
      const theirsLabel = ontoName || sha || "commit";
      return {
        kind: "rebase",
        inProgress: true,
        conflicts,
        progress: current && total ? { current, total } : null,
        currentCommit: sha ? { sha, subject } : null,
        sides: { ours: oursLabel, theirs: theirsLabel },
      };
    }

    if (existsSync(cherryPickHeadPath)) {
      const cpHead = await readGitFile(cherryPickHeadPath);
      let subject = "";
      try {
        const r = await this.execGit(cwd, ["log", "-1", "--format=%s", cpHead]);
        subject = r.stdout.trim();
      } catch {
        /* empty */
      }
      let branch = "";
      try {
        const r = await this.execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
        branch = r.stdout.trim();
      } catch {
        /* empty */
      }
      return {
        kind: "cherry-pick",
        inProgress: true,
        conflicts,
        progress: null,
        currentCommit: cpHead ? { sha: cpHead.slice(0, 7), subject: subject || cpHead.slice(0, 7) } : null,
        sides: { ours: branch || "HEAD", theirs: cpHead.slice(0, 7) },
      };
    }

    if (existsSync(bisectPath)) {
      return { kind: "bisect", inProgress: true, conflicts, progress: null, currentCommit: null, sides: null };
    }

    return { kind: "idle", inProgress: false, conflicts: [], progress: null, currentCommit: null, sides: null };
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
    return lazygit?.launch ? { file: lazygit.launch.file, args: [...lazygit.launch.args] } : null;
  }

  async fetch(
    workspace: WorkspaceRef,
    { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.runWriteAction(workspace, {
      type: "fetch",
      label: "Fetch",
      run: (cwd) => runEffect(this.execAuthGitEffect(cwd, ["fetch", "--all", "--prune"], { connection })),
      allowDirty: true,
      connection,
      rootPath,
    });
  }

  async pull(
    workspace: WorkspaceRef,
    {
      connection = null,
      rootPath = "",
      stashDirty = false,
    }: { connection?: Connection | null; rootPath?: string; stashDirty?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    return this.runWriteAction(workspace, {
      type: "pull",
      label: "Pull",
      run: (cwd) => runEffect(this.execAuthGitEffect(cwd, ["pull", "--ff-only"], { connection })),
      allowDirty: true,
      stashDirty,
      connection,
      rootPath,
    });
  }

  async push(
    workspace: WorkspaceRef,
    { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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
    const remoteNames = Object.keys((snapshot.remotes as Record<string, unknown>) || {}).filter(
      (k) => !k.includes(":"),
    );
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

  async forcePushWithLease(
    workspace: WorkspaceRef,
    { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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
    const remoteNames = Object.keys((snapshot.remotes as Record<string, unknown>) || {}).filter(
      (k) => !k.includes(":"),
    );
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

  async checkoutBranch(
    workspace: WorkspaceRef,
    { branch, rootPath = "" }: { branch?: string; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  async createBranch(
    workspace: WorkspaceRef,
    { branch, startPoint = "", rootPath = "" }: { branch?: string; startPoint?: string; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  async mergeIntoCurrent(
    workspace: WorkspaceRef,
    {
      baseBranch,
      stashDirty = false,
      rootPath = "",
    }: { baseBranch?: string; stashDirty?: boolean; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.runWriteAction(workspace, {
      type: "merge",
      label: "Merge",
      baseBranch,
      stashDirty,
      run: (cwd, resolvedBaseBranch) => runEffect(this.execGitEffect(cwd, ["merge", "--no-edit", resolvedBaseBranch])),
      rootPath,
    });
  }

  async rebaseOnto(
    workspace: WorkspaceRef,
    {
      baseBranch,
      stashDirty = false,
      rootPath = "",
    }: { baseBranch?: string; stashDirty?: boolean; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.runWriteAction(workspace, {
      type: "rebase",
      label: "Rebase",
      baseBranch,
      stashDirty,
      run: (cwd, resolvedBaseBranch) => runEffect(this.execGitEffect(cwd, ["rebase", resolvedBaseBranch])),
      rootPath,
    });
  }

  async continueOperation(
    workspace: WorkspaceRef,
    { rootPath = "" }: { rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

    const result = await this.runWriteAction(workspace, {
      type: operationState.kind,
      label: "Continue",
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, args),
      rootPath,
    });

    if (result.ok) {
      const stashRestore = await this.restoreParkedStashIfFinished(workspace, rootPath);
      if (stashRestore) {
        result.rawOutput = joinRawOutput(result.rawOutput, stashRestore);
        (result.warnings as string[]).push("Restored previously stashed local changes.");
      }
    }

    return result;
  }

  /**
   * When a continue/skip finishes the whole operation, bring back changes
   * that were auto-stashed when it started — the conflict-stop path keeps
   * them parked ("Stashed local changes were kept…") and only abort restored
   * them before this helper existed. No-op while the operation still runs.
   */
  private async restoreParkedStashIfFinished(workspace: WorkspaceRef, rootPath: string): Promise<string> {
    // The pre-action inspect (runWriteAction) may still be cached — drop it so
    // the in-progress check sees the state the continue/skip actually left.
    this.invalidateSnapshotCache(workspace.id, rootPath || null);
    const after = await (rootPath ? this._inspectRoot(workspace, rootPath) : this.inspectWorkspace(workspace));
    const opAfter = after.operationState as { inProgress?: boolean } | undefined;
    if (opAfter?.inProgress) return "";
    const output = await this.restoreStridetermStash(rootPath || String(workspace.cwd || ""));
    if (output) this.invalidateSnapshotCache(workspace.id, rootPath || null);
    return output;
  }

  async abortOperation(
    workspace: WorkspaceRef,
    { rootPath = "" }: { rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  async skipCommit(
    workspace: WorkspaceRef,
    { rootPath = "" }: { rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
    const snapshot = await (rootPath ? this._inspectRoot(workspace, rootPath) : this.inspectWorkspace(workspace));
    if (!snapshot.available) {
      return createStructuredResult({ ok: false, summary: String(snapshot.error || "Git workspace is unavailable.") });
    }
    const operationState = snapshot.operationState as { kind: string };
    const args = resolveSkipArgs(operationState.kind);
    if (!args) {
      return createStructuredResult({ ok: false, summary: "Current operation does not support skip." });
    }
    const result = await this.runWriteAction(workspace, {
      type: operationState.kind,
      label: "Skip",
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, args),
      rootPath,
    });

    if (result.ok) {
      const stashRestore = await this.restoreParkedStashIfFinished(workspace, rootPath);
      if (stashRestore) {
        result.rawOutput = joinRawOutput(result.rawOutput, stashRestore);
        (result.warnings as string[]).push("Restored previously stashed local changes.");
      }
    }

    return result;
  }

  async listConflicts(
    workspace: WorkspaceRef,
    { rootPath = "" }: { rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd || "";
    if (!effectiveCwd) return { ok: false, entries: [], summary: "No workspace directory." };
    try {
      const result = await this.execGit(effectiveCwd, ["ls-files", "-u"]);
      const entries = parseLsFilesUntracked(result.stdout);
      // Detect binary files via null-byte sniff on the worktree file
      const entriesWithBinary = await Promise.all(
        entries.map(async (entry) => {
          const absPath = path.join(effectiveCwd, entry.path);
          let binary = false;
          try {
            // Read first 8000 bytes to detect binary
            const buf = Buffer.alloc(8000);
            const fh = await import("node:fs/promises").then((m) => m.open(absPath, "r"));
            try {
              const { bytesRead } = await fh.read(buf, 0, 8000, 0);
              binary = buf.slice(0, bytesRead).includes(0);
            } finally {
              await fh.close();
            }
          } catch {
            /* use false */
          }
          return { ...entry, binary };
        }),
      );
      return { ok: true, entries: entriesWithBinary };
    } catch (err) {
      return { ok: false, entries: [], summary: String((err as Error).message) };
    }
  }

  async conflictDetail(
    workspace: WorkspaceRef,
    { filePath, rootPath = "" }: { filePath: string; rootPath?: string },
  ): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd || "";
    if (!effectiveCwd || !filePath) {
      return { ok: false, summary: "File path and workspace directory are required." };
    }
    // Sanitize path
    const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");

    const readStage = async (stage: number): Promise<string> => {
      try {
        const result = await this.execGit(effectiveCwd, ["show", `:${stage}:${normalized}`]);
        return String(result.stdout || "");
      } catch {
        return "";
      }
    };

    const [base, ours, theirs] = await Promise.all([readStage(1), readStage(2), readStage(3)]);

    let worktree = "";
    try {
      worktree = await fsReadFile(path.join(effectiveCwd, normalized), "utf-8");
    } catch {
      /* file may not exist for delete conflicts */
    }

    // Detect binary via null byte
    const binary = worktree.includes("\0") || base.includes("\0") || ours.includes("\0") || theirs.includes("\0");

    // Get labels from operationState
    let sides = { ours: "Ours", theirs: "Theirs" };
    try {
      const snap = await (rootPath ? this._inspectRoot(workspace, rootPath) : this.inspectWorkspace(workspace));
      const opSides = (snap.operationState as Record<string, unknown>)?.sides as {
        ours: string;
        theirs: string;
      } | null;
      if (opSides?.ours && opSides?.theirs) sides = opSides;
    } catch {
      /* use defaults */
    }

    // Conflict type from ls-files -u
    let conflictType = "both-modified";
    try {
      const r = await this.execGit(effectiveCwd, ["ls-files", "-u", "--", normalized]);
      const entries = parseLsFilesUntracked(r.stdout);
      if (entries[0]) conflictType = entries[0].conflictType;
    } catch {
      /* use default */
    }

    return { ok: true, filePath: normalized, base, ours, theirs, worktree, binary, conflictType, sides };
  }

  async resolveConflict(
    workspace: WorkspaceRef,
    {
      filePath,
      mode,
      content,
      rootPath = "",
    }: { filePath: string; mode: "ours" | "theirs" | "manual" | "delete"; content?: string; rootPath?: string },
  ): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd || "";
    if (!effectiveCwd || !filePath) {
      return createStructuredResult({ ok: false, summary: "File path and workspace directory are required." });
    }
    const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    try {
      if (mode === "delete") {
        await this.execGit(effectiveCwd, ["rm", "-f", "--", normalized]);
        return createStructuredResult({ ok: true, summary: `Deleted ${normalized}.` });
      }
      if (mode === "ours") {
        await this.execGit(effectiveCwd, ["checkout", "--ours", "--", normalized]);
        await this.execGit(effectiveCwd, ["add", "--", normalized]);
        return createStructuredResult({ ok: true, summary: `Resolved ${normalized} using our version.` });
      }
      if (mode === "theirs") {
        await this.execGit(effectiveCwd, ["checkout", "--theirs", "--", normalized]);
        await this.execGit(effectiveCwd, ["add", "--", normalized]);
        return createStructuredResult({ ok: true, summary: `Resolved ${normalized} using their version.` });
      }
      if (mode === "manual") {
        if (content === undefined) {
          return createStructuredResult({ ok: false, summary: "Content is required for manual resolution." });
        }
        await fsWriteFile(path.join(effectiveCwd, normalized), content, "utf-8");
        await this.execGit(effectiveCwd, ["add", "--", normalized]);
        return createStructuredResult({ ok: true, summary: `Resolved ${normalized} with manual edits.` });
      }
      return createStructuredResult({ ok: false, summary: `Unknown resolution mode: ${mode}` });
    } catch (err) {
      return createStructuredResult({
        ok: false,
        summary: String((err as { stderr?: string }).stderr || (err as Error).message),
      });
    }
  }

  async unresolveConflict(
    workspace: WorkspaceRef,
    { filePath, rootPath = "" }: { filePath: string; rootPath?: string },
  ): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd || "";
    if (!effectiveCwd || !filePath) {
      return createStructuredResult({ ok: false, summary: "File path and workspace directory are required." });
    }
    const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    try {
      await this.execGit(effectiveCwd, ["checkout", "-m", "--", normalized]);
      return createStructuredResult({ ok: true, summary: `Restored conflict markers in ${normalized}.` });
    } catch (err) {
      return createStructuredResult({
        ok: false,
        summary: String((err as { stderr?: string }).stderr || (err as Error).message),
      });
    }
  }

  async diffPreview(
    workspace: WorkspaceRef | null,
    {
      path: targetPath,
      scope = "unstaged",
      baseBranch = "",
      rootPath = "",
    }: { path?: string; scope?: string; baseBranch?: string; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  async logPage(
    workspace: WorkspaceRef | null,
    {
      rootPath = "",
      baseBranch = "",
      skip = 0,
      limit = 100,
    }: { rootPath?: string; baseBranch?: string; skip?: number; limit?: number } = {},
  ): Promise<{ ok: boolean; commits: ReturnType<typeof parseGitLog>; hasMore: boolean; error?: string }> {
    const cwd = rootPath || workspace?.cwd || "";
    if (!cwd) return { ok: false, commits: [], hasMore: false, error: "Missing rootPath" };
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const safeSkip = Math.max(0, Math.floor(skip));
    const range = baseBranch ? `${baseBranch}..HEAD` : "HEAD";
    try {
      // Fetch one extra to detect if more remain.
      const result = await this.execGit(cwd, [
        "log",
        "--date=relative",
        "--pretty=format:%h%x09%ad%x09%an%x09%d%x09%s",
        "--skip",
        String(safeSkip),
        "-n",
        String(safeLimit + 1),
        range,
      ]);
      const all = parseGitLog(result.stdout || "");
      const hasMore = all.length > safeLimit;
      return { ok: true, commits: all.slice(0, safeLimit), hasMore };
    } catch (error) {
      return { ok: false, commits: [], hasMore: false, error: extractErrorMessage(error) };
    }
  }

  /**
   * Fetch full metadata for a single commit (used by the GitHistoryTab info
   * dialog so the user can read a long commit message in a real scrollable
   * pane and copy the full hash / body without the tooltip-truncates-long-
   * text problem).
   *
   * Returns a flat record with the full hash, abbreviated hash, author /
   * committer identities, ISO/relative dates, refs (decoration), subject,
   * full body, and the diff stat one-line shortlog. Using `-z` separators
   * keeps multi-line bodies intact.
   */
  async commitInfo(
    workspace: WorkspaceRef | null,
    { hash, rootPath = "" }: { hash?: string; rootPath?: string } = {},
  ): Promise<{
    ok: boolean;
    hash: string;
    shortHash?: string;
    parents?: string;
    author?: string;
    authorEmail?: string;
    committer?: string;
    committerEmail?: string;
    authorDate?: string;
    committerDate?: string;
    relativeDate?: string;
    refs?: string;
    subject?: string;
    body?: string;
    stat?: string;
    error?: string;
  }> {
    const effectiveCwd = rootPath || workspace?.cwd || "";
    if (!effectiveCwd || !hash) {
      return { ok: false, hash: hash || "", error: "Workspace cwd and commit hash are required." };
    }

    // %x1f is unit-separator (rare in commit messages); we use it as a hard
    // delimiter so we don't have to deal with tab/newline collisions inside
    // the body. The trailing %B (full message) is kept last so anything goes.
    const SEP = "";
    const fmt = [
      "%H", // 0 full hash
      "%h", // 1 short hash
      "%P", // 2 parent hashes (space-separated)
      "%an", // 3 author name
      "%ae", // 4 author email
      "%aI", // 5 author date ISO
      "%cn", // 6 committer name
      "%ce", // 7 committer email
      "%cI", // 8 committer date ISO
      "%ar", // 9 author date relative
      "%d", // 10 ref names (decoration)
      "%s", // 11 subject
      "%B", // 12 full body (last so any newlines/separators don't break parsing)
    ].join(SEP);

    try {
      const result = await this.execGit(effectiveCwd, ["show", "--no-patch", "--shortstat", `--format=${fmt}`, hash]);
      const raw = String(result.stdout || "").replace(/\r\n/g, "\n");
      // git show concatenates the format output and the --shortstat line; the
      // shortstat sits on its own line at the very end. We split on the last
      // newline that follows the body.
      const parts = raw.split(SEP);
      // The 12th field is %B (full body); but everything after the 12th SEP
      // is part of %B and may itself contain newlines + the appended stat
      // line. We re-join indices ≥12 in case anyone ever sneaks SEP into a
      // commit message.
      if (parts.length < 13) {
        return { ok: false, hash, error: "Could not parse git show output." };
      }
      const tail = parts.slice(12).join(SEP);
      // Pull the trailing shortstat line (e.g. " 3 files changed, 12 insertions(+), 1 deletion(-)").
      const tailLines = tail.split(/\n/);
      let stat = "";
      while (tailLines.length && tailLines[tailLines.length - 1].trim() === "") tailLines.pop();
      if (tailLines.length && /file[s]?\s+changed/.test(tailLines[tailLines.length - 1])) {
        stat = tailLines.pop()!.trim();
        // Drop the blank line that git inserts between body and shortstat.
        while (tailLines.length && tailLines[tailLines.length - 1].trim() === "") tailLines.pop();
      }
      const body = tailLines.join("\n").trim();
      return {
        ok: true,
        hash: parts[0] || hash,
        shortHash: parts[1] || "",
        parents: parts[2] || "",
        author: parts[3] || "",
        authorEmail: parts[4] || "",
        authorDate: parts[5] || "",
        committer: parts[6] || "",
        committerEmail: parts[7] || "",
        committerDate: parts[8] || "",
        relativeDate: parts[9] || "",
        refs: (parts[10] || "").trim().replace(/^\(/, "").replace(/\)$/, ""),
        subject: parts[11] || "",
        body,
        stat,
      };
    } catch (error) {
      return { ok: false, hash, error: extractErrorMessage(error) };
    }
  }

  async commitDiff(
    workspace: WorkspaceRef | null,
    { hash, rootPath = "" }: { hash?: string; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

    const operationState = snapshot.operationState as {
      kind: string;
      inProgress: boolean;
      label?: string;
      conflicts: string[];
    };
    const resolvedBaseBranch = String(baseBranch || snapshot.baseBranch || snapshot.upstream || "").trim();
    const warnings = createOperationWarnings(snapshot as Parameters<typeof createOperationWarnings>[0], {
      type,
      baseBranch: resolvedBaseBranch,
      stashDirty,
    });

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
        (warnings as string[]).push(
          "Stashed local changes were kept because the Git operation needs manual resolution.",
        );
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

  _logGitAudit({
    type,
    connection,
    success,
    durationMs,
    errorMessage,
    workspaceId,
    remoteUrl,
    extra = {},
  }: LogGitAuditOptions): void {
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

  async mergeCurrentIntoBase(
    workspace: WorkspaceRef,
    { baseBranch, rootPath = "" }: { baseBranch?: string; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

    const siblingWorktrees =
      (snapshot.siblingWorktrees as Array<{
        branch: string;
        path: string;
        isMainWorktree: boolean;
        isCurrent: boolean;
      }>) || [];
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

  async commitAll(
    workspace: WorkspaceRef | null,
    { message, rootPath = "" }: { message?: string; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  async removeWorktree(
    workspace: WorkspaceRef | null,
    {
      worktreePath,
      deleteBranch = false,
      rootPath = "",
    }: { worktreePath?: string; deleteBranch?: boolean; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

    // Fast path: delete the worktree directory ourselves, then ask git to
    // prune the metadata. `git worktree remove --force` walks the tree with
    // per-file stat calls and is markedly slower than the platform-native
    // recursive remove. On Windows we shell out to `rd /s /q` (filesystem
    // driver level — one or two orders of magnitude faster than fs.rm on NTFS
    // with deep node_modules trees). Other platforms use fs.rm directly,
    // which is already a thin syscall wrapper there. fs.rm fallback with
    // retries handles antivirus / lock interference on Windows when rd fails.
    let rawOutput: string;
    let removalError: { stdout?: string; stderr?: string; message?: string } | null = null;
    if (existsSync(resolvedPath)) {
      let removed = false;
      if (process.platform === "win32") {
        try {
          await execFileText("cmd.exe", ["/c", "rd", "/s", "/q", resolvedPath], { timeout: 30_000 });
          removed = true;
        } catch {
          // fall through to fs.rm with retries — gives proper EBUSY/EPERM
          // error codes that the maxRetries loop can back off on.
        }
      }
      if (!removed) {
        try {
          await fsRm(resolvedPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch (error) {
          removalError = error as { stdout?: string; stderr?: string; message?: string };
        }
      }
    }

    // Tell git to drop the worktree entry. `prune` cleans stale entries when
    // we already removed the directory; if the directory still exists (e.g.
    // fs.rm hit a locked file), fall back to `git worktree remove --force`.
    try {
      if (removalError || existsSync(resolvedPath)) {
        const result = await this.execGit(effectiveCwd, ["worktree", "remove", "--force", resolvedPath]);
        rawOutput = joinRawOutput(result.stdout, result.stderr);
      } else {
        const pruneResult = await this.execGit(effectiveCwd, ["worktree", "prune"]);
        rawOutput = joinRawOutput(pruneResult.stdout, pruneResult.stderr);
      }
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      return createStructuredResult({
        ok: false,
        summary: `Failed to remove worktree at ${resolvedPath}.`,
        rawOutput: joinRawOutput(err.stdout || (removalError?.message ?? ""), err.stderr),
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
      rawOutput: joinRawOutput(rawOutput, branchOutput),
    });
  }

  /**
   * Find the symbolic default branch of the most-relevant remote. Returns
   * the full short-name including remote prefix (e.g. "origin/master"), or
   * "" if no remote has `refs/remotes/<remote>/HEAD` configured.
   *
   * Local-only read (no fetch). Origin wins, then remaining remotes
   * alphabetically — same precedence as listBranches uses.
   */
  async readSymbolicDefaultRemoteBranch(cwd: string, remotes: Record<string, string> = {}): Promise<string> {
    const names = Object.keys(remotes || {}).filter((n) => n && !n.includes(":"));
    if (!names.length) return "";
    const ordered = names.includes("origin")
      ? ["origin", ...names.filter((n) => n !== "origin").sort()]
      : [...names].sort();
    for (const remote of ordered) {
      try {
        const result = await this.execGit(cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
        const value = result.stdout.trim();
        if (value) return value;
      } catch {
        // No symbolic HEAD set for this remote — try the next one.
      }
    }
    return "";
  }

  /**
   * Pick the best base branch for the current HEAD.
   *
   * Strategy:
   *   1. Build candidates from ALL local + remote branches (cap top-50 by
   *      committerdate on huge repos so this stays bounded).
   *   2. For each candidate, measure `rev-list --count <merge-base>..HEAD` —
   *      the number of commits HEAD has past the fork point. The candidate
   *      with the smallest distance is the closest ancestor.
   *   3. Ties are broken by: symbolic default remote > hardcoded
   *      main/master/develop list > upstream > alphabetical. This means a
   *      brand-new branch (distance 0 to several refs) lands on the most
   *      "canonical" one instead of an arbitrary alphabetical pick.
   *   4. If no candidate has a reachable merge-base (rare — empty repo,
   *      orphan branch), fall back to the symbolic default, then the legacy
   *      hardcoded preferBaseBranch heuristic.
   *
   * This replaces the old hardcoded-candidates approach which silently
   * skipped any branch outside ["main", "master", "develop"], so creating a
   * feature off another feature picked the wrong base.
   */
  async detectBestBaseBranch(
    cwd: string,
    currentBranch: string,
    upstream: string,
    branchNames: string[] = [],
    remotes: Record<string, string> = {},
    precomputedSymbolicDefault?: string,
  ): Promise<string> {
    // Allow callers (inspectWorkspace) that already resolved the symbolic
    // default to pass it in — avoids a duplicate `git symbolic-ref` call
    // every inspect tick. Pass `""` to opt out without re-running.
    const symbolicDefault =
      precomputedSymbolicDefault !== undefined
        ? precomputedSymbolicDefault
        : await this.readSymbolicDefaultRemoteBranch(cwd, remotes);
    const candidates = await this.buildExpandedBaseBranchCandidates(cwd, currentBranch, upstream, branchNames);
    if (!candidates.length) {
      return symbolicDefault || preferBaseBranch(currentBranch, upstream, branchNames);
    }

    const distances = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const result = await this.execGit(cwd, ["merge-base", "HEAD", candidate]);
          const mergeBase = result.stdout.trim();
          if (!mergeBase) return { candidate, distance: Infinity };
          const countResult = await this.execGit(cwd, ["rev-list", "--count", `${mergeBase}..HEAD`]);
          const parsed = parseInt(countResult.stdout.trim(), 10);
          return { candidate, distance: Number.isFinite(parsed) ? parsed : Infinity };
        } catch {
          return { candidate, distance: Infinity };
        }
      }),
    );

    const reachable = distances.filter((d) => d.distance < Infinity);
    if (!reachable.length) {
      return symbolicDefault || preferBaseBranch(currentBranch, upstream, branchNames);
    }

    const HARDCODED_PRIORITY = ["main", "origin/main", "master", "origin/master", "develop", "origin/develop"];
    const tieBreakRank = (name: string): number => {
      if (symbolicDefault && name === symbolicDefault) return 0;
      const idx = HARDCODED_PRIORITY.indexOf(name);
      if (idx >= 0) return 1 + idx; // 1..6
      if (upstream && name === upstream) return 100;
      return 1000;
    };

    reachable.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      const ta = tieBreakRank(a.candidate);
      const tb = tieBreakRank(b.candidate);
      if (ta !== tb) return ta - tb;
      return a.candidate.localeCompare(b.candidate);
    });

    return reachable[0].candidate;
  }

  /**
   * Build candidate base branches. Unlike the legacy hardcoded helper this
   * considers ALL refs so a feature branched off another feature can win.
   *
   * On repos with many branches we cap to the 50 most-recently-active ones
   * (sorted by committerdate). Bounded cost is more important than
   * exhaustive coverage — old stale branches are extremely unlikely to be
   * the right base, and we still cover the common cases plus current
   * upstream.
   */
  async buildExpandedBaseBranchCandidates(
    cwd: string,
    currentBranch: string,
    upstream: string,
    branchNames: string[],
  ): Promise<string[]> {
    const normalizedCurrent = normalizeBranchName(currentBranch);
    let pool: string[] = (branchNames || []).filter(Boolean);

    if (pool.length > 50) {
      try {
        const result = await this.execGit(cwd, [
          "for-each-ref",
          "--format=%(refname:short)",
          "--sort=-committerdate",
          "--count=50",
          "refs/heads",
          "refs/remotes",
        ]);
        pool = String(result.stdout || "")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      } catch {
        pool = pool.slice(0, 50);
      }
    }

    const seen = new Set<string>();
    const result: string[] = [];
    const add = (name: string): void => {
      if (!name || name.endsWith("/HEAD")) return;
      const norm = normalizeBranchName(name);
      if (!norm || norm === normalizedCurrent || seen.has(norm)) return;
      seen.add(norm);
      result.push(name);
    };

    if (upstream) add(upstream);
    for (const name of pool) add(name);
    return result;
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

  async stash(
    workspace: WorkspaceRef | null,
    {
      message = "",
      rootPath = "",
      includeUntracked = true,
      keepIndex = false,
      paths = [],
      allowEmptyInitialCommit = false,
    }: {
      message?: string;
      rootPath?: string;
      includeUntracked?: boolean;
      keepIndex?: boolean;
      paths?: string[];
      allowEmptyInitialCommit?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      // git stash needs a base commit to stash against. On an unborn HEAD (a
      // freshly `git init`'d repo with no commits yet) every variant fails with
      // the cryptic "You do not have the initial commit yet". Either signal the
      // caller to offer a one-click fix (needsInitialCommit), or — when the user
      // accepted it — create an empty root commit so the stash has a base.
      const head = await this.execGit(effectiveCwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => ({
        stdout: "",
        stderr: "",
      }));
      if (!String(head.stdout || "").trim()) {
        if (!allowEmptyInitialCommit) {
          return {
            ...createStructuredResult({
              ok: false,
              summary: "Cannot stash: the repository has no commits yet. Create an initial commit first.",
            }),
            needsInitialCommit: true,
          };
        }
        await this.execGit(effectiveCwd, ["commit", "--allow-empty", "-m", "Initial commit"]);
      }
      const args = ["stash", "push"];
      // Default ON to match the previous behaviour; callers may opt out.
      if (includeUntracked !== false) args.push("--include-untracked");
      if (keepIndex) args.push("--keep-index");
      if (message) args.push("-m", message);
      // Path-scoped stash: only the listed files are stashed, the rest stay in
      // the working tree. Everything after `--` is treated by git as a pathspec
      // (no option injection possible), and execGit passes args as an array so
      // there is no shell to escape. Drop empties/non-strings defensively.
      const safePaths = (Array.isArray(paths) ? paths : []).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      if (safePaths.length) args.push("--", ...safePaths);
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
      const raw = joinRawOutput(err.stdout, err.stderr);
      return createStructuredResult({
        ok: false,
        // Surface the actual git error (e.g. "pathspec '…' did not match",
        // "You do not have the initial commit yet") instead of a generic label,
        // matching the sibling stash methods. Falls back when git wrote nothing.
        summary: raw || "Stash failed.",
        rawOutput: raw,
      });
    }
  }

  async stashPop(
    workspace: WorkspaceRef | null,
    { rootPath = "", ref = "" }: { rootPath?: string; ref?: string } = {},
  ): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const args = ["stash", "pop"];
      if (ref) args.push(ref);
      const result = await this.execGit(effectiveCwd, args);
      return createStructuredResult({
        ok: true,
        summary: "Stash applied and removed.",
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      const combined = joinRawOutput(err.stdout, err.stderr);
      // Modern git refuses to drop the entry on conflict — it stays in place.
      if (/CONFLICT|conflict/i.test(combined)) {
        return createStructuredResult({
          ok: false,
          summary: "Pop produced conflicts. Stash entry kept — resolve in the Changes tab and drop it manually.",
          conflicts: parseConflictPaths(combined),
          rawOutput: combined,
        });
      }
      return createStructuredResult({
        ok: false,
        summary: "Stash pop failed.",
        rawOutput: combined,
      });
    }
  }

  // ─── Stash detail / lifecycle operations ──────────────────────────

  async listStashes(
    workspace: WorkspaceRef | null,
    { rootPath = "" }: { rootPath?: string } = {},
  ): Promise<{ ok: boolean; stashes: StashEntry[]; summary: string }> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return { ok: false, stashes: [], summary: "Workspace has no working directory." };
    }
    try {
      const result = await this.execGit(effectiveCwd, ["stash", "list", "--format=%gd%x09%ct%x09%H%x09%gs%x09%an"]);
      const lines = String(result.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean);
      const stashes: StashEntry[] = [];
      for (const line of lines) {
        const [ref, ct, hash, subject, author] = line.split("\t");
        const idxMatch = /stash@\{(\d+)\}/.exec(ref || "");
        const index = idxMatch ? parseInt(idxMatch[1], 10) : stashes.length;
        const subj = subject || "";
        const m = /^(WIP on |On )([^:]+): (.*)$/.exec(subj);
        let branch = "";
        let customMessage = "";
        let isWipDefault = false;
        if (m) {
          branch = m[2];
          if (m[1] === "WIP on ") {
            customMessage = "";
            isWipDefault = true;
          } else {
            customMessage = m[3];
          }
        } else {
          customMessage = subj;
        }
        const date = ct ? new Date(parseInt(ct, 10) * 1000).toISOString() : "";

        let baseCommit = "";
        let baseSubject = "";
        try {
          const baseRes = await this.execGit(effectiveCwd, ["log", "-1", "--format=%h%x09%s", `${ref}^1`]);
          const parts = String(baseRes.stdout || "")
            .trim()
            .split("\t");
          baseCommit = parts[0] || "";
          baseSubject = parts.slice(1).join("\t");
        } catch {
          // Detached or unborn base — leave blank.
        }

        const filePaths = await this.stashShowNameOnly(effectiveCwd, ref);
        const fileCount = filePaths.length;

        stashes.push({
          index,
          ref,
          hash: hash || "",
          date,
          author: author || "",
          branch,
          baseCommit,
          baseSubject,
          message: subj,
          customMessage,
          isWipDefault,
          fileCount,
          filePaths,
        });
      }
      return { ok: true, stashes, summary: `${stashes.length} stash(es) found.` };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return {
        ok: false,
        stashes: [],
        summary: joinRawOutput(err.stdout, err.stderr) || "Failed to list stashes.",
      };
    }
  }

  private async stashShowNameOnly(cwd: string, ref: string): Promise<string[]> {
    try {
      const res = await this.execGit(cwd, ["stash", "show", "--include-untracked", "--name-only", ref]);
      return String(res.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      try {
        const res = await this.execGit(cwd, ["stash", "show", "--name-only", ref]);
        return String(res.stdout || "")
          .split(/\r?\n/)
          .filter(Boolean);
      } catch {
        return [];
      }
    }
  }

  async stashFiles(
    workspace: WorkspaceRef | null,
    { rootPath = "", ref = "" }: { rootPath?: string; ref?: string } = {},
  ): Promise<{ ok: boolean; files: StashFile[]; baseCommit: string; summary: string }> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return { ok: false, files: [], baseCommit: "", summary: "Workspace has no working directory." };
    }
    if (!ref) {
      return { ok: false, files: [], baseCommit: "", summary: "Stash ref is required." };
    }
    try {
      let baseCommit = "";
      try {
        const baseRes = await this.execGit(effectiveCwd, ["rev-parse", "--short", `${ref}^1`]);
        baseCommit = String(baseRes.stdout || "").trim();
      } catch {
        // ignore
      }

      // Tracked changes: name-status (codes + rename/copy paths).
      const nameStatusRes = await this.execGit(effectiveCwd, ["stash", "show", "--name-status", ref]).catch(() => ({
        stdout: "",
        stderr: "",
      }));
      // Numbers per file: numstat ("-\t-" ⇒ binary).
      const numstatRes = await this.execGit(effectiveCwd, ["stash", "show", "--numstat", ref]).catch(() => ({
        stdout: "",
        stderr: "",
      }));

      const numstat = parseStashNumstat(String(numstatRes.stdout || ""));
      const files: StashFile[] = parseStashNameStatus(String(nameStatusRes.stdout || ""), numstat);

      // Untracked files (only present when the stash was made with -u) live in
      // the third parent. List them and diff against the empty tree for counts.
      const hasUntracked = await this.refExists(effectiveCwd, `${ref}^3`);
      if (hasUntracked) {
        const untrackedNumstat = await this.execGit(effectiveCwd, [
          "diff",
          "--numstat",
          EMPTY_TREE_SHA,
          `${ref}^3`,
        ]).catch(() => ({ stdout: "", stderr: "" }));
        const counts = parseStashNumstat(String(untrackedNumstat.stdout || ""));
        const seen = new Set(files.map((f) => f.path));
        for (const [p, c] of counts) {
          if (seen.has(p)) continue;
          files.push({
            path: p,
            code: "?",
            status: "untracked",
            additions: c.binary ? 0 : c.additions,
            deletions: 0,
            isBinary: c.binary,
          });
        }
      }

      return { ok: true, files, baseCommit, summary: `${files.length} file(s) in ${ref}.` };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return {
        ok: false,
        files: [],
        baseCommit: "",
        summary: joinRawOutput(err.stdout, err.stderr) || "Failed to read stash files.",
      };
    }
  }

  private async refExists(cwd: string, ref: string): Promise<boolean> {
    try {
      await this.execGit(cwd, ["rev-parse", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  }

  async stashApply(
    workspace: WorkspaceRef | null,
    { rootPath = "", ref = "" }: { rootPath?: string; ref?: string } = {},
  ): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const args = ["stash", "apply"];
      if (ref) args.push(ref);
      const result = await this.execGit(effectiveCwd, args);
      return createStructuredResult({
        ok: true,
        summary: "Stash applied. The stash entry was kept.",
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      const combined = joinRawOutput(err.stdout, err.stderr);
      // `git stash apply` exits non-zero on conflicts but still writes the
      // changes (with conflict markers) into the working tree.
      if (/CONFLICT|conflict/i.test(combined)) {
        return createStructuredResult({
          ok: true,
          summary: "Stash applied with conflicts. Resolve them in the Changes tab.",
          warnings: ["Stash applied with conflicts. Resolve them in the Changes tab."],
          conflicts: parseConflictPaths(combined),
          rawOutput: combined,
        });
      }
      return createStructuredResult({ ok: false, summary: "Stash apply failed.", rawOutput: combined });
    }
  }

  async stashDrop(
    workspace: WorkspaceRef | null,
    { rootPath = "", ref = "" }: { rootPath?: string; ref?: string } = {},
  ): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    try {
      const args = ["stash", "drop"];
      if (ref) args.push(ref);
      const result = await this.execGit(effectiveCwd, args);
      return createStructuredResult({
        ok: true,
        summary: "Stash dropped.",
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return createStructuredResult({
        ok: false,
        summary: "Stash drop failed.",
        rawOutput: joinRawOutput(err.stdout, err.stderr),
      });
    }
  }

  async stashBranch(
    workspace: WorkspaceRef | null,
    {
      rootPath = "",
      ref = "",
      branchName = "",
      switchImmediately = true,
    }: { rootPath?: string; ref?: string; branchName?: string; switchImmediately?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    const name = String(branchName || "").trim();
    if (!name || !/^[A-Za-z0-9._/-]+$/.test(name)) {
      return createStructuredResult({ ok: false, summary: "Invalid branch name." });
    }
    try {
      if (switchImmediately) {
        // Native path: create branch from the stash base, check it out, apply
        // the stash, and drop the entry. Requires a clean working tree.
        const status = await this.execGit(effectiveCwd, ["status", "--porcelain"]).catch(() => ({
          stdout: "",
          stderr: "",
        }));
        if (String(status.stdout || "").trim()) {
          return createStructuredResult({
            ok: false,
            summary:
              "Working tree has uncommitted changes. Commit or stash them first, or uncheck 'Switch immediately'.",
          });
        }
        const result = await this.execGit(effectiveCwd, ["stash", "branch", name, ref]);
        return createStructuredResult({
          ok: true,
          summary: `Created and switched to '${name}' from the stash.`,
          rawOutput: joinRawOutput(result.stdout, result.stderr),
        });
      }
      // Non-switching path: just create the branch ref at the stash base. The
      // stash is kept intact and the current branch/working tree are untouched.
      const result = await this.execGit(effectiveCwd, ["branch", name, `${ref}^1`]);
      return createStructuredResult({
        ok: true,
        summary: `Created branch '${name}' from the stash base. The stash was kept.`,
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return createStructuredResult({
        ok: false,
        summary: "Branch from stash failed.",
        rawOutput: joinRawOutput(err.stdout, err.stderr),
      });
    }
  }

  async stashFileDiff(
    workspace: WorkspaceRef | null,
    { rootPath = "", ref = "", relativePath = "" }: { rootPath?: string; ref?: string; relativePath?: string } = {},
  ): Promise<unknown> {
    const effectiveCwd = rootPath || workspace?.cwd;
    const { computeStashFileDiff } = await import("./file-manager.js");
    return computeStashFileDiff(effectiveCwd || "", ref, relativePath);
  }

  async stashExportPatch(
    workspace: WorkspaceRef | null,
    { rootPath = "", ref = "" }: { rootPath?: string; ref?: string } = {},
  ): Promise<{ ok: boolean; patch: string; suggestedFilename: string; summary: string }> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return { ok: false, patch: "", suggestedFilename: "", summary: "Workspace has no working directory." };
    }
    if (!ref) {
      return { ok: false, patch: "", suggestedFilename: "", summary: "Stash ref is required." };
    }
    try {
      const { composeStashPatch, suggestStashFilename } = await import("./git-stash-patch.js");
      const listed = await this.listStashes(workspace, { rootPath });
      const entry = listed.stashes.find((s) => s.ref === ref);

      // Tracked + staged changes as a binary-safe unified diff.
      const trackedRes = await this.execGit(effectiveCwd, ["stash", "show", "--binary", "--no-color", "-p", ref]);
      let body = String(trackedRes.stdout || "");

      // Untracked files (stash^3) — append a from-empty diff per file.
      const includesUntracked = await this.refExists(effectiveCwd, `${ref}^3`);
      if (includesUntracked) {
        const untrackedRes = await this.execGit(effectiveCwd, [
          "diff",
          "--binary",
          "--no-color",
          EMPTY_TREE_SHA,
          `${ref}^3`,
        ]).catch(() => ({ stdout: "", stderr: "" }));
        const untrackedBody = String(untrackedRes.stdout || "");
        if (untrackedBody.trim()) {
          body = body.trim() ? `${body.replace(/\s*$/, "")}\n${untrackedBody}` : untrackedBody;
        }
      }

      const meta = {
        baseCommit: entry?.baseCommit || "",
        branch: entry?.branch || "",
        message: entry?.customMessage || (entry?.isWipDefault ? "WIP" : ""),
        includesUntracked,
      };
      const patch = composeStashPatch(meta, body);
      const suggestedFilename = suggestStashFilename({
        index: entry?.index ?? 0,
        branch: entry?.branch || "",
        customMessage: entry?.customMessage || "",
        date: entry?.date || "",
      });
      return { ok: true, patch, suggestedFilename, summary: "Patch composed." };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return {
        ok: false,
        patch: "",
        suggestedFilename: "",
        summary: joinRawOutput(err.stdout, err.stderr) || "Failed to export stash patch.",
      };
    }
  }

  async stashImportPatch(
    workspace: WorkspaceRef | null,
    { rootPath = "", patch = "", message = "" }: { rootPath?: string; patch?: string; message?: string } = {},
  ): Promise<Record<string, unknown>> {
    const effectiveCwd = rootPath || workspace?.cwd;
    if (!effectiveCwd) {
      return createStructuredResult({ ok: false, summary: "Workspace has no working directory." });
    }
    if (!patch || !patch.trim()) {
      return createStructuredResult({ ok: false, summary: "Patch is empty." });
    }

    const { parseStashPatch, validatePatchPaths } = await import("./git-stash-patch.js");
    const safety = validatePatchPaths(patch, effectiveCwd);
    if (!safety.ok) {
      return createStructuredResult({
        ok: false,
        summary: `Patch references a path outside the repository (${safety.badPath}). Import refused.`,
      });
    }

    const parsed = parseStashPatch(patch);
    const importMessage = (message || parsed.message || "Imported stash").trim();

    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const crypto = await import("node:crypto");
    const tmpFile = path.join(os.tmpdir(), `strideterm-stash-import-${crypto.randomUUID()}.patch`);

    try {
      await fs.writeFile(tmpFile, patch, "utf8");

      const warnings: string[] = [];
      // If the tree is dirty, set the user's current changes aside FIRST so the
      // patch is checked and applied against a clean tree. Checking before the
      // auto-stash would test the patch against the dirty tree it will never be
      // applied to — an overlapping local edit could fail `--check` even when
      // the patch applies fine once those edits are stashed away.
      const status = await this.execGit(effectiveCwd, ["status", "--porcelain"]).catch(() => ({
        stdout: "",
        stderr: "",
      }));
      let autoStashed = false;
      if (String(status.stdout || "").trim()) {
        await this.execGit(effectiveCwd, [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          "strideterm: changes set aside before patch import",
        ]);
        autoStashed = true;
        warnings.push("Your existing changes were stashed before importing.");
      }

      // Never write changes if the patch doesn't apply cleanly. If we already
      // set the user's changes aside, restore them before bailing so a rejected
      // import is a no-op from their point of view.
      try {
        await this.execGit(effectiveCwd, ["apply", "--check", tmpFile]);
      } catch (checkErr) {
        const err = checkErr as { stdout?: string; stderr?: string };
        if (autoStashed) {
          await this.execGit(effectiveCwd, ["stash", "pop"]).catch(() => {});
        }
        return createStructuredResult({
          ok: false,
          summary: "Patch does not apply cleanly to this branch.",
          rawOutput: joinRawOutput(err.stdout, err.stderr),
        });
      }

      await this.execGit(effectiveCwd, ["apply", tmpFile]);
      const pushArgs = ["stash", "push", "--include-untracked", "-m", importMessage];
      const result = await this.execGit(effectiveCwd, pushArgs);

      return createStructuredResult({
        ok: true,
        summary: `Imported patch as a new stash: "${importMessage}".`,
        warnings,
        rawOutput: joinRawOutput(result.stdout, result.stderr),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return createStructuredResult({
        ok: false,
        summary: "Failed to import patch.",
        rawOutput: joinRawOutput(err.stdout, err.stderr),
      });
    } finally {
      await fsRm(tmpFile, { force: true }).catch(() => {});
    }
  }

  // ─── Tag operations ───────────────────────────────────────────────

  async listTags(
    workspace: WorkspaceRef | null,
    { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  async createTag(
    workspace: WorkspaceRef | null,
    {
      tagName,
      message = "",
      commit = "",
      rootPath = "",
    }: { tagName?: string; message?: string; commit?: string; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  async deleteTag(
    workspace: WorkspaceRef | null,
    { tagName, rootPath = "" }: { tagName?: string; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  async pushTag(
    workspace: WorkspaceRef,
    {
      tagName,
      connection = null,
      rootPath = "",
    }: { tagName?: string; connection?: Connection | null; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  async pushAllTags(
    workspace: WorkspaceRef,
    { connection = null, rootPath = "" }: { connection?: Connection | null; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  async deleteRemoteTag(
    workspace: WorkspaceRef,
    {
      tagName,
      connection = null,
      rootPath = "",
    }: { tagName?: string; connection?: Connection | null; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
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

  // ─── Branch list & graph (Branches sub-tab / commit tree visualization) ──

  /**
   * Enumerate local and remote branches with last-commit metadata and
   * ahead/behind counts vs the current HEAD. Powers the JetBrains-style
   * Branches sub-tab. Single batched read per branch via for-each-ref so
   * the call is bounded by O(branches) and not O(branches × commits).
   */
  async listBranches(
    workspace: WorkspaceRef | null,
    { rootPath = "" }: { rootPath?: string } = {},
  ): Promise<{
    ok: boolean;
    current: string;
    upstream: string;
    local: Array<{
      name: string;
      isCurrent: boolean;
      upstream: string;
      ahead: number;
      behind: number;
      lastCommit: string;
      lastSubject: string;
      lastAuthor: string;
      lastRelativeDate: string;
      lastCommitTimestamp: number;
      merged: boolean;
      worktreePath?: string;
    }>;
    remotes: Array<{
      name: string;
      remote: string;
      shortName: string;
      lastCommit: string;
      lastSubject: string;
      lastAuthor: string;
      lastRelativeDate: string;
      lastCommitTimestamp: number;
      isDefault: boolean;
    }>;
    defaultBranch: string; // short name (no remote prefix), e.g. "master"
    defaultRemote: string; // remote that supplied the symbolic HEAD, e.g. "origin"
    error?: string;
  }> {
    const cwd = rootPath || workspace?.cwd || "";
    const empty = {
      ok: false,
      current: "",
      upstream: "",
      local: [],
      remotes: [],
      defaultBranch: "",
      defaultRemote: "",
    };
    if (!cwd) return { ...empty, error: "Missing rootPath" };

    const startTime = Date.now();
    try {
      const fmt = [
        "%(refname)", // 0 full ref
        "%(refname:short)", // 1 short name
        "%(HEAD)", // 2 "*" if HEAD
        "%(upstream:short)", // 3 upstream short (locals only)
        "%(upstream:track,nobracket)", // 4 e.g. "ahead 2, behind 1" (locals)
        "%(objectname:short)", // 5 short commit hash
        "%(contents:subject)", // 6 subject
        "%(authorname)", // 7 author
        "%(committerdate:relative)", // 8 relative date
        "%(committerdate:unix)", // 9 epoch seconds (for date-range filter + sort)
      ].join("%09");

      const [localResult, remoteResult, currentBranchResult, upstreamResult, worktreeListResult] = await Promise.all([
        this.execGit(cwd, ["for-each-ref", `--format=${fmt}`, "--sort=-committerdate", "refs/heads"]).catch(() => ({
          stdout: "",
          stderr: "",
        })),
        this.execGit(cwd, ["for-each-ref", `--format=${fmt}`, "--sort=-committerdate", "refs/remotes"]).catch(() => ({
          stdout: "",
          stderr: "",
        })),
        this.execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({ stdout: "HEAD", stderr: "" })),
        this.execGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => ({
          stdout: "",
          stderr: "",
        })),
        this.execGit(cwd, ["worktree", "list", "--porcelain"]).catch(() => ({ stdout: "", stderr: "" })),
      ]);

      // Map of branch shortname → worktree path so the UI can route "Delete
      // branch" through the worktree-aware confirm flow when a checkout exists.
      const worktreesByBranch = new Map<string, string>();
      for (const entry of parseWorktreeList(worktreeListResult.stdout)) {
        if (entry.branch && entry.path) worktreesByBranch.set(entry.branch, entry.path);
      }

      const current = currentBranchResult.stdout.trim();
      const upstream = upstreamResult.stdout.trim();

      // Parse local branches. We capture ahead/behind from upstream:track but
      // also resolve a synthetic "vs HEAD" pair so the UI can show how each
      // branch relates to the currently checked-out one (matches IDEA's
      // "compare with current" tooltip).
      const localLines = String(localResult.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean);
      const local = localLines.map((line) => {
        const parts = line.split("\t");
        const fullRef = parts[0] || "";
        const shortName = parts[1] || fullRef.replace(/^refs\/heads\//, "");
        const isCurrent = (parts[2] || "").trim() === "*";
        const upstreamShort = (parts[3] || "").trim();
        const track = (parts[4] || "").trim();
        let ahead = 0;
        let behind = 0;
        // upstream:track,nobracket emits e.g. "ahead 3", "behind 1",
        // "ahead 2, behind 1", or "" / "gone".
        const aheadMatch = /ahead\s+(\d+)/.exec(track);
        const behindMatch = /behind\s+(\d+)/.exec(track);
        if (aheadMatch) ahead = parseInt(aheadMatch[1], 10) || 0;
        if (behindMatch) behind = parseInt(behindMatch[1], 10) || 0;
        const worktreePath = worktreesByBranch.get(shortName);
        return {
          name: shortName,
          isCurrent,
          upstream: upstreamShort,
          ahead,
          behind,
          lastCommit: parts[5] || "",
          lastSubject: parts[6] || "",
          lastAuthor: parts[7] || "",
          lastRelativeDate: parts[8] || "",
          lastCommitTimestamp: parseInt(parts[9] || "", 10) || 0,
          merged: false,
          ...(worktreePath ? { worktreePath } : {}),
        };
      });

      // Per-branch ahead/behind vs HEAD (current branch). This is what
      // IDEA's "Compare with current" surfaces. Done in parallel so we
      // don't pay N round-trips serially for a 50-branch repo.
      if (current && current !== "HEAD") {
        await Promise.all(
          local.map(async (entry) => {
            if (entry.isCurrent || entry.name === current) return;
            try {
              const result = await this.execGit(cwd, [
                "rev-list",
                "--left-right",
                "--count",
                `${current}...${entry.name}`,
              ]);
              const counts = parseRevListCount(result.stdout);
              // left = current ahead of entry; right = entry ahead of current
              // We expose ahead/behind from the *entry's* perspective only
              // when we don't already have upstream tracking info.
              if (!entry.upstream) {
                entry.ahead = counts.right;
                entry.behind = counts.left;
              }
              // merged: HEAD reaches entry.name with 0 remaining
              entry.merged = counts.right === 0;
            } catch {
              // ignore — branch refs may not be reachable
            }
          }),
        );
      }

      // Parse remote branches; skip "<remote>/HEAD" symbolic ref to avoid
      // duplicates pointing at the default branch.
      const remoteLines = String(remoteResult.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean);
      const remotes = remoteLines
        .map((line) => {
          const parts = line.split("\t");
          const shortName = parts[1] || "";
          const slash = shortName.indexOf("/");
          const remote = slash >= 0 ? shortName.slice(0, slash) : "";
          const branchShort = slash >= 0 ? shortName.slice(slash + 1) : shortName;
          return {
            name: shortName,
            remote,
            shortName: branchShort,
            lastCommit: parts[5] || "",
            lastSubject: parts[6] || "",
            lastAuthor: parts[7] || "",
            lastRelativeDate: parts[8] || "",
            lastCommitTimestamp: parseInt(parts[9] || "", 10) || 0,
            isDefault: false,
          };
        })
        .filter((entry) => entry.shortName && entry.shortName !== "HEAD");

      // Resolve the default branch per remote via `git symbolic-ref
      // refs/remotes/<remote>/HEAD --short`. Local read, one git call per
      // unique remote (typically 1–2). Falls back to "" when the symbolic
      // ref isn't set — e.g. for remotes added without `git remote set-head`.
      const uniqueRemotes = Array.from(new Set(remotes.map((r) => r.remote))).filter(Boolean);
      const defaultsByRemote = new Map<string, string>(); // remote → "<remote>/<branch>"
      await Promise.all(
        uniqueRemotes.map(async (remoteName) => {
          try {
            const result = await this.execGit(cwd, ["symbolic-ref", "--short", `refs/remotes/${remoteName}/HEAD`]);
            const value = result.stdout.trim();
            if (value) defaultsByRemote.set(remoteName, value);
          } catch {
            // No symbolic HEAD configured for this remote — skip.
          }
        }),
      );
      for (const entry of remotes) {
        if (defaultsByRemote.get(entry.remote) === entry.name) entry.isDefault = true;
      }
      // Pick a primary default. origin wins when present; otherwise pick the
      // first alphabetically. Only one is exposed at top level — multi-remote
      // setups can still see per-entry `isDefault` for each one.
      let primaryRemote = "";
      if (defaultsByRemote.has("origin")) {
        primaryRemote = "origin";
      } else {
        const sortedWithDefault = Array.from(defaultsByRemote.keys()).sort();
        if (sortedWithDefault.length) primaryRemote = sortedWithDefault[0];
      }
      const primaryDefaultFull = primaryRemote ? defaultsByRemote.get(primaryRemote) || "" : "";
      const defaultBranch = primaryDefaultFull
        ? primaryDefaultFull.slice(primaryRemote.length + 1) // strip "origin/" → "master"
        : "";

      log.debug("git list-branches", {
        cwd,
        durationMs: Date.now() - startTime,
        localCount: local.length,
        remoteCount: remotes.length,
        current,
        defaultBranch,
        defaultRemote: primaryRemote,
      });
      return {
        ok: true,
        current,
        upstream,
        local,
        remotes,
        defaultBranch,
        defaultRemote: primaryRemote,
      };
    } catch (error) {
      const message = extractErrorMessage(error);
      log.warn("git list-branches failed", { cwd, durationMs: Date.now() - startTime, err: message });
      return { ...empty, error: message };
    }
  }

  async deleteBranch(
    workspace: WorkspaceRef,
    { branch, force = false, rootPath = "" }: { branch?: string; force?: boolean; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
    const name = String(branch || "").trim();
    if (!name) {
      return createStructuredResult({ ok: false, summary: "Branch name is required." });
    }
    if (name.startsWith("-")) {
      return createStructuredResult({ ok: false, summary: "Invalid branch name." });
    }
    // Preflight: refuse early if the branch is checked out in a worktree. Git
    // itself rejects this with a generic stderr; we surface a structured
    // `code` so the UI can offer the worktree-aware remove+delete flow instead.
    const effectiveCwd = rootPath || String(workspace?.cwd || "");
    if (effectiveCwd) {
      try {
        const result = await this.execGit(effectiveCwd, ["worktree", "list", "--porcelain"]);
        const match = parseWorktreeList(result.stdout).find((entry) => entry.branch === name);
        if (match && match.path) {
          return {
            ...createStructuredResult({
              ok: false,
              summary: `Branch ${name} is checked out in worktree ${match.path}. Remove the worktree first.`,
            }),
            code: "branch-in-worktree",
            branch: name,
            worktreePath: match.path,
          };
        }
      } catch {
        // Worktree probe is advisory — fall through to the real delete, which
        // will surface git's own error if it does refuse.
      }
    }
    return this.runWriteAction(workspace, {
      type: "delete-branch",
      label: `Delete branch ${name}`,
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, ["branch", force ? "-D" : "-d", name]),
      rootPath,
    });
  }

  async deleteRemoteBranch(
    workspace: WorkspaceRef,
    {
      branch,
      remote = "origin",
      connection = null,
      rootPath = "",
    }: { branch?: string; remote?: string; connection?: Connection | null; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
    const name = String(branch || "").trim();
    const remoteName = String(remote || "origin").trim();
    if (!name) {
      return createStructuredResult({ ok: false, summary: "Branch name is required." });
    }
    if (name.startsWith("-") || remoteName.startsWith("-")) {
      return createStructuredResult({ ok: false, summary: "Invalid branch or remote name." });
    }
    return this.runWriteAction(workspace, {
      type: "delete-remote-branch",
      label: `Delete remote branch ${remoteName}/${name}`,
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execAuthGit(cwd, ["push", remoteName, `:refs/heads/${name}`], { connection }),
      connection,
      rootPath,
    });
  }

  async renameBranch(
    workspace: WorkspaceRef,
    { branch, newName, rootPath = "" }: { branch?: string; newName?: string; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
    const from = String(branch || "").trim();
    const to = String(newName || "").trim();
    if (!to) {
      return createStructuredResult({ ok: false, summary: "New branch name is required." });
    }
    if (from.startsWith("-") || to.startsWith("-")) {
      return createStructuredResult({ ok: false, summary: "Invalid branch name." });
    }
    const args = from ? ["branch", "-m", from, to] : ["branch", "-m", to];
    return this.runWriteAction(workspace, {
      type: "rename-branch",
      label: from ? `Rename branch ${from} → ${to}` : `Rename current branch → ${to}`,
      allowDirty: true,
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, args),
      rootPath,
    });
  }

  async checkoutRemoteBranch(
    workspace: WorkspaceRef,
    {
      remoteBranch,
      localBranch = "",
      rootPath = "",
    }: { remoteBranch?: string; localBranch?: string; rootPath?: string } = {},
  ): Promise<Record<string, unknown>> {
    const remote = String(remoteBranch || "").trim();
    if (!remote) {
      return createStructuredResult({ ok: false, summary: "Remote branch is required." });
    }
    if (remote.startsWith("-")) {
      return createStructuredResult({ ok: false, summary: "Invalid remote branch." });
    }
    // Derive a sensible local name when caller didn't pin one: strip the
    // leading "<remote>/" segment so "origin/feat-x" → "feat-x".
    const derived = localBranch.trim() || remote.replace(/^[^/]+\//, "");
    if (!derived || derived.startsWith("-")) {
      return createStructuredResult({ ok: false, summary: "Invalid local branch name." });
    }
    return this.runWriteAction(workspace, {
      type: "checkout-remote",
      label: `Checkout ${remote}`,
      skipPreflight: true,
      run: async (cwd) => this.execGit(cwd, ["checkout", "-b", derived, "--track", remote]),
      rootPath,
    });
  }

  /**
   * Topology log for the commit graph visualization. Returns commits with
   * full parents and decoration so the renderer can build the lanes itself
   * (so we can be JetBrains/Wappler-style without depending on git's own
   * --graph ASCII art). Includes all local and remote branches plus HEAD
   * by default so the picture matches IDEA's unified Log view.
   *
   * Output is deliberately compact — only the fields the SVG renderer
   * needs — and capped via `limit`. Caller decides how many commits to
   * render at once.
   */
  async logGraph(
    workspace: WorkspaceRef | null,
    {
      rootPath = "",
      limit = 300,
      includeRemotes = true,
      branch = "",
      sinceDate = "",
      untilDate = "",
      paths = [],
      topoOrder = false,
      author = "",
    }: {
      rootPath?: string;
      limit?: number;
      includeRemotes?: boolean;
      branch?: string;
      sinceDate?: string;
      untilDate?: string;
      paths?: string[];
      topoOrder?: boolean;
      author?: string;
    } = {},
  ): Promise<{
    ok: boolean;
    head: string;
    commits: Array<{
      hash: string;
      shortHash: string;
      parents: string[];
      subject: string;
      author: string;
      relativeDate: string;
      isoDate: string;
      refs: string[];
    }>;
    refs: Record<string, string>;
    error?: string;
  }> {
    const cwd = rootPath || workspace?.cwd || "";
    if (!cwd) return { ok: false, head: "", commits: [], refs: {}, error: "Missing rootPath" };
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
    const startTime = Date.now();

    // Choose what to walk:
    //   - branch (string)            → just that ref
    //   - includeRemotes=false       → only local heads + HEAD
    //   - default                    → all heads + remotes + HEAD (IDEA "Log")
    let walkArgs: string[];
    if (branch && !branch.startsWith("-")) {
      walkArgs = [branch];
    } else if (includeRemotes) {
      walkArgs = ["--branches", "--remotes", "--tags", "HEAD"];
    } else {
      walkArgs = ["--branches", "HEAD"];
    }

    // Use a unit-separator we can split on safely (subjects often contain
    // tabs / pipes / commas). The 0x1f character is unlikely in real text.
    const SEP = "";
    const fmt = ["%H", "%h", "%P", "%s", "%an", "%cr", "%cI", "%D"].join(SEP);

    // Optional filters — keep all guarded so empty/invalid inputs don't change
    // the command. safeDateExpr/safeRepoPath already rejected '-' prefixes,
    // but we still pass these as separate argv items (never concatenated into
    // a single shell string) so a malformed date can't smuggle a flag.
    const filterArgs: string[] = [];
    if (sinceDate.trim()) filterArgs.push(`--since=${sinceDate.trim()}`);
    if (untilDate.trim()) filterArgs.push(`--until=${untilDate.trim()}`);
    // --author matches against the commit's "Author <email>" line; git treats
    // the pattern as a fixed-string substring (no need to escape regex).
    if (author.trim()) filterArgs.push(`--author=${author.trim()}`);

    // -- <paths> must come AFTER all rev-walking args; collect them separately.
    const pathArgs = (paths || []).map((p) => p.trim()).filter((p) => p && !p.startsWith("-"));

    try {
      const result = await this.execGit(cwd, [
        "log",
        `--pretty=format:${fmt}`,
        topoOrder ? "--topo-order" : "--date-order",
        "-n",
        String(safeLimit),
        ...filterArgs,
        ...walkArgs,
        ...(pathArgs.length ? ["--", ...pathArgs] : []),
      ]);
      const refs: Record<string, string> = {};
      const lines = String(result.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean);
      const commits = lines.map((line) => {
        const [
          hash = "",
          shortHash = "",
          parentList = "",
          subject = "",
          author = "",
          relativeDate = "",
          isoDate = "",
          decoration = "",
        ] = line.split(SEP);
        const parents = parentList
          .split(/\s+/)
          .map((p) => p.trim())
          .filter(Boolean);
        // %D emits "HEAD -> main, origin/main, tag: v1" — split into clean
        // refs while remembering HEAD's resolved branch ("main" above).
        const decoTokens = decoration
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        const cleanRefs: string[] = [];
        for (const token of decoTokens) {
          if (token.startsWith("HEAD -> ")) {
            const target = token.slice(8).trim();
            cleanRefs.push("HEAD");
            cleanRefs.push(target);
            refs["HEAD"] = hash;
            refs[target] = hash;
          } else if (token === "HEAD") {
            cleanRefs.push("HEAD");
            refs["HEAD"] = hash;
          } else if (token.startsWith("tag: ")) {
            const tagName = token.slice(5).trim();
            cleanRefs.push(`tag:${tagName}`);
            refs[`tag:${tagName}`] = hash;
          } else {
            cleanRefs.push(token);
            refs[token] = hash;
          }
        }
        return {
          hash,
          shortHash,
          parents,
          subject,
          author,
          relativeDate,
          isoDate,
          refs: cleanRefs,
        };
      });
      // Resolve HEAD even when the decoration didn't include it (e.g. on
      // detached HEAD where %D only shows the surrounding branch).
      let head = refs["HEAD"] || "";
      if (!head) {
        try {
          const headResult = await this.execGit(cwd, ["rev-parse", "HEAD"]);
          head = headResult.stdout.trim();
        } catch {
          // ignore
        }
      }
      log.debug("git log-graph", {
        cwd,
        durationMs: Date.now() - startTime,
        limit: safeLimit,
        commitCount: commits.length,
        branch: branch || "",
        includeRemotes,
        topoOrder,
        sinceDate: sinceDate || "",
        untilDate: untilDate || "",
        author: author || "",
        pathCount: pathArgs.length,
      });
      return { ok: true, head, commits, refs };
    } catch (error) {
      const message = extractErrorMessage(error);
      log.warn("git log-graph failed", { cwd, durationMs: Date.now() - startTime, err: message });
      return { ok: false, head: "", commits: [], refs: {}, error: message };
    }
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
