import fs from "node:fs/promises";
import path from "node:path";

const TEXT_PREVIEW_MAX = 256 * 1024; // 256 KB
const BINARY_SNIFF_SIZE = 8192;
const MAX_ENTRIES = 1000;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp", ".avif"]);

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
