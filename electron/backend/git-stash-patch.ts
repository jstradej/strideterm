/// <reference types="node" />
import path from "node:path";

/**
 * strideterm stash-patch format (v1).
 *
 * A stash export is a normal git unified diff (so it still applies with plain
 * `git apply` outside strideterm) prefixed with a small `#`-comment header that
 * records the metadata we need to faithfully re-create the stash on import.
 * `git apply` ignores any leading lines before the first `diff --git`, so the
 * header is invisible to the git tooling and only meaningful to us.
 */

export const STASH_PATCH_MARKER = "# strideterm-stash-patch v1";

export interface StashPatchMeta {
  baseCommit: string;
  branch: string;
  message: string;
  includesUntracked: boolean;
}

export interface ParsedStashPatch extends StashPatchMeta {
  /** Whether a strideterm header was present (false ⇒ legacy / foreign patch). */
  hasHeader: boolean;
}

/**
 * Compose a strideterm stash patch from metadata + a unified-diff body.
 */
export function composeStashPatch(meta: StashPatchMeta, body: string): string {
  const header = [
    STASH_PATCH_MARKER,
    `# base: ${meta.baseCommit || ""}`,
    `# branch: ${meta.branch || ""}`,
    `# message: ${(meta.message || "").replace(/\r?\n/g, " ")}`,
    `# includes-untracked: ${meta.includesUntracked ? "true" : "false"}`,
  ].join("\n");
  // Ensure exactly one blank line between header and body.
  const trimmedBody = body.replace(/^\s*\n/, "");
  return `${header}\n\n${trimmedBody}`;
}

/**
 * Parse the strideterm header from a patch. Best-effort: foreign patches with
 * no header return { hasHeader: false } and sensible empty defaults.
 */
export function parseStashPatch(patch: string): ParsedStashPatch {
  const empty: ParsedStashPatch = {
    hasHeader: false,
    baseCommit: "",
    branch: "",
    message: "",
    includesUntracked: false,
  };
  if (!patch) return empty;
  const lines = patch.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== STASH_PATCH_MARKER) {
    return empty;
  }
  const meta: ParsedStashPatch = { ...empty, hasHeader: true };
  for (const line of lines.slice(1)) {
    if (!line.startsWith("#")) break; // header ends at first non-comment line
    const m = /^#\s*([a-z-]+):\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === "base") meta.baseCommit = value.trim();
    else if (key === "branch") meta.branch = value.trim();
    else if (key === "message") meta.message = value;
    else if (key === "includes-untracked") meta.includesUntracked = value.trim() === "true";
  }
  return meta;
}

/**
 * Extract every file path referenced by `diff --git a/<p> b/<p>` headers.
 * Git always emits forward slashes here, regardless of platform.
 */
export function extractDiffPaths(patch: string): string[] {
  const paths = new Set<string>();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(patch)) !== null) {
    if (match[1]) paths.add(match[1]);
    if (match[2]) paths.add(match[2]);
  }
  // Also catch /dev/null-paired hunks via +++/--- headers (added/deleted files).
  const re2 = /^[-+]{3} [ab]\/(.+)$/gm;
  while ((match = re2.exec(patch)) !== null) {
    if (match[1] && match[1] !== "/dev/null") paths.add(match[1]);
  }
  return [...paths];
}

/**
 * Reject patches that try to escape the repo root via absolute paths or `..`
 * traversal. Returns the offending path when unsafe so callers can surface it.
 */
export function validatePatchPaths(patch: string, rootPath: string): { ok: boolean; badPath?: string } {
  const root = path.resolve(rootPath);
  for (const rel of extractDiffPaths(patch)) {
    // Absolute paths (posix or windows) are never allowed inside a diff body.
    if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("/") || rel.startsWith("\\")) {
      return { ok: false, badPath: rel };
    }
    if (rel.split(/[\\/]/).includes("..")) {
      return { ok: false, badPath: rel };
    }
    const resolved = path.resolve(root, rel);
    const relToRoot = path.relative(root, resolved);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      return { ok: false, badPath: rel };
    }
  }
  return { ok: true };
}

/**
 * Build a filename suggestion for an export. Slugifies the user message when
 * present, otherwise falls back to `stash-<index>-<branch>-<date>`.
 */
export function suggestStashFilename(opts: {
  index: number;
  branch: string;
  customMessage: string;
  date: string;
}): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);
  const datePart = (opts.date || "").slice(0, 10).replace(/-/g, "");
  if (opts.customMessage && opts.customMessage.trim()) {
    const s = slug(opts.customMessage);
    if (s) return `${s}.patch`;
  }
  const branchSlug = slug(opts.branch || "detached") || "detached";
  return `stash-${opts.index}-${branchSlug}-${datePart || "0"}.patch`;
}
