import { describe, expect, test } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { begin, chunk, cancel, finish, listWithUsage, remove, usage } from "./attachments.js";

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
