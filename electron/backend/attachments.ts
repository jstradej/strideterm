import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createReadStream, constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { ATTACHMENT_READ_MAX_BYTES } from "../shared/attachment-upload.js";
import { validateAttachmentName, validateAttachmentContent, AttachmentPolicyError } from "./attachment-file-policy.js";

export const CHUNK_SIZE = 512 * 1024;
export const MAX_SIZE = 25 * 1024 * 1024;
export const MAX_TOTAL_SIZE = 4 * 1024 * 1024 * 1024;
export const MAX_FILE_COUNT = 100;
export const MAX_CONCURRENT_TRANSFERS = 4;
const DAILY_RECEIVED_LIMIT = 128 * 1024 * 1024;
const DESKTOP_MAX_SIZE = 1024 * 1024 * 1024;

export interface AttachmentLimits {
  kind: "phone" | "desktop";
  maxFileBytes: number;
  /** null: no daily limit, and uploads of this kind never touch the daily ledger. */
  dailyReceivedBytes: number | null;
  storageBytes: number;
  fileCount: number;
  activeTransfers: number;
}
export const PHONE_LIMITS: AttachmentLimits = {
  kind: "phone",
  maxFileBytes: MAX_SIZE,
  dailyReceivedBytes: DAILY_RECEIVED_LIMIT,
  storageBytes: MAX_TOTAL_SIZE,
  fileCount: MAX_FILE_COUNT,
  activeTransfers: MAX_CONCURRENT_TRANSFERS,
};
export const DESKTOP_LIMITS: AttachmentLimits = {
  kind: "desktop",
  maxFileBytes: DESKTOP_MAX_SIZE,
  dailyReceivedBytes: null,
  storageBytes: MAX_TOTAL_SIZE,
  fileCount: MAX_FILE_COUNT,
  activeTransfers: MAX_CONCURRENT_TRANSFERS,
};
export function formatLimitBytes(bytes: number) {
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  return bytes >= gib && bytes % gib === 0 ? `${bytes / gib} GiB` : `${Math.round((bytes / mib) * 10) / 10} MiB`;
}
const run = promisify(execFile);
const locks = new Map<string, Promise<void>>();
const excludeLocks = new Map<string, Promise<void>>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// eslint-disable-next-line security/detect-unsafe-regex
const RESERVED = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const EXPIRED_MS = 24 * 60 * 60 * 1000;
export type AttachmentResult = { transferId: string; path: string; size: number; sha256: string; name: string };
export type AttachmentListResult = AttachmentResult & { uploadedAt?: number };
type State = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  offset: number;
  owner?: string;
  /** Absent for a phone transfer. A desktop transfer carries no hash until finish computes it. */
  kind?: "desktop";
  idempotencyKey?: string;
  createdAt: number;
  updatedAt: number;
  done?: AttachmentResult;
};

async function usagePath(root: string) {
  return safePath(root, ".strideterm/.attachment-usage.json");
}
async function recordReceivedUnlocked(root: string, bytes: number) {
  const file = await usagePath(root);
  let usage: { day: string; received: number } = { day: new Date().toISOString().slice(0, 10), received: 0 };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<typeof usage>;
    if (
      typeof parsed.day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.day) ||
      !Number.isSafeInteger(parsed.received) ||
      (parsed.received as number) < 0
    )
      throw new Error("Attachment usage ledger is invalid");
    usage = parsed as typeof usage;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const day = new Date().toISOString().slice(0, 10);
  if (usage.day !== day) usage = { day, received: 0 };
  if (!Number.isSafeInteger(bytes) || usage.received + bytes > DAILY_RECEIVED_LIMIT)
    throw new Error(
      `Attachment daily receive quota exceeded (limit ${formatLimitBytes(DAILY_RECEIVED_LIMIT)} per workspace per day)`,
    );
  usage.received += bytes;
  await atomic(file, JSON.stringify(usage));
}
async function recordReceived(root: string, bytes: number) {
  const base = await workspace(root);
  return locked(`${base}\u0000received-ledger`, () => recordReceivedUnlocked(base, bytes));
}
export async function usage(root: string, limits: AttachmentLimits = PHONE_LIMITS) {
  const base = await workspace(root);
  let received = 0;
  const day = new Date().toISOString().slice(0, 10);
  try {
    const value = JSON.parse(await readFile(await usagePath(base), "utf8")) as { day: string; received: number };
    if (
      typeof value.day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.day) ||
      !Number.isSafeInteger(value.received) ||
      value.received < 0
    )
      throw new Error("Attachment usage ledger is invalid");
    if (value.day === day) received = value.received;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    day,
    received,
    dailyLimit: limits.dailyReceivedBytes,
    storageLimit: limits.storageBytes,
    fileLimit: limits.fileCount,
    activeLimit: limits.activeTransfers,
    ...(limits.kind === "desktop" ? { fileSizeLimit: limits.maxFileBytes } : {}),
  };
}
function validId(value: string) {
  if (!UUID.test(value)) throw new Error("Invalid transfer id");
  return value;
}
function safeName(value: string) {
  const name = path
    .basename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[ .]+$/, "")
    .slice(0, 180)
    .replace(/[ .]+$/, "");
  if (!name || name === "." || name === ".." || RESERVED.test(name)) throw new Error("Invalid attachment name");
  return name;
}
async function workspace(root: string) {
  const result = await realpath(root);
  if (!(await lstat(result)).isDirectory()) throw new Error("Workspace root is not a directory");
  return result;
}
async function safePath(root: string, relative: string, missing = true) {
  const base = await workspace(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Attachment path escapes workspace");
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Attachment path contains a symlink");
      if (!info.isDirectory() && current !== target) throw new Error("Attachment path contains a non-directory");
      const actual = await realpath(current);
      if (actual !== current && !actual.startsWith(`${base}${path.sep}`))
        throw new Error("Attachment path escapes workspace");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !missing) throw error;
      break;
    }
  }
  return target;
}
async function atomic(file: string, value: string) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, value, { flag: "wx" });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
async function locked<T>(key: string, fn: () => Promise<T>) {
  const prior = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const chain = prior.then(() => next);
  locks.set(key, chain);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}
function owner(state: State, value?: string) {
  if (state.owner !== value) throw new Error("Attachment owner mismatch");
}

async function configureGitExclude(root: string) {
  let repo: string;
  try {
    repo = (await run("git", ["-C", root, "rev-parse", "--show-toplevel"])).stdout.trim();
  } catch (error) {
    if (
      (error as { code?: number; stderr?: string }).code === 128 &&
      /not a git repository/i.test((error as { stderr?: string }).stderr ?? "")
    )
      return;
    throw new Error("Unable to inspect Git workspace", { cause: error });
  }
  let exclude: string;
  try {
    exclude = path.resolve(
      root,
      (await run("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"])).stdout.trim(),
    );
  } catch {
    throw new Error("Unable to locate Git exclude file");
  }
  const rel = path.relative(repo, root).split(path.sep).join("/");
  // eslint-disable-next-line no-useless-escape
  const escapeGit = (value: string) => value.replace(/[\\*?\[\]]/g, "\\$&");
  const escapedPrefix = rel ? `/${escapeGit(rel)}/` : "/";
  const rules = [
    `${escapedPrefix}.strideterm/attachments/`,
    `${escapedPrefix}.strideterm/.attachment-transfers/`,
    `${escapedPrefix}.strideterm/.attachment-usage.json`,
  ];
  let text = "";
  try {
    text = await readFile(exclude, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = rules.filter((rule) => !lines.has(rule));
  if (missing.length) {
    await mkdir(path.dirname(exclude), { recursive: true });
    await writeFile(exclude, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  }
  for (const rule of rules) {
    const probe = path
      .join(
        rel,
        rule.includes("attachments") ? ".strideterm/attachments/.probe" : ".strideterm/.attachment-transfers/.probe",
      )
      .split(path.sep)
      .join("/");
    try {
      await run("git", ["-C", repo, "check-ignore", "--no-index", "--quiet", "--", probe]);
    } catch (error) {
      throw new Error("Unable to exclude attachment storage from Git", { cause: error });
    }
  }
  for (const rule of rules) {
    const probe = path
      .join(rel, rule.includes("attachments") ? ".strideterm/attachments" : ".strideterm/.attachment-transfers")
      .split(path.sep)
      .join("/");
    try {
      const tracked = (await run("git", ["-C", repo, "--literal-pathspecs", "ls-files", "--", probe])).stdout.trim();
      if (tracked) throw new Error("Attachment storage contains tracked files");
    } catch (error) {
      if (error instanceof Error && error.message === "Attachment storage contains tracked files") throw error;
      throw new Error("Unable to inspect tracked attachment files", { cause: error });
    }
  }
}
async function ensureGitExclude(root: string) {
  const lockKey = "git-info-exclude-global";
  const prior = excludeLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prior.then(() => next);
  excludeLocks.set(lockKey, chain);
  await prior;
  try {
    return await configureGitExclude(root);
  } finally {
    release();
    if (excludeLocks.get(lockKey) === chain) excludeLocks.delete(lockKey);
  }
}
async function hashFile(file: string) {
  const hash = crypto.createHash("sha256");
  let length = 0;
  for await (const part of createReadStream(file)) {
    hash.update(part as Buffer);
    length += (part as Buffer).length;
  }
  return { digest: hash.digest("hex"), length };
}
function integrityFailure() {
  return new Error("Attachment integrity check failed");
}
async function load(root: string, transferId: string) {
  const id = validId(transferId);
  const file = await safePath(root, `.strideterm/.attachment-transfers/${id}/state.json`, false);
  const state = JSON.parse(await readFile(file, "utf8")) as State;
  if (state.id !== id) throw new Error("Invalid attachment state");
  if (!state.done && state.offset === state.size) {
    const target = await safePath(root, `.strideterm/attachments/${id}/${state.name}`);
    try {
      const info = await stat(target);
      // A renamed target only exists after finish verified and validated it, so a desktop transfer, which has no
      // hash of its own, adopts the one computed here.
      const adopted = info.isFile() && info.size === state.size ? (await hashFile(target)).digest : "";
      if (adopted && (adopted === state.sha256 || (state.kind === "desktop" && !state.sha256))) {
        state.sha256 = adopted;
        state.done = {
          transferId: id,
          path: `.strideterm/attachments/${id}/${state.name}`,
          size: state.size,
          sha256: state.sha256,
          name: state.name,
        };
        await atomic(file, JSON.stringify(state));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return state;
}

export async function cleanup(root: string, maxAgeMs = EXPIRED_MS) {
  const base = await workspace(root);
  const transfers = await safePath(base, ".strideterm/.attachment-transfers");
  let removed = 0;
  try {
    for (const entry of await readdir(transfers, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      await locked(entry.name, async () => {
        try {
          const state = await load(base, entry.name);
          if (!state.done && Date.now() - state.updatedAt >= maxAgeMs) {
            await rm(await safePath(base, `.strideterm/.attachment-transfers/${entry.name}`, false), {
              recursive: true,
            });
            removed++;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const orphan = await safePath(base, `.strideterm/.attachment-transfers/${entry.name}`, false);
          const info = await stat(orphan);
          if (Date.now() - info.mtimeMs >= maxAgeMs) {
            await rm(orphan, { recursive: true });
            removed++;
          }
        }
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { removed };
}

async function beginUnlocked(
  root: string,
  originalName: string,
  size: number,
  sha256: string,
  requestOwner: string | undefined,
  idempotencyKey: string | undefined,
  limits: AttachmentLimits,
) {
  const desktop = limits.kind === "desktop";
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes)
    throw new Error(`Attachment exceeds the ${formatLimitBytes(limits.maxFileBytes)} limit`);
  if (desktop ? sha256 !== "" : !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid SHA-256");
  const name = safeName(originalName);
  if (!desktop) validateAttachmentName(name);
  const base = await workspace(root);
  await ensureGitExclude(base);
  const key = idempotencyKey === undefined ? undefined : String(idempotencyKey);
  if (key !== undefined && (!key || key.length > 256)) throw new Error("Invalid idempotency key");
  const transfers = await safePath(base, ".strideterm/.attachment-transfers");
  await mkdir(transfers, { recursive: true });
  await cleanup(base);
  let reserved = 0,
    files = 0,
    active = 0;
  try {
    for (const entry of await readdir(transfers, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try {
        const prior = await load(base, entry.name);
        files++;
        reserved += prior.size;
        if (!prior.done) active++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (key)
    for (const entry of await readdir(transfers, { withFileTypes: true }))
      if (entry.isDirectory() && UUID.test(entry.name)) {
        try {
          const prior = await load(base, entry.name);
          if (prior.idempotencyKey === key) {
            if (
              prior.name !== name ||
              prior.size !== size ||
              prior.sha256 !== sha256 ||
              prior.owner !== requestOwner ||
              (prior.kind === "desktop") !== desktop
            )
              throw new Error("Idempotency key metadata mismatch");
            return {
              transferId: prior.id,
              chunkSize: CHUNK_SIZE,
              offset: prior.offset,
              ...(prior.done ? { done: prior.done } : {}),
            };
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
  if (files >= limits.fileCount)
    throw new Error(`Attachment quota exceeded: a workspace holds at most ${limits.fileCount} attachments`);
  if (reserved + size > limits.storageBytes)
    throw new Error(
      `Attachment quota exceeded: a workspace holds at most ${formatLimitBytes(limits.storageBytes)} of attachments`,
    );
  if (active >= limits.activeTransfers)
    throw new Error(`Too many concurrent attachment transfers (limit ${limits.activeTransfers})`);
  const transferId = crypto.randomUUID();
  const dir = await safePath(base, `.strideterm/.attachment-transfers/${transferId}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    await safePath(base, `.strideterm/.attachment-transfers/${transferId}/payload.part`),
    Buffer.alloc(0),
    { flag: "wx" },
  );
  const now = Date.now();
  await atomic(
    await safePath(base, `.strideterm/.attachment-transfers/${transferId}/state.json`),
    JSON.stringify({
      id: transferId,
      name,
      size,
      sha256,
      offset: 0,
      owner: requestOwner,
      ...(desktop ? { kind: "desktop" as const } : {}),
      idempotencyKey: key,
      createdAt: now,
      updatedAt: now,
    } satisfies State),
  );
  return { transferId, chunkSize: CHUNK_SIZE, offset: 0 };
}
export async function begin(
  root: string,
  originalName: string,
  size: number,
  sha256: string,
  requestOwner?: string,
  idempotencyKey?: string,
  limits: AttachmentLimits = PHONE_LIMITS,
) {
  const base = await workspace(root);
  return locked(`${base}\u0000begin`, () =>
    beginUnlocked(base, originalName, size, sha256, requestOwner, idempotencyKey, limits),
  );
}
export async function status(root: string, transferId: string, requestOwner?: string) {
  return locked(validId(transferId), async () => {
    const state = await load(root, transferId);
    owner(state, requestOwner);
    return (
      state.done ?? {
        transferId: state.id,
        offset: state.offset,
        size: state.size,
        name: state.name,
        sha256: state.sha256,
      }
    );
  });
}
export async function chunk(root: string, transferId: string, offset: number, encoded: string, requestOwner?: string) {
  return locked(validId(transferId), async () => {
    const state = await load(root, transferId);
    owner(state, requestOwner);
    if (state.done) return { offset: state.size };
    const bytes = Buffer.from(encoded, "base64");
    const payload = await safePath(root, `.strideterm/.attachment-transfers/${state.id}/payload.part`, false);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > state.offset ||
      bytes.length > CHUNK_SIZE ||
      offset + bytes.length > state.size
    )
      throw new Error("Invalid attachment chunk offset or size");
    if (offset < state.offset) {
      if (offset + bytes.length > state.offset) throw new Error("Invalid attachment chunk retry range");
      const existing = Buffer.alloc(bytes.length);
      const reader = await open(payload, "r");
      try {
        await reader.read(existing, 0, bytes.length, offset);
      } finally {
        await reader.close();
      }
      if (existing.equals(bytes)) {
        if (state.kind !== "desktop") await recordReceived(root, bytes.length);
        return { offset: state.offset };
      }
      throw new Error("Invalid attachment chunk retry");
    }
    if (state.kind !== "desktop") await recordReceived(root, bytes.length);
    const handle = await open(payload, "r+");
    try {
      const written = await handle.write(bytes, 0, bytes.length, offset);
      if (written.bytesWritten !== bytes.length) throw new Error("Attachment chunk write was incomplete");
      await handle.sync();
    } finally {
      await handle.close();
    }
    state.offset += bytes.length;
    state.updatedAt = Date.now();
    await atomic(
      await safePath(root, `.strideterm/.attachment-transfers/${state.id}/state.json`, false),
      JSON.stringify(state),
    );
    return { offset: state.offset };
  });
}
export async function finish(root: string, transferId: string, requestOwner?: string): Promise<AttachmentResult> {
  return locked(validId(transferId), async () => {
    const state = await load(root, transferId);
    owner(state, requestOwner);
    if (state.done) return state.done;
    if (state.offset !== state.size) throw new Error("Attachment is incomplete");
    const payload = await safePath(root, `.strideterm/.attachment-transfers/${state.id}/payload.part`, false);
    // A desktop transfer accepts any file type and is only hashed, as a stream; a phone transfer is held whole and inspected.
    const bytes = state.kind === "desktop" ? undefined : await readFile(payload);
    const measured = bytes
      ? { digest: crypto.createHash("sha256").update(bytes).digest("hex"), length: bytes.length }
      : await hashFile(payload);
    if (measured.length !== state.size) throw integrityFailure();
    if (state.kind === "desktop") state.sha256 = measured.digest;
    else if (measured.digest !== state.sha256) throw integrityFailure();
    if (bytes) {
      try {
        await validateAttachmentContent(state.name, bytes);
      } catch (error) {
        if (error instanceof AttachmentPolicyError) {
          await rm(await safePath(root, `.strideterm/.attachment-transfers/${state.id}`), {
            recursive: true,
            force: true,
          });
        }
        throw error;
      }
    }
    const destination = await safePath(root, `.strideterm/attachments/${state.id}/${state.name}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(payload, destination);
    const result = {
      transferId: state.id,
      path: `.strideterm/attachments/${state.id}/${state.name}`,
      size: state.size,
      sha256: state.sha256,
      name: state.name,
    };
    state.done = result;
    state.updatedAt = Date.now();
    await atomic(
      await safePath(root, `.strideterm/.attachment-transfers/${state.id}/state.json`, false),
      JSON.stringify(state),
    );
    return result;
  });
}
export async function list(root: string): Promise<AttachmentListResult[]> {
  const dir = await safePath(root, ".strideterm/.attachment-transfers");
  try {
    await stat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: AttachmentListResult[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }))
    if (entry.isDirectory() && UUID.test(entry.name)) {
      try {
        const state = await locked(entry.name, () => load(root, entry.name));
        if (state.done) {
          const uploadedAt = state.updatedAt;
          result.push(
            Number.isSafeInteger(uploadedAt) && uploadedAt >= 0 ? { ...state.done, uploadedAt } : { ...state.done },
          );
        }
      } catch (error) {
        // A process can crash after creating a transfer directory but before publishing state.json.
        // Ignore that incomplete entry; cleanup() removes it once its bounded retention expires.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  return result;
}
export async function record(root: string, transferId: string, requestOwner?: string): Promise<AttachmentListResult> {
  return locked(validId(transferId), async () => {
    const state = await load(root, transferId);
    if (requestOwner !== undefined) owner(state, requestOwner);
    if (!state.done) throw new Error("Attachment is incomplete");
    const uploadedAt = state.updatedAt;
    return Number.isSafeInteger(uploadedAt) && uploadedAt >= 0 ? { ...state.done, uploadedAt } : { ...state.done };
  });
}
export async function read(root: string, transferId: string, fileName: string, offset: number, length: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > ATTACHMENT_READ_MAX_BYTES
  )
    throw new Error("Invalid attachment read range");
  return locked(validId(transferId), async () => {
    let state: State;
    try {
      state = await load(root, transferId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Attachment not found", { cause: error });
      throw error;
    }
    if (!state.done || safeName(fileName) !== state.name) throw new Error("Attachment not found");
    const target = await safePath(root, `.strideterm/attachments/${state.id}/${state.name}`, false);
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Attachment not found");
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, info.size - offset)));
      const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 };
      return { bytes: buffer.subarray(0, bytesRead), size: info.size };
    } finally {
      await handle.close();
    }
  });
}
export async function listWithUsage(root: string, limits: AttachmentLimits = PHONE_LIMITS) {
  const attachments = await list(root);
  const base = await workspace(root);
  const activeDir = await safePath(base, ".strideterm/.attachment-transfers");
  let storageBytes = 0;
  let fileCount = 0;
  let activeTransfers = 0;
  try {
    for (const entry of await readdir(activeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try {
        const state = await load(base, entry.name);
        if (state.done) {
          storageBytes += state.done.size;
          fileCount++;
        } else {
          storageBytes += state.offset;
          activeTransfers++;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const current = await usage(base, limits);
  return { attachments, usage: { ...current, storageBytes, fileCount, activeTransfers } };
}
export async function remove(root: string, transferId: string, fileName: string, requestOwner?: string) {
  return locked(validId(transferId), async () => {
    const state = await load(root, transferId);
    if (requestOwner !== undefined) owner(state, requestOwner);
    if (!state.done || safeName(fileName) !== state.name) throw new Error("Attachment not found");
    await rm(await safePath(root, `.strideterm/attachments/${state.id}/${state.name}`, false));
    await rm(await safePath(root, `.strideterm/attachments/${state.id}`), { recursive: true });
    await rm(await safePath(root, `.strideterm/.attachment-transfers/${state.id}`), { recursive: true });
    return { ok: true };
  });
}
export async function cancel(root: string, transferId: string, requestOwner?: string) {
  return locked(validId(transferId), async () => {
    let state: State;
    try {
      state = await load(root, transferId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
      throw error;
    }
    owner(state, requestOwner);
    if (state.done) return { ok: true };
    await rm(await safePath(root, `.strideterm/.attachment-transfers/${state.id}`, false), { recursive: true });
    return { ok: true };
  });
}
