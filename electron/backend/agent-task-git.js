import { access } from "node:fs/promises";
import path from "node:path";

export async function ensureGitRepo(cwd, { execCommand, gitInitLocks, log }) {
  const gitDir = path.join(cwd, ".git");
  try {
    await access(gitDir);
    log.trace("git repo exists", { cwd });
    return true;
  } catch {
    if (gitInitLocks.has(cwd)) {
      log.debug("git init already in progress, waiting", { cwd });
      return gitInitLocks.get(cwd);
    }

    const initPromise = doGitInit(cwd, { execCommand, log });
    gitInitLocks.set(cwd, initPromise);
    try {
      return await initPromise;
    } finally {
      gitInitLocks.delete(cwd);
    }
  }
}

async function doGitInit(cwd, { execCommand, log }) {
  log.info("no git repo found, running git init", { cwd });
  try {
    try {
      await access(path.join(cwd, ".git"));
      log.trace("git repo appeared while waiting for lock", { cwd });
      return true;
    } catch {
      // Still no .git — proceed.
    }

    const result = await execCommand("git init", cwd, 10_000);
    if (result.exitCode === 0) {
      log.info("git repo initialized", { cwd });
      await execCommand("git add -A", cwd, 10_000);
      await execCommand(
        'git commit -m "Initial commit (auto-created by strideterm task runner)" --allow-empty',
        cwd,
        10_000,
      );
      log.info("initial commit created", { cwd });
      return true;
    }
    log.warn("git init failed", { cwd, exitCode: result.exitCode, stderr: result.stderr });
    return false;
  } catch (error) {
    log.warn("git init error", { cwd, err: error.message });
    return false;
  }
}

export async function getGitContext(cwd, { execCommand, log }) {
  const empty = { status: "Not a git repository.", diffStat: "", diffNames: "" };
  const gitDir = path.join(cwd, ".git");
  try {
    await access(gitDir);
  } catch {
    log.debug("getGitContext: no .git directory", { cwd });
    return empty;
  }

  const MAX_LINES = 80;
  const MAX_CHARS = 5000;

  function clip(text, label = "output") {
    if (!text) return "(clean)";
    const lines = text.split("\n");
    const totalLines = lines.length;
    let clipped =
      totalLines > MAX_LINES
        ? lines.slice(0, MAX_LINES).join("\n") +
          `\n... (${totalLines - MAX_LINES} more lines hidden out of ${totalLines} total ${label} lines)`
        : text;
    if (clipped.length > MAX_CHARS) {
      clipped = clipped.slice(0, MAX_CHARS) + `\n... (${label} truncated at ${MAX_CHARS} chars)`;
    }
    return clipped;
  }

  try {
    const [statusResult, diffStatResult, diffNamesResult] = await Promise.all([
      execCommand("git status --short", cwd, 10_000),
      execCommand("git diff --stat", cwd, 10_000),
      execCommand("git diff --name-only", cwd, 10_000),
    ]);

    const context = {
      status: clip(statusResult.stdout.trim(), "git status"),
      diffStat: clip(diffStatResult.stdout.trim(), "diff stat"),
      diffNames: clip(diffNamesResult.stdout.trim(), "changed files"),
    };

    log.debug("git context gathered", {
      cwd,
      statusLines: statusResult.stdout.split("\n").length,
      diffFiles: diffNamesResult.stdout.split("\n").filter(Boolean).length,
    });

    return context;
  } catch (error) {
    log.warn("failed to gather git context", { cwd, err: error.message });
    return empty;
  }
}
