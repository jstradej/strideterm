import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PEER_DIRECTORY_MAX_ENTRIES, type PeerDirectoryListing } from "../../shared/peers.js";

/** A refusal with a sentence the other desktop can show as it is. */
export class PeerDirectoryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "PeerDirectoryError";
  }
}

export interface PeerDirectoryOptions {
  maxEntries?: number;
  homeDir?: () => string;
  /** Drive roots that exist on this machine; Windows only. */
  driveRoots?: () => Promise<string[]>;
}

const DRIVE_PROBE_TIMEOUT_MS = 750;
const SYMLINK_STAT_BATCH = 64;
const WINDOWS_ABSOLUTE = /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/** Probes A: to Z: without a shell; a slow or absent drive (a disconnected network share) is skipped after a short wait. */
export async function probeWindowsDriveRoots(): Promise<string[]> {
  const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
  const found = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      let timer: NodeJS.Timeout | undefined;
      const exists = await Promise.race([
        fs.promises.access(root).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), DRIVE_PROBE_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
      return exists ? root : null;
    }),
  );
  return found.filter((root): root is string => root !== null);
}

function compareNames(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function errnoOf(error: unknown): string {
  return String((error as NodeJS.ErrnoException | null)?.code ?? "");
}

function resolveRequested(requested: string, home: string): string {
  if (requested.includes("\0")) throw new PeerDirectoryError(400, "The folder path is not valid.");
  if (requested === "") return path.resolve(home);
  const absolute = process.platform === "win32" ? WINDOWS_ABSOLUTE.test(requested) : path.isAbsolute(requested);
  if (!absolute) throw new PeerDirectoryError(400, "The folder path must be absolute.");
  return path.resolve(requested);
}

async function isDirectoryEntry(dir: string, entry: fs.Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await fs.promises.stat(path.join(dir, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

/** The sub-folders of one folder on this machine. Files are never named, sized, dated or read. */
export async function listPeerDirectories(
  requested: string,
  options: PeerDirectoryOptions = {},
): Promise<PeerDirectoryListing> {
  const homeDir = options.homeDir ?? os.homedir;
  const maxEntries = options.maxEntries ?? PEER_DIRECTORY_MAX_ENTRIES;
  const home = homeDir();
  const dir = resolveRequested(requested, home);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(dir);
  } catch (error) {
    const code = errnoOf(error);
    if (code === "EACCES" || code === "EPERM") throw new PeerDirectoryError(403, "That folder cannot be read.");
    if (code === "ENOTDIR") throw new PeerDirectoryError(400, "That path is not a folder.");
    throw new PeerDirectoryError(404, "That folder was not found.");
  }
  if (!stat.isDirectory()) throw new PeerDirectoryError(400, "That path is not a folder.");

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") throw new PeerDirectoryError(404, "That folder was not found.");
    if (code === "ENOTDIR") throw new PeerDirectoryError(400, "That path is not a folder.");
    throw new PeerDirectoryError(403, "That folder cannot be read.");
  }

  const names: string[] = [];
  for (let start = 0; start < dirents.length; start += SYMLINK_STAT_BATCH) {
    const batch = dirents.slice(start, start + SYMLINK_STAT_BATCH);
    const flags = await Promise.all(batch.map((entry) => isDirectoryEntry(dir, entry)));
    batch.forEach((entry, index) => {
      if (flags[index]) names.push(entry.name);
    });
  }
  names.sort(compareNames);

  const parentDir = path.dirname(dir);
  const driveRoots = process.platform === "win32" ? await (options.driveRoots ?? probeWindowsDriveRoots)() : ["/"];
  const roots = [home, ...driveRoots].filter((root, index, all) => root && all.indexOf(root) === index);

  return {
    path: dir,
    parent: parentDir === dir ? null : parentDir,
    separator: path.sep === "\\" ? "\\" : "/",
    entries: names.slice(0, maxEntries).map((name) => ({ name })),
    roots,
    truncated: names.length > maxEntries,
  };
}
