import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_READ_MAX_BYTES, attachmentReadSchema } from "../../electron/shared/attachment-upload.js";
import type { AttachmentRecord } from "../attachments.js";
import { AttachmentDownloadCancelled, readAttachment, saveBlobAsDownload } from "./attachment-download.js";

const attachment: AttachmentRecord = {
  transferId: "11111111-1111-4111-8111-111111111111",
  path: ".strideterm/attachments/t/big.bin",
  size: 10,
  sha256: "a".repeat(64),
  name: "big.bin",
};

function b64(text: string): string {
  return btoa(text);
}

afterEach(() => vi.restoreAllMocks());

describe("readAttachment", () => {
  it("reads in windows from offset 0 and stops at eof", async () => {
    const attachmentRead = vi
      .fn()
      .mockResolvedValueOnce({ data: b64("abcd"), size: 10, eof: false })
      .mockResolvedValueOnce({ data: b64("efgh"), size: 10, eof: false })
      .mockResolvedValueOnce({ data: b64("ij"), size: 10, eof: true });
    const progress: number[] = [];
    const blob = await readAttachment({ attachmentRead } as never, {
      workspaceId: "ws",
      attachment,
      onProgress: (read) => progress.push(read),
    });
    expect(attachmentRead.mock.calls.map(([req]) => req.offset)).toEqual([0, 4, 8]);
    for (const [req] of attachmentRead.mock.calls) {
      expect(req.length).toBe(ATTACHMENT_READ_MAX_BYTES);
      expect(attachmentReadSchema.safeParse(req).success).toBe(true);
    }
    expect(progress).toEqual([4, 8, 10]);
    expect(blob.size).toBe(10);
  });

  it("stops between windows when cancelled", async () => {
    const controller = new AbortController();
    const attachmentRead = vi.fn(async () => {
      controller.abort();
      return { data: b64("abcd"), size: 10, eof: false };
    });
    await expect(
      readAttachment({ attachmentRead } as never, { workspaceId: "ws", attachment, signal: controller.signal }),
    ).rejects.toBeInstanceOf(AttachmentDownloadCancelled);
    expect(attachmentRead).toHaveBeenCalledTimes(1);
  });

  it("fails instead of looping when the host returns nothing before eof", async () => {
    const attachmentRead = vi.fn(async () => ({ data: "", size: 10, eof: false }));
    await expect(readAttachment({ attachmentRead } as never, { workspaceId: "ws", attachment })).rejects.toThrow(
      /no data/,
    );
  });
});

describe("saveBlobAsDownload", () => {
  it("clicks a download link for the blob", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    saveBlobAsDownload(new Blob(["a"]), "big.bin");
    expect(click).toHaveBeenCalledOnce();
  });
});
