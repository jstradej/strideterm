import type { SshFileEntry } from "../../../../electron/shared/ssh-file-events.js";

export type SftpSortKey = "name" | "size" | "modified" | "mode";
export interface SftpSort {
  key: SftpSortKey;
  dir: "asc" | "desc";
}

/** Remote paths are POSIX strings (Windows OpenSSH is `/C:/...`): never the host OS separator. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

export function joinRemote(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function breadcrumbs(path: string): Array<{ name: string; path: string }> {
  const crumbs = [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) {
    acc += `/${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

/** True for a folder, and for a symbolic link (it may lead to one: opening it lists, and a failure says why). */
export function isNavigable(entry: SshFileEntry): boolean {
  return entry.type === "dir" || entry.type === "symlink";
}

export function sortEntries(entries: readonly SshFileEntry[], sort: SftpSort): SshFileEntry[] {
  const direction = sort.dir === "asc" ? 1 : -1;
  const compare = (a: SshFileEntry, b: SshFileEntry): number => {
    switch (sort.key) {
      case "size":
        return a.size - b.size;
      case "modified":
        return a.mtimeMs - b.mtimeMs;
      case "mode":
        return a.mode - b.mode;
      default:
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    }
  };
  // Folders stay on top whatever the column.
  return [...entries].sort((a, b) => {
    const folderOrder = Number(b.type === "dir") - Number(a.type === "dir");
    if (folderOrder) return folderOrder;
    return compare(a, b) * direction || a.name.localeCompare(b.name);
  });
}

export function formatMode(entry: Pick<SshFileEntry, "type" | "mode">): string {
  const lead = entry.type === "dir" ? "d" : entry.type === "symlink" ? "l" : "-";
  const bits = "rwxrwxrwx";
  let out = lead;
  for (let index = 0; index < 9; index += 1) out += entry.mode & (1 << (8 - index)) ? bits[index] : "-";
  return out;
}

export function formatModified(mtimeMs: number): string {
  if (!mtimeMs) return "";
  const date = new Date(mtimeMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `root` + a relative sub-folder in the root's own style (the desktop may be Windows while the client is not). */
export function joinLocal(root: string, relative: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const cleaned = relative
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== ".")
    .join(separator);
  const base = root.replace(/[\\/]+$/, "") || root;
  return cleaned ? `${base}${separator}${cleaned}` : base;
}

/** A relative sub-folder must stay below its root. */
export function isSafeRelativeFolder(relative: string): boolean {
  return !relative.split(/[\\/]+/).some((segment) => segment === "..");
}
