import path from "node:path";
import { crc32 } from "node:zlib";
import * as yauzl from "yauzl";

export class AttachmentPolicyError extends Error {
  constructor(message: string, code = "attachment-content-mismatch") {
    super(message);
    this.code = code;
  }
  code: string;
}
const allowed = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "mp4",
  "mov",
  "m4v",
  "webm",
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "pdf",
  "txt",
  "text",
  "log",
  "md",
  "csv",
  "json",
  "xml",
  "yaml",
  "yml",
  "zip",
]);
const blocked = new Set([
  "exe",
  "msi",
  "apk",
  "bat",
  "cmd",
  "ps1",
  "sh",
  "js",
  "mjs",
  "cjs",
  "py",
  "pyw",
  "dll",
  "com",
  "scr",
  "jar",
  "vbs",
  "wsf",
]);
export function validateAttachmentName(name: string) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (blocked.has(ext) || !allowed.has(ext))
    throw new AttachmentPolicyError("Attachment file type is not allowed", "attachment-type-not-allowed");
}
function fail(message: string): never {
  throw new AttachmentPolicyError(message);
}
function magic(bytes: Buffer, hex: string) {
  return bytes.subarray(0, hex.length / 2).toString("hex") === hex;
}

function* mp4Boxes(bytes: Buffer, type: string, ...descendants: string[]): Generator<Buffer> {
  for (let offset = 0; offset + 8 <= bytes.length;) {
    let headerSize = 8;
    let size = bytes.readUInt32BE(offset);
    if (size === 1) {
      if (offset + 16 > bytes.length || bytes.readUInt32BE(offset + 8) !== 0) return;
      headerSize = 16;
      size = bytes.readUInt32BE(offset + 12);
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < headerSize || offset + size > bytes.length) return;
    if (bytes.subarray(offset + 4, offset + 8).toString() === type) {
      const body = bytes.subarray(offset + headerSize, offset + size);
      const [child, ...remaining] = descendants;
      if (child) yield* mp4Boxes(body, child, ...remaining);
      else yield body;
    }
    offset += size;
  }
}

function matchesMp4Audio(bytes: Buffer) {
  if (bytes.subarray(4, 8).toString() !== "ftyp") return false;
  const brand = mp4Boxes(bytes, "ftyp").next().value;
  if (!brand || brand.length < 8 || brand.length % 4 !== 0) return false;
  let audio = false;
  for (const handler of mp4Boxes(bytes, "moov", "trak", "mdia", "hdlr")) {
    const type = handler.subarray(8, 12).toString();
    if (type === "vide") return false;
    if (type === "soun") audio = true;
  }
  return audio;
}

function matchesAudio(ext: string, bytes: Buffer) {
  switch (ext) {
    case "mp3": {
      if (bytes.subarray(0, 3).toString() === "ID3") {
        if (bytes.length < 10 || bytes[3]! < 2 || bytes[3]! > 4 || bytes[4] === 0xff) return false;
        const size = bytes.subarray(6, 10);
        if (size.some((byte) => byte >= 0x80)) return false;
        const footerSize = bytes[3] === 4 && (bytes[5]! & 0x10) !== 0 ? 10 : 0;
        bytes = bytes.subarray(10 + size.reduce((total, byte) => total * 128 + byte, 0) + footerSize);
      }
      if (bytes.length < 4) return false;
      const versionAndLayer = bytes[1]!;
      const bitrateAndSampleRate = bytes[2]!;
      return (
        bytes[0] === 0xff &&
        (versionAndLayer & 0xe6) === 0xe2 &&
        (versionAndLayer & 0x18) !== 0x08 &&
        (bitrateAndSampleRate & 0xf0) !== 0xf0 &&
        (bitrateAndSampleRate & 0x0c) !== 0x0c &&
        (bytes[3]! & 3) !== 2
      );
    }
    case "wav":
      return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE";
    case "m4a":
      return matchesMp4Audio(bytes);
    case "aac": {
      if (bytes.length < 7 || bytes[0] !== 0xff || (bytes[1]! & 0xf6) !== 0xf0 || (bytes[2]! & 0x3c) > 0x30)
        return false;
      const frameSize = ((bytes[3]! & 3) << 11) | (bytes[4]! << 3) | (bytes[5]! >> 5);
      const headerSize = (bytes[1]! & 1) === 1 ? 7 : 9;
      return frameSize > headerSize && frameSize <= bytes.length;
    }
    case "flac":
      return bytes.length >= 42 && magic(bytes, "664c6143") && (bytes.readUInt32BE(4) & 0x7fffffff) === 34;
    case "ogg":
    case "opus": {
      if (bytes.length < 28 || !magic(bytes, "4f67675300") || bytes[5] !== 2) return false;
      const segmentCount = bytes[26]!;
      const packetStart = 27 + segmentCount;
      const packetSize = bytes[27]!;
      if (segmentCount === 0 || packetSize === 255 || packetStart + packetSize > bytes.length) return false;
      const packet = bytes.subarray(packetStart, packetStart + packetSize);
      if (packet.length >= 19 && packet.subarray(0, 8).toString() === "OpusHead") return true;
      return (
        ext === "ogg" &&
        ((packet.length >= 30 && magic(packet, "01766f72626973")) ||
          (packet.length >= 51 && magic(packet, "7f464c4143")) ||
          (packet.length >= 80 && packet.subarray(0, 8).toString() === "Speex   "))
      );
    }
    default:
      return false;
  }
}

export async function validateAttachmentContent(name: string, bytes: Buffer) {
  validateAttachmentName(name);
  const ext = path.extname(name).slice(1).toLowerCase();
  if (["txt", "text", "log", "md", "csv", "json", "xml", "yaml", "yml"].includes(ext)) {
    if (bytes.includes(0) || magic(bytes, "4d5a") || magic(bytes, "7f454c46") || magic(bytes, "2321"))
      fail("Attachment content does not match its type");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("Attachment content does not match its type");
    }
    return;
  }
  const valid =
    ext === "png"
      ? magic(bytes, "89504e470d0a1a0a")
      : ext === "jpg" || ext === "jpeg"
        ? magic(bytes, "ffd8ff")
        : ext === "gif"
          ? magic(bytes, "47494638")
          : ext === "webp"
            ? bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
            : ext === "pdf"
              ? magic(bytes, "255044462d")
              : ext === "zip"
                ? magic(bytes, "504b")
                : ["mp4", "mov", "m4v"].includes(ext)
                  ? bytes.subarray(4, 8).toString() === "ftyp"
                  : ext === "webm"
                    ? magic(bytes, "1a45dfa3")
                    : matchesAudio(ext, bytes);
  if (!valid) fail("Attachment content does not match its type");
  if (ext !== "zip") return;
  await inspectZip(bytes);
}
async function inspectZip(bytes: Buffer) {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip)
        return reject(new AttachmentPolicyError("Invalid ZIP attachment", "attachment-unsafe-archive"));
      let entries = 0,
        total = 0;
      const done = (error?: Error) => {
        zip.close();
        error ? reject(error) : resolve();
      };
      zip.on("error", (error) =>
        done(new AttachmentPolicyError(`Invalid ZIP attachment: ${error.message}`, "attachment-unsafe-archive")),
      );
      zip.on("entry", (entry) => {
        try {
          const name = entry.fileName;
          if (
            ++entries > 1000 ||
            name.includes("\\") ||
            path.posix.isAbsolute(name) ||
            /^[A-Za-z]:/.test(name) ||
            name.split("/").includes("..")
          )
            return done(new AttachmentPolicyError("ZIP entry path is not allowed", "attachment-unsafe-archive"));
          if (entry.isEncrypted())
            return done(
              new AttachmentPolicyError("Encrypted ZIP attachments are not allowed", "attachment-unsafe-archive"),
            );
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (entry.versionMadeBy >>> 8 === 3 && mode === 0xa000)
            return done(new AttachmentPolicyError("ZIP links are not allowed", "attachment-unsafe-archive"));
          if (name.endsWith("/")) {
            zip.readEntry();
            return;
          }
          try {
            validateAttachmentName(name);
          } catch {
            return done(new AttachmentPolicyError("ZIP contains a disallowed entry", "attachment-unsafe-archive"));
          }
          if (name.toLowerCase().endsWith(".zip"))
            return done(new AttachmentPolicyError("ZIP contains a nested archive", "attachment-unsafe-archive"));
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
            return done(
              new AttachmentPolicyError("ZIP compression method is not allowed", "attachment-unsafe-archive"),
            );
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return done(new AttachmentPolicyError("Unable to inspect ZIP entry"));
            const chunks: Buffer[] = [];
            let count = 0;
            stream.on("data", (chunk: Buffer) => {
              count += chunk.length;
              total += chunk.length;
              if (count > entry.compressedSize * 100 + 1024 || count > 25 * 1024 * 1024 || total > 100 * 1024 * 1024)
                stream.destroy(
                  new AttachmentPolicyError("ZIP entry exceeds safety limits", "attachment-unsafe-archive"),
                );
              else chunks.push(chunk);
            });
            stream.on("error", (error) => done(new AttachmentPolicyError(error.message, "attachment-unsafe-archive")));
            stream.on("end", () => {
              void (async () => {
                try {
                  const content = Buffer.concat(chunks);
                  if (crc32(content) !== entry.crc32)
                    throw new AttachmentPolicyError("ZIP CRC mismatch", "attachment-unsafe-archive");
                  await validateAttachmentContent(name, content);
                  zip.readEntry();
                } catch (error) {
                  done(error as Error);
                }
              })();
            });
          });
        } catch (error) {
          done(error as Error);
        }
      });
      zip.on("end", () => resolve());
      zip.readEntry();
    });
  });
}
