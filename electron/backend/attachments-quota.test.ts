import { describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  DESKTOP_LIMITS,
  PEER_COPY_OWNER_PREFIX,
  TRANSFER_ACTIVE_MS,
  begin,
  chunk,
  cancel,
  finish,
  listWithUsage,
  remove,
  usage,
} from "./attachments.js";

const hash = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const temp = () => mkdtemp(path.join(os.tmpdir(), "strideterm-quota-"));

describe("attachment quotas", () => {
  test("serializes different idempotency keys at the active limit", async () => {
    const root = await temp();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          begin(root, `file-${i}.txt`, 1, hash(Buffer.from("x")), `owner-${i}`, `key-${i}`),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("counts identical chunk retries in received ledger but stores once", async () => {
    const root = await temp();
    try {
      const body = Buffer.from("retry");
      const started = await begin(root, "retry.txt", body.length, hash(body));
      await chunk(root, started.transferId, 0, body.toString("base64"));
      await chunk(root, started.transferId, 0, body.toString("base64"));
      const usage = (await listWithUsage(root)).usage;
      expect(usage.received).toBe(body.length * 2);
      expect(usage.storageBytes).toBe(body.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cancel and delete release active/storage but preserve received bytes", async () => {
    const root = await temp();
    try {
      const body = Buffer.from("stored");
      const pending = await begin(root, "pending.txt", body.length, hash(body));
      await chunk(root, pending.transferId, 0, body.toString("base64"));
      const before = (await listWithUsage(root)).usage.received;
      await cancel(root, pending.transferId);
      expect((await listWithUsage(root)).usage.activeTransfers).toBe(0);
      const done = await begin(root, "done.txt", body.length, hash(body));
      await chunk(root, done.transferId, 0, body.toString("base64"));
      await finish(root, done.transferId);
      expect((await listWithUsage(root)).usage.storageBytes).toBe(body.length);
      await remove(root, done.transferId, "done.txt");
      const after = (await listWithUsage(root)).usage;
      expect(after.storageBytes).toBe(0);
      expect(after.received).toBe(before + body.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for a malformed persisted ledger", async () => {
    const root = await temp();
    try {
      await mkdir(path.join(root, ".strideterm"), { recursive: true });
      await writeFile(
        path.join(root, ".strideterm/.attachment-usage.json"),
        JSON.stringify({ day: "today", received: -1 }),
      );
      await expect(usage(root)).rejects.toThrow(/ledger is invalid/);
      const started = await begin(root, "x.txt", 1, hash(Buffer.from("x")));
      await expect(chunk(root, started.transferId, 0, Buffer.from("x").toString("base64"))).rejects.toThrow(
        /ledger is invalid/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects the daily cap and preserves the ledger across calls", async () => {
    const root = await temp();
    try {
      const ledger = path.join(root, ".strideterm/.attachment-usage.json");
      await mkdir(path.dirname(ledger), { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      await writeFile(ledger, JSON.stringify({ day: today, received: 128 * 1024 * 1024 - 1 }));
      const started = await begin(root, "daily.txt", 2, hash(Buffer.from("ab")));
      await expect(chunk(root, started.transferId, 0, Buffer.from("ab").toString("base64"))).rejects.toThrow(
        /daily receive quota/,
      );
      expect((await usage(root)).received).toBe(128 * 1024 * 1024 - 1);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      await writeFile(ledger, JSON.stringify({ day: yesterday, received: 128 * 1024 * 1024 }));
      const rollover = await begin(root, "rollover.txt", 2, hash(Buffer.from("cd")));
      await expect(chunk(root, rollover.transferId, 0, Buffer.from("cd").toString("base64"))).resolves.toEqual({
        offset: 2,
      });
      expect((await usage(root)).received).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes a rejected transfer while retaining received accounting", async () => {
    const root = await temp();
    try {
      const body = Buffer.from("not a png");
      const started = await begin(root, "bad.png", body.length, hash(body));
      await chunk(root, started.transferId, 0, body.toString("base64"));
      const received = (await usage(root)).received;
      await expect(finish(root, started.transferId)).rejects.toThrow();
      const snapshot = (await listWithUsage(root)).usage;
      expect(snapshot.activeTransfers).toBe(0);
      expect(snapshot.storageBytes).toBe(0);
      expect(snapshot.received).toBe(received);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("attachment limits by uploader", () => {
  const GIB = 1024 * 1024 * 1024;
  const fabricateDone = async (root: string, count: number) => {
    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID();
      const dir = path.join(root, ".strideterm/.attachment-transfers", id);
      await mkdir(dir, { recursive: true });
      const done = { transferId: id, path: `.strideterm/attachments/${id}/f.txt`, size: 1, sha256: "", name: "f.txt" };
      await writeFile(
        path.join(dir, "state.json"),
        JSON.stringify({ id, name: "f.txt", size: 1, sha256: "", offset: 1, createdAt: 1, updatedAt: 1, done }),
      );
    }
  };

  test("the phone is still refused above 25 MiB and by the daily ledger, naming the limit", async () => {
    const root = await temp();
    try {
      await expect(begin(root, "big.zip", 25 * 1024 * 1024 + 1, hash(Buffer.from("x")))).rejects.toThrow(
        "Attachment exceeds the 25 MiB limit",
      );
      const ledger = path.join(root, ".strideterm/.attachment-usage.json");
      await mkdir(path.dirname(ledger), { recursive: true });
      await writeFile(
        ledger,
        JSON.stringify({ day: new Date().toISOString().slice(0, 10), received: 128 * 1024 * 1024 - 1 }),
      );
      const started = await begin(root, "daily.txt", 2, hash(Buffer.from("ab")));
      await expect(chunk(root, started.transferId, 0, Buffer.from("ab").toString("base64"))).rejects.toThrow(
        /daily receive quota exceeded \(limit 128 MiB/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a desktop upload takes more than 25 MiB, is refused above 1 GiB, and ignores the daily ledger", async () => {
    const root = await temp();
    try {
      const ledger = path.join(root, ".strideterm/.attachment-usage.json");
      await mkdir(path.dirname(ledger), { recursive: true });
      const full = JSON.stringify({ day: new Date().toISOString().slice(0, 10), received: 128 * 1024 * 1024 });
      await writeFile(ledger, full);
      const big = await begin(root, "big.zip", GIB, "", "w", undefined, DESKTOP_LIMITS);
      expect(big.offset).toBe(0);
      await expect(begin(root, "huge.zip", GIB + 1, "", "w", undefined, DESKTOP_LIMITS)).rejects.toThrow(
        "Attachment exceeds the 1 GiB limit",
      );
      await expect(begin(root, "x.zip", 1, hash(Buffer.from("x")), "w", undefined, DESKTOP_LIMITS)).rejects.toThrow(
        /Invalid SHA-256/,
      );
      const small = await begin(root, "ok.txt", 2, "", "w", undefined, DESKTOP_LIMITS);
      await chunk(root, small.transferId, 0, Buffer.from("ab").toString("base64"), "w");
      expect(await readFile(ledger, "utf8")).toBe(full);
      const desktop = (await listWithUsage(root, DESKTOP_LIMITS)).usage;
      expect(desktop).toMatchObject({ dailyLimit: null, fileSizeLimit: GIB, storageLimit: 4 * GIB, fileLimit: 100 });
      const phone = (await listWithUsage(root)).usage;
      expect(phone).toMatchObject({ dailyLimit: 128 * 1024 * 1024, storageLimit: 4 * GIB, fileLimit: 100 });
      expect(phone).not.toHaveProperty("fileSizeLimit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the storage cap is shared by both uploaders", async () => {
    const root = await temp();
    try {
      for (let i = 0; i < 4; i++) await begin(root, `part-${i}.zip`, GIB, "", `w${i}`, undefined, DESKTOP_LIMITS);
      await expect(begin(root, "more.zip", 1, "", "w", undefined, DESKTOP_LIMITS)).rejects.toThrow(
        "Attachment quota exceeded: a workspace holds at most 4 GiB of attachments",
      );
      await expect(begin(root, "phone.txt", 1, hash(Buffer.from("x")))).rejects.toThrow(
        "Attachment quota exceeded: a workspace holds at most 4 GiB of attachments",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the file count cap is shared by both uploaders", async () => {
    const root = await temp();
    try {
      await fabricateDone(root, 100);
      const message = "Attachment quota exceeded: a workspace holds at most 100 attachments";
      await expect(begin(root, "x.txt", 1, hash(Buffer.from("x")))).rejects.toThrow(message);
      await expect(begin(root, "x.txt", 1, "", "w", undefined, DESKTOP_LIMITS)).rejects.toThrow(message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an idle partial stops counting as active for every owner, so abandoned uploads cannot lock a workspace", async () => {
    const fill = async (owner: (index: number) => string) => {
      const root = await temp();
      for (let i = 0; i < 4; i++) await begin(root, `a${i}.txt`, 1, "", owner(i), `k${i}`, DESKTOP_LIMITS);
      await expect(begin(root, "b.txt", 1, "", "w", undefined, DESKTOP_LIMITS)).rejects.toThrow(/Too many concurrent/);
      return root;
    };
    const peer = await fill((i) => `${PEER_COPY_OWNER_PREFIX}${i}`);
    const window = await fill((i) => `window-${i}`);
    // Four phone uploads the user abandoned (cancelled, closed the sheet, lost the relay) without the desktop hearing.
    const phone = await temp();
    for (let i = 0; i < 4; i++) await begin(phone, `p${i}.txt`, 2, hash(Buffer.from("xy")), "pair:device:p:w", `p${i}`);
    await expect(begin(phone, "next.txt", 1, hash(Buffer.from("x")), "pair:device:p:w", "next")).rejects.toThrow(
      /Too many concurrent/,
    );
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + TRANSFER_ACTIVE_MS + 1000);
    try {
      await expect(begin(peer, "b.txt", 1, "", "w", undefined, DESKTOP_LIMITS)).resolves.toMatchObject({ offset: 0 });
      await expect(begin(window, "b.txt", 1, "", "w", undefined, DESKTOP_LIMITS)).resolves.toMatchObject({
        offset: 0,
      });
      await expect(
        begin(phone, "next.txt", 1, hash(Buffer.from("x")), "pair:device:p:w", "next"),
      ).resolves.toMatchObject({ offset: 0 });
      // An idle partial is not gone: its idempotency key still resumes it.
      const resumed = await begin(phone, "p0.txt", 2, hash(Buffer.from("xy")), "pair:device:p:w", "p0");
      await expect(
        chunk(phone, resumed.transferId, 0, Buffer.from("xy").toString("base64"), "pair:device:p:w"),
      ).resolves.toEqual({
        offset: 2,
      });
    } finally {
      spy.mockRestore();
      await rm(peer, { recursive: true, force: true });
      await rm(window, { recursive: true, force: true });
      await rm(phone, { recursive: true, force: true });
    }
  });

  test("a transfer that keeps receiving chunks keeps counting as active", async () => {
    const root = await temp();
    const started = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(started);
    try {
      const data = Buffer.from("abcd");
      const ids: string[] = [];
      for (let i = 0; i < 4; i++)
        ids.push((await begin(root, `a${i}.txt`, 4, hash(data), "pair:device:p:w", `k${i}`)).transferId);
      // Each transfer moves just inside the window, again and again: none of them is idle.
      for (let step = 1; step <= 3; step++) {
        spy.mockReturnValue(started + step * (TRANSFER_ACTIVE_MS - 1000));
        for (const id of ids)
          await chunk(root, id, step - 1, data.subarray(step - 1, step).toString("base64"), "pair:device:p:w");
      }
      await expect(begin(root, "b.txt", 1, hash(Buffer.from("x")), "pair:device:p:w", "b")).rejects.toThrow(
        /Too many concurrent/,
      );
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the concurrent transfer cap names its limit for both uploaders", async () => {
    const root = await temp();
    try {
      for (let i = 0; i < 4; i++) await begin(root, `a${i}.txt`, 1, "", `w${i}`, undefined, DESKTOP_LIMITS);
      await expect(begin(root, "b.txt", 1, "", "w", undefined, DESKTOP_LIMITS)).rejects.toThrow(
        "Too many concurrent attachment transfers (limit 4)",
      );
      await expect(begin(root, "c.txt", 1, hash(Buffer.from("x")))).rejects.toThrow(/limit 4/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
