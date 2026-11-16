import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Git directories a checkout writes to that sit OUTSIDE its root: a linked worktree's `.git` is a file
 * naming `<main repo>/.git/worktrees/<name>`, and git also writes objects and refs to the common
 * directory. Without write access to both, `git commit` inside the sandbox fails.
 *
 * The pointer file and everything inside the git dir are content the sandboxed agent can edit, so none of
 * it selects a grant by itself. A pointer is accepted only when it proves a real linked worktree of THIS
 * checkout: it must name `<common>/worktrees/<name>`, and that directory's own `gitdir` back-reference
 * (git writes it, and only a directory git created has it) must name this checkout's `.git` file. The
 * common directory is derived from that layout, never read from `commondir`. Anything else yields no
 * grant at all: `git commit` then fails inside the sandbox, which is the safe side.
 *
 * Returns host-notation paths; empty for a normal checkout. `pointerFiles` lists the files whose content
 * decides the grant (`<root>/.git`, `<gitdir>/gitdir`, `<gitdir>/commondir`) so the policy keeps them
 * read-only.
 */
export interface ExternalGitDirs {
  dirs: string[];
  pointerFiles: string[];
}

export interface ResolveGitDirsOptions {
  wslDistro?: string;
  readText?: (file: string) => string;
  realPath?: (file: string) => string;
}

const NONE: ExternalGitDirs = { dirs: [], pointerFiles: [] };

export function resolveExternalGitDirs(root: string, options: ResolveGitDirsOptions = {}): ExternalGitDirs {
  const readText = options.readText ?? ((file: string) => readFileSync(file, "utf8"));
  const realPath = options.realPath ?? ((file: string) => realpathSync(file));
  const dotGit = path.join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return NONE;
  } catch {
    return NONE;
  }
  // A checkout inside WSL, seen from Windows through \\wsl$\<distro>, names its git dir with a Linux path.
  const hostPath = (value: string, base: string): string =>
    options.wslDistro && value.startsWith("/")
      ? `\\\\wsl$\\${options.wslDistro}${value.replace(/\//gu, "\\")}`
      : path.resolve(base, value);
  const same = (a: string, b: string): boolean => {
    const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
    return fold(path.resolve(a)) === fold(path.resolve(b));
  };
  try {
    const match = /^gitdir:\s*(.+?)\s*$/mu.exec(readText(dotGit));
    if (!match) return NONE;
    const gitDir = hostPath(match[1], root);
    const worktrees = path.dirname(gitDir);
    if (path.basename(worktrees) !== "worktrees" || !path.basename(gitDir)) return NONE;
    const backReference = readText(path.join(gitDir, "gitdir")).trim();
    if (!backReference || !same(hostPath(backReference, gitDir), dotGit)) {
      // The back-reference may name the checkout through a link; compare real locations too.
      let sameReal = false;
      try {
        sameReal = same(realPath(hostPath(backReference, gitDir)), realPath(dotGit));
      } catch {
        sameReal = false;
      }
      if (!sameReal) return NONE;
    }
    const common = path.dirname(worktrees);
    return {
      dirs: [gitDir, common],
      pointerFiles: [dotGit, path.join(gitDir, "gitdir"), path.join(gitDir, "commondir")],
    };
  } catch {
    return NONE;
  }
}
