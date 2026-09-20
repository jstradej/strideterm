import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile, stat, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { begin, chunk, cleanup, finish, list, remove, status } from "./attachments.js";

const run = promisify(execFile);

describe("attachments", () => {
  test("resumes chunks, verifies hash, and publishes atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-attachments-"));
    try {
      const body = Buffer.from("89504e470d0a1a0a", "hex");
      const hash = crypto.createHash("sha256").update(body).digest("hex");
      const started = await begin(root, "../screenshot.png", body.length, hash);
      await chunk(root, started.transferId, 0, body.subarray(0, 5).toString("base64"));
      const progress = await status(root, started.transferId);
      if (!("offset" in progress)) throw new Error("expected receiving attachment status");
      expect(progress.offset).toBe(5);
      await chunk(root, started.transferId, 5, body.subarray(5).toString("base64"));
      const result = await finish(root, started.transferId);
      expect(result.path).toContain(`.strideterm/attachments/${started.transferId}/`);
      expect(await readFile(path.join(root, result.path))).toEqual(body);
      const listed = await list(root);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual({ ...result, uploadedAt: expect.any(Number) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("acknowledges an identical offset replay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-attachments-"));
    try {
      const body = Buffer.from("abc");
      const hash = crypto.createHash("sha256").update(body).digest("hex");
      const started = await begin(root, "x.txt", body.length, hash);
      await chunk(root, started.transferId, 0, body.toString("base64"));
      await expect(chunk(root, started.transferId, 0, body.toString("base64"))).resolves.toEqual({
        offset: body.length,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds state to owner and makes begin idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-attachments-"));
    try {
      const body = Buffer.from("same");
      const hash = crypto.createHash("sha256").update(body).digest("hex");
      const first = await begin(root, "same.txt", body.length, hash, "phone-a", "request-1");
      const again = await begin(root, "same.txt", body.length, hash, "phone-a", "request-1");
      expect(again.transferId).toBe(first.transferId);
      await expect(status(root, first.transferId, "phone-b")).rejects.toThrow(/owner/);
      await chunk(root, first.transferId, 0, body.toString("base64"), "phone-a");
      await expect(begin(root, "other.txt", body.length, hash, "phone-a", "request-1")).rejects.toThrow(/metadata/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("supports zero-byte files and rejects symlinked storage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-attachments-"));
    try {
      const hash = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
      const started = await begin(root, "empty.txt", 0, hash, "owner");
      const result = await finish(root, started.transferId, "owner");
      expect(result.size).toBe(0);
      expect(await finish(root, started.transferId, "owner")).toEqual(result);
      await remove(root, started.transferId, "empty.txt", "owner");
      await rm(path.join(root, ".strideterm"), { recursive: true, force: true });
      await symlink(
        await mkdtemp(path.join(os.tmpdir(), "strideterm-outside-")),
        path.join(root, ".strideterm"),
        "junction",
      );
      await expect(begin(root, "escape.txt", 0, hash)).rejects.toThrow(/symlink|Git/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores and later cleans an interrupted transfer directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-attachments-"));
    const id = crypto.randomUUID();
    try {
      const orphan = path.join(root, ".strideterm/.attachment-transfers", id);
      await mkdir(orphan, { recursive: true });
      expect(await list(root)).toEqual([]);
      expect((await cleanup(root, 0)).removed).toBe(1);
      expect(await stat(orphan).catch(() => null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers completion after payload rename before done state is persisted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-attachments-"));
    try {
      const body = Buffer.from("rename then crash");
      const hash = crypto.createHash("sha256").update(body).digest("hex");
      const started = await begin(root, "recovered.txt", body.length, hash, "owner");
      await chunk(root, started.transferId, 0, body.toString("base64"), "owner");
      const payload = path.join(root, ".strideterm/.attachment-transfers", started.transferId, "payload.part");
      const destination = path.join(root, ".strideterm/attachments", started.transferId, "recovered.txt");
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(payload, destination);
      const recovered = await status(root, started.transferId, "owner");
      expect("path" in recovered && recovered.sha256).toBe(hash);
      expect(await list(root)).toEqual([
        expect.objectContaining({ transferId: started.transferId, name: "recovered.txt", sha256: hash }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses persisted completion time for list timestamps and omits invalid legacy values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-attachments-"));
    try {
      const hash = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
      const started = await begin(root, "timestamped.txt", 0, hash);
      const result = await finish(root, started.transferId);
      const statePath = path.join(root, ".strideterm", ".attachment-transfers", started.transferId, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.updatedAt = 1_700_000_000_123;
      await writeFile(statePath, JSON.stringify(state));
      expect(await list(root)).toEqual([{ ...result, uploadedAt: 1_700_000_000_123 }]);
      state.updatedAt = "invalid";
      await writeFile(statePath, JSON.stringify(state));
      expect(await list(root)).toEqual([result]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans expired incomplete transfers but keeps completed files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-attachments-"));
    try {
      const hash = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
      const pending = await begin(root, "pending.txt", 1, hash);
      const done = await begin(root, "done.txt", 0, hash);
      await finish(root, done.transferId);
      const statePath = path.join(root, ".strideterm", ".attachment-transfers", pending.transferId, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.updatedAt = 0;
      await writeFile(statePath, JSON.stringify(state));
      expect((await cleanup(root, 1)).removed).toBe(1);
      await expect(stat(path.join(root, ".strideterm", ".attachment-transfers", pending.transferId))).rejects.toThrow();
      expect(await list(root)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes Git excludes for nested workspaces and serializes keyed begin", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "strideterm-git-"));
    try {
      await run("git", ["-C", repo, "init", "-q"]);
      const root = path.join(repo, "folder[glob]");
      await mkdir(root, { recursive: true });
      const hash = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
      const [a, b] = await Promise.all([
        begin(root, "a.txt", 0, hash, "phone", "same-key"),
        begin(root, "a.txt", 0, hash, "phone", "same-key"),
      ]);
      expect(a.transferId).toBe(b.transferId);
      const exclude = (await run("git", ["-C", repo, "rev-parse", "--git-path", "info/exclude"])).stdout.trim();
      const excludes = await readFile(path.resolve(repo, exclude), "utf8");
      expect(excludes).toContain("/folder\\[glob\\]/.strideterm/attachments/");
      expect(
        await run("git", [
          "-C",
          repo,
          "check-ignore",
          "--no-index",
          "--",
          "folder[glob]/.strideterm/attachments/.probe",
        ]),
      ).toBeTruthy();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("rejects payload tampering and pre-tracked storage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-attachments-"));
    try {
      const body = Buffer.from("abc");
      const hash = crypto.createHash("sha256").update(body).digest("hex");
      const started = await begin(root, "tampered.txt", body.length, hash);
      await chunk(root, started.transferId, 0, body.toString("base64"));
      await writeFile(
        path.join(root, ".strideterm", ".attachment-transfers", started.transferId, "payload.part"),
        "bad",
      );
      await expect(finish(root, started.transferId)).rejects.toThrow(/integrity/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const repo = await mkdtemp(path.join(os.tmpdir(), "strideterm-tracked-"));
    try {
      await run("git", ["-C", repo, "init", "-q"]);
      await mkdir(path.join(repo, ".strideterm", "attachments"), { recursive: true });
      await writeFile(path.join(repo, ".strideterm", "attachments", "tracked.txt"), "tracked");
      await run("git", ["-C", repo, "add", ".strideterm/attachments/tracked.txt"]);
      await expect(
        begin(repo, "new.txt", 0, crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex")),
      ).rejects.toThrow(/tracked/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("uses the linked worktree exclude file", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "strideterm-worktree-"));
    const linked = `${repo}-linked`;
    try {
      await run("git", ["-C", repo, "init", "-q"]);
      await writeFile(path.join(repo, "README.md"), "root");
      await run("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=test", "add", "README.md"]);
      await run("git", [
        "-C",
        repo,
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=test",
        "commit",
        "-qm",
        "init",
      ]);
      await run("git", ["-C", repo, "worktree", "add", "-q", linked]);
      const hash = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
      await begin(linked, "linked.txt", 0, hash);
      const commonExclude = (await run("git", ["-C", linked, "rev-parse", "--git-path", "info/exclude"])).stdout.trim();
      expect(await readFile(path.resolve(linked, commonExclude), "utf8")).toContain(".strideterm/attachments/");
    } finally {
      await rm(linked, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
