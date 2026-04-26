import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  listDirectory,
  readFilePreview,
  readFileContent,
  writeFileContent,
  createFile,
  createDirectory,
  renameEntry,
  deleteEntry,
  moveEntry,
  copyEntry,
  getGitFileStatus,
  computeFileDiff,
  getGitRefs,
  readFileAtRevision,
  getCommitFiles,
  computeCommitFileDiff,
} from "./file-manager.js";

function execGit(cwd: string, args: string[]) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

let tmpRoot: string;

beforeAll(async () => {
  // On macOS os.tmpdir() returns a /var/... path that is a symlink to
  // /private/var/...; git rev-parse --show-toplevel canonicalises to the
  // real path, so path.relative(tmpRoot, top) starts with `..` and the
  // file-manager filters every entry out. Resolve the real path up-front
  // so root and top compare equal.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-fm-test-"));
  tmpRoot = await fs.realpath(created);
});

afterAll(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("file-manager core", () => {
  test("listDirectory + path traversal guard", async () => {
    const root = path.join(tmpRoot, "list-test");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "a.txt"), "hello");
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub", "b.txt"), "world");

    const result = await listDirectory(root, "");
    const names = result.entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "sub"]);

    const sub = await listDirectory(root, "sub");
    expect(sub.entries[0].name).toBe("b.txt");

    await expect(listDirectory(root, "../../etc/passwd")).rejects.toThrow(/Path traversal/);
  });

  test("readFilePreview text + binary + image discrimination", async () => {
    const root = path.join(tmpRoot, "preview-test");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "text.md"), "# Hello\n");
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 0, 4]));
    // Tiny PNG header
    await fs.writeFile(path.join(root, "tiny.png"), Buffer.from("89504e470d0a1a0a", "hex"));

    const text = await readFilePreview(root, "text.md");
    expect(text.kind).toBe("text");
    expect(text.content).toMatch(/Hello/);

    const binary = await readFilePreview(root, "binary.bin");
    expect(binary.kind).toBe("binary");

    const image = await readFilePreview(root, "tiny.png");
    expect(image.kind).toBe("image");
    expect(image.imageSrc).toMatch(/file:\/\//);
  });

  test("CRUD lifecycle: create, write, rename, copy, move, delete", async () => {
    const root = path.join(tmpRoot, "crud-test");
    await fs.mkdir(root, { recursive: true });

    await createFile(root, "", "hello.txt");
    await writeFileContent(root, "hello.txt", "v1");
    const r1 = await readFileContent(root, "hello.txt");
    expect(r1.content).toBe("v1");

    await renameEntry(root, "hello.txt", "renamed.txt");
    await createDirectory(root, "", "sub");
    await copyEntry(root, "renamed.txt", "sub/renamed.txt");
    await moveEntry(root, "renamed.txt", "sub/moved.txt");

    const sub = await listDirectory(root, "sub");
    const subNames = sub.entries.map((e) => e.name).sort();
    expect(subNames).toEqual(["moved.txt", "renamed.txt"]);

    await deleteEntry(root, "sub/renamed.txt");
    await deleteEntry(root, "sub");
    const final = await listDirectory(root, "");
    expect(final.entries.length).toBe(0);
  });
});

describe("file-manager git integration", () => {
  let repo: string;
  let initialCommit: string;

  beforeAll(async () => {
    repo = path.join(tmpRoot, "git-test");
    await fs.mkdir(repo, { recursive: true });
    await execGit(repo, ["init", "-q"]);
    await execGit(repo, ["config", "user.email", "test@example.com"]);
    await execGit(repo, ["config", "user.name", "Test"]);
    await execGit(repo, ["config", "commit.gpgsign", "false"]);
    await fs.writeFile(path.join(repo, "README.md"), "# Initial\n");
    await fs.writeFile(path.join(repo, "code.js"), "const x = 1;\n");
    await fs.mkdir(path.join(repo, "src"));
    await fs.writeFile(path.join(repo, "src", "index.js"), "export const a = 1;\n");
    await execGit(repo, ["add", "."]);
    await execGit(repo, ["commit", "-q", "-m", "initial"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log = (await execGit(repo, ["rev-parse", "HEAD"])) as any;
    initialCommit = log.stdout.trim();
    // Make some changes for status checks
    await fs.writeFile(path.join(repo, "README.md"), "# Initial\nChanged\n");
    await fs.writeFile(path.join(repo, "untracked.txt"), "new\n");
    await fs.writeFile(path.join(repo, "src", "index.js"), "export const a = 2;\n");
  });

  test("non-git path returns isRepo=false", async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-not-git-"));
    try {
      const result = await getGitFileStatus(elsewhere);
      expect(result.isRepo).toBe(false);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  test("getGitFileStatus reports modified, untracked, and dir rollups", async () => {
    const status = await getGitFileStatus(repo);
    expect(status.isRepo).toBe(true);
    expect(status.entries["README.md"]?.status).toBe("modified");
    expect(status.entries["untracked.txt"]?.status).toBe("untracked");
    expect(status.entries["src/index.js"]?.status).toBe("modified");
    // Directory rollup picks up nested changes
    expect(status.directories!["src"]).toBe("modified");
  });

  test("getGitFileStatus respects subdirectory rootPath", async () => {
    const subStatus = await getGitFileStatus(path.join(repo, "src"));
    expect(subStatus.isRepo).toBe(true);
    // From src/'s perspective, src/index.js is just "index.js"
    expect(subStatus.entries["index.js"]?.status).toBe("modified");
  });

  test("readFileAtRevision returns committed content", async () => {
    const head = await readFileAtRevision(repo, "README.md", "HEAD");
    expect(head.ok).toBe(true);
    expect(head.content).toBe("# Initial\n");

    const commit = await readFileAtRevision(repo, "README.md", initialCommit);
    expect(commit.ok).toBe(true);
    expect(commit.content).toBe("# Initial\n");

    const missing = await readFileAtRevision(repo, "untracked.txt", "HEAD");
    expect(missing.missing).toBe(true);
  });

  test("computeFileDiff vs HEAD vs commit produce different left/right content", async () => {
    const vsHead = await computeFileDiff(repo, "README.md", { source: "head" });
    expect(vsHead.ok).toBe(true);
    expect(vsHead.leftContent).toBe("# Initial\n");
    expect(vsHead.rightContent).toBe("# Initial\nChanged\n");
    expect(vsHead.leftLabel).toBe("HEAD");
    expect(vsHead.rightLabel).toBe("working tree");
    expect(vsHead.language).toBe("markdown");

    const vsCommit = await computeFileDiff(repo, "README.md", { source: "commit", revisionRef: initialCommit });
    expect(vsCommit.ok).toBe(true);
    expect(vsCommit.leftContent).toBe("# Initial\n");
    expect(vsCommit.leftLabel).toMatch(/commit/);

    const noRef = await computeFileDiff(repo, "README.md", { source: "branch" });
    expect(noRef.ok).toBe(false);
    expect(noRef.leftError).toMatch(/Branch name is required/);
  });

  test("getGitRefs lists branches, current branch, and recent commits for a file", async () => {
    const refs = await getGitRefs(repo, "README.md");
    expect(refs.isRepo).toBe(true);
    expect(refs.branches.length).toBeGreaterThan(0);
    expect(["main", "master"]).toContain(refs.currentBranch);
    expect(refs.commits.length).toBeGreaterThan(0);
    expect(refs.commits[0].subject).toMatch(/initial/);
  });

  test("getGitFileStatus(includeIgnored:true) surfaces .gitignore'd entries", async () => {
    // Drop a .gitignore + an ignored file, then check both flag values.
    await fs.writeFile(path.join(repo, ".gitignore"), "ignored.log\n");
    await fs.writeFile(path.join(repo, "ignored.log"), "noise\n");
    try {
      const without = await getGitFileStatus(repo);
      expect(without.entries["ignored.log"]).toBeUndefined();

      const withIgnored = await getGitFileStatus(repo, { includeIgnored: true });
      expect(withIgnored.entries["ignored.log"]?.status).toBe("ignored");
    } finally {
      await fs.rm(path.join(repo, ".gitignore"), { force: true });
      await fs.rm(path.join(repo, "ignored.log"), { force: true });
    }
  });
});

describe("file-manager commit history", () => {
  let repo: string;
  let firstCommit: string;
  let secondCommit: string;

  beforeAll(async () => {
    repo = path.join(tmpRoot, "git-history-test");
    await fs.mkdir(repo, { recursive: true });
    await execGit(repo, ["init", "-q"]);
    await execGit(repo, ["config", "user.email", "test@example.com"]);
    await execGit(repo, ["config", "user.name", "Test"]);
    await execGit(repo, ["config", "commit.gpgsign", "false"]);
    // First commit — creates two files.
    await fs.writeFile(path.join(repo, "alpha.txt"), "alpha v1\n");
    await fs.writeFile(path.join(repo, "beta.txt"), "beta v1\n");
    await execGit(repo, ["add", "."]);
    await execGit(repo, ["commit", "-q", "-m", "first"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: execGit return type not narrowed in test helper
    firstCommit = ((await execGit(repo, ["rev-parse", "HEAD"])) as any).stdout.trim();
    // Second commit — modifies alpha, deletes beta, adds gamma.
    await fs.writeFile(path.join(repo, "alpha.txt"), "alpha v2\n");
    await fs.rm(path.join(repo, "beta.txt"));
    await fs.writeFile(path.join(repo, "gamma.txt"), "gamma v1\n");
    await execGit(repo, ["add", "-A"]);
    await execGit(repo, ["commit", "-q", "-m", "second"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: execGit return type not narrowed in test helper
    secondCommit = ((await execGit(repo, ["rev-parse", "HEAD"])) as any).stdout.trim();
  });

  test("getCommitFiles on initial commit lists adds with no parent", async () => {
    const result = await getCommitFiles(repo, firstCommit);
    expect(result.isRepo).toBe(true);
    expect(result.parentHash).toBe(""); // no parent for the first commit
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual(["alpha.txt", "beta.txt"]);
    expect(result.files.every((f) => f.code === "A")).toBe(true);
  });

  test("getCommitFiles on second commit lists modify + delete + add", async () => {
    const result = await getCommitFiles(repo, secondCommit);
    expect(result.isRepo).toBe(true);
    expect(result.parentHash).toBe(firstCommit);
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f.code]));
    expect(byPath["alpha.txt"]).toBe("M");
    expect(byPath["beta.txt"]).toBe("D");
    expect(byPath["gamma.txt"]).toBe("A");
  });

  test("getCommitFiles on missing hash returns empty files", async () => {
    const result = await getCommitFiles(repo, "");
    expect(result.isRepo).toBe(true);
    expect(result.files).toEqual([]);
  });

  test("computeCommitFileDiff vs parent and against initial commit", async () => {
    const vsParent = await computeCommitFileDiff(repo, "alpha.txt", secondCommit);
    expect(vsParent.ok).toBe(true);
    expect(vsParent.leftContent).toBe("alpha v1\n");
    expect(vsParent.rightContent).toBe("alpha v2\n");
    expect(vsParent.leftLabel).toMatch(/commit/);
    expect(vsParent.rightLabel).toMatch(/commit/);
    expect(vsParent.source).toBe("commitRange");

    const initial = await computeCommitFileDiff(repo, "alpha.txt", firstCommit);
    expect(initial.leftLabel).toBe("(no parent)");
    expect(initial.leftMissing).toBe(true);
    expect(initial.rightContent).toBe("alpha v1\n");
  });

  test("computeCommitFileDiff with empty hash returns errorDiff", async () => {
    const result = await computeCommitFileDiff(repo, "alpha.txt", "");
    expect(result.ok).toBe(false);
    expect(result.leftError).toMatch(/missing commit hash/i);
  });
});
