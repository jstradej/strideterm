import fs from "node:fs/promises";
import path from "node:path";
import { execFileText } from "./process-utils.js";
import { guessLanguageFromPath } from "../../config/language-map.js";

const TEXT_PREVIEW_MAX = 256 * 1024; // 256 KB
const BINARY_SNIFF_SIZE = 8192;
const MAX_ENTRIES = 1000;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp", ".avif"]);

const GIT_STATUS_PRIORITY = {
  conflict: 5,
  staged: 4,
  modified: 3,
  untracked: 2,
  ignored: 1,
  clean: 0,
};

/**
 * Resolve and guard a path against traversal outside the root.
 * Returns the absolute path, or throws if it escapes.
 */
function safePath(rootPath, relativePath) {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, relativePath || "");
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return resolved;
}

function toRelative(rootPath, absolutePath) {
  return path.relative(rootPath, absolutePath).replace(/\\/g, "/");
}

function isHiddenEntry(name) {
  return name.startsWith(".");
}

async function statEntry(fullPath, rootPath) {
  const stat = await fs.stat(fullPath);
  const name = path.basename(fullPath);
  const ext = path.extname(name).toLowerCase();
  const relativePath = toRelative(rootPath, fullPath);

  let hasChildren = false;
  if (stat.isDirectory()) {
    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      hasChildren = entries.some((e) => e.isDirectory());
    } catch {
      hasChildren = false;
    }
  }

  const lstat = await fs.lstat(fullPath);
  const kind = lstat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";

  return {
    name,
    relativePath,
    kind,
    extension: stat.isDirectory() ? "" : ext,
    size: stat.isDirectory() ? 0 : stat.size,
    modifiedAt: stat.mtime.toISOString(),
    hasChildren,
    isHidden: isHiddenEntry(name),
  };
}

function looksLikeBinary(buffer) {
  for (let i = 0; i < Math.min(buffer.length, BINARY_SNIFF_SIZE); i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function guessMimeType(ext) {
  const map = {
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".xml": "text/xml",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
  };
  return map[ext] || "text/plain";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listDirectory(rootPath, relativePath) {
  const absDir = safePath(rootPath, relativePath);
  const dirents = await fs.readdir(absDir, { withFileTypes: true });
  const root = path.resolve(rootPath);

  const entries = [];
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    const fullPath = path.join(absDir, dirent.name);

    // Resolve symlinks — skip if they escape root
    if (dirent.isSymbolicLink()) {
      try {
        const real = await fs.realpath(fullPath);
        const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
        if (real !== root && !real.startsWith(normalizedRoot)) continue;
      } catch {
        continue;
      }
    }

    try {
      entries.push(await statEntry(fullPath, root));
    } catch {
      // Skip entries we can't stat (permission denied, etc.)
    }
  }

  return {
    entries,
    path: toRelative(root, absDir),
  };
}

export async function getDirectoryTree(rootPath, relativePath) {
  return listDirectory(rootPath, relativePath);
}

export async function readFilePreview(rootPath, relativePath) {
  const absFile = safePath(rootPath, relativePath);
  const stat = await fs.stat(absFile);

  if (stat.isDirectory()) {
    return {
      kind: "directory",
      mimeType: null,
      content: null,
      truncated: false,
      size: 0,
      encoding: null,
      imageSrc: null,
    };
  }

  if (stat.size === 0) {
    return { kind: "empty", mimeType: null, content: "", truncated: false, size: 0, encoding: null, imageSrc: null };
  }

  const ext = path.extname(absFile).toLowerCase();

  // Image files — return file:// URL
  if (IMAGE_EXTENSIONS.has(ext)) {
    const fileUrl = `file:///${absFile.replace(/\\/g, "/").replace(/^\//, "")}`;
    return {
      kind: "image",
      mimeType: guessMimeType(ext),
      content: null,
      truncated: false,
      size: stat.size,
      encoding: null,
      imageSrc: fileUrl,
    };
  }

  // Read first chunk to detect binary
  const fd = await fs.open(absFile, "r");
  try {
    const sniffBuffer = Buffer.alloc(Math.min(BINARY_SNIFF_SIZE, stat.size));
    await fd.read(sniffBuffer, 0, sniffBuffer.length, 0);

    if (looksLikeBinary(sniffBuffer)) {
      return {
        kind: "binary",
        mimeType: "application/octet-stream",
        content: null,
        truncated: false,
        size: stat.size,
        encoding: null,
        imageSrc: null,
      };
    }
  } finally {
    await fd.close();
  }

  // Text file — read up to limit
  const truncated = stat.size > TEXT_PREVIEW_MAX;
  let content;
  if (truncated) {
    const fd2 = await fs.open(absFile, "r");
    try {
      const buf = Buffer.alloc(TEXT_PREVIEW_MAX);
      await fd2.read(buf, 0, TEXT_PREVIEW_MAX, 0);
      content = buf.toString("utf-8");
    } finally {
      await fd2.close();
    }
  } else {
    content = await fs.readFile(absFile, "utf-8");
  }

  return {
    kind: "text",
    mimeType: guessMimeType(ext),
    content,
    truncated,
    size: stat.size,
    encoding: "utf-8",
    imageSrc: null,
  };
}

export async function readFileContent(rootPath, relativePath) {
  const absFile = safePath(rootPath, relativePath);
  const content = await fs.readFile(absFile, "utf-8");
  return { content, size: Buffer.byteLength(content, "utf-8"), encoding: "utf-8" };
}

export async function writeFileContent(rootPath, relativePath, content) {
  const absFile = safePath(rootPath, relativePath);
  await fs.writeFile(absFile, content, "utf-8");
  const stat = await fs.stat(absFile);
  return { ok: true, size: stat.size };
}

export async function createFile(rootPath, parentPath, name) {
  const absDir = safePath(rootPath, parentPath);
  const absFile = path.join(absDir, name);
  safePath(rootPath, path.relative(path.resolve(rootPath), absFile));
  await fs.writeFile(absFile, "", "utf-8");
  return { entry: await statEntry(absFile, path.resolve(rootPath)) };
}

export async function createDirectory(rootPath, parentPath, name) {
  const absDir = safePath(rootPath, parentPath);
  const absNew = path.join(absDir, name);
  safePath(rootPath, path.relative(path.resolve(rootPath), absNew));
  await fs.mkdir(absNew, { recursive: true });
  return { entry: await statEntry(absNew, path.resolve(rootPath)) };
}

export async function renameEntry(rootPath, relativePath, newName) {
  const absOld = safePath(rootPath, relativePath);
  const absNew = path.join(path.dirname(absOld), newName);
  safePath(rootPath, path.relative(path.resolve(rootPath), absNew));
  await fs.rename(absOld, absNew);
  return { entry: await statEntry(absNew, path.resolve(rootPath)) };
}

export async function deleteEntry(rootPath, relativePath) {
  const absTarget = safePath(rootPath, relativePath);
  const stat = await fs.stat(absTarget);
  if (stat.isDirectory()) {
    await fs.rm(absTarget, { recursive: true, force: true });
  } else {
    await fs.unlink(absTarget);
  }
  return { ok: true };
}

export async function moveEntry(rootPath, fromPath, toPath) {
  const absFrom = safePath(rootPath, fromPath);
  const absTo = safePath(rootPath, toPath);
  await fs.rename(absFrom, absTo);
  return { entry: await statEntry(absTo, path.resolve(rootPath)) };
}

export async function copyEntry(rootPath, fromPath, toPath) {
  const absFrom = safePath(rootPath, fromPath);
  const absTo = safePath(rootPath, toPath);
  const stat = await fs.stat(absFrom);
  if (stat.isDirectory()) {
    await fs.cp(absFrom, absTo, { recursive: true });
  } else {
    await fs.copyFile(absFrom, absTo);
  }
  return { entry: await statEntry(absTo, path.resolve(rootPath)) };
}

export async function getFileInfo(rootPath, relativePath) {
  const absFile = safePath(rootPath, relativePath);
  const stat = await fs.stat(absFile);
  return {
    stat: {
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      createdAt: stat.birthtime.toISOString(),
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      isSymlink: (await fs.lstat(absFile)).isSymbolicLink(),
    },
  };
}

// ---------------------------------------------------------------------------
// Git integration — status, diff, ref listing
// ---------------------------------------------------------------------------

/**
 * Resolve the git working directory that contains the given root path.
 * Returns the absolute path to the work tree (which equals or contains rootPath),
 * or null if rootPath is not inside a git repository.
 */
async function resolveGitToplevel(rootPath) {
  try {
    const result = await execFileText("git", ["rev-parse", "--show-toplevel"], {
      cwd: rootPath,
    });
    const top = (result.stdout || "").trim();
    return top ? path.resolve(top) : null;
  } catch {
    return null;
  }
}

function ensureForwardSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function relativeFromRoot(rootPath, target) {
  const rel = path.relative(rootPath, target);
  return ensureForwardSlashes(rel);
}

/**
 * Convert a path that is rooted at the git toplevel into one that is rooted
 * at our rootPath. If the file lives outside our rootPath (because rootPath
 * is a subdirectory of the repo) it will start with `../` and we drop it.
 */
function repoPathToFmRelative(rootPath, repoRoot, repoRelative) {
  const abs = path.resolve(repoRoot, repoRelative);
  const fmRel = path.relative(rootPath, abs);
  if (!fmRel || fmRel.startsWith("..")) return null;
  return ensureForwardSlashes(fmRel);
}

/**
 * Decode git porcelain v2 path tokens — they may be quoted with C escapes
 * when they contain unusual characters.
 */
function decodeGitPath(token) {
  if (!token.startsWith('"') || !token.endsWith('"')) return token;
  const inner = token.slice(1, -1);
  return inner.replace(/\\(.)/g, (_m, c) => {
    if (c === "n") return "\n";
    if (c === "t") return "\t";
    if (c === "r") return "\r";
    return c;
  });
}

/**
 * Parse a single porcelain v2 entry line (one of "1", "2", "u", "?") and
 * return a { repoPath, status } object, or null if unparseable.
 */
function parsePorcelainEntry(line) {
  if (!line) return null;
  if (line.startsWith("? ")) {
    return { repoPath: decodeGitPath(line.slice(2).trim()), status: "untracked" };
  }
  if (line.startsWith("! ")) {
    return { repoPath: decodeGitPath(line.slice(2).trim()), status: "ignored" };
  }
  const prefix = line[0];
  if (!["1", "2", "u"].includes(prefix)) return null;
  const pieces = line.split(" ");
  const xy = pieces[1] || "..";
  const stagedStatus = xy[0];
  const unstagedStatus = xy[1];
  const pathOffset = prefix === "2" ? 9 : prefix === "u" ? 10 : 8;
  const rest = pieces.slice(pathOffset).join(" ");
  const [pathPart] = rest.split("\t");
  const repoPath = decodeGitPath(pathPart || "");
  if (!repoPath) return null;
  let status;
  if (prefix === "u") status = "conflict";
  else if (stagedStatus !== "." && unstagedStatus !== ".")
    status = "staged"; // both — treat as staged with extra
  else if (stagedStatus !== ".") status = "staged";
  else if (unstagedStatus !== ".") status = "modified";
  else status = "modified";
  return { repoPath, status, stagedStatus, unstagedStatus };
}

/**
 * Returns a Map<relativePath, statusInfo> for the entire repo (relative to
 * our rootPath). statusInfo = { status, stagedStatus, unstagedStatus }.
 * Includes ignored entries when includeIgnored is true.
 */
export async function getGitFileStatus(rootPath, { includeIgnored = false } = {}) {
  const root = path.resolve(rootPath);
  const top = await resolveGitToplevel(root);
  if (!top) {
    return { isRepo: false, root: "", entries: {} };
  }
  // Run git from the toplevel so paths in the porcelain output are always
  // relative to the repo root — easier to reason about for the FM relative
  // path mapping below.
  const args = ["-c", "status.relativePaths=false", "status", "--porcelain=v2", "--branch"];
  if (includeIgnored) args.push("--ignored");
  let stdout;
  try {
    const result = await execFileText("git", args, { cwd: top });
    stdout = result.stdout || "";
  } catch (err) {
    return { isRepo: true, root: top, entries: {}, error: err?.error?.message || "git status failed" };
  }
  const entries = {};
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith("# ")) continue;
    const parsed = parsePorcelainEntry(line);
    if (!parsed) continue;
    const fmRel = repoPathToFmRelative(root, top, parsed.repoPath);
    if (!fmRel) continue;
    entries[fmRel] = {
      status: parsed.status,
      stagedStatus: parsed.stagedStatus || "",
      unstagedStatus: parsed.unstagedStatus || "",
    };
  }

  // Derive directory rollups — a directory inherits the highest-priority
  // status of any descendant. This lets the tree show a marker on parent
  // folders even when only deep children are dirty.
  const directoryRollup = {};
  for (const [filePath, info] of Object.entries(entries)) {
    const parts = filePath.split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      const current = directoryRollup[acc];
      if (!current || GIT_STATUS_PRIORITY[info.status] > GIT_STATUS_PRIORITY[current]) {
        directoryRollup[acc] = info.status;
      }
    }
  }

  return {
    isRepo: true,
    root: top,
    rootRelativeToFm: relativeFromRoot(root, top),
    entries,
    directories: directoryRollup,
  };
}

/**
 * Read raw file content at a specific git revision. revision may be:
 *   - "HEAD"
 *   - any commit hash
 *   - a branch name (local or remote like "origin/main")
 *   - "" for the index ("staged")
 * Returns { ok, content, missing, encoding }.
 */
export async function readFileAtRevision(rootPath, relativePath, revision) {
  const absFile = safePath(rootPath, relativePath);
  const top = await resolveGitToplevel(path.resolve(rootPath));
  if (!top) {
    return { ok: false, content: "", missing: true, error: "Not a git repository", revision };
  }
  const repoRel = ensureForwardSlashes(path.relative(top, absFile));
  if (!repoRel || repoRel.startsWith("..")) {
    return { ok: false, content: "", missing: true, error: "Path outside git repo", revision };
  }
  const target = revision === "" || revision == null ? `:0:${repoRel}` : `${revision}:${repoRel}`;
  try {
    const result = await execFileText("git", ["show", target], { cwd: top, encoding: "utf-8" });
    return { ok: true, content: result.stdout || "", missing: false, revision };
  } catch (err) {
    const stderr = (err?.stderr || "").trim();
    const missing = /exists on disk, but not in|does not exist|fatal: path|fatal: bad object/i.test(stderr);
    return { ok: !missing, content: "", missing, error: stderr || "git show failed", revision };
  }
}

/**
 * Read current working file content for diff. Returns { ok, content, missing }.
 */
export async function readWorkingFile(rootPath, relativePath) {
  try {
    const absFile = safePath(rootPath, relativePath);
    const stat = await fs.stat(absFile);
    if (!stat.isFile()) {
      return { ok: false, content: "", missing: true, error: "Not a regular file" };
    }
    const content = await fs.readFile(absFile, "utf-8");
    return { ok: true, content, missing: false };
  } catch (err) {
    return { ok: false, content: "", missing: true, error: err.message };
  }
}

/**
 * Get all available diff targets for a file. Returns:
 *   - branches:  string[] (local + recent remote refs)
 *   - tags:      string[]
 *   - commits:   { hash, shortHash, subject, author, date }[] (recent log of file)
 *   - currentBranch: string
 */
export async function getGitRefs(rootPath, relativePath) {
  const root = path.resolve(rootPath);
  const top = await resolveGitToplevel(root);
  if (!top) {
    return { isRepo: false, branches: [], tags: [], commits: [], currentBranch: "" };
  }

  // Run all queries in parallel; tolerate failures individually.
  const [branchResult, tagResult, headResult, logResult] = await Promise.all([
    execFileText("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], {
      cwd: top,
    }).catch(() => ({ stdout: "" })),
    execFileText("git", ["tag", "--list", "--sort=-creatordate"], { cwd: top }).catch(() => ({ stdout: "" })),
    execFileText("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: top }).catch(() => ({ stdout: "" })),
    relativePath
      ? execFileText(
          "git",
          ["log", "-n", "50", "--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s", "--date=iso-strict", "--", relativePath],
          { cwd: top },
        ).catch(() => ({ stdout: "" }))
      : Promise.resolve({ stdout: "" }),
  ]);

  const branches = (branchResult.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const tags = (tagResult.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);

  const currentBranch = (headResult.stdout || "").trim();

  const commits = (logResult.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((row) => {
      const [hash, shortHash, author, date, ...rest] = row.split("\t");
      return {
        hash,
        shortHash,
        author,
        date,
        subject: rest.join("\t"),
      };
    });

  return { isRepo: true, branches, tags, commits, currentBranch };
}

/**
 * Compute a diff payload for a file vs a chosen revision/source.
 *
 * source ∈ { "head" | "staged" | "commit" | "branch" | "tag" }
 *   - "head"   → compare working tree to HEAD
 *   - "staged" → compare index (staged) to HEAD
 *   - "commit" → compare working tree to a commit hash (revisionRef required)
 *   - "branch" → compare working tree to a branch (revisionRef required)
 *   - "tag"    → compare working tree to a tag
 *
 * Returns:
 *   { ok, leftContent, rightContent, leftLabel, rightLabel,
 *     leftMissing, rightMissing, language, revision, source }
 */
export async function computeFileDiff(rootPath, relativePath, { source = "head", revisionRef = "" } = {}) {
  const language = guessLanguageFromPath(relativePath);

  // Right side is always the on-disk working copy (or staged file for "staged" source).
  let right;
  let rightLabel;
  if (source === "staged") {
    right = await readFileAtRevision(rootPath, relativePath, ""); // index
    rightLabel = "staged";
  } else {
    right = await readWorkingFile(rootPath, relativePath);
    rightLabel = "working tree";
  }

  // Left side is whatever the user picked.
  let left;
  let leftLabel;
  let revisionUsed;
  if (source === "head" || source === "staged") {
    left = await readFileAtRevision(rootPath, relativePath, "HEAD");
    leftLabel = "HEAD";
    revisionUsed = "HEAD";
  } else if (source === "commit") {
    if (!revisionRef) {
      return errorDiff("Commit hash is required", source);
    }
    left = await readFileAtRevision(rootPath, relativePath, revisionRef);
    leftLabel = `commit ${revisionRef.slice(0, 8)}`;
    revisionUsed = revisionRef;
  } else if (source === "branch") {
    if (!revisionRef) {
      return errorDiff("Branch name is required", source);
    }
    left = await readFileAtRevision(rootPath, relativePath, revisionRef);
    leftLabel = `branch ${revisionRef}`;
    revisionUsed = revisionRef;
  } else if (source === "tag") {
    if (!revisionRef) {
      return errorDiff("Tag name is required", source);
    }
    left = await readFileAtRevision(rootPath, relativePath, revisionRef);
    leftLabel = `tag ${revisionRef}`;
    revisionUsed = revisionRef;
  } else {
    return errorDiff(`Unknown diff source: ${source}`, source);
  }

  return {
    ok: !!(left && right),
    leftContent: left.content || "",
    rightContent: right.content || "",
    leftLabel,
    rightLabel,
    leftMissing: !!left.missing,
    rightMissing: !!right.missing,
    leftError: left.error || "",
    rightError: right.error || "",
    language,
    revision: revisionUsed,
    source,
  };
}

function errorDiff(message, source) {
  return {
    ok: false,
    leftContent: "",
    rightContent: "",
    leftLabel: "",
    rightLabel: "",
    leftMissing: true,
    rightMissing: true,
    leftError: message,
    rightError: "",
    language: "plaintext",
    revision: "",
    source,
  };
}

const COMMIT_STATUS_MAP = {
  A: "staged",
  M: "modified",
  D: "modified",
  R: "modified",
  C: "modified",
  T: "modified",
  U: "conflict",
};

/**
 * Return the list of files changed in a single commit (vs its first parent).
 * Returns: { isRepo, hash, parentHash, files: [{ path, code, status }] }
 */
export async function getCommitFiles(rootPath, hash) {
  const root = path.resolve(rootPath);
  const top = await resolveGitToplevel(root);
  if (!top) return { isRepo: false, hash, parentHash: "", files: [] };
  if (!hash) return { isRepo: true, hash: "", parentHash: "", files: [] };

  // Detect parent (handles initial commit by leaving parentHash empty).
  let parentHash;
  try {
    const parentResult = await execFileText("git", ["rev-parse", `${hash}^`], { cwd: top });
    parentHash = (parentResult.stdout || "").trim();
  } catch {
    parentHash = "";
  }

  let lines;
  try {
    // --root makes the initial commit (no parent) report its files as adds
    // instead of returning an empty diff.
    const args = ["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "-C", "--root", hash];
    const result = await execFileText("git", args, { cwd: top });
    lines = (result.stdout || "").split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return { isRepo: true, hash, parentHash, files: [], error: err?.error?.message || "git diff-tree failed" };
  }

  const files = [];
  for (const line of lines) {
    const parts = line.split("\t");
    const code = (parts[0] || "").trim();
    // For renames/copies, parts = [R100, oldPath, newPath]; we want newPath.
    const repoRel = parts[parts.length - 1];
    if (!repoRel) continue;
    const fmRel = repoPathToFmRelative(root, top, repoRel);
    if (!fmRel) continue;
    files.push({
      path: fmRel,
      code: code[0] || "M",
      status: COMMIT_STATUS_MAP[code[0]] || "modified",
    });
  }
  return { isRepo: true, hash, parentHash, files };
}

/**
 * Diff a file between a commit and its parent (or against an empty file when
 * the commit has no parent / introduces a new file).
 * Returns the same shape as computeFileDiff.
 */
export async function computeCommitFileDiff(rootPath, relativePath, hash) {
  const language = guessLanguageFromPath(relativePath);
  const root = path.resolve(rootPath);
  const top = await resolveGitToplevel(root);
  if (!top || !hash) {
    return errorDiff("Not a git repository or missing commit hash", "commitRange");
  }

  const right = await readFileAtRevision(rootPath, relativePath, hash);
  let left;
  let leftLabel;
  try {
    const parentResult = await execFileText("git", ["rev-parse", `${hash}^`], { cwd: top });
    const parent = (parentResult.stdout || "").trim();
    if (parent) {
      left = await readFileAtRevision(rootPath, relativePath, parent);
      leftLabel = `commit ${parent.slice(0, 8)}`;
    } else {
      left = { ok: true, content: "", missing: true, revision: "" };
      leftLabel = "(no parent)";
    }
  } catch {
    left = { ok: true, content: "", missing: true, revision: "" };
    leftLabel = "(no parent)";
  }

  return {
    ok: !!(left && right),
    leftContent: left.content || "",
    rightContent: right.content || "",
    leftLabel,
    rightLabel: `commit ${hash.slice(0, 8)}`,
    leftMissing: !!left.missing,
    rightMissing: !!right.missing,
    leftError: left.error || "",
    rightError: right.error || "",
    language,
    revision: hash,
    source: "commitRange",
  };
}
