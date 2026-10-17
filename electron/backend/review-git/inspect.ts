import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { isFullSha } from "../../shared/review-source-identity.js";

export interface GitAuth {
  login?: string;
  token?: string;
}

export type GitRun = (cwd: string, args: string[], auth?: GitAuth) => Promise<{ stdout: string; stderr: string }>;

export type GitOperationKind = "rebase" | "merge" | "cherry-pick" | "revert";

export interface DirtyState {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  total: number;
  /** Sorted, repo-relative paths of every entry in the porcelain status. */
  paths: string[];
  /** Digest of the exact porcelain status: changes whenever the index or worktree does. */
  digest: string;
}

export interface CheckoutFacts {
  cwd: string;
  headSha: string;
  /** Short name of the checked-out branch; "" when detached or unborn. */
  branch: string;
  detached: boolean;
  dirty: DirtyState;
  operation: GitOperationKind | null;
  gitDir: string;
  commonDir: string;
  shallow: boolean;
  originUrl: string;
}

export type Ancestry = "equal" | "behind" | "ahead" | "diverged" | "unknown";

export interface CommitSummary {
  sha: string;
  subject: string;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const OPERATION_MARKERS: Array<[string, GitOperationKind]> = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function digest(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u0000");
  }
  return hash.digest("hex").slice(0, 32);
}

export function parsePorcelainStatus(raw: string): DirtyState {
  const entries = raw.split("\u0000").filter(Boolean);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    // Renames and copies carry the origin path as a separate NUL-terminated field.
    if (code[0] === "R" || code[0] === "C") index += 1;
    paths.push(file);
    if (code === "??") {
      untracked += 1;
    } else if (CONFLICT_CODES.has(code)) {
      conflicted += 1;
    } else {
      if (code[0] !== " ") staged += 1;
      if (code[1] !== " ") unstaged += 1;
    }
  }
  paths.sort();
  return { staged, unstaged, untracked, conflicted, total: paths.length, paths, digest: digest(raw) };
}

export async function inspectCheckout(git: GitRun, cwd: string): Promise<CheckoutFacts> {
  const run = async (args: string[]) => (await git(cwd, args)).stdout.trim();
  const headSha = await run(["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "");
  const branch = await run(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
  const status = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const gitDirRaw = await run(["rev-parse", "--git-dir"]);
  const commonDirRaw = await run(["rev-parse", "--git-common-dir"]).catch(() => gitDirRaw);
  const gitDir = path.resolve(cwd, gitDirRaw);
  const commonDir = path.resolve(cwd, commonDirRaw || gitDirRaw);
  const shallow = (await run(["rev-parse", "--is-shallow-repository"]).catch(() => "false")) === "true";
  const originUrl = await run(["remote", "get-url", "origin"]).catch(() => "");

  let operation: GitOperationKind | null = null;
  for (const [marker, kind] of OPERATION_MARKERS) {
    if (await exists(path.join(gitDir, marker))) {
      operation = kind;
      break;
    }
  }
  return {
    cwd,
    headSha,
    branch,
    detached: !branch,
    dirty: parsePorcelainStatus(status),
    operation,
    gitDir,
    commonDir,
    shallow,
    originUrl,
  };
}

/**
 * Relation of `local` to `other` in the commit graph, from `local`'s side:
 * "behind" means local is an ancestor of other (a fast-forward is possible),
 * "ahead" means other is an ancestor of local. A shallow clone or a missing
 * object cannot prove either, so it answers "unknown" — never a guess.
 */
export async function compareCommits(
  git: GitRun,
  cwd: string,
  local: string,
  other: string,
  { shallow = false }: { shallow?: boolean } = {},
): Promise<Ancestry> {
  if (!local || !other) return "unknown";
  if (local === other) return "equal";
  if (shallow) return "unknown";
  try {
    const out = (await git(cwd, ["rev-list", "--left-right", "--count", `${local}...${other}`])).stdout.trim();
    const [onlyLocal, onlyOther] = out.split(/\s+/u).map((value) => Number(value));
    if (!Number.isFinite(onlyLocal) || !Number.isFinite(onlyOther)) return "unknown";
    if (onlyLocal === 0 && onlyOther === 0) return "equal";
    if (onlyLocal === 0) return "behind";
    if (onlyOther === 0) return "ahead";
    return "diverged";
  } catch {
    return "unknown";
  }
}

export async function listCommits(
  git: GitRun,
  cwd: string,
  range: string,
  limit = 50,
): Promise<{ commits: CommitSummary[]; total: number }> {
  try {
    const total = Number((await git(cwd, ["rev-list", "--count", range])).stdout.trim()) || 0;
    if (!total) return { commits: [], total: 0 };
    const out = (await git(cwd, ["log", `--max-count=${limit}`, "--format=%H%x09%s", range])).stdout;
    const commits = out
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subject] = line.split("\t");
        return { sha, subject: subject.join("\t") };
      });
    return { commits, total };
  } catch {
    return { commits: [], total: 0 };
  }
}

export async function hasCommit(git: GitRun, cwd: string, sha: string): Promise<boolean> {
  if (!sha) return false;
  try {
    await git(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The live tip of `ref` on `remote`, or null when the ref does not exist there. */
export async function lsRemoteRef(
  git: GitRun,
  cwd: string,
  remote: string,
  ref: string,
  auth?: GitAuth,
): Promise<string | null> {
  const out = (await git(cwd, ["ls-remote", remote, ref], auth)).stdout;
  for (const line of out.split(/\r?\n/u)) {
    const [sha, name] = line.trim().split(/\s+/u);
    if (name === ref && isFullSha(sha)) return sha;
  }
  return null;
}

export function describeDirty(dirty: DirtyState): string {
  const parts: string[] = [];
  if (dirty.staged) parts.push(`${dirty.staged} staged`);
  if (dirty.unstaged) parts.push(`${dirty.unstaged} modified`);
  if (dirty.untracked) parts.push(`${dirty.untracked} untracked`);
  if (dirty.conflicted) parts.push(`${dirty.conflicted} conflicted`);
  return parts.join(", ");
}
