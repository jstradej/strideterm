import type { PanelState } from "../../electron/shared/types/state.js";

export const PATHS_MIME = "application/x-strideterm-paths";

export type TerminalDropKind = "local" | "wsl" | "ssh" | "powershell";

const SAFE_POSIX = /^[A-Za-z0-9_@%+=:,./-]+$/;
const SAFE_WIN32 = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

export function quotePathForShell(path: string, platform: string): string {
  if (platform === "win32") {
    return SAFE_WIN32.test(path) ? path : `"${path}"`;
  }
  return SAFE_POSIX.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

function quotePathForPowerShell(path: string, platform: string): string {
  const safe = platform === "win32" ? SAFE_WIN32 : SAFE_POSIX;
  return safe.test(path) ? path : `'${path.replace(/'/g, "''")}'`;
}

export function windowsPathToWsl(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const unc = /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(.*)$/i.exec(normalized);
  if (unc) return unc[1] || "/";
  if (!/^[A-Za-z]:(\/|$)/.test(normalized)) return null;
  const rest = normalized.slice(2).replace(/\/+$/, "");
  return `/mnt/${normalized[0].toLowerCase()}${rest}`;
}

export function runtimeAbsolutePath(rootPath: string, relativePath: string, platform: string): string {
  const sep = platform === "win32" ? "\\" : "/";
  const root = rootPath.replace(/[\\/]+$/, "") || (platform === "win32" ? rootPath : "");
  const rel = relativePath.replace(/^[\\/]+/, "");
  const joined = rel ? `${root}${sep}${rel}` : root || sep;
  return platform === "win32" ? joined.replace(/\//g, "\\") : joined;
}

export type FormatDroppedPathsResult = { ok: true; text: string } | { ok: false; error: string };

export function formatDroppedPaths(
  paths: readonly string[],
  platform: string,
  kind: TerminalDropKind,
): FormatDroppedPathsResult {
  if (kind === "ssh") {
    return { ok: false, error: "This is an SSH terminal. A path on this computer means nothing on the remote host." };
  }
  const quoted: string[] = [];
  for (const path of paths) {
    if (kind === "wsl") {
      const converted = windowsPathToWsl(path);
      if (converted === null) {
        return { ok: false, error: `Cannot use "${path}" in WSL: only drive and WSL paths can be mapped.` };
      }
      quoted.push(quotePathForShell(converted, "linux"));
    } else if (kind === "powershell") {
      quoted.push(quotePathForPowerShell(path, platform));
    } else {
      quoted.push(quotePathForShell(path, platform));
    }
  }
  return { ok: true, text: `${quoted.join(" ")} ` };
}

function firstWord(command: string | undefined): string {
  const trimmed = (command || "").trim();
  const match = /^(?:"([^"]*)"|(\S+))/.exec(trimmed);
  return match ? match[1] || match[2] || "" : "";
}

function isWslExecutable(value: string | undefined): boolean {
  const base = firstWord(value).split(/[\\/]/).pop() || "";
  return /^wsl(\.exe)?$/i.test(base);
}

function isPowerShellExecutable(value: string | undefined): boolean {
  const pattern = /^(powershell|pwsh)(\.exe)?$/i;
  return [firstWord(value), (value || "").trim()].some((word) => pattern.test(word.split(/[\\/]/).pop() || ""));
}

export function terminalDropKind(panel: PanelState | null | undefined, platform: string): TerminalDropKind {
  if (!panel) return "local";
  if (panel.launch?.kind === "ssh") return "ssh";
  if ([panel.launch?.file, panel.launch?.command, panel.command].some(isPowerShellExecutable)) return "powershell";
  if (platform !== "win32") return "local";
  if (isWslExecutable(panel.launch?.file) || isWslExecutable(panel.launch?.command) || isWslExecutable(panel.command)) {
    return "wsl";
  }
  return "local";
}

export function setDragPaths(dataTransfer: DataTransfer | null | undefined, paths: readonly string[]): void {
  if (!dataTransfer || !paths.length) return;
  dataTransfer.effectAllowed = "copyMove";
  dataTransfer.setData(PATHS_MIME, JSON.stringify(paths));
  dataTransfer.setData("text/plain", paths.join("\n"));
}

export function readDragPaths(dataTransfer: DataTransfer | null | undefined): string[] | null {
  const raw = dataTransfer?.getData(PATHS_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const paths = parsed.filter((p): p is string => typeof p === "string" && p.length > 0);
    return paths.length ? paths : null;
  } catch {
    return null;
  }
}
