import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { probeDirectory } from "./fs-probe.js";

async function makeDir(base: string, ...parts: string[]) {
  const dir = path.join(base, ...parts);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function initGit(dir: string) {
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fs-probe-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("probeDirectory", () => {
  test("returns isGitRepo=true when .git exists at path", async () => {
    await initGit(tmpRoot);
    const result = await probeDirectory(tmpRoot);
    expect(result.isGitRepo).toBe(true);
    expect(result.path).toBe(path.resolve(tmpRoot));
  });

  test("returns isGitRepo=false when no .git exists", async () => {
    const result = await probeDirectory(tmpRoot);
    expect(result.isGitRepo).toBe(false);
    expect(result.childRepos).toEqual([]);
  });

  test("finds child repos in layout", async () => {
    // parent dir is NOT a git repo, but api/ and web/ are
    const api = await makeDir(tmpRoot, "api");
    const web = await makeDir(tmpRoot, "web");
    await initGit(api);
    await initGit(web);

    const result = await probeDirectory(tmpRoot);
    expect(result.isGitRepo).toBe(false);
    expect(result.childRepos.length).toBe(2);
    // Results are in scan order; check both paths are represented
    const names = result.childRepos.map((p) => path.basename(p)).sort();
    expect(names).toEqual(["api", "web"]);
  });

  test("finds nested child repos up to depth 2", async () => {
    // services/auth is a git repo two levels deep
    const auth = await makeDir(tmpRoot, "services", "auth");
    await initGit(auth);

    const result = await probeDirectory(tmpRoot, { maxDepth: 2 });
    expect(result.childRepos.length).toBe(1);
    expect(path.basename(result.childRepos[0])).toBe("auth");
  });

  test("does not find repos beyond maxDepth=1", async () => {
    const auth = await makeDir(tmpRoot, "services", "auth");
    await initGit(auth);

    const result = await probeDirectory(tmpRoot, { maxDepth: 1 });
    // services itself is not a git repo and auth is too deep
    expect(result.childRepos.length).toBe(0);
  });

  test("ignores node_modules", async () => {
    const nm = await makeDir(tmpRoot, "node_modules", "some-pkg");
    await initGit(nm);
    // also add a real child repo
    const api = await makeDir(tmpRoot, "api");
    await initGit(api);

    const result = await probeDirectory(tmpRoot);
    expect(result.childRepos.length).toBe(1);
    expect(path.basename(result.childRepos[0])).toBe("api");
  });

  test("ignores directories starting with dot", async () => {
    const hidden = await makeDir(tmpRoot, ".hidden");
    await initGit(hidden);

    const result = await probeDirectory(tmpRoot);
    expect(result.childRepos).toEqual([]);
  });

  test("stops recursion at detected repo boundary", async () => {
    // repo/subrepo should not be found because we stop at repo/.git
    const repo = await makeDir(tmpRoot, "repo");
    await initGit(repo);
    const subrepo = await makeDir(tmpRoot, "repo", "subrepo");
    await initGit(subrepo);

    const result = await probeDirectory(tmpRoot);
    // Only finds repo, not subrepo (stops at boundary)
    expect(result.childRepos.length).toBe(1);
    expect(path.basename(result.childRepos[0])).toBe("repo");
  });

  test("returns truncated=true when budget is exhausted", async () => {
    // Create many directories to exhaust the readdir budget quickly
    for (let i = 0; i < 5; i++) {
      await makeDir(tmpRoot, `dir${i}`);
    }

    const result = await probeDirectory(tmpRoot, { maxReaddir: 2, maxMs: 10000 });
    // With maxReaddir=2 we scan the root dir (budget.readdir=1) then one child (budget.readdir=2),
    // the third child triggers the budget check and sets truncated=true
    expect(result.truncated).toBe(true);
  });

  test("returns truncated=false when scan completes within budget", async () => {
    await makeDir(tmpRoot, "a");
    await makeDir(tmpRoot, "b");

    const result = await probeDirectory(tmpRoot, { maxReaddir: 300, maxMs: 5000 });
    expect(result.truncated).toBe(false);
  });

  test("returns empty result for empty string path", async () => {
    const result = await probeDirectory("", { maxReaddir: 300, maxMs: 5000 });
    // resolved path of "" is process.cwd(); just verify structure
    expect(result).toHaveProperty("isGitRepo");
    expect(result).toHaveProperty("childRepos");
    expect(result).toHaveProperty("truncated");
  });

  test("scannedDepth reflects requested depth", async () => {
    const result = await probeDirectory(tmpRoot, { maxDepth: 3 });
    expect(result.scannedDepth).toBe(3);
  });
});
