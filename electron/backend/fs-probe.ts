import fs from "node:fs/promises";
import path from "node:path";

const PROBE_IGNORE = new Set(["node_modules", "dist", "build", "target", "vendor", "__pycache__", ".venv"]);
const DEFAULT_BUDGET = { maxReaddir: 300, maxMs: 1500 };

interface ScanBudget {
  readdir: number;
  maxReaddir: number;
  startMs: number;
  maxMs: number;
  truncated: boolean;
}

async function hasGitDir(dirPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(dirPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function scanDir(dirPath: string, maxDepth: number, budget: ScanBudget, childRepos: string[]): Promise<void> {
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
  dirPath: string,
  { maxDepth = 2, maxReaddir = DEFAULT_BUDGET.maxReaddir, maxMs = DEFAULT_BUDGET.maxMs } = {},
): Promise<{
  path: string;
  isGitRepo: boolean;
  childRepos: string[];
  scannedDepth: number;
  truncated: boolean;
}> {
  const resolved = path.resolve(dirPath || "");
  const budget: ScanBudget = { readdir: 0, maxReaddir, startMs: Date.now(), maxMs, truncated: false };

  const isGitRepo = await hasGitDir(resolved);
  let isInsideGitRepo = false;
  if (isGitRepo) {
    isInsideGitRepo = true;
  }

  const childRepos: string[] = [];
  await scanDir(resolved, maxDepth, budget, childRepos);

  return {
    path: resolved,
    isGitRepo: isGitRepo || isInsideGitRepo,
    childRepos,
    scannedDepth: maxDepth,
    truncated: budget.truncated,
  };
}
