import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  attachmentTransferSchema,
  attachmentUploadBeginSchema,
  attachmentUploadChunkSchema,
} from "../../electron/shared/attachment-upload.js";
import type { AttachmentRecord } from "../attachments.js";
import {
  attachmentsUnavailableReason,
  bytesToBase64,
  createAttachmentUploader,
  type UploadItem,
} from "./useAttachmentUpload.js";

const CHUNK = ATTACHMENT_UPLOAD_CHUNK_BYTES;

function fakeFile(size: number, name = "data.bin"): File {
  const bytes = new Uint8Array(size).map((_, index) => index % 251);
  return {
    name,
    size,
    slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
  } as unknown as File;
}

function expectedBase64(size: number, start: number, end: number): string {
  return bytesToBase64(new Uint8Array(size).map((_, index) => index % 251).slice(start, end));
}

function record(name: string): AttachmentRecord {
  return { transferId: "t-1", path: `.strideterm/attachments/t-1/${name}`, size: 1, sha256: "a".repeat(64), name };
}

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    attachmentUploadBegin: vi.fn(async (_req: { name: string }) => ({
      transferId: "11111111-1111-4111-8111-111111111111",
      chunkBytes: CHUNK,
      received: 0,
    })),
    attachmentUploadChunk: vi.fn(async (req: { offset: number; data: string }) => ({
      received:
        req.offset +
        Math.ceil((req.data.length / 4) * 3) -
        (req.data.endsWith("==") ? 2 : req.data.endsWith("=") ? 1 : 0),
    })),
    attachmentUploadFinish: vi.fn(async (_req: { transferId: string }) => record("data.bin")),
    attachmentUploadCancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

function uploader(api: ReturnType<typeof makeApi>, options: Parameters<typeof createAttachmentUploader>[1] = {}) {
  return createAttachmentUploader(api as never, { retryDelaysMs: [0, 0], ...options });
}

describe("createAttachmentUploader finishing phase", () => {
  it.each([["resolves"], ["rejects"]])(
    "flags the item as finishing while the host answers, until it %s",
    async (how) => {
      let finish!: { resolve: (_value: AttachmentRecord) => void; reject: (_reason: unknown) => void };
      const api = makeApi({
        attachmentUploadFinish: vi.fn(
          () =>
            new Promise<AttachmentRecord>((resolve, reject) => {
              finish = { resolve, reject };
            }),
        ),
      });
      const seen: boolean[] = [];
      const up = uploader(api, { onProgress: (item) => seen.push(item.finishing) });
      const done = up.upload([fakeFile(10)], "ws");
      await vi.waitFor(() => expect(up.items[0].finishing).toBe(true));
      expect(up.items[0].state).toBe("uploading");
      expect(up.items[0].sent).toBe(10);
      expect(seen.at(-1)).toBe(true);

      if (how === "resolves") finish.resolve(record("data.bin"));
      else finish.reject(new Error("checksum"));
      await done;
      expect(up.items[0].finishing).toBe(false);
      expect(up.items[0].state).toBe(how === "resolves" ? "done" : "failed");
      if (how === "rejects") expect(up.items[0].error).toBe("checksum");
    },
  );
});

describe("createAttachmentUploader", () => {
  it.each([
    ["1 byte", 1, [[0, 1]]],
    ["chunk - 1", CHUNK - 1, [[0, CHUNK - 1]]],
    ["exactly one chunk", CHUNK, [[0, CHUNK]]],
    [
      "chunk + 1",
      CHUNK + 1,
      [
        [0, CHUNK],
        [CHUNK, CHUNK + 1],
      ],
    ],
    [
      "several chunks",
      CHUNK * 2 + 7,
      [
        [0, CHUNK],
        [CHUNK, CHUNK * 2],
        [CHUNK * 2, CHUNK * 2 + 7],
      ],
    ],
  ])("sends %s as the exact sequence of windows", async (_label, size, windows) => {
    const api = makeApi();
    const up = uploader(api);
    const [item] = await up.upload([fakeFile(size)], "ws-1");

    expect(api.attachmentUploadChunk.mock.calls.map(([req]) => [req.offset, req.data])).toEqual(
      windows.map(([start, end]) => [start, expectedBase64(size, start, end)]),
    );
    expect(item.state).toBe("done");
    expect(item.sent).toBe(size);
    expect(item.record).toEqual(record("data.bin"));
    expect(api.attachmentUploadFinish).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      transferId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("builds payloads the shared schemas accept", async () => {
    const api = makeApi();
    await uploader(api).upload([fakeFile(CHUNK + 5)], "ws-1");
    expect(attachmentUploadBeginSchema.safeParse(api.attachmentUploadBegin.mock.calls[0][0]).success).toBe(true);
    for (const [req] of api.attachmentUploadChunk.mock.calls)
      expect(attachmentUploadChunkSchema.safeParse(req).success).toBe(true);
    expect(attachmentTransferSchema.safeParse(api.attachmentUploadFinish.mock.calls[0][0]).success).toBe(true);
  });

  it("resumes from the received offset the server reports", async () => {
    const api = makeApi({
      attachmentUploadBegin: vi.fn(async () => ({ transferId: "t", chunkBytes: 100, received: 150 })),
      attachmentUploadChunk: vi.fn(async (req: { offset: number }) => ({ received: Math.min(req.offset + 100, 250) })),
    });
    const [item] = await uploader(api).upload([fakeFile(250)], "ws-1");
    expect(api.attachmentUploadChunk.mock.calls.map(([req]) => req.offset)).toEqual([150]);
    expect(item.state).toBe("done");
  });

  it("continues from what the server confirms when it accepted less than was sent", async () => {
    const api = makeApi({
      attachmentUploadBegin: vi.fn(async () => ({ transferId: "t", chunkBytes: 100, received: 0 })),
      attachmentUploadChunk: vi
        .fn()
        .mockResolvedValueOnce({ received: 60 })
        .mockResolvedValueOnce({ received: 160 })
        .mockResolvedValueOnce({ received: 200 }),
    });
    await uploader(api).upload([fakeFile(200)], "ws-1");
    expect(api.attachmentUploadChunk.mock.calls.map(([req]) => req.offset)).toEqual([0, 60, 160]);
  });

  it("retries a failing chunk and then succeeds", async () => {
    const api = makeApi();
    const real = api.attachmentUploadChunk.getMockImplementation()!;
    api.attachmentUploadChunk
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockImplementation(real);
    const [item] = await uploader(api).upload([fakeFile(10)], "ws-1");
    expect(api.attachmentUploadChunk).toHaveBeenCalledTimes(3);
    expect(item.state).toBe("done");
  });

  it("fails with the server's sentence once the retries are used up, and cancels the transfer", async () => {
    const api = makeApi({
      attachmentUploadChunk: vi.fn(async () => {
        throw new Error("Workspace attachments are full (4 GiB).");
      }),
    });
    const settled: UploadItem[] = [];
    const [item] = await uploader(api, { onSettled: (entry) => settled.push(entry) }).upload([fakeFile(10)], "ws-1");
    expect(api.attachmentUploadChunk).toHaveBeenCalledTimes(3);
    expect(item.state).toBe("failed");
    expect(item.error).toBe("Workspace attachments are full (4 GiB).");
    expect(api.attachmentUploadCancel).toHaveBeenCalledOnce();
    expect(api.attachmentUploadFinish).not.toHaveBeenCalled();
    expect(settled).toEqual([item]);
  });

  it("shows a refused begin as a failure without touching the transfer", async () => {
    const api = makeApi({
      attachmentUploadBegin: vi.fn(async () => {
        throw new Error("Attachments are not available in SSH workspaces.");
      }),
    });
    const [item] = await uploader(api).upload([fakeFile(10)], "ws-1");
    expect(item.error).toBe("Attachments are not available in SSH workspaces.");
    expect(api.attachmentUploadCancel).not.toHaveBeenCalled();
  });

  it("cancels between chunks, tells the server and settles nothing", async () => {
    const api = makeApi();
    const settled = vi.fn();
    const up = uploader(api, { onSettled: settled });
    const real = api.attachmentUploadChunk.getMockImplementation()!;
    api.attachmentUploadChunk.mockImplementation(async (req) => {
      up.cancel(up.items[0]);
      return real(req);
    });
    const [item] = await up.upload([fakeFile(CHUNK * 3)], "ws-1");
    expect(api.attachmentUploadChunk).toHaveBeenCalledTimes(1);
    expect(item.state).toBe("cancelled");
    expect(api.attachmentUploadCancel).toHaveBeenCalledOnce();
    expect(api.attachmentUploadFinish).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("does not start a queued item that was cancelled", async () => {
    const api = makeApi();
    const up = uploader(api);
    const promise = up.upload([fakeFile(5, "a"), fakeFile(5, "b")], "ws-1");
    up.cancel(up.items[1]);
    await promise;
    expect(up.items.map((item) => item.state)).toEqual(["done", "cancelled"]);
    expect(api.attachmentUploadBegin).toHaveBeenCalledTimes(1);
  });

  it("does not let one failed file stop the rest", async () => {
    const api = makeApi();
    api.attachmentUploadBegin
      .mockRejectedValueOnce(new Error("name not allowed"))
      .mockResolvedValue({ transferId: "t", chunkBytes: CHUNK, received: 0 });
    const items = await uploader(api).upload([fakeFile(5, "bad"), fakeFile(5, "good")], "ws-1");
    expect(items.map((item) => item.state)).toEqual(["failed", "done"]);
  });

  it("refuses an empty file locally", async () => {
    const api = makeApi();
    const [item] = await uploader(api).upload([fakeFile(0, "empty.txt")], "ws-1");
    expect(item.state).toBe("failed");
    expect(item.error).toBe('"empty.txt" is empty. Empty files cannot be uploaded.');
    expect(api.attachmentUploadBegin).not.toHaveBeenCalled();
  });

  it("runs separate batches one after another", async () => {
    const order: string[] = [];
    const api = makeApi({
      attachmentUploadBegin: vi.fn(async (req: { name: string }) => {
        order.push(`begin ${req.name}`);
        return { transferId: "t", chunkBytes: CHUNK, received: 0 };
      }),
      attachmentUploadFinish: vi.fn(async () => {
        order.push("finish");
        return record("x");
      }),
    });
    const up = uploader(api);
    await Promise.all([up.upload([fakeFile(5, "a")], "ws-1"), up.upload([fakeFile(5, "b")], "ws-1")]);
    expect(order).toEqual(["begin a", "finish", "begin b", "finish"]);
  });
});

describe("attachmentsUnavailableReason", () => {
  it("names container and SSH workspaces and leaves the rest alone", () => {
    expect(attachmentsUnavailableReason({ kind: "docker" })).toMatch(/container/);
    expect(attachmentsUnavailableReason({ panels: [{ launch: { kind: "ssh" } }] })).toMatch(/SSH/);
    expect(attachmentsUnavailableReason({ panels: [{ launch: { kind: "ssh" } }, { launch: null }] })).toBe("");
    expect(attachmentsUnavailableReason(null)).toBe("");
  });
});
