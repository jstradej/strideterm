export interface CommanderEntry {
  name: string;
  kind: "file" | "directory";
  relativePath: string;
  isHidden?: boolean;
  size?: number;
  modifiedAt?: string;
  extension?: string;
}

export interface CommanderRow {
  key: string;
  parent: boolean;
  entry: CommanderEntry | null;
}

export type CommanderSortKey = "name" | "ext" | "size" | "modified";

export function parentPath(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

export function splitName(entry: { name: string; kind: string }): { base: string; ext: string } {
  if (entry.kind === "directory") return { base: entry.name, ext: "" };
  const dot = entry.name.lastIndexOf(".");
  if (dot <= 0 || dot === entry.name.length - 1) return { base: entry.name, ext: "" };
  return { base: entry.name.slice(0, dot), ext: entry.name.slice(dot + 1) };
}

export function formatBytes(bytes: number): string {
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trim(bytes / 1024)} k`;
  return `${trim(bytes / (1024 * 1024))} M`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatCommanderDate(iso: string | undefined, withTime: boolean): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const part = (type: string) => dateFormat.formatToParts(date).find((item) => item.type === type)?.value ?? "";
  const day = `${part("day")}.${part("month")}.${part("year")}`;
  return withTime ? `${day} ${part("hour")}:${part("minute")}` : day;
}

export function buildRows(
  entries: CommanderEntry[],
  options: { path: string; showHidden: boolean; filter: string; sortBy: CommanderSortKey; sortAsc: boolean },
): CommanderRow[] {
  const filter = options.filter.trim().toLowerCase();
  const items = entries.filter(
    (entry) => (options.showHidden || !entry.isHidden) && (!filter || entry.name.toLowerCase().includes(filter)),
  );
  const byName = (a: CommanderEntry, b: CommanderEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const direction = options.sortAsc ? 1 : -1;
  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    if (a.kind === "directory") {
      if (options.sortBy === "modified")
        return direction * (new Date(a.modifiedAt || 0).getTime() - new Date(b.modifiedAt || 0).getTime());
      return (options.sortBy === "name" ? direction : 1) * byName(a, b);
    }
    let cmp: number;
    switch (options.sortBy) {
      case "size":
        cmp = (a.size || 0) - (b.size || 0);
        break;
      case "modified":
        cmp = new Date(a.modifiedAt || 0).getTime() - new Date(b.modifiedAt || 0).getTime();
        break;
      case "ext":
        cmp = splitName(a).ext.localeCompare(splitName(b).ext, undefined, { sensitivity: "base" });
        break;
      default:
        cmp = byName(a, b);
    }
    return direction * (cmp || byName(a, b));
  });
  const rows: CommanderRow[] = items.map((entry) => ({ key: entry.relativePath, parent: false, entry }));
  if (options.path) rows.unshift({ key: "..", parent: true, entry: null });
  return rows;
}

export interface QuickViewState {
  status: "none" | "loading" | "text" | "image" | "empty" | "binary" | "error" | "directory";
  name: string;
  content?: string;
  src?: string;
  message?: string;
}

export interface CommanderMemory {
  paths: [string, string];
  cursors: [string | null, string | null];
  active: 0 | 1;
}

const MEMORY_KEY = "files.commanderPanels";
const MEMORY_MAX_ROOTS = 30;

function loadMemory(): Map<string, CommanderMemory> {
  const map = new Map<string, CommanderMemory>();
  try {
    const parsed = JSON.parse(localStorage.getItem(MEMORY_KEY) || "[]");
    if (!Array.isArray(parsed)) return map;
    for (const item of parsed) {
      const [root, value] = Array.isArray(item) ? item : [];
      const ok =
        typeof root === "string" &&
        Array.isArray(value?.paths) &&
        value.paths.length === 2 &&
        value.paths.every((path: unknown) => typeof path === "string") &&
        Array.isArray(value?.cursors) &&
        value.cursors.every((key: unknown) => key === null || typeof key === "string");
      if (ok) map.set(root, { paths: value.paths, cursors: value.cursors, active: value.active === 1 ? 1 : 0 });
    }
  } catch {
    // UI-state persistence is best effort
  }
  return map;
}

// Also persisted so the panels survive a restart; kept outside the component so switching workspace and back restores them.
export const commanderRootMemory = loadMemory();

export function rememberCommanderRoot(root: string, value: CommanderMemory) {
  commanderRootMemory.delete(root);
  commanderRootMemory.set(root, value);
  while (commanderRootMemory.size > MEMORY_MAX_ROOTS) {
    commanderRootMemory.delete(commanderRootMemory.keys().next().value as string);
  }
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify([...commanderRootMemory]));
  } catch {
    // UI-state persistence is best effort
  }
}

const MARK_MEMORY_MAX = 100;
const commanderMarkMemory = new Map<string, Set<string>>();

// Marks live only for the session: the same Set is handed back on remount so every in-place mutation is remembered.
export function commanderMarksFor(root: string, side: number, path: string, fresh = false): Set<string> {
  const key = JSON.stringify([root, side, path]);
  let marks = fresh ? undefined : commanderMarkMemory.get(key);
  if (!marks) marks = new Set();
  commanderMarkMemory.delete(key);
  commanderMarkMemory.set(key, marks);
  while (commanderMarkMemory.size > MARK_MEMORY_MAX) {
    commanderMarkMemory.delete(commanderMarkMemory.keys().next().value as string);
  }
  return marks;
}

const hostedSelectionMemory = new Map<string, string>();

export function rememberHostedSelection(hostViewId: string, panelId: string) {
  hostedSelectionMemory.set(hostViewId, panelId);
}

export function recallHostedSelection(hostViewId: string): string {
  return hostedSelectionMemory.get(hostViewId) ?? "";
}

export const HISTORY_LIMIT = 50;

export function searchRowIndex(rows: CommanderRow[], prefix: string): number {
  const wanted = prefix.toLowerCase();
  return rows.findIndex((row) => !!row.entry && row.entry.name.toLowerCase().startsWith(wanted));
}

export interface CompareViewState {
  status: "loading" | "ready";
  title: string;
  payload?: {
    leftLabel: string;
    rightLabel: string;
    leftContent: string;
    rightContent: string;
    language: string;
    ok: boolean;
  };
}
