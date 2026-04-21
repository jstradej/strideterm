import fs from "node:fs/promises";
import path from "node:path";

const PROBE_IGNORE = new Set(["node_modules", "dist", "build", "target", "vendor", "__pycache__", ".venv"]);
const DEFAULT_BUDGET = { maxReaddir: 300, maxMs: 1500 };

async function hasGitDir(dirPath) {
  try {
    await fs.access(path.join(dirPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function scanDir(dirPath, maxDepth, budget, childRepos) {
  if (budget.readdir >= budget.maxReaddir || Date.now() - budget.startMs > budget.maxMs) {
    budget.truncated = true;
    return;
  }

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
    budget.readdir++;
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (PROBE_IGNORE.has(entry.name)) continue;

    const childPath = path.join(dirPath, entry.name);
    if (await hasGitDir(childPath)) {
      childRepos.push(childPath);
      // Don't recurse into detected repos
      continue;
    }

    if (maxDepth > 1) {
      await scanDir(childPath, maxDepth - 1, budget, childRepos);
    }
  }
}

export async function probeDirectory(
  dirPath,
  { maxDepth = 2, maxReaddir = DEFAULT_BUDGET.maxReaddir, maxMs = DEFAULT_BUDGET.maxMs } = {},
) {
  const resolved = path.resolve(dirPath || "");
  const budget = { readdir: 0, maxReaddir, startMs: Date.now(), maxMs, truncated: false };

  const isGitRepo = await hasGitDir(resolved);
  let isInsideGitRepo = false;
  if (isGitRepo) {
    isInsideGitRepo = true;
  }

  const childRepos = [];
  await scanDir(resolved, maxDepth, budget, childRepos);

  return {
    path: resolved,
    isGitRepo: isGitRepo || isInsideGitRepo,
    childRepos,
    scannedDepth: maxDepth,
    truncated: budget.truncated,
  };
}
