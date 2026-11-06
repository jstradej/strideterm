import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { safeFileName, writeJiraIssueFiles } from "./jira-development-files.js";
import type { JiraIssue } from "./jira-manager.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jira-development-files-"));
  dirs.push(dir);
  return dir;
}

const issue: JiraIssue = {
  ref: { provider: "jira", connectionId: "jira-a", issueId: "1001", issueKey: "ABC-7" },
  summary: "Retry failed deliveries",
  status: "Open",
  issueType: "Story",
  projectKey: "ABC",
  updated: "2026-11-02T10:00:00.000Z",
  assignee: "Ann",
  labels: ["kafka", "retry"],
  url: "https://jira.example.com/browse/ABC-7",
  descriptionMarkdown: "Retry **three** times.",
  issueLinks: [{ type: "blocks", direction: "outward", issueKey: "ABC-8", summary: "Release", status: "Open" }],
  attachments: [
    { id: "1", fileName: "log.txt", mediaType: "text/plain", sizeBytes: 4 },
    { id: "2", fileName: "../log.txt", mediaType: "text/plain", sizeBytes: 4 },
    { id: "3", fileName: "huge.zip", mediaType: "application/zip", sizeBytes: 20 },
    { id: "4", fileName: "gone.png", mediaType: "image/png", sizeBytes: 4 },
  ],
};

describe("writeJiraIssueFiles links", () => {
  const link = (target: string, at: string) => symlink(target, at, process.platform === "win32" ? "junction" : "dir");
  const base = { issue, comments: [], task: "Do the work.", fetchAttachment: async () => new Uint8Array([1]) };

  test.each([[".strideterm"], [".strideterm/jira"], [".strideterm/jira/ABC-7"]])(
    "refuses to write through a link at %s and leaves the other folder untouched",
    async (linked) => {
      const root = await tempDir();
      const elsewhere = await tempDir();
      const parent = path.join(root, ...linked.split("/").slice(0, -1));
      await mkdir(parent, { recursive: true });
      await link(elsewhere, path.join(root, ...linked.split("/")));
      await expect(writeJiraIssueFiles({ root, ...base })).rejects.toThrow(/Refusing to write the Jira issue files/);
      expect(await readdir(elsewhere)).toEqual([]);
    },
  );

  test("refuses a linked attachments folder", async () => {
    const root = await tempDir();
    const elsewhere = await tempDir();
    const dir = path.join(root, ".strideterm", "jira", "ABC-7");
    await mkdir(dir, { recursive: true });
    await link(elsewhere, path.join(dir, "attachments"));
    await expect(writeJiraIssueFiles({ root, ...base })).rejects.toThrow(/Refusing to write the Jira issue files/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  test("a file link in the folder is refused, a regular file is replaced", async () => {
    const root = await tempDir();
    const elsewhere = await tempDir();
    const dir = path.join(root, ".strideterm", "jira", "ABC-7");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "ISSUE.md"), "old");
    await writeFile(path.join(dir, "TASK.md"), "old");
    await writeJiraIssueFiles({ root, ...base, issue: { ...issue, attachments: undefined } });
    expect(await readFile(path.join(dir, "TASK.md"), "utf8")).toBe("Do the work.\n");

    const target = path.join(elsewhere, "victim.txt");
    await writeFile(target, "keep");
    await rm(path.join(dir, "TASK.md"));
    try {
      await symlink(target, path.join(dir, "TASK.md"), "file");
    } catch {
      return;
    }
    await expect(writeJiraIssueFiles({ root, ...base, issue: { ...issue, attachments: undefined } })).rejects.toThrow(
      /link or not a file/,
    );
    expect(await readFile(target, "utf8")).toBe("keep");
  });
});

describe("writeJiraIssueFiles", () => {
  test("says how many comments are missing when the thread was cut", async () => {
    const root = await tempDir();
    await writeJiraIssueFiles({
      root,
      issue: { ...issue, attachments: undefined },
      comments: [{ id: "c9", author: "Ann", created: "2026-11-01", body: "Latest." }],
      commentsTotal: 1500,
      task: "t",
      fetchAttachment: async () => new Uint8Array(),
    });
    const markdown = await readFile(path.join(root, ".strideterm", "jira", "ABC-7", "ISSUE.md"), "utf8");
    expect(markdown).toContain("## Comments (newest 1 of 1500)");
    expect(markdown).toContain("Only the newest 1 of 1500 comments are included; the 1499 oldest are not.");
  });

  test("writes the issue with every comment, downloads what fits and says why the rest is missing", async () => {
    const root = await tempDir();
    const written = await writeJiraIssueFiles({
      root,
      issue,
      comments: [
        { id: "c1", author: "Ann", created: "2026-11-01", body: "Start with the EU cluster." },
        { id: "c2", author: "Ben", created: "2026-11-02", updated: "2026-11-03", body: "Only for orders." },
      ],
      task: "Do the work.",
      maxAttachmentBytes: 10,
      fetchAttachment: async (attachment) => {
        if (attachment.id === "4") throw new Error("Jira attachment was not found on this issue.");
        return new TextEncoder().encode(`#${attachment.id}#`);
      },
    });

    expect(written).toEqual({ relativeDir: ".strideterm/jira/ABC-7", attachments: 2, comments: 2 });
    const dir = path.join(root, ".strideterm", "jira", "ABC-7");
    const markdown = await readFile(path.join(dir, "ISSUE.md"), "utf8");
    expect(markdown).toContain("# ABC-7: Retry failed deliveries");
    expect(markdown).toContain("- **Labels:** kafka, retry");
    expect(markdown).toContain("Retry **three** times.");
    expect(markdown).toContain("- blocks ABC-8 · Release (Open)");
    expect(markdown).toContain("## Comments (2)");
    expect(markdown).toContain("### Ben · 2026-11-02, edited 2026-11-03");
    expect(markdown.indexOf("Start with the EU cluster.")).toBeLessThan(markdown.indexOf("Only for orders."));
    // A path in a file name never leaves the folder, and two names that collide both survive.
    expect((await readdir(path.join(dir, "attachments"))).sort()).toEqual(["2-log.txt", "log.txt"]);
    expect(markdown).toContain("huge.zip (20 B, application/zip) — not downloaded: larger than 10 B");
    expect(markdown).toContain(
      "gone.png (4 B, image/png) — not downloaded: Jira attachment was not found on this issue.",
    );
    expect(await readFile(path.join(dir, "TASK.md"), "utf8")).toBe("Do the work.\n");
  });

  test("an issue with nothing but a summary still gets a complete ISSUE.md", async () => {
    const root = await tempDir();
    await writeJiraIssueFiles({
      root,
      issue: { ...issue, descriptionMarkdown: undefined, issueLinks: undefined, attachments: undefined },
      comments: [],
      task: "x",
      fetchAttachment: async () => new Uint8Array(),
    });
    const markdown = await readFile(path.join(root, ".strideterm", "jira", "ABC-7", "ISSUE.md"), "utf8");
    expect(markdown).toContain("_No description._");
    expect(markdown).toContain("_No attachments._");
    expect(markdown).toContain("_No comments._");
    expect(markdown).not.toContain("## Linked issues");
  });
});

describe("safeFileName", () => {
  test("is Windows-safe on every OS", () => {
    expect(safeFileName("report.pdf. . ")).toBe("report.pdf");
    expect(safeFileName("CON")).toBe("_CON");
    expect(safeFileName("nul.txt")).toBe("_nul.txt");
    expect(safeFileName("Com1.log")).toBe("_Com1.log");
    expect(safeFileName("lpt9")).toBe("_lpt9");
    expect(safeFileName("console.txt")).toBe("console.txt");
    expect(safeFileName("...")).toBe("attachment");
    expect(safeFileName("a:b?.png")).toBe("a_b_.png");
  });
});
