/**
 * Pure parsing and utility functions for git command output.
 * Extracted from git-manager.js to reduce file size.
 * All functions here are stateless and side-effect free.
 */
import path from "node:path";
import os from "node:os";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";

interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  renames: number;
  deletes: number;
}

interface NameStatusEntry {
  code: string;
  path: string;
  previousPath: string;
}

interface WorktreeEntry {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

interface GitSnapshot {
  branch?: string;
  upstream?: string;
  aheadCount?: number;
  behindCount?: number;
  dirty?: boolean;
  dirtyCount?: number;
  [key: string]: unknown;
}

export const DEFAULT_DIFF_STAT: Readonly<DiffStat> = Object.freeze({
  files: 0,
  insertions: 0,
  deletions: 0,
  renames: 0,
  deletes: 0,
});

export const DEFAULT_OPERATION_STATE: Readonly<{
  kind: string;
  inProgress: boolean;
  label: string;
  details: string;
  conflicts: string[];
  canContinue: boolean;
  canAbort: boolean;
}> = Object.freeze({
  kind: "idle",
  inProgress: false,
  label: "",
  details: "",
  conflicts: [],
  canContinue: false,
  canAbort: false,
});

export function createGitChangeBucket(name: string): { name: string; files: NameStatusEntry[]; diffStat: DiffStat } {
  return {
    name,
    files: [],
    diffStat: { ...DEFAULT_DIFF_STAT },
  };
}

export function createUnavailableSnapshot(
  workspace: { id: string; cwd?: string },
  error = "",
): Record<string, unknown> {
  return {
    workspaceId: workspace.id,
    projectId: workspace.id,
    cwd: workspace.cwd || "",
    available: false,
    root: "",
    repository: "",
    branch: "",
    remotes: {},
    commitCount: 0,
    dirty: false,
    dirtyCount: 0,
    status: [],
    staged: [],
    unstaged: [],
    untracked: [],
    changes: {
      staged: createGitChangeBucket("Staged"),
      unstaged: createGitChangeBucket("Unstaged"),
      untracked: createGitChangeBucket("Untracked"),
    },
    diffStat: { ...DEFAULT_DIFF_STAT },
    log: [],
    lazygit: {
      available: false,
      backend: null,
      error: "",
      launch: null,
    },
    gitDir: "",
    gitCommonDir: "",
    isWorktree: false,
    isMainWorktree: false,
    worktreePath: workspace.cwd || "",
    mainWorktreePath: "",
    siblingWorktrees: [],
    upstream: "",
    baseBranch: "",
    aheadCount: 0,
    behindCount: 0,
    compareWithBase: {
      baseBranch: "",
      aheadCount: 0,
      behindCount: 0,
      commits: [],
      files: [],
      diffStat: { ...DEFAULT_DIFF_STAT },
      potentialConflicts: [],
      baseChangedFiles: [],
    },
    lastFetchAt: null,
    operationState: { ...DEFAULT_OPERATION_STATE },
    error,
    lastUpdatedAt: null,
    lastChangeAt: null,
  };
}

// --- Path / string utilities ---

export function toWslPath(cwd: string): string | null {
  const normalized = String(cwd || "").replaceAll("\\", "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) {
    return null;
  }

  const [, drive, rest] = match;
  return `/mnt/${drive.toLowerCase()}/${rest}`;
}

export function stripRefsPrefix(value = ""): string {
  return String(value || "")
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
}

export function normalizeBranchName(value = ""): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return stripRefsPrefix(trimmed).replace(/^origin\//, "");
}

export function parseIntSafe(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveGitPath(cwd: string, value = ""): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

// --- Output parsers ---

export function parseDiffStatLine(line: string | null | undefined): DiffStat {
  const stat = { ...DEFAULT_DIFF_STAT };
  if (!line) {
    return stat;
  }

  const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
  const deletionsMatch = line.match(/(\d+)\s+deletions?\(-\)/);
  stat.files = filesMatch ? parseIntSafe(filesMatch[1]) : 0;
  stat.insertions = insertionsMatch ? parseIntSafe(insertionsMatch[1]) : 0;
  stat.deletions = deletionsMatch ? parseIntSafe(deletionsMatch[1]) : 0;
  return stat;
}

export function mergeDiffStats(...stats: Array<Partial<DiffStat> | null | undefined>): DiffStat {
  return stats.reduce<DiffStat>(
    (merged, current) => ({
      files: merged.files + (current?.files || 0),
      insertions: merged.insertions + (current?.insertions || 0),
      deletions: merged.deletions + (current?.deletions || 0),
      renames: merged.renames + (current?.renames || 0),
      deletes: merged.deletes + (current?.deletes || 0),
    }),
    { ...DEFAULT_DIFF_STAT },
  );
}

export function summarizeNameStatusEntries(entries: Array<Partial<NameStatusEntry>> = []): DiffStat {
  const stat = { ...DEFAULT_DIFF_STAT };
  const uniqueFiles = new Set();

  for (const entry of entries) {
    if (entry?.path) {
      uniqueFiles.add(entry.path);
    }
    if ((entry?.code || "").startsWith("R")) {
      stat.renames += 1;
    }
    if ((entry?.code || "") === "D") {
      stat.deletes += 1;
    }
  }

  stat.files = uniqueFiles.size;
  return stat;
}

export function parseGitLog(
  rawText: string,
): Array<{ shortHash: string; relativeDate: string; author: string; refs: string; subject: string }> {
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

export function parseNameStatus(rawText: string): NameStatusEntry[] {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [code = "", firstPath = "", secondPath = ""] = line.split("\t");
      return {
        code,
        path: secondPath || firstPath,
        previousPath: secondPath ? firstPath : "",
      };
    });
}

export function parseGitRemotes(rawText: string): Record<string, string> {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((result, line) => {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) {
        return result;
      }
      const [, name, url, kind] = match;
      result[name] = result[name] || url;
      result[`${name}:${kind}`] = url;
      return result;
    }, {});
}

export function parseRevListCount(rawText: string): { left: number; right: number } {
  const [left = "0", right = "0"] = String(rawText || "")
    .trim()
    .split(/\s+/);
  return {
    left: parseIntSafe(left),
    right: parseIntSafe(right),
  };
}

export function parseStatusEntries(rawText: string): Array<{ code: string; path: string }> {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2).trim() || "??",
      path: line.slice(3).trim(),
    }));
}

export function parsePorcelainV2(rawText: string): {
  branch: string;
  upstream: string;
  aheadCount: number;
  behindCount: number;
  staged: Array<{
    path: string;
    previousPath: string;
    code: string;
    stagedStatus: string;
    unstagedStatus: string;
    kind: string;
    label: string;
  }>;
  unstaged: Array<{
    path: string;
    previousPath: string;
    code: string;
    stagedStatus: string;
    unstagedStatus: string;
    kind: string;
    label: string;
  }>;
  untracked: Array<{
    path: string;
    code: string;
    stagedStatus: string;
    unstagedStatus: string;
    kind: string;
    label: string;
    previousPath: string;
  }>;
  conflicts: Array<{
    path: string;
    previousPath: string;
    code: string;
    stagedStatus: string;
    unstagedStatus: string;
    kind: string;
    label: string;
  }>;
} {
  type PorcelainEntry = {
    path: string;
    previousPath: string;
    code: string;
    stagedStatus: string;
    unstagedStatus: string;
    kind: string;
    label: string;
  };
  type UntrackedEntry = {
    path: string;
    code: string;
    stagedStatus: string;
    unstagedStatus: string;
    kind: string;
    label: string;
    previousPath: string;
  };
  const summary: {
    branch: string;
    upstream: string;
    aheadCount: number;
    behindCount: number;
    staged: PorcelainEntry[];
    unstaged: PorcelainEntry[];
    untracked: UntrackedEntry[];
    conflicts: PorcelainEntry[];
  } = {
    branch: "",
    upstream: "",
    aheadCount: 0,
    behindCount: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
  };

  for (const rawLine of String(rawText || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }

    if (line.startsWith("# branch.head ")) {
      summary.branch = line.slice("# branch.head ".length).trim();
      continue;
    }

    if (line.startsWith("# branch.upstream ")) {
      summary.upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        summary.aheadCount = parseIntSafe(match[1]);
        summary.behindCount = parseIntSafe(match[2]);
      }
      continue;
    }

    if (line.startsWith("? ")) {
      const filePath = line.slice(2).trim();
      summary.untracked.push({
        path: filePath,
        code: "??",
        stagedStatus: "?",
        unstagedStatus: "?",
        kind: "untracked",
        label: "Untracked",
        previousPath: "",
      });
      continue;
    }

    const prefix = line[0];
    if (!["1", "2", "u"].includes(prefix)) {
      continue;
    }

    const pieces = line.split(" ");
    const xy = pieces[1] || "..";
    const stagedStatus = xy[0] || ".";
    const unstagedStatus = xy[1] || ".";
    const pathOffset = prefix === "2" ? 9 : prefix === "u" ? 10 : 8;
    const rest = pieces.slice(pathOffset).join(" ");
    const [pathPart = "", previousPath = ""] = rest.split("\t");
    const filePath = pathPart;
    const entry = {
      path: filePath,
      previousPath,
      code: xy.replace(/\./g, ""),
      stagedStatus,
      unstagedStatus,
      kind: prefix === "u" ? "conflict" : "tracked",
      label: prefix === "u" ? "Conflict" : "Modified",
    };

    if (prefix === "u") {
      summary.conflicts.push(entry);
      continue;
    }

    if (stagedStatus !== ".") {
      summary.staged.push(entry);
    }
    if (unstagedStatus !== ".") {
      summary.unstaged.push(entry);
    }
  }

  return summary;
}

export function parseWorktreeList(rawText: string): WorktreeEntry[] {
  const entries = [];
  let current = null;

  for (const rawLine of String(rawText || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      if (current) {
        entries.push(current);
      }
      current = {
        path: value,
        head: "",
        branch: "",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branch = stripRefsPrefix(value);
    } else if (key === "bare") {
      current.bare = true;
    } else if (key === "detached") {
      current.detached = true;
    } else if (key === "locked") {
      current.locked = true;
    } else if (key === "prunable") {
      current.prunable = true;
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

export function readBranchList(rawText: string): string[] {
  return String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.endsWith("/HEAD"));
}

// --- Branch selection helpers ---

export function preferBaseBranch(currentBranch: string, upstream: string, branchNames: string[] = []): string {
  const normalizedCurrent = normalizeBranchName(currentBranch);
  const normalizedUpstream = normalizeBranchName(upstream);
  const exactCandidates = new Set(branchNames);

  const orderedCandidates = ["main", "origin/main", "master", "origin/master", "develop", "origin/develop"];
  for (const candidate of orderedCandidates) {
    if (normalizeBranchName(candidate) === normalizedCurrent) {
      continue;
    }
    if (exactCandidates.has(candidate)) {
      return candidate;
    }
  }

  if (upstream && normalizeBranchName(upstream) !== normalizedCurrent) {
    return upstream;
  }
  if (normalizedUpstream && normalizedUpstream !== normalizedCurrent) {
    return normalizedUpstream;
  }

  return "";
}

// --- Operation state helpers ---

export type ConflictType = "both-modified" | "both-added" | "deleted-by-us" | "deleted-by-them" | "unknown";

export interface ConflictEntry {
  path: string;
  conflictType: ConflictType;
  binary: boolean;
  stages: number[];
}

/**
 * Parse `git ls-files -u` output to classify conflict types per file.
 * Format: <mode> <object> <stage>\t<file>
 * Stages: 1=base, 2=ours, 3=theirs
 */
export function parseLsFilesUntracked(rawText: string): ConflictEntry[] {
  const stagesByPath = new Map<string, Set<number>>();
  for (const rawLine of String(rawText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Format: "100644 <sha> <stage>\t<path>"
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const filePath = line.slice(tab + 1);
    const parts = line.slice(0, tab).split(/\s+/);
    const stage = parseInt(parts[2] ?? "", 10);
    if (!isNaN(stage) && filePath) {
      if (!stagesByPath.has(filePath)) stagesByPath.set(filePath, new Set());
      stagesByPath.get(filePath)!.add(stage);
    }
  }

  const result: ConflictEntry[] = [];
  for (const [filePath, stages] of stagesByPath) {
    const has1 = stages.has(1);
    const has2 = stages.has(2);
    const has3 = stages.has(3);
    let conflictType: ConflictType;
    if (has1 && has2 && has3) {
      conflictType = "both-modified";
    } else if (!has1 && has2 && has3) {
      conflictType = "both-added";
    } else if (has1 && !has2 && has3) {
      conflictType = "deleted-by-us";
    } else if (has1 && has2 && !has3) {
      conflictType = "deleted-by-them";
    } else {
      conflictType = "unknown";
    }
    result.push({ path: filePath, conflictType, binary: false, stages: [...stages].sort() });
  }
  return result;
}

export interface OperationProgress {
  current: number;
  total: number;
}

export interface OperationSides {
  ours: string;
  theirs: string;
}

export interface OperationCurrentCommit {
  sha: string;
  subject: string;
}

export function buildOperationState({
  kind,
  conflicts = [],
  progress = null,
  currentCommit = null,
  sides = null,
}: {
  kind?: string;
  conflicts?: string[];
  progress?: OperationProgress | null;
  currentCommit?: OperationCurrentCommit | null;
  sides?: OperationSides | null;
} = {}): {
  kind: string;
  inProgress: boolean;
  label: string;
  details: string;
  conflicts: string[];
  canContinue: boolean;
  canAbort: boolean;
  canSkip: boolean;
  progress: OperationProgress | null;
  currentCommit: OperationCurrentCommit | null;
  sides: OperationSides | null;
} {
  if (!kind || kind === "idle") {
    return {
      ...DEFAULT_OPERATION_STATE,
      canSkip: false,
      progress: null,
      currentCommit: null,
      sides: null,
    };
  }

  const labelMap: Record<string, string> = {
    merge: "Merge in progress",
    rebase: "Rebase in progress",
    "cherry-pick": "Cherry-pick in progress",
    bisect: "Bisect in progress",
  };

  return {
    kind,
    inProgress: true,
    label: labelMap[kind] || "Git operation in progress",
    details: conflicts.length ? `${conflicts.length} file(s) still need resolution.` : "",
    conflicts,
    canContinue: kind !== "bisect",
    canAbort: true,
    canSkip: kind === "rebase" || kind === "cherry-pick",
    progress: progress ?? null,
    currentCommit: currentCommit ?? null,
    sides: sides ?? null,
  };
}

export function extractErrorMessage(error: unknown): string {
  const e = error as { stderr?: string; stdout?: string; error?: { message?: string } } | null | undefined;
  return e?.stderr || e?.stdout || e?.error?.message || "Git command failed.";
}

export function createOperationWarnings(
  snapshot: GitSnapshot,
  { type, baseBranch, stashDirty }: { type?: string; baseBranch?: string; stashDirty?: boolean },
): string[] {
  const warnings: string[] = [];
  const normalizedBaseBranch = normalizeBranchName(baseBranch);
  const normalizedCurrentBranch = normalizeBranchName(snapshot.branch);

  if (stashDirty && snapshot.dirty) {
    warnings.push("Local changes will be stashed before the operation and restored afterwards when possible.");
  }
  if (type === "rebase" && snapshot.upstream) {
    warnings.push("Rebase rewrites the history of the current branch. Push with care if this branch is shared.");
  }
  if ((snapshot.aheadCount ?? 0) > 0 && snapshot.upstream) {
    warnings.push(`Current branch is ${snapshot.aheadCount} commit(s) ahead of ${snapshot.upstream}.`);
  }
  if ((snapshot.behindCount ?? 0) > 0 && snapshot.upstream) {
    warnings.push(`Current branch is ${snapshot.behindCount} commit(s) behind ${snapshot.upstream}.`);
  }
  if (normalizedBaseBranch && normalizedBaseBranch === normalizedCurrentBranch) {
    warnings.push("Base branch matches the current branch. No history integration is needed.");
  }

  return warnings;
}

export function createStructuredResult({
  ok,
  summary,
  warnings = [],
  conflicts = [],
  rawOutput = "",
  operationState = DEFAULT_OPERATION_STATE,
}: {
  ok: boolean;
  summary: string;
  warnings?: string[];
  conflicts?: string[];
  rawOutput?: string;
  operationState?: typeof DEFAULT_OPERATION_STATE;
}): {
  ok: boolean;
  summary: string;
  warnings: string[];
  conflicts: string[];
  rawOutput: string;
  operationState: typeof DEFAULT_OPERATION_STATE;
} {
  return {
    ok,
    summary,
    warnings,
    conflicts,
    rawOutput: String(rawOutput || "").trim(),
    operationState,
  };
}

export function resolveContinueArgs(kind: string): string[] | null {
  if (kind === "merge") return ["merge", "--continue"];
  if (kind === "rebase") return ["rebase", "--continue"];
  if (kind === "cherry-pick") return ["cherry-pick", "--continue"];
  if (kind === "bisect") return ["bisect", "good"];
  return null;
}

export function resolveAbortArgs(kind: string): string[] | null {
  if (kind === "merge") return ["merge", "--abort"];
  if (kind === "rebase") return ["rebase", "--abort"];
  if (kind === "cherry-pick") return ["cherry-pick", "--abort"];
  if (kind === "bisect") return ["bisect", "reset"];
  return null;
}

export function resolveSkipArgs(kind: string): string[] | null {
  if (kind === "rebase") return ["rebase", "--skip"];
  if (kind === "cherry-pick") return ["cherry-pick", "--skip"];
  return null;
}

// --- Worktree / diff helpers ---

export async function inspectWorktreeDirtyState(
  execGitImpl: (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
  worktreePath: string,
  fallbackDirty = false,
): Promise<{ dirty: boolean; dirtyCount: number }> {
  try {
    const result = await execGitImpl(worktreePath, ["status", "--short"]);
    return {
      dirty: result.stdout.trim().length > 0,
      dirtyCount: result.stdout.trim() ? result.stdout.trim().split(/\r?\n/).length : 0,
    };
  } catch {
    return {
      dirty: fallbackDirty,
      dirtyCount: fallbackDirty ? 1 : 0,
    };
  }
}

export function joinRawOutput(...chunks: unknown[]): string {
  return chunks
    .map((chunk) => String(chunk || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function uniqueByPath(
  entries: Array<{ path: string; previousPath?: string; code?: string }> = [],
): Array<{ path: string; previousPath?: string; code?: string }> {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.path}:${entry.previousPath || ""}:${entry.code || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function mapStatusForLegacy(
  staged: Array<{ code?: string; stagedStatus?: string; path: string }>,
  unstaged: Array<{ code?: string; unstagedStatus?: string; path: string }>,
  untracked: Array<{ code?: string; path: string }>,
): Array<{ path: string; previousPath?: string; code?: string }> {
  return uniqueByPath([
    ...staged.map((entry) => ({ code: entry.code || entry.stagedStatus, path: entry.path })),
    ...unstaged.map((entry) => ({ code: entry.code || entry.unstagedStatus, path: entry.path })),
    ...untracked.map((entry) => ({ code: entry.code || "??", path: entry.path })),
  ]);
}

export function trimDiffPreview(rawText: string, limit = 400): string {
  const lines = String(rawText || "").split(/\r?\n/);
  if (lines.length <= limit) {
    return rawText;
  }
  return `${lines.slice(0, limit).join("\n")}\n... diff preview truncated ...`;
}

export async function renderUntrackedDiffPreview(
  execGit: (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
  cwd: string,
  targetPath: string,
): Promise<{ ok: boolean; diff: string; summary: string }> {
  const absolutePath = path.resolve(cwd, targetPath);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "strideterm-git-diff-"));
  const emptyFilePath = path.join(tempDir, "empty");

  try {
    await writeFile(emptyFilePath, "", "utf8");
    try {
      const result = await execGit(cwd, ["diff", "--no-index", "--no-prefix", "--", emptyFilePath, absolutePath]);
      return {
        ok: true,
        diff: trimDiffPreview(result.stdout || result.stderr || ""),
        summary: "",
      };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      const diff = trimDiffPreview(err.stdout || err.stderr || "");
      if (diff) {
        return {
          ok: true,
          diff,
          summary: "",
        };
      }
      return {
        ok: false,
        diff,
        summary: extractErrorMessage(error),
      };
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function getFetchTimestamp(gitCommonDir: string | null | undefined): string | null {
  if (!gitCommonDir) {
    return null;
  }

  try {
    const fetchHeadPath = path.join(gitCommonDir, "FETCH_HEAD");
    if (!existsSync(fetchHeadPath)) {
      return null;
    }
    return statSync(fetchHeadPath).mtime.toISOString();
  } catch {
    return null;
  }
}

// --- Stash detail parsing ------------------------------------------------

/**
 * The well-known SHA-1 of git's empty tree object. Diffing the untracked-files
 * snapshot (`<ref>^3`) against this yields a from-empty diff for each file.
 */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface StashEntry {
  index: number;
  ref: string;
  /** Full SHA of the stash commit — used to detect a stash-stack reshuffle
   *  (e.g. a `git stash drop` from a terminal) before acting on `stash@{N}`. */
  hash: string;
  date: string;
  author: string;
  branch: string;
  baseCommit: string;
  baseSubject: string;
  message: string;
  customMessage: string;
  isWipDefault: boolean;
  fileCount: number;
  /** Repo-relative paths of the files this stash touches. Returned eagerly so
   *  the client-side filter can match file paths without hydrating every entry. */
  filePaths: string[];
}

export interface StashFile {
  path: string;
  code: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "unmerged" | "untracked";
  additions: number;
  deletions: number;
  isBinary: boolean;
  oldPath?: string;
}

const STASH_STATUS_MAP: Record<string, StashFile["status"]> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  T: "modified",
};

/**
 * Parse `git diff/stash show --numstat` into a map keyed by the (new) path.
 * Binary files report `-` for both counts.
 */
export function parseStashNumstat(raw: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const out = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...rest] = parts;
    let pathPart = rest.join("\t");
    // Renames: "old => new" or "dir/{old => new}/file" — keep the resolved path.
    const arrow = pathPart.match(/\{(.*) => (.*)\}/);
    if (arrow) {
      pathPart = pathPart.replace(/\{.*? => (.*?)\}/, "$1");
    } else if (pathPart.includes(" => ")) {
      pathPart = pathPart.split(" => ")[1];
    }
    const binary = addRaw === "-" || delRaw === "-";
    out.set(pathPart, {
      additions: binary ? 0 : parseIntSafe(addRaw, 0),
      deletions: binary ? 0 : parseIntSafe(delRaw, 0),
      binary,
    });
  }
  return out;
}

/**
 * Parse `git stash show --name-status` into StashFile records, merging in the
 * additions/deletions from a numstat map.
 */
export function parseStashNameStatus(
  raw: string,
  numstat: Map<string, { additions: number; deletions: number; binary: boolean }>,
): StashFile[] {
  const files: StashFile[] = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const codeRaw = parts[0] || "";
    const letter = codeRaw[0] || "M";
    let filePath = parts[1] || "";
    let oldPath: string | undefined;
    // Renames/copies carry two paths: "R100\told\tnew".
    if ((letter === "R" || letter === "C") && parts.length >= 3) {
      oldPath = parts[1];
      filePath = parts[2];
    }
    if (!filePath) continue;
    const counts = numstat.get(filePath);
    files.push({
      path: filePath,
      code: letter,
      status: STASH_STATUS_MAP[letter] || "modified",
      additions: counts?.additions ?? 0,
      deletions: counts?.deletions ?? 0,
      isBinary: counts?.binary ?? false,
      ...(oldPath ? { oldPath } : {}),
    });
  }
  return files;
}

/**
 * Extract conflicted file paths from a `git stash apply/pop` failure message.
 */
export function parseConflictPaths(raw: string): string[] {
  const paths = new Set<string>();
  const re = /CONFLICT\s*\([^)]*\):\s*(?:Merge conflict in|.*? in)\s+(.+?)\s*$/gim;
  let m: RegExpExecArray | null;
  for (const line of String(raw || "").split(/\r?\n/)) {
    re.lastIndex = 0;
    m = re.exec(line);
    if (m && m[1]) paths.add(m[1].trim());
  }
  return [...paths];
}
