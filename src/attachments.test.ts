import { describe, expect, it } from "vitest";
import { normalizeAttachmentList } from "./attachments.js";

const record = {
  transferId: "transfer-1",
  path: ".strideterm/attachments/transfer-1/file.txt",
  size: 12,
  sha256: "a".repeat(64),
  name: "file.txt",
};

describe("normalizeAttachmentList", () => {
  it("accepts Electron arrays and remote envelopes", () => {
    expect(normalizeAttachmentList([record])).toEqual([record]);
    expect(normalizeAttachmentList({ attachments: [record] })).toEqual([record]);
    expect(normalizeAttachmentList([{ ...record, uploadedAt: 1_700_000_000_123 }])).toEqual([
      { ...record, uploadedAt: 1_700_000_000_123 },
    ]);
  });

  it("omits invalid optional upload timestamps", () => {
    expect(normalizeAttachmentList([{ ...record, uploadedAt: -1 }])).toEqual([record]);
    expect(normalizeAttachmentList([{ ...record, uploadedAt: "invalid" }])).toEqual([record]);
  });

  it("rejects malformed list responses", () => {
    expect(() => normalizeAttachmentList(null)).toThrow("Invalid attachment list response");
    expect(() => normalizeAttachmentList({ attachments: [{ ...record, size: "12" }] })).toThrow(
      "Invalid attachment list response",
    );
  });
});
