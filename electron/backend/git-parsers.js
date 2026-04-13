/**
 * Pure parsing and utility functions for git command output.
 * Extracted from git-manager.js to reduce file size.
 * All functions here are stateless and side-effect free.
 */
import path from "node:path";
import os from "node:os";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";

export const DEFAULT_DIFF_STAT = Object.freeze({
  files: 0,
  insertions: 0,
  deletions: 0,
  renames: 0,
  deletes: 0,
});

export const DEFAULT_OPERATION_STATE = Object.freeze({
  kind: "idle",
  inProgress: false,
  label: "",
  details: "",
  conflicts: [],
  canContinue: false,
  canAbort: false,
});

export function createGitChangeBucket(name) {
  return {
    name,
    files: [],
    diffStat: { ...DEFAULT_DIFF_STAT },
  };
}

export function createUnavailableSnapshot(workspace, error = "") {
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
  };
}

// --- Path / string utilities ---

export function toWslPath(cwd) {
  const normalized = String(cwd || "").replaceAll("\\", "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) {
    return null;
  }

  const [, drive, rest] = match;
  return `/mnt/${drive.toLowerCase()}/${rest}`;
}

export function stripRefsPrefix(value = "") {
  return String(value || "")
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
}

export function normalizeBranchName(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return stripRefsPrefix(trimmed).replace(/^origin\//, "");
}

export function parseIntSafe(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveGitPath(cwd, value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

// --- Output parsers ---

export function parseDiffStatLine(line) {
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

export function mergeDiffStats(...stats) {
  return stats.reduce(
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

export function summarizeNameStatusEntries(entries = []) {
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

export function parseGitLog(rawText) {
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

export function parseNameStatus(rawText) {
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

export function parseGitRemotes(rawText) {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((result, line) => {
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

export function parseRevListCount(rawText) {
  const [left = "0", right = "0"] = String(rawText || "")
    .trim()
    .split(/\s+/);
  return {
    left: parseIntSafe(left),
    right: parseIntSafe(right),
  };
}

export function parseStatusEntries(rawText) {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2).trim() || "??",
      path: line.slice(3).trim(),
    }));
}

export function parsePorcelainV2(rawText) {
  const summary = {
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

export function parseWorktreeList(rawText) {
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

export function readBranchList(rawText) {
  return String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.endsWith("/HEAD"));
}

// --- Branch selection helpers ---

export function preferBaseBranch(currentBranch, upstream, branchNames = []) {
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

export function buildBaseBranchCandidates(currentBranch, upstream, branchNames = []) {
  const normalizedCurrent = normalizeBranchName(currentBranch);
  const seen = new Set();
  const candidates = [];

  function add(name) {
    const norm = normalizeBranchName(name);
    if (norm && norm !== normalizedCurrent && !seen.has(norm)) {
      seen.add(norm);
      candidates.push(name);
    }
  }

  if (upstream) add(upstream);
  for (const name of ["develop", "origin/develop", "main", "origin/main", "master", "origin/master"]) {
    if (branchNames.includes(name)) add(name);
  }

  return candidates;
}

// --- Operation state helpers ---

export function buildOperationState({ kind, conflicts = [] } = {}) {
  if (!kind || kind === "idle") {
    return { ...DEFAULT_OPERATION_STATE };
  }

  const labelMap = {
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
  };
}

export function extractErrorMessage(error) {
  return error?.stderr || error?.stdout || error?.error?.message || "Git command failed.";
}

export function createOperationWarnings(snapshot, { type, baseBranch, stashDirty }) {
  const warnings = [];
  const normalizedBaseBranch = normalizeBranchName(baseBranch);
  const normalizedCurrentBranch = normalizeBranchName(snapshot.branch);

  if (stashDirty && snapshot.dirty) {
    warnings.push("Local changes will be stashed before the operation and restored afterwards when possible.");
  }
  if (type === "rebase" && snapshot.upstream) {
    warnings.push("Rebase rewrites the history of the current branch. Push with care if this branch is shared.");
  }
  if (snapshot.aheadCount > 0 && snapshot.upstream) {
    warnings.push(`Current branch is ${snapshot.aheadCount} commit(s) ahead of ${snapshot.upstream}.`);
  }
  if (snapshot.behindCount > 0 && snapshot.upstream) {
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
}) {
  return {
    ok,
    summary,
    warnings,
    conflicts,
    rawOutput: String(rawOutput || "").trim(),
    operationState,
  };
}

export function resolveContinueArgs(kind) {
  if (kind === "merge") return ["merge", "--continue"];
  if (kind === "rebase") return ["rebase", "--continue"];
  if (kind === "cherry-pick") return ["cherry-pick", "--continue"];
  if (kind === "bisect") return ["bisect", "good"];
  return null;
}

export function resolveAbortArgs(kind) {
  if (kind === "merge") return ["merge", "--abort"];
  if (kind === "rebase") return ["rebase", "--abort"];
  if (kind === "cherry-pick") return ["cherry-pick", "--abort"];
  if (kind === "bisect") return ["bisect", "reset"];
  return null;
}

// --- Worktree / diff helpers ---

export async function inspectWorktreeDirtyState(execGitImpl, worktreePath, fallbackDirty = false) {
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

export function joinRawOutput(...chunks) {
  return chunks
    .map((chunk) => String(chunk || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function uniqueByPath(entries = []) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.path}:${entry.previousPath || ""}:${entry.code || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function mapStatusForLegacy(staged, unstaged, untracked) {
  return uniqueByPath([
    ...staged.map((entry) => ({ code: entry.code || entry.stagedStatus, path: entry.path })),
    ...unstaged.map((entry) => ({ code: entry.code || entry.unstagedStatus, path: entry.path })),
    ...untracked.map((entry) => ({ code: entry.code || "??", path: entry.path })),
  ]);
}

export function trimDiffPreview(rawText, limit = 400) {
  const lines = String(rawText || "").split(/\r?\n/);
  if (lines.length <= limit) {
    return rawText;
  }
  return `${lines.slice(0, limit).join("\n")}\n... diff preview truncated ...`;
}

export async function renderUntrackedDiffPreview(execGit, cwd, targetPath) {
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
      const diff = trimDiffPreview(error.stdout || error.stderr || "");
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

export function getFetchTimestamp(gitCommonDir) {
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
