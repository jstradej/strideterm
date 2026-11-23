import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getLogger } from "./logger.js";
import { sanitizeGitEnvironment } from "./shared/git-auth-utils.js";

const execFileAsync = promisify(execFile);
const log = getLogger("review-project-skills");

const SKILLS_PREFIX = ".claude/skills/";
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);
export const MAX_PROJECT_SKILL_FILES = 500;
export const MAX_PROJECT_SKILL_BYTES = 5 * 1024 * 1024;

export function reviewProjectSkillsDir(dataDir: string, workspaceId: string): string | null {
  if (!SAFE_WORKSPACE_ID.test(workspaceId)) return null;
  return path.join(dataDir, "review-skills", workspaceId);
}

/** The materialised plugin for this workspace, or null when there is none. */
export function existingReviewProjectSkillsDir(dataDir: string, workspaceId: string): string | null {
  const dir = reviewProjectSkillsDir(dataDir, workspaceId);
  return dir && existsSync(path.join(dir, ".claude-plugin", "plugin.json")) ? dir : null;
}

export async function removeReviewProjectSkills(dataDir: string, workspaceId: string): Promise<void> {
  const dir = reviewProjectSkillsDir(dataDir, workspaceId);
  if (!dir) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    log.warn("Could not remove the review project skills", { workspaceId, error: String(error) });
  }
}

function safeRelativePath(entryPath: string): string | null {
  if (entryPath.includes("\0") || entryPath.includes("\\") || entryPath.includes(":")) return null;
  const rest = entryPath.slice(SKILLS_PREFIX.length);
  const segments = rest.split("/");
  // A skill is `<name>/SKILL.md`; a file straight under skills/ is no skill.
  if (segments.length < 2) return null;
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")) return null;
  return rest;
}

interface TreeEntry {
  mode: string;
  sha: string;
  size: number;
  path: string;
}

function parseTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split("\0")) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\s+(\d+|-)\t([\s\S]*)$/u.exec(record);
    if (!match) continue;
    const [, mode, , sha, size, entryPath] = match;
    entries.push({ mode, sha, size: Number(size), path: entryPath });
  }
  return entries;
}

/**
 * Copies the repository's `.claude/skills` as of `baseCommit` (never the working tree) into a plugin directory owned
 * by the app, so a review session can load the project's skills without trusting the pull request's version.
 * Returns the plugin directory, or null when the base has no usable skills.
 */
export async function materializeReviewProjectSkills({
  repoDir,
  baseCommit,
  workspaceId,
  dataDir,
}: {
  repoDir: string;
  baseCommit: string;
  workspaceId: string;
  dataDir: string;
}): Promise<string | null> {
  const finalDir = reviewProjectSkillsDir(dataDir, workspaceId);
  if (!finalDir) throw new Error("Invalid workspace id for review project skills.");
  if (!/^[0-9a-f]{7,64}$/iu.test(baseCommit)) throw new Error("Invalid merge base for review project skills.");

  const git = async (args: string[], encoding: "utf8" | "buffer") =>
    (
      await execFileAsync("git", [...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []), ...args], {
        cwd: repoDir,
        env: sanitizeGitEnvironment(),
        encoding,
        maxBuffer: MAX_PROJECT_SKILL_BYTES + 1024 * 1024,
        windowsHide: true,
      })
    ).stdout;

  const listing = (await git(["ls-tree", "-r", "-z", "-l", baseCommit, "--", ".claude/skills"], "utf8")) as string;
  const kept: Array<{ entry: TreeEntry; rest: string }> = [];
  let totalBytes = 0;
  for (const entry of parseTree(listing)) {
    if (!entry.path.startsWith(SKILLS_PREFIX)) continue;
    if (!REGULAR_BLOB_MODES.has(entry.mode)) {
      log.info("Skipped a non-regular skill entry", { path: entry.path, mode: entry.mode });
      continue;
    }
    const rest = safeRelativePath(entry.path);
    if (!rest) {
      log.warn("Skipped an unsafe skill path", { path: JSON.stringify(entry.path) });
      continue;
    }
    if (kept.length >= MAX_PROJECT_SKILL_FILES || totalBytes + entry.size > MAX_PROJECT_SKILL_BYTES) {
      log.warn("Skipped a skill file over the size limits", { path: entry.path, size: entry.size });
      continue;
    }
    totalBytes += entry.size;
    kept.push({ entry, rest });
  }

  if (!kept.length) {
    await removeReviewProjectSkills(dataDir, workspaceId);
    return null;
  }

  const root = path.dirname(finalDir);
  const tmpDir = path.join(root, `.${workspaceId}.tmp-${process.pid}-${Date.now()}`);
  try {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(path.join(tmpDir, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(tmpDir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "project-skills", version: "0.0.0" })}\n`,
      "utf8",
    );
    const skillsRoot = path.join(tmpDir, "skills");
    for (const { entry, rest } of kept) {
      const target = path.join(skillsRoot, ...rest.split("/"));
      if (!path.resolve(target).startsWith(path.resolve(skillsRoot) + path.sep)) continue;
      const content = (await git(["cat-file", "blob", entry.sha], "buffer")) as Buffer;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return finalDir;
}
