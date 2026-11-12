import fs from "node:fs/promises";
import path from "node:path";
import { isSensitivePath } from "../file-manager.js";
import { SshFileError } from "./ssh-file-error.js";
import type { SshFileLocalPolicy } from "./ssh-file-transfers.js";

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function comparable(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return CASE_INSENSITIVE_FS ? normalized.toLowerCase() : normalized;
}

function isInside(child: string, parent: string): boolean {
  const c = comparable(child);
  const p = comparable(parent);
  return c === p || c.startsWith(p + "/");
}

/** `realpath` of the deepest existing ancestor with the missing tail re-attached (the target may not exist yet). */
async function realpathOfPossiblyMissing(target: string): Promise<string> {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when any segment of the path is a `.git` directory name. */
export function hasGitSegment(target: string): boolean {
  return path
    .resolve(target)
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === ".git");
}

/**
 * Local paths a caller confined to workspace roots may touch: logically inside one of `roots()`, and — after
 * following symlinks — still inside one of them. Sensitive system paths are refused whatever the roots say.
 * `protectGit` additionally refuses any destination inside a `.git` directory and any `.git` name in a download.
 */
export function createRootsLocalPolicy({
  roots,
  protectGit = false,
}: {
  roots: () => string[];
  protectGit?: boolean;
}): SshFileLocalPolicy {
  async function assertInside(target: string): Promise<void> {
    if (!path.isAbsolute(target)) throw new SshFileError("outside-roots", `Not an absolute local path: ${target}`);
    const usable = roots().filter((root) => root && !isSensitivePath(root));
    const logical = path.resolve(target);
    if (isSensitivePath(logical) || !usable.some((root) => isInside(logical, root))) {
      throw new SshFileError("outside-roots", "That local path is outside this workspace's folders.");
    }
    const real = await realpathOfPossiblyMissing(logical);
    if (isSensitivePath(real))
      throw new SshFileError("outside-roots", "That local path resolves to a protected location.");
    const realRoots = await Promise.all(usable.map((root) => realpathOfPossiblyMissing(root)));
    if (!realRoots.some((root) => isInside(real, root)) && !usable.some((root) => isInside(real, root))) {
      throw new SshFileError("outside-roots", "That local path resolves outside this workspace's folders.");
    }
  }
  return {
    async assertReadable(absPath) {
      await assertInside(absPath);
    },
    async assertWritableDir(absDir) {
      await assertInside(absDir);
      // The real path too: a link or a Windows 8.3 alias (GIT~1) reaches .git under another name.
      if (protectGit && (hasGitSegment(absDir) || hasGitSegment(await realpathOfPossiblyMissing(absDir)))) {
        throw new SshFileError("outside-roots", "Downloads never write into a .git directory.");
      }
    },
    rejectsName: protectGit
      ? (name) =>
          name.replace(/[. ]+$/, "").toLowerCase() === ".git" ? "Downloads never create a .git directory." : null
      : undefined,
  };
}

/** The desktop user chose the path themselves (dialog, OS drop, in-app drag): any absolute path is acceptable. */
export const desktopLocalPolicy: SshFileLocalPolicy = {
  async assertReadable(absPath) {
    if (!path.isAbsolute(absPath)) throw new SshFileError("outside-roots", `Not an absolute local path: ${absPath}`);
  },
  async assertWritableDir(absDir) {
    if (!path.isAbsolute(absDir)) throw new SshFileError("outside-roots", `Not an absolute local path: ${absDir}`);
  },
};
