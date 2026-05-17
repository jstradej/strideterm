/// <reference types="node" />
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { execFileText } from "./process-utils.js";
import { guessLanguageFromPath } from "../../config/language-map.js";

const TEXT_PREVIEW_MAX = 256 * 1024; // 256 KB
const BINARY_SNIFF_SIZE = 8192;
const MAX_ENTRIES = 1000;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp", ".avif"]);

const GIT_STATUS_PRIORITY: Record<string, number> = {
  conflict: 5,
  staged: 4,
  modified: 3,
  untracked: 2,
  ignored: 1,
  clean: 0,
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface FileEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory" | "symlink";
  extension: string;
  size: number;
  modifiedAt: string;
  hasChildren: boolean;
  isHidden: boolean;
}

interface FilePreviewResult {
  kind: "text" | "binary" | "image" | "directory" | "empty";
  mimeType: string | null;
  content: string | null;
  truncated: boolean;
  size: number;
  encoding: string | null;
  imageSrc: string | null;
}

interface FileContentResult {
  content: string;
  size: number;
  encoding: string;
}

interface WriteResult {
  ok: boolean;
  size: number;
}

interface EntryResult {
  entry: FileEntry;
}

interface FileInfoResult {
  stat: {
    size: number;
    modifiedAt: string;
    createdAt: string;
    isDirectory: boolean;
    isFile: boolean;
    isSymlink: boolean;
  };
}

interface GitStatusEntry {
  status: string;
  stagedStatus: string;
  unstagedStatus: string;
}

interface GitFileStatusResult {
  isRepo: boolean;
  root: string;
  rootRelativeToFm?: string;
  entries: Record<string, GitStatusEntry>;
  directories?: Record<string, string>;
  error?: string;
}

interface FileRevisionResult {
  ok: boolean;
  content: string;
  missing: boolean;
  error?: string;
  revision?: string | null;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

interface GitRefsResult {
  isRepo: boolean;
  branches: string[];
  tags: string[];
  commits: GitCommit[];
  currentBranch: string;
}

interface DiffResult {
  ok: boolean;
  leftContent: string;
  rightContent: string;
  leftLabel: string;
  rightLabel: string;
  leftMissing: boolean;
  rightMissing: boolean;
  leftError: string;
  rightError: string;
  language: string;
  revision: string | undefined;
  source: string;
}

interface CommitFileEntry {
  path: string;
  code: string;
  status: string;
}

interface CommitFilesResult {
  isRepo: boolean;
  hash: string;
  parentHash: string;
  files: CommitFileEntry[];
  error?: string;
}

interface PorcelainEntry {
  repoPath: string;
  status: string;
  stagedStatus?: string;
  unstagedStatus?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Whitelist of paths a caller may target as `rootPath`. Without this guard
// the remote LAN client (which holds the access token but is otherwise
// untrusted code on a separate machine) could read or write any file the
// Electron process can see by simply choosing rootPath = "/" or "C:\".
// Wired up by the runtime once workspaces are loaded; until then the
// allowlist is empty and every fs call rejects.
let allowedRootsResolver: (() => string[]) | null = null;

export function setAllowedRootsResolver(resolver: () => string[]): void {
  allowedRootsResolver = resolver;
}

// Strip Windows extended-length / namespace prefixes so the rest of the
// pipeline can compare against plain `C:\…` and `\\server\…` forms. Without
// this, `\\?\C:\Windows` slips past both the regex denylist and the
// allowlist (the resolved path doesn't start with a drive letter).
function stripWindowsNamespacePrefix(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return "\\\\" + p.slice("\\\\?\\UNC\\".length);
  if (p.startsWith("\\\\?\\")) return p.slice("\\\\?\\".length);
  if (p.startsWith("\\\\.\\")) return p.slice("\\\\.\\".length);
  return p;
}

// Path comparisons are case-insensitive on Windows (NTFS/ReFS default) and
// historically case-insensitive on macOS (HFS+ default; APFS configurable).
// Treat both as case-insensitive so `C:\Work\Project` and `c:\work\project`
// match. Linux is case-sensitive — leave it alone.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function normalizePathForCompare(p: string): string {
  const stripped = stripWindowsNamespacePrefix(p);
  let n = path.resolve(stripped).replace(/\\/g, "/").replace(/\/+$/, "");
  if (CASE_INSENSITIVE_FS) n = n.toLowerCase();
  return n;
}

// Hard denylist applied regardless of the workspace allowlist. Even if the
// user explicitly created a workspace at one of these locations (e.g.
// `C:\Windows` or `/etc`) we refuse to read or write through file-manager
// — point the user at a real editor instead. This is defense in depth so
// a careless workspace cwd can't turn into an arbitrary-fs primitive,
// especially when reached via the remote LAN endpoint.
function isSensitivePath(p: string): boolean {
  if (!p) return true;
  const stripped = stripWindowsNamespacePrefix(p);
  const resolved = path.resolve(stripped);
  const parsed = path.parse(resolved);
  // Filesystem root itself: "/" on POSIX, "C:\" on Windows.
  if (resolved === parsed.root) return true;
  const norm = resolved.replace(/\\/g, "/").toLowerCase();
  // UNC root or partial path (`//server`, `//server/share`). Refuse without
  // an explicit allowlist entry — there's no good default for "is this share
  // sensitive?" so treat them all as sensitive and rely on the workspace
  // having added the exact share when the user opted in.
  if (norm.startsWith("//")) {
    const segments = norm.replace(/^\/+/, "").split("/").filter(Boolean);
    // \\server or \\server\share with no further path component → sensitive.
    if (segments.length <= 2) return true;
  }
  const posixDeny = [
    "/etc",
    "/bin",
    "/sbin",
    "/usr",
    "/var",
    "/boot",
    "/dev",
    "/proc",
    "/sys",
    "/root",
    "/lib",
    "/lib64",
    "/opt",
    "/srv",
  ];
  for (const d of posixDeny) {
    if (norm === d || norm.startsWith(d + "/")) return true;
  }
  // Windows system dirs on any drive letter, comparing the path tail
  // after the drive letter. Catches `C:\Windows`, `D:\Program Files`, etc.
  const winMatch = /^([a-z]):\/(.+)$/.exec(norm);
  if (winMatch) {
    const tail = "/" + winMatch[2];
    const winDeny = [
      "/windows",
      "/program files",
      "/program files (x86)",
      "/programdata",
      "/system volume information",
    ];
    for (const t of winDeny) {
      if (tail === t || tail.startsWith(t + "/")) return true;
    }
  }
  return false;
}

function isRootAllowed(root: string): boolean {
  // Deny first — sensitive system paths are off-limits even if the user
  // has registered them as a workspace cwd.
  if (isSensitivePath(root)) return false;
  if (!allowedRootsResolver) {
    // Resolver not yet installed — be safe and refuse. The runtime registers
    // it during `init()`; tests that bypass init must register their own.
    return false;
  }
  const requested = normalizePathForCompare(root);
  if (!requested) return false;
  for (const allowed of allowedRootsResolver()) {
    if (!allowed) continue;
    // Skip allowed entries that are themselves sensitive — an absent-minded
    // workspace at `/` shouldn't open up the whole filesystem.
    if (isSensitivePath(allowed)) continue;
    const a = normalizePathForCompare(allowed);
    if (requested === a) return true;
    // Allow drilling into subdirectories of an allowed root (file pickers
    // legitimately walk below the project root).
    if (requested.startsWith(a + "/")) return true;
  }
  return false;
}

/**
 * Resolve and guard a path against traversal outside the root.
 * Returns the absolute path, or throws if it escapes or if `rootPath`
 * itself isn't in the allowlist.
 *
 * Logical check only — `path.resolve` normalises `..` segments but does
 * not follow symlinks. A symlink inside the workspace pointing at
 * `/etc/shadow` would still satisfy this check. Callers that read or
 * write the resolved path must additionally call `assertRealPathInside()`
 * before performing the syscall.
 */
function safePath(rootPath: string, relativePath: string | null | undefined): string {
  const root = path.resolve(rootPath);
  if (!isRootAllowed(root)) {
    throw new Error(`Root path not allowed: ${rootPath}`);
  }
  const resolved = path.resolve(root, relativePath || "");
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return resolved;
}

export function resolveWorkspaceAbsPath(rootPath: string, relativePath: string | null | undefined): string {
  return safePath(rootPath, relativePath);
}

/**
 * Defence in depth against symlink escapes. `safePath` only checks the
 * logical path, so a symlink at `<root>/danger -> /etc` would resolve
 * to `<root>/danger` and pass. Before any fs read/write/delete we also
 * canonicalise the target with `fs.realpath` and verify the *real* path
 * still lives under the root's real path — or under any other root the
 * runtime allowlist covers, so legitimate cross-workspace symlinks
 * (a pnpm shared store, a dev `~/lib` aliased into multiple workspaces)
 * keep working.
 *
 * For create operations the leaf doesn't exist yet, so we realpath the
 * deepest existing ancestor and re-attach the missing tail. That still
 * catches `parent` being a symlink out of the workspace; only the new
 * leaf segment itself is unverified, and a freshly-created file can't
 * be a symlink.
 */
async function assertRealPathInside(rootPath: string, absoluteTarget: string): Promise<void> {
  const root = path.resolve(rootPath);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    // The root itself doesn't exist on disk — fall back to the logical
    // root, since `path.resolve` already normalised it. No symlink to
    // canonicalise away.
    realRoot = root;
  }
  let realTarget: string;
  try {
    realTarget = await fs.realpath(absoluteTarget);
  } catch {
    // Target missing — walk up to the deepest existing ancestor and
    // realpath that. Anything below it is a path the caller is about
    // to create, which can't itself be a symlink yet.
    let parent = path.dirname(absoluteTarget);
    while (parent !== path.dirname(parent)) {
      try {
        const realParent = await fs.realpath(parent);
        const tail = path.relative(parent, absoluteTarget);
        realTarget = path.resolve(realParent, tail);
        break;
      } catch {
        parent = path.dirname(parent);
      }
    }
    // Loop exited without finding any ancestor — fall back to the
    // logical target. `path.resolve` already eliminated `..` segments,
    // so this is no worse than the pre-realpath state.
    realTarget ??= absoluteTarget;
  }

  // Pre-canonicalise denylist trip-wires. Even if the realpath happens
  // to fall under an allowlisted root (or under the requesting root),
  // refuse anything that lands in `/etc`, `C:\Windows`, etc. The
  // existing root allowlist already filters these, but realpath can
  // route around it: a workspace at `~/proj` with a symlink
  // `~/proj/escape -> /etc` realpaths to `/etc/...`, which the
  // workspace allowlist on its own would have to exhaustively enumerate
  // to block.
  if (isSensitivePath(realTarget)) {
    throw new Error("Symlink escape blocked: target is a sensitive system path");
  }

  // Common case: realpath stays under the requesting workspace's root
  // (or the workspace itself, equal-not-startsWith). Most pnpm /
  // virtualenv layouts hit this branch — they symlink within the same
  // workspace dir.
  const sep = path.sep;
  const normReqRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (realTarget === realRoot || realTarget.startsWith(normReqRoot)) return;

  // Fallback: cross-workspace symlinks — accept if the realpath lands
  // under any other root the user has registered (other workspace cwds,
  // git roots, review checkouts). This covers the user who deliberately
  // shares a node_modules across two workspaces; a malicious workspace
  // can only "escape" into something the user already opened, never
  // into arbitrary filesystem.
  if (allowedRootsResolver) {
    const realTargetCmp = normalizePathForCompare(realTarget);
    for (const allowed of allowedRootsResolver()) {
      if (!allowed) continue;
      if (isSensitivePath(allowed)) continue;
      let realAllowed: string;
      try {
        realAllowed = await fs.realpath(path.resolve(allowed));
      } catch {
        realAllowed = path.resolve(allowed);
      }
      const a = normalizePathForCompare(realAllowed);
      if (realTargetCmp === a || realTargetCmp.startsWith(a + "/")) return;
    }
  }

  throw new Error("Symlink escape blocked");
}

function toRelative(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).replace(/\\/g, "/");
}

function isHiddenEntry(name: string): boolean {
  return name.startsWith(".");
}

async function statEntry(fullPath: string, rootPath: string): Promise<FileEntry> {
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
  const kind: "file" | "directory" | "symlink" = lstat.isSymbolicLink()
    ? "symlink"
    : stat.isDirectory()
      ? "directory"
      : "file";

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

function looksLikeBinary(buffer: Buffer): boolean {
  for (let i = 0; i < Math.min(buffer.length, BINARY_SNIFF_SIZE); i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function guessMimeType(ext: string): string {
  const map: Record<string, string> = {
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

export async function listDirectory(
  rootPath: string,
  relativePath: string,
): Promise<{ entries: FileEntry[]; path: string }> {
  const absDir = safePath(rootPath, relativePath);
  await assertRealPathInside(rootPath, absDir);
  const dirents = await fs.readdir(absDir, { withFileTypes: true });
  const root = path.resolve(rootPath);

  const entries: FileEntry[] = [];
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

export async function getDirectoryTree(
  rootPath: string,
  relativePath: string,
): Promise<{ entries: FileEntry[]; path: string }> {
  return listDirectory(rootPath, relativePath);
}

export async function readFilePreview(rootPath: string, relativePath: string): Promise<FilePreviewResult> {
  const absFile = safePath(rootPath, relativePath);
  await assertRealPathInside(rootPath, absFile);
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
  let content: string;
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

export async function readFileContent(rootPath: string, relativePath: string): Promise<FileContentResult> {
  const absFile = safePath(rootPath, relativePath);
  await assertRealPathInside(rootPath, absFile);
  let content: string;
  try {
    content = await fs.readFile(absFile, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const normalizedRelativePath = relativePath.replace(/\\/g, "/");
    if (code === "ENOENT" && /^\.strideterm\/tasks\/[^/]+\/TASK_LOG\.jsonl$/.test(normalizedRelativePath)) {
      return { content: "", size: 0, encoding: "utf-8" };
    }
    throw err;
  }
  return { content, size: Buffer.byteLength(content, "utf-8"), encoding: "utf-8" };
}

export async function writeFileContent(rootPath: string, relativePath: string, content: string): Promise<WriteResult> {
  const absFile = safePath(rootPath, relativePath);
  await assertRealPathInside(rootPath, absFile);
  await fs.writeFile(absFile, content, "utf-8");
  const stat = await fs.stat(absFile);
  return { ok: true, size: stat.size };
}

export async function createFile(rootPath: string, parentPath: string, name: string): Promise<EntryResult> {
  const absDir = safePath(rootPath, parentPath);
  const absFile = path.join(absDir, name);
  safePath(rootPath, path.relative(path.resolve(rootPath), absFile));
  await assertRealPathInside(rootPath, absFile);
  await fs.writeFile(absFile, "", "utf-8");
  return { entry: await statEntry(absFile, path.resolve(rootPath)) };
}

export async function createDirectory(rootPath: string, parentPath: string, name: string): Promise<EntryResult> {
  const absDir = safePath(rootPath, parentPath);
  const absNew = path.join(absDir, name);
  safePath(rootPath, path.relative(path.resolve(rootPath), absNew));
  await assertRealPathInside(rootPath, absNew);
  await fs.mkdir(absNew, { recursive: true });
  return { entry: await statEntry(absNew, path.resolve(rootPath)) };
}

export async function renameEntry(rootPath: string, relativePath: string, newName: string): Promise<EntryResult> {
  const absOld = safePath(rootPath, relativePath);
  const absNew = path.join(path.dirname(absOld), newName);
  safePath(rootPath, path.relative(path.resolve(rootPath), absNew));
  await assertRealPathInside(rootPath, absOld);
  await assertRealPathInside(rootPath, absNew);
  await fs.rename(absOld, absNew);
  return { entry: await statEntry(absNew, path.resolve(rootPath)) };
}

export async function deleteEntry(rootPath: string, relativePath: string): Promise<{ ok: boolean }> {
  const absTarget = safePath(rootPath, relativePath);
  await assertRealPathInside(rootPath, absTarget);
  const stat = await fs.stat(absTarget);
  if (stat.isDirectory()) {
    await fs.rm(absTarget, { recursive: true, force: true });
  } else {
    await fs.unlink(absTarget);
  }
  return { ok: true };
}

export async function moveEntry(rootPath: string, fromPath: string, toPath: string): Promise<EntryResult> {
  const absFrom = safePath(rootPath, fromPath);
  const absTo = safePath(rootPath, toPath);
  await assertRealPathInside(rootPath, absFrom);
  await assertRealPathInside(rootPath, absTo);
  if (absFrom === absTo) {
    throw new Error(`Source and destination are the same: ${path.basename(absTo)}`);
  }
  if (await pathExists(absTo)) {
    throw new Error(`Destination already exists: ${path.basename(absTo)}`);
  }
  await fs.rename(absFrom, absTo);
  return { entry: await statEntry(absTo, path.resolve(rootPath)) };
}

export async function copyEntry(rootPath: string, fromPath: string, toPath: string): Promise<EntryResult> {
  const absFrom = safePath(rootPath, fromPath);
  let absTo = safePath(rootPath, toPath);
  await assertRealPathInside(rootPath, absFrom);
  // Same-directory paste (the GUI Ctrl+C → Ctrl+V) lands on the source's
  // own path or an existing sibling. Auto-rename to "<name> (copy).<ext>",
  // "<name> (copy 2).<ext>", … so the user gets the system file-manager UX
  // instead of either a silent no-op or an overwrite.
  if (absFrom === absTo || (await pathExists(absTo))) {
    const destDir = path.dirname(absTo);
    const newName = await findAvailableCopyName(destDir, path.basename(absTo));
    absTo = path.join(destDir, newName);
  }
  await assertRealPathInside(rootPath, absTo);
  const stat = await fs.stat(absFrom);
  if (stat.isDirectory()) {
    // errorOnExist + force:false: belt-and-braces against a TOCTOU between
    // pathExists() above and fs.cp here. Without it fs.cp silently merges
    // into an existing directory, which would surprise the user.
    await fs.cp(absFrom, absTo, { recursive: true, force: false, errorOnExist: true });
  } else {
    // COPYFILE_EXCL fails fast if the destination materialised after our
    // existence check — better than silently overwriting another file.
    await fs.copyFile(absFrom, absTo, fsConstants.COPYFILE_EXCL);
  }
  return { entry: await statEntry(absTo, path.resolve(rootPath)) };
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the next available "<base> (copy).<ext>" / "<base> (copy N).<ext>"
 * inside `absDirPath` so a paste into the same directory doesn't clash.
 *
 * Mirrors GNOME Files' naming. `path.extname` returns "" for dotfiles like
 * `.gitignore` (preserved as `.gitignore (copy)`) and the last segment for
 * compound suffixes (`archive.tar.gz` becomes `archive.tar (copy).gz` —
 * same compromise Finder makes). The 1000-iteration cap is a defensive
 * upper bound; in practice users never reach it.
 */
async function findAvailableCopyName(absDirPath: string, originalName: string): Promise<string> {
  const ext = path.extname(originalName);
  const base = ext ? originalName.slice(0, -ext.length) : originalName;
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${base} (copy)${ext}` : `${base} (copy ${i})${ext}`;
    if (!(await pathExists(path.join(absDirPath, candidate)))) {
      return candidate;
    }
  }
  throw new Error(`Could not find a free "${originalName}" copy name after 1000 attempts`);
}

export async function getFileInfo(rootPath: string, relativePath: string): Promise<FileInfoResult> {
  const absFile = safePath(rootPath, relativePath);
  await assertRealPathInside(rootPath, absFile);
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
async function resolveGitToplevel(rootPath: string): Promise<string | null> {
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

function ensureForwardSlashes(value: unknown): string {
  return String(value || "").replace(/\\/g, "/");
}

function relativeFromRoot(rootPath: string, target: string): string {
  const rel = path.relative(rootPath, target);
  return ensureForwardSlashes(rel);
}

/**
 * Convert a path that is rooted at the git toplevel into one that is rooted
 * at our rootPath. If the file lives outside our rootPath (because rootPath
 * is a subdirectory of the repo) it will start with `../` and we drop it.
 */
function repoPathToFmRelative(rootPath: string, repoRoot: string, repoRelative: string): string | null {
  const abs = path.resolve(repoRoot, repoRelative);
  const fmRel = path.relative(rootPath, abs);
  if (!fmRel || fmRel.startsWith("..")) return null;
  return ensureForwardSlashes(fmRel);
}

/**
 * Decode git porcelain v2 path tokens — they may be quoted with C escapes
 * when they contain unusual characters.
 */
function decodeGitPath(token: string): string {
  if (!token.startsWith('"') || !token.endsWith('"')) return token;
  const inner = token.slice(1, -1);
  return inner.replace(/\\(.)/g, (_m: string, c: string) => {
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
function parsePorcelainEntry(line: string): PorcelainEntry | null {
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
  let status: string;
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
export async function getGitFileStatus(
  rootPath: string,
  { includeIgnored = false }: { includeIgnored?: boolean } = {},
): Promise<GitFileStatusResult> {
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
  let stdout: string;
  try {
    const result = await execFileText("git", args, { cwd: top });
    stdout = result.stdout || "";
  } catch (err) {
    const error = err as { error?: { message?: string } };
    return { isRepo: true, root: top, entries: {}, error: error?.error?.message || "git status failed" };
  }
  const entries: Record<string, GitStatusEntry> = {};
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
  const directoryRollup: Record<string, string> = {};
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
export async function readFileAtRevision(
  rootPath: string,
  relativePath: string,
  revision: string | null | undefined,
): Promise<FileRevisionResult> {
  const absFile = safePath(rootPath, relativePath);
  await assertRealPathInside(rootPath, absFile);
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
    const error = err as { stderr?: string };
    const stderr = (error?.stderr || "").trim();
    const missing = /exists on disk, but not in|does not exist|fatal: path|fatal: bad object/i.test(stderr);
    return { ok: !missing, content: "", missing, error: stderr || "git show failed", revision };
  }
}

/**
 * Read current working file content for diff. Returns { ok, content, missing }.
 */
export async function readWorkingFile(
  rootPath: string,
  relativePath: string,
): Promise<{ ok: boolean; content: string; missing: boolean; error?: string }> {
  try {
    const absFile = safePath(rootPath, relativePath);
    await assertRealPathInside(rootPath, absFile);
    const stat = await fs.stat(absFile);
    if (!stat.isFile()) {
      return { ok: false, content: "", missing: true, error: "Not a regular file" };
    }
    const content = await fs.readFile(absFile, "utf-8");
    return { ok: true, content, missing: false };
  } catch (err) {
    const error = err as Error;
    return { ok: false, content: "", missing: true, error: error.message };
  }
}

/**
 * Get all available diff targets for a file. Returns:
 *   - branches:  string[] (local + recent remote refs)
 *   - tags:      string[]
 *   - commits:   { hash, shortHash, subject, author, date }[] (recent log of file)
 *   - currentBranch: string
 */
export async function getGitRefs(rootPath: string, relativePath?: string): Promise<GitRefsResult> {
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
export async function computeFileDiff(
  rootPath: string,
  relativePath: string,
  { source = "head", revisionRef = "" }: { source?: string; revisionRef?: string } = {},
): Promise<DiffResult> {
  const language = guessLanguageFromPath(relativePath);

  // Right side is always the on-disk working copy (or staged file for "staged" source).
  let right: { ok: boolean; content: string; missing: boolean; error?: string; revision?: string | null };
  let rightLabel: string;
  if (source === "staged") {
    right = await readFileAtRevision(rootPath, relativePath, ""); // index
    rightLabel = "staged";
  } else {
    right = await readWorkingFile(rootPath, relativePath);
    rightLabel = "working tree";
  }

  // Left side is whatever the user picked.
  let left: { ok: boolean; content: string; missing: boolean; revision?: string | null; error?: string };
  let leftLabel: string;
  let revisionUsed: string | undefined;
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

function errorDiff(message: string, source: string): DiffResult {
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

const COMMIT_STATUS_MAP: Record<string, string> = {
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
export async function getCommitFiles(rootPath: string, hash: string): Promise<CommitFilesResult> {
  const root = path.resolve(rootPath);
  const top = await resolveGitToplevel(root);
  if (!top) return { isRepo: false, hash, parentHash: "", files: [] };
  if (!hash) return { isRepo: true, hash: "", parentHash: "", files: [] };

  // Detect parent (handles initial commit by leaving parentHash empty).
  let parentHash: string;
  try {
    const parentResult = await execFileText("git", ["rev-parse", `${hash}^`], { cwd: top });
    parentHash = (parentResult.stdout || "").trim();
  } catch {
    parentHash = "";
  }

  let lines: string[];
  try {
    // --root makes the initial commit (no parent) report its files as adds
    // instead of returning an empty diff.
    const args = ["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "-C", "--root", hash];
    const result = await execFileText("git", args, { cwd: top });
    lines = (result.stdout || "").split(/\r?\n/).filter(Boolean);
  } catch (err) {
    const error = err as { error?: { message?: string } };
    return { isRepo: true, hash, parentHash, files: [], error: error?.error?.message || "git diff-tree failed" };
  }

  const files: CommitFileEntry[] = [];
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
export async function computeCommitFileDiff(rootPath: string, relativePath: string, hash: string): Promise<DiffResult> {
  const language = guessLanguageFromPath(relativePath);
  const root = path.resolve(rootPath);
  const top = await resolveGitToplevel(root);
  if (!top || !hash) {
    return errorDiff("Not a git repository or missing commit hash", "commitRange");
  }

  const right = await readFileAtRevision(rootPath, relativePath, hash);
  let left: { ok: boolean; content: string; missing: boolean; revision?: string | null; error?: string };
  let leftLabel: string;
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
