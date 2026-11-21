import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  PEER_ATTACHMENT_COPY_FINISHED_CHANNEL,
  PEER_ATTACHMENT_COPY_PROGRESS_CHANNEL,
  type PeerAttachmentCopyFinished,
  type PeerAttachmentCopyProgress,
} from "../../shared/peer-attachment-copy-events.js";
import type { AppState } from "../../shared/types/state.js";
import * as attachments from "../attachments.js";
import { createPeerAttachmentCopies } from "./peer-attachment-copy.js";
import { PeerClientError, type PeerRequest, type PeerResponse } from "./peer-client.js";

const BLOCK = 512 * 1024;
const BYTES = randomBytes(BLOCK * 2 + 300_000);
const SHA = createHash("sha256").update(BYTES).digest("hex");

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-copy-engine-"));
  roots.push(root);
  return root;
}

function source(name = "photo.png") {
  return { workspaceId: "host-ws", transferId: randomUUID(), name, size: BYTES.length, sha256: SHA };
}

async function setup(options: { hosts?: string[]; clock?: () => number } = {}) {
  const hosts = options.hosts ?? ["h1"];
  const root = await tempRoot();
  const state = {
    workspaces: [{ id: "ws-1", profileId: "default", cwd: root, panels: [] }],
  } as unknown as AppState;
  const events: Array<{ channel: string; payload: unknown }> = [];
  const reads: Array<{ hostId: string; offset: number }> = [];
  let changed = 0;
  const hooks = {
    onRead: async (_hostId: string, _offset: number): Promise<void> => undefined,
  };
  const copies = createPeerAttachmentCopies({
    getState: () => state,
    hostInfo: (hostId) => (hosts.includes(hostId) ? { label: `Host ${hostId}`, state: "online" } : null),
    requireHostOnline: async () => undefined,
    request: async (hostId: string, request: PeerRequest): Promise<PeerResponse> => {
      const body = JSON.parse(request.body ?? "{}") as { offset: number; length: number };
      reads.push({ hostId, offset: body.offset });
      await hooks.onRead(hostId, body.offset);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: BYTES.subarray(body.offset, body.offset + body.length).toString("base64"),
          size: BYTES.length,
        }),
      };
    },
    emit: (channel, payload) => events.push({ channel, payload }),
    changed: () => {
      changed += 1;
    },
    ...(options.clock ? { now: options.clock } : {}),
  });
  const finished = () =>
    events
      .filter((entry) => entry.channel === PEER_ATTACHMENT_COPY_FINISHED_CHANNEL)
      .map((entry) => entry.payload as PeerAttachmentCopyFinished);
  const progress = () =>
    events
      .filter((entry) => entry.channel === PEER_ATTACHMENT_COPY_PROGRESS_CHANNEL)
      .map((entry) => entry.payload as PeerAttachmentCopyProgress);
  const request = (hostId: string, from = source()) => ({ hostId, source: from, targetWorkspaceId: "ws-1" });
  return { copies, root, events, reads, hooks, finished, progress, request, changedCount: () => changed };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const caller = { profileId: "default" };

describe("peer attachment copy engine", () => {
  test("at most two copies run per target workspace across hosts; the others wait instead of failing", async () => {
    const { copies, hooks, request, finished } = await setup({ hosts: ["h1", "h2", "h3"] });
    const blocked = gate();
    hooks.onRead = () => blocked.promise;
    for (const hostId of ["h1", "h2", "h3"]) await copies.start(request(hostId), caller);
    expect(
      copies
        .getPayload()
        .running.map((run) => run.state)
        .sort(),
    ).toEqual(["queued", "running", "running"]);
    blocked.release();
    await copies.idle();
    expect(finished().map((event) => event.state)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  test("two overlapping starts of the same copy share one copyId and one run", async () => {
    const { copies, request } = await setup();
    const same = request("h1");
    const [first, second] = await Promise.all([copies.start(same, caller), copies.start(same, caller)]);
    expect(second.copyId).toBe(first.copyId);
    expect(copies.getPayload().running).toHaveLength(1);
    await copies.idle();
  });

  test("a refused start releases the reservation, so the next start of that copy is accepted", async () => {
    const { copies, request, root, finished } = await setup();
    const id = randomUUID();
    const dir = path.join(root, ".strideterm", ".attachment-transfers", id);
    await mkdir(dir, { recursive: true });
    const done = {
      transferId: id,
      path: `.strideterm/attachments/${id}/x`,
      size: 4 * 1024 ** 3,
      sha256: "a".repeat(64),
      name: "x",
    };
    await writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({
        id,
        name: "x",
        size: done.size,
        sha256: done.sha256,
        offset: done.size,
        createdAt: 1,
        updatedAt: Date.now(),
        done,
      }),
    );
    const same = request("h1");
    await expect(copies.start(same, caller)).rejects.toThrow(/quota exceeded/);
    await rm(dir, { recursive: true });
    await copies.start(same, caller);
    await copies.idle();
    expect(finished()[0]).toMatchObject({ state: "succeeded" });
  });

  test("a copied file deleted from disk is not reported as copied again: a real new copy is made", async () => {
    const { copies, request, root } = await setup();
    const same = request("h1");
    await copies.start(same, caller);
    await copies.idle();
    const [first] = await attachments.list(root);
    await rm(path.join(root, first!.path));

    await copies.start(same, caller);
    await copies.idle();
    const listed = await attachments.list(root);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.transferId).not.toBe(first!.transferId);
    const block = await attachments.read(root, listed[0]!.transferId, "photo.png", 0, BLOCK);
    expect(block.bytes.equals(BYTES.subarray(0, BLOCK))).toBe(true);
  });

  test("a retry of a partial near the storage limit is accepted: only begin judges quota for a known key", async () => {
    const { copies, hooks, request, root, finished } = await setup();
    const id = randomUUID();
    const dir = path.join(root, ".strideterm", ".attachment-transfers", id);
    await mkdir(dir, { recursive: true });
    const size = 4 * 1024 ** 3 - BYTES.length;
    const done = { transferId: id, path: `.strideterm/attachments/${id}/x`, size, sha256: "a".repeat(64), name: "x" };
    await writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({
        id,
        name: "x",
        size,
        sha256: done.sha256,
        offset: size,
        createdAt: 1,
        updatedAt: Date.now(),
        done,
      }),
    );
    const same = request("h1");
    let reads = 0;
    hooks.onRead = async () => {
      reads += 1;
      if (reads === 2) throw new Error("connection dropped");
    };
    await copies.start(same, caller);
    await copies.idle();
    expect(finished()[0]).toMatchObject({ state: "failed", bytesDone: BLOCK });

    hooks.onRead = async () => undefined;
    await copies.start(same, caller);
    await copies.idle();
    expect(finished()[1]).toMatchObject({ state: "succeeded" });
  });

  test("dispose empties the queue: a waiting copy never starts, a running one ends without reporting", async () => {
    const { copies, hooks, request, reads, finished, root } = await setup();
    const blocked = gate();
    hooks.onRead = () => blocked.promise;
    for (let index = 0; index < 3; index++) await copies.start(request("h1"), caller);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    copies.dispose();
    blocked.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads).toHaveLength(2);
    expect(finished()).toEqual([]);
    expect((await attachments.listWithUsage(root, attachments.DESKTOP_LIMITS)).usage.activeTransfers).toBe(2);
  });

  test("a network failure mid-transfer fails cleanly and stays resumable from the offset", async () => {
    const { copies, hooks, request, reads, finished, root } = await setup();
    const same = request("h1");
    let calls = 0;
    const real = hooks.onRead;
    hooks.onRead = async (hostId, offset) => {
      calls += 1;
      if (calls === 2) {
        throw new PeerClientError("unreachable", "Nothing is listening at 192.168.1.20.");
      }
      await real(hostId, offset);
    };
    await copies.start(same, caller);
    await copies.idle();
    expect(finished()).toHaveLength(1);
    expect(finished()[0]).toMatchObject({
      state: "failed",
      bytesDone: BLOCK,
      error: { message: "Nothing is listening at 192.168.1.20." },
    });
    expect(await attachments.list(root)).toEqual([]);
    expect((await attachments.listWithUsage(root, attachments.DESKTOP_LIMITS)).usage).toMatchObject({
      activeTransfers: 1,
      storageBytes: BLOCK,
    });

    reads.length = 0;
    hooks.onRead = real;
    await copies.start(same, caller);
    await copies.idle();
    expect(finished()[1]).toMatchObject({ state: "succeeded" });
    expect(reads.map((read) => read.offset)).toEqual([BLOCK, BLOCK * 2]);
  });

  test("progress is its own throttled event and never a payload broadcast", async () => {
    let clock = 1_000_000;
    const { copies, request, progress, changedCount, hooks } = await setup({ clock: () => clock });
    hooks.onRead = async () => {
      clock += 400;
    };
    await copies.start(request("h1"), caller);
    await copies.idle();
    const events = progress();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.map((event) => event.bytesDone)).toEqual(
      [...events.map((event) => event.bytesDone)].sort((a, b) => a - b),
    );
    expect(events.every((event) => event.bytesTotal === BYTES.length)).toBe(true);
    // queued, started and finished: nothing in between
    expect(changedCount()).toBe(3);

    clock += 10_000;
    const fast = await setup({ clock: () => clock });
    await fast.copies.start(fast.request("h1"), caller);
    await fast.copies.idle();
    expect(fast.progress()).toHaveLength(1);
  });

  describe("discarding a failed copy", () => {
    test("removes its partial, ends it as cancelled and tells the windows", async () => {
      const { copies, hooks, request, finished, root } = await setup();
      hooks.onRead = async (_hostId, offset) => {
        if (offset > 0) throw new Error("host went away");
      };
      const { copyId } = await copies.start(request("h1"), caller);
      await copies.idle();
      expect((await attachments.listWithUsage(root, attachments.DESKTOP_LIMITS)).usage.activeTransfers).toBe(1);

      expect(() => copies.cancel(copyId, { profileId: "other" })).toThrow(/not running/);
      await copies.cancel(copyId, caller);
      expect(finished().at(-1)).toMatchObject({
        copyId,
        state: "cancelled",
        error: { message: "The copy was discarded." },
      });
      expect(copies.getPayload().lastResults[0]).toMatchObject({ copyId, state: "cancelled" });
      expect((await attachments.listWithUsage(root, attachments.DESKTOP_LIMITS)).usage).toMatchObject({
        activeTransfers: 0,
        storageBytes: 0,
      });
      expect(() => copies.cancel(copyId, caller)).toThrow(/not running/);
    });

    test("a succeeded copy cannot be discarded, and a retry in flight keeps the partial it resumes", async () => {
      const { copies, hooks, request, finished, root } = await setup();
      const done = await copies.start(request("h1"), caller);
      await copies.idle();
      expect(() => copies.cancel(done.copyId, caller)).toThrow(/not running/);

      const same = request("h1");
      let fail = true;
      hooks.onRead = async (_hostId, offset) => {
        if (fail && offset > 0) throw new Error("host went away");
      };
      const failed = await copies.start(same, caller);
      await copies.idle();
      const blocked = gate();
      fail = false;
      hooks.onRead = () => blocked.promise;
      const retry = await copies.start(same, caller);
      expect(retry.copyId).not.toBe(failed.copyId);
      await copies.cancel(failed.copyId, caller);
      blocked.release();
      await copies.idle();
      expect(finished().at(-1)).toMatchObject({ copyId: retry.copyId, state: "succeeded" });
      expect((await attachments.list(root)).length).toBe(2);
    });
  });
});
