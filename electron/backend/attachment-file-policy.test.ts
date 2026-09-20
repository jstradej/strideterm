import { describe, expect, test } from "vitest";
import { validateAttachmentContent, validateAttachmentName } from "./attachment-file-policy.js";
import { crc32, deflateRawSync } from "node:zlib";

function zip(
  entries: Array<{ name: string; data?: Buffer; flags?: number; attrs?: number; madeBy?: number; corrupt?: boolean }>,
) {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name);
    const data = item.data ?? Buffer.alloc(0);
    const compressed = item.name.endsWith("/") ? data : deflateRawSync(data);
    const crc = item.corrupt ? 0 : crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(item.flags ?? 0, 6);
    local.writeUInt16LE(item.name.endsWith("/") ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(Buffer.concat([local, compressed]));
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(item.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(item.flags ?? 0, 8);
    central.writeUInt16LE(item.name.endsWith("/") ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(item.attrs ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += locals.at(-1)!.length;
  }
  const body = Buffer.concat(locals),
    central = Buffer.concat(centrals),
    eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, eocd]);
}

describe("attachment file policy", () => {
  test("accepts valid text and PNG signatures", async () => {
    await expect(validateAttachmentContent("note.txt", Buffer.from("plain text"))).resolves.toBeUndefined();
    await expect(
      validateAttachmentContent("image.png", Buffer.from("89504e470d0a1a0a", "hex")),
    ).resolves.toBeUndefined();
  });
  test("rejects executable disguises and blocked names", async () => {
    expect(() => validateAttachmentName("run.exe")).toThrow(/not allowed/);
    await expect(validateAttachmentContent("run.txt", Buffer.from("MZpayload"))).rejects.toMatchObject({
      code: "attachment-content-mismatch",
    });
  });
  test("rejects malformed and unsafe archives", async () => {
    await expect(validateAttachmentContent("bad.zip", Buffer.from("PK\x03\x04"))).rejects.toMatchObject({
      code: "attachment-unsafe-archive",
    });
    await expect(validateAttachmentContent("bad.zip", Buffer.from("not a zip"))).rejects.toMatchObject({
      code: "attachment-content-mismatch",
    });
  });
  test("accepts a real ZIP with text, image, and directory", async () => {
    await expect(
      validateAttachmentContent(
        "bundle.zip",
        zip([
          { name: "docs/", data: Buffer.alloc(0) },
          { name: "docs/readme.txt", data: Buffer.from("hello") },
          { name: "image.png", data: Buffer.from("89504e470d0a1a0a", "hex") },
        ]),
      ),
    ).resolves.toBeUndefined();
  });
  test("rejects unsafe ZIP entries and bad CRC", async () => {
    await expect(
      validateAttachmentContent("bundle.zip", zip([{ name: "script.ps1", data: Buffer.from("Write-Host hi") }])),
    ).rejects.toMatchObject({ code: "attachment-unsafe-archive" });
    await expect(
      validateAttachmentContent("bundle.zip", zip([{ name: "readme.txt", data: Buffer.from("hello"), corrupt: true }])),
    ).rejects.toMatchObject({ code: "attachment-unsafe-archive" });
    await expect(
      validateAttachmentContent("bundle.zip", zip([{ name: "../../escape.txt", data: Buffer.from("x") }])),
    ).rejects.toMatchObject({ code: "attachment-unsafe-archive" });
  });
  test("rejects encrypted, nested, symlink, and ratio bomb entries", async () => {
    await expect(
      validateAttachmentContent("bundle.zip", zip([{ name: "secret.txt", data: Buffer.from("x"), flags: 1 }])),
    ).rejects.toMatchObject({ code: "attachment-unsafe-archive" });
    await expect(
      validateAttachmentContent("bundle.zip", zip([{ name: "inner.zip", data: Buffer.from("x") }])),
    ).rejects.toMatchObject({ code: "attachment-unsafe-archive" });
    await expect(
      validateAttachmentContent(
        "bundle.zip",
        zip([{ name: "link.txt", data: Buffer.from("x"), madeBy: (3 << 8) | 20, attrs: 0xa0000000 }]),
      ),
    ).rejects.toMatchObject({ code: "attachment-unsafe-archive" });
    await expect(
      validateAttachmentContent("bundle.zip", zip([{ name: "bomb.txt", data: Buffer.alloc(1024 * 1024, 65) }])),
    ).rejects.toMatchObject({ code: "attachment-unsafe-archive" });
  });
});
