import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open as openFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UsageAccountSnapshot } from "../../shared/agent-usage.js";

const MAX_ACCOUNTS_FILE_BYTES = 64 * 1024;
const MAX_ACCOUNTS = 64;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

function validEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

interface ParsedAccounts {
  active: string | null;
  old: string[];
}

function parseAccounts(value: unknown): ParsedAccounts | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!(record.active === null || record.active === undefined || typeof record.active === "string")) return undefined;
  if (
    record.old !== undefined &&
    (!Array.isArray(record.old) || !record.old.every((entry) => typeof entry === "string"))
  )
    return undefined;

  const active = typeof record.active === "string" ? record.active : null;
  const old = Array.isArray(record.old) ? record.old : [];
  if (active !== null && !validEmail(active)) return undefined;
  if (old.length > MAX_ACCOUNTS || old.some((email) => !validEmail(email))) return undefined;
  return { active, old };
}

function accountSnapshot(email: string): UsageAccountSnapshot {
  return {
    id: `gemini:${createHash("sha256").update(email.toLowerCase()).digest("hex")}`,
    label: email,
    status: "listed",
  };
}

/**
 * Reads Gemini CLI's non-credential account index. The active email is only
 * metadata and must never be used to label passive quota observed in a terminal.
 */
export async function readGeminiKnownAccounts(): Promise<UsageAccountSnapshot[]> {
  const home = process.env.GEMINI_CLI_HOME || os.homedir();
  if (!home) return [];

  // Gemini CLI stores this index beside its runtime state. It does not use the
  // credentials file, keyring, or a directory scan for this metadata lookup.
  const runtimeDir =
    process.env.SANDBOX === "sandbox-exec" ? path.join(home, ".cache", ".gemini") : path.join(home, ".gemini");
  const accountPath = path.join(runtimeDir, "google_accounts.json");
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    const info = await lstat(accountPath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_ACCOUNTS_FILE_BYTES) return [];
    handle = await openFile(accountPath, READ_ONLY_NO_FOLLOW);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.size <= 0 || openedInfo.size > MAX_ACCOUNTS_FILE_BYTES) return [];
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_ACCOUNTS_FILE_BYTES) return [];
    const parsed = parseAccounts(JSON.parse(bytes.toString("utf8")) as unknown);
    if (!parsed) return [];

    const emails = new Map<string, string>();
    const activeIsInOld =
      parsed.active !== null && parsed.old.some((email) => email.toLowerCase() === parsed.active!.toLowerCase());
    const oldLimit = parsed.active !== null && !activeIsInOld ? MAX_ACCOUNTS - 1 : MAX_ACCOUNTS;
    for (const email of parsed.old.slice(0, oldLimit)) emails.set(email.toLowerCase(), email);
    if (parsed.active) emails.set(parsed.active.toLowerCase(), parsed.active);
    return [...emails.values()].map(accountSnapshot);
  } catch {
    // Missing, unreadable, or malformed optional metadata is an empty listing.
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
