import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  existingReviewProjectSkillsDir,
  materializeReviewProjectSkills,
  MAX_PROJECT_SKILL_FILES,
  removeReviewProjectSkills,
  reviewProjectSkillsDir,
} from "./review-project-skills.js";

let tmp = "";
let repo = "";
let dataDir = "";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function put(rel: string, content: string | Buffer): void {
  const file = path.join(repo, ...rel.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function commit(message: string): string {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

function run(base: string, workspaceId = "ws-1") {
  return materializeReviewProjectSkills({ repoDir: repo, baseCommit: base, workspaceId, dataDir });
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "review-skills-"));
  repo = path.join(tmp, "repo");
  dataDir = path.join(tmp, "data");
  mkdirSync(repo);
  git("init", "-q");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("materializeReviewProjectSkills", () => {
  test("copies the base's skills as a plugin, binary files intact, and ignores head-only changes", async () => {
    const bytes = Buffer.from([0, 255, 1, 2, 13, 10, 200]);
    put(".claude/skills/quick-review/SKILL.md", "base skill\n");
    put(".claude/skills/quick-review/assets/blob.bin", bytes);
    const base = commit("base");
    put(".claude/skills/quick-review/SKILL.md", "head skill\n");
    put(".claude/skills/injected/SKILL.md", "head only\n");
    commit("head");

    const dir = await run(base);

    expect(dir).toBe(reviewProjectSkillsDir(dataDir, "ws-1"));
    expect(JSON.parse(readFileSync(path.join(dir!, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({
      name: "project-skills",
      version: "0.0.0",
    });
    expect(readFileSync(path.join(dir!, "skills", "quick-review", "SKILL.md"), "utf8")).toBe("base skill\n");
    expect(readFileSync(path.join(dir!, "skills", "quick-review", "assets", "blob.bin")).equals(bytes)).toBe(true);
    expect(existsSync(path.join(dir!, "skills", "injected"))).toBe(false);
    expect(existingReviewProjectSkillsDir(dataDir, "ws-1")).toBe(dir);
  });

  test("skips symlinks and submodule entries", async () => {
    put(".claude/skills/a/SKILL.md", "a\n");
    put("secret.txt", "outside\n");
    git("add", "-A");
    // Index entries written directly so the test does not depend on the OS creating symlinks.
    const blob = git("hash-object", "-w", "secret.txt");
    git("update-index", "--add", "--cacheinfo", `120000,${blob},.claude/skills/a/link`);
    git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},.claude/skills/sub`);
    const base = commit("base");

    const dir = await run(base);

    expect(readdirSync(path.join(dir!, "skills", "a"))).toEqual(["SKILL.md"]);
    expect(existsSync(path.join(dir!, "skills", "sub"))).toBe(false);
  });

  test("rejects traversal and files directly under skills/", async () => {
    put(".claude/skills/README.md", "not a skill\n");
    put(".claude/skills/ok/SKILL.md", "ok\n");
    const base = commit("base");
    const dir = await run(base);
    expect(readdirSync(path.join(dir!, "skills"))).toEqual(["ok"]);
    // `..` and absolute names cannot be created by git itself; the guard is exercised through the module's paths.
    expect(reviewProjectSkillsDir(dataDir, "../escape")).toBeNull();
    expect(reviewProjectSkillsDir(dataDir, "a/b")).toBeNull();
  });

  test("caps the number of files", async () => {
    for (let i = 0; i < MAX_PROJECT_SKILL_FILES + 5; i += 1) put(`.claude/skills/s/f${i}.md`, "x");
    const base = commit("base");
    const dir = await run(base);
    expect(readdirSync(path.join(dir!, "skills", "s")).length).toBe(MAX_PROJECT_SKILL_FILES);
    // One `git cat-file` per kept file: slow under a loaded full-suite run.
  }, 120_000);

  test("caps total bytes", async () => {
    put(".claude/skills/s/big1.bin", Buffer.alloc(3 * 1024 * 1024, 1));
    put(".claude/skills/s/big2.bin", Buffer.alloc(3 * 1024 * 1024, 2));
    const base = commit("base");
    const dir = await run(base);
    expect(readdirSync(path.join(dir!, "skills", "s"))).toEqual(["big1.bin"]);
  });

  test("replaces the directory on a second run and returns null (removing it) when no skills remain", async () => {
    put(".claude/skills/a/SKILL.md", "one\n");
    const first = commit("one");
    const dir = await run(first);
    writeFileSync(path.join(dir!, "stale.txt"), "stale");
    git("rm", "-rq", ".claude");
    put(".claude/skills/b/SKILL.md", "two\n");
    const second = commit("two");

    await run(second);
    expect(existsSync(path.join(dir!, "stale.txt"))).toBe(false);
    expect(existsSync(path.join(dir!, "skills", "a"))).toBe(false);
    expect(readFileSync(path.join(dir!, "skills", "b", "SKILL.md"), "utf8")).toBe("two\n");

    git("rm", "-rq", ".claude");
    const third = commit("none");
    expect(await run(third)).toBeNull();
    expect(existingReviewProjectSkillsDir(dataDir, "ws-1")).toBeNull();
    expect(existsSync(dir!)).toBe(false);
  });

  test("rejects an invalid workspace id or commit and removeReviewProjectSkills deletes the directory", async () => {
    put(".claude/skills/a/SKILL.md", "a\n");
    const base = commit("base");
    await expect(run(base, "../x")).rejects.toThrow();
    await expect(run("--not-a-sha")).rejects.toThrow();
    const dir = await run(base);
    await removeReviewProjectSkills(dataDir, "ws-1");
    expect(existsSync(dir!)).toBe(false);
  });
});
