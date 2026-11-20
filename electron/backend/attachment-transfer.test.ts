import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { begin, cancel, chunk, finish, read } from "./attachment-transfer.js";
import { list } from "./attachments.js";
import {
  ATTACHMENT_READ_MAX_BYTES,
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  attachmentReadSchema,
  attachmentTransferSchema,
  attachmentUploadBeginSchema,
  attachmentUploadChunkSchema,
} from "../shared/attachment-upload.js";

const WS = "ws";
const sha = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const temp = () => mkdtemp(path.join(os.tmpdir(), "strideterm-transfer-"));
const png = (size: number) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), crypto.randomBytes(size - 8)]);

async function send(root: string, owner: string, transferId: string, data: Buffer, from = 0) {
  for (let offset = from; offset < data.length; offset += ATTACHMENT_UPLOAD_CHUNK_BYTES) {
    await chunk(
      root,
      {
        workspaceId: WS,
        transferId,
        offset,
        data: data.subarray(offset, offset + ATTACHMENT_UPLOAD_CHUNK_BYTES).toString("base64"),
      },
      owner,
    );
  }
}

async function upload(root: string, owner: string, name: string, data: Buffer) {
  const started = await begin(root, { workspaceId: WS, name, size: data.length }, owner);
  await send(root, owner, started.transferId, data);
  return { started, record: await finish(root, { workspaceId: WS, transferId: started.transferId }, owner) };
}

describe("attachment transfer", () => {
  test("uploads a multi-chunk file, stores the server-computed hash and reads it back in windows", async () => {
    const root = await temp();
    try {
      const data = png(ATTACHMENT_UPLOAD_CHUNK_BYTES * 2 + 1234);
      const { started, record } = await upload(root, "window-a", "photo.png", data);
      expect(started.chunkBytes).toBe(ATTACHMENT_UPLOAD_CHUNK_BYTES);
      expect(started.received).toBe(0);
      expect(record).toEqual(
        expect.objectContaining({
          transferId: started.transferId,
          name: "photo.png",
          size: data.length,
          sha256: sha(data),
          uploadedAt: expect.any(Number),
        }),
      );
      expect(await readFile(path.join(root, record.path))).toEqual(data);
      expect(await list(root)).toEqual([record]);

      const parts: Buffer[] = [];
      for (let offset = 0; ;) {
        const window = await read(root, {
          workspaceId: WS,
          transferId: started.transferId,
          name: "photo.png",
          offset,
          length: ATTACHMENT_READ_MAX_BYTES,
        });
        expect(window.size).toBe(data.length);
        const bytes = Buffer.from(window.data, "base64");
        parts.push(bytes);
        offset += bytes.length;
        expect(window.eof).toBe(offset >= data.length);
        if (window.eof) break;
      }
      expect(Buffer.concat(parts)).toEqual(data);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resumes with the same idempotency key and reports what was received", async () => {
    const root = await temp();
    try {
      const data = png(ATTACHMENT_UPLOAD_CHUNK_BYTES + 10);
      const request = { workspaceId: WS, name: "resume.png", size: data.length, idempotencyKey: "key-1" };
      const first = await begin(root, request, "window-a");
      await send(root, "window-a", first.transferId, data.subarray(0, ATTACHMENT_UPLOAD_CHUNK_BYTES));
      const again = await begin(root, request, "window-a");
      expect(again.transferId).toBe(first.transferId);
      expect(again.received).toBe(ATTACHMENT_UPLOAD_CHUNK_BYTES);
      await send(root, "window-a", first.transferId, data, again.received);
      expect((await finish(root, { workspaceId: WS, transferId: first.transferId }, "window-a")).sha256).toBe(
        sha(data),
      );
      await expect(begin(root, request, "window-b")).rejects.toThrow(/metadata/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses out-of-order, overlapping and oversized chunks", async () => {
    const root = await temp();
    try {
      const data = png(ATTACHMENT_UPLOAD_CHUNK_BYTES * 3);
      const { transferId } = await begin(root, { workspaceId: WS, name: "order.png", size: data.length }, "w");
      const block = (offset: number, bytes = data.subarray(offset, offset + ATTACHMENT_UPLOAD_CHUNK_BYTES)) => ({
        workspaceId: WS,
        transferId,
        offset,
        data: bytes.toString("base64"),
      });
      await expect(chunk(root, block(ATTACHMENT_UPLOAD_CHUNK_BYTES), "w")).rejects.toThrow(/offset/);
      await chunk(root, block(0), "w");
      await expect(chunk(root, block(ATTACHMENT_UPLOAD_CHUNK_BYTES / 2), "w")).rejects.toThrow(/retry/);
      await expect(
        chunk(root, block(ATTACHMENT_UPLOAD_CHUNK_BYTES, data.subarray(0, ATTACHMENT_UPLOAD_CHUNK_BYTES + 1)), "w"),
      ).rejects.toThrow(/offset or size/);
      await expect(chunk(root, block(0, Buffer.from("different")), "w")).rejects.toThrow(/retry/);
      await expect(chunk(root, block(0), "w")).resolves.toEqual({ received: ATTACHMENT_UPLOAD_CHUNK_BYTES });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses finish before every byte arrived", async () => {
    const root = await temp();
    try {
      const data = png(ATTACHMENT_UPLOAD_CHUNK_BYTES + 5);
      const { transferId } = await begin(root, { workspaceId: WS, name: "early.png", size: data.length }, "w");
      await send(root, "w", transferId, data.subarray(0, ATTACHMENT_UPLOAD_CHUNK_BYTES));
      await expect(finish(root, { workspaceId: WS, transferId }, "w")).rejects.toThrow(/incomplete/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("only the owner may continue, finish or cancel a transfer, and a caller without identity may not begin", async () => {
    const root = await temp();
    try {
      const data = png(100);
      const { transferId } = await begin(root, { workspaceId: WS, name: "mine.png", size: data.length }, "window-a");
      const block = { workspaceId: WS, transferId, offset: 0, data: data.toString("base64") };
      await expect(chunk(root, block, "window-b")).rejects.toThrow(/owner/);
      await chunk(root, block, "window-a");
      await expect(finish(root, { workspaceId: WS, transferId }, "window-b")).rejects.toThrow(/owner/);
      await expect(cancel(root, { workspaceId: WS, transferId }, "window-b")).rejects.toThrow(/owner/);
      await expect(begin(root, { workspaceId: WS, name: "x.png", size: 1 }, "")).rejects.toThrow(/identity/);
      await expect(finish(root, { workspaceId: WS, transferId }, "")).rejects.toThrow(/identity/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cancel removes the partial data", async () => {
    const root = await temp();
    try {
      const data = png(ATTACHMENT_UPLOAD_CHUNK_BYTES * 2);
      const { transferId } = await begin(root, { workspaceId: WS, name: "gone.png", size: data.length }, "w");
      await send(root, "w", transferId, data.subarray(0, ATTACHMENT_UPLOAD_CHUNK_BYTES));
      const dir = path.join(root, ".strideterm/.attachment-transfers", transferId);
      expect((await stat(dir)).isDirectory()).toBe(true);
      await expect(cancel(root, { workspaceId: WS, transferId }, "w")).resolves.toEqual({ ok: true });
      await expect(stat(dir)).rejects.toThrow();
      await expect(list(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads windows with eof and refuses unfinished, unknown and mismatched attachments", async () => {
    const root = await temp();
    try {
      const text = Buffer.from("x".repeat(1000));
      const { record } = await upload(root, "w", "notes.txt", text);
      const ask = (offset: number, length: number, name = "notes.txt", transferId = record.transferId) =>
        read(root, { workspaceId: WS, transferId, name, offset, length });
      const head = await ask(0, 400);
      expect(Buffer.from(head.data, "base64")).toEqual(text.subarray(0, 400));
      expect(head).toMatchObject({ size: 1000, eof: false });
      const exact = await ask(600, 400);
      expect(exact).toMatchObject({ size: 1000, eof: true });
      expect(Buffer.from(exact.data, "base64")).toEqual(text.subarray(600));
      expect(await ask(2000, 10)).toEqual({ data: "", size: 1000, eof: true });
      await expect(ask(0, 10, "other.txt")).rejects.toThrow(/not found/);
      await expect(ask(0, 10, "notes.txt", crypto.randomUUID())).rejects.toThrow(/not found/);
      await expect(ask(0, 0)).rejects.toThrow(/range/);
      await expect(ask(0, ATTACHMENT_READ_MAX_BYTES + 1)).rejects.toThrow(/range/);

      const pending = await begin(root, { workspaceId: WS, name: "pending.txt", size: 5 }, "w");
      await send(root, "w", pending.transferId, Buffer.from("hello"));
      await expect(ask(0, 5, "pending.txt", pending.transferId)).rejects.toThrow(/not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a link planted inside the attachment folder cannot be read through", async () => {
    const root = await temp();
    const outside = await temp();
    try {
      const { record } = await upload(root, "w", "inside.txt", Buffer.from("inside"));
      await writeFile(path.join(outside, "inside.txt"), "secret outside");
      const folder = path.join(root, ".strideterm/attachments", record.transferId);
      await rm(folder, { recursive: true });
      await symlink(outside, folder, "junction");
      await expect(
        read(root, { workspaceId: WS, transferId: record.transferId, name: "inside.txt", offset: 0, length: 100 }),
      ).rejects.toThrow(/symlink|escapes/);

      await rm(folder, { recursive: true, force: true });
      await mkdir(folder, { recursive: true });
      const linked = await symlink(path.join(outside, "inside.txt"), path.join(folder, "inside.txt")).then(
        () => true,
        () => false,
      );
      if (linked)
        await expect(
          read(root, { workspaceId: WS, transferId: record.transferId, name: "inside.txt", offset: 0, length: 100 }),
        ).rejects.toThrow(/symlink|escapes/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("accepts any file type and content, byte for byte", async () => {
    const root = await temp();
    try {
      const zipLike = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), crypto.randomBytes(64)]);
      const cases: [string, Buffer][] = [
        ["run.exe", Buffer.from([0x4d, 0x5a, 0, 1])],
        ["setup.sh", Buffer.from("#!/bin/sh\necho hi\n")],
        ["tool.py", Buffer.from("print(1)")],
        ["report.docx", crypto.randomBytes(100)],
        ["backup.tar.gz", crypto.randomBytes(100)],
        ["noextension", Buffer.from("data")],
        ["fake.png", Buffer.from("not a png")],
        ["binary.txt", Buffer.from([0x61, 0, 0x62])],
        ["encrypted.zip", zipLike],
        ["escape.zip", Buffer.from("PK../../x", "latin1")],
      ];
      for (const [name, data] of cases) {
        const { record } = await upload(root, "w", name, data);
        expect(record.name).toBe(name);
        expect(record.sha256).toBe(sha(data));
        expect(await readFile(path.join(root, record.path))).toEqual(data);
        if (process.platform !== "win32") expect((await stat(path.join(root, record.path))).mode & 0o111).toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("still refuses an unsafe name", async () => {
    const root = await temp();
    try {
      for (const name of ["con", "NUL.txt", "com1.log", "lpt9", "clock$", "..", ".", "...", " ", "a/..", "dir/.."])
        await expect(begin(root, { workspaceId: WS, name, size: 1 }, "w"), name).rejects.toThrow(
          /Invalid attachment name/,
        );
      const stored = async (name: string) => {
        const { record } = await upload(root, "w", name, Buffer.from("x"));
        return record.name;
      };
      expect(await stored("../../etc/passwd")).toBe("passwd");
      expect(await stored("a\\b\\evil.sh")).toMatch(/^(a_b_)?evil\.sh$/);
      expect(await stored("trailing. . ")).toBe("trailing");
      expect(await stored("we<ir>d:na\u0001me?.bin")).toBe("we_ir_d_na_me_.bin");
      expect((await stored("a".repeat(250) + ".bin")).length).toBeLessThanOrEqual(180);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a file above the phone limit without inspecting it", async () => {
    const root = await temp();
    try {
      const size = 26 * 1024 * 1024;
      const data = Buffer.alloc(size, 0x61);
      data[size - 3] = 0;
      const { record } = await upload(root, "w", "binary.txt", data);
      expect(record.size).toBe(size);
      expect(record.sha256).toBe(sha(data));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("attachment transfer schemas", () => {
  const id = crypto.randomUUID();
  test("are strict and bounded", () => {
    expect(attachmentUploadBeginSchema.safeParse({ workspaceId: "w", name: "a.png", size: 1 }).success).toBe(true);
    for (const bad of [
      { workspaceId: "w", name: "a.png", size: 0 },
      { workspaceId: "w", name: "a.png", size: 1024 ** 3 + 1 },
      { workspaceId: "w", name: "a".repeat(256), size: 1 },
      { workspaceId: "w", name: "a.png", size: 1, extra: true },
      { workspaceId: "", name: "a.png", size: 1 },
    ])
      expect(attachmentUploadBeginSchema.safeParse(bad).success).toBe(false);
    const chunkBase = { workspaceId: "w", transferId: id, offset: 0, data: "AAAA" };
    expect(attachmentUploadChunkSchema.safeParse(chunkBase).success).toBe(true);
    expect(attachmentUploadChunkSchema.safeParse({ ...chunkBase, offset: -1 }).success).toBe(false);
    expect(attachmentUploadChunkSchema.safeParse({ ...chunkBase, data: "not base64!" }).success).toBe(false);
    expect(attachmentUploadChunkSchema.safeParse({ ...chunkBase, data: "A".repeat(699_053) }).success).toBe(false);
    expect(attachmentUploadChunkSchema.safeParse({ ...chunkBase, transferId: "nope" }).success).toBe(false);
    expect(attachmentTransferSchema.safeParse({ workspaceId: "w", transferId: id }).success).toBe(true);
    const readBase = { workspaceId: "w", transferId: id, name: "a.png", offset: 0, length: 1 };
    expect(attachmentReadSchema.safeParse(readBase).success).toBe(true);
    expect(attachmentReadSchema.safeParse({ ...readBase, length: 0 }).success).toBe(false);
    expect(attachmentReadSchema.safeParse({ ...readBase, length: ATTACHMENT_READ_MAX_BYTES + 1 }).success).toBe(false);
    expect(attachmentReadSchema.safeParse({ ...readBase, offset: 1.5 }).success).toBe(false);
  });
});
