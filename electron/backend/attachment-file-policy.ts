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
                    : false;
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
