/** Path notation conversion between Windows and a WSL2 distro. Pure string handling. */

export interface MappedWslPath {
  /** The path as the distro sees it. */
  path: string;
  /** Set when the Windows path was a `\\wsl$\<distro>` / `\\wsl.localhost\<distro>` path: the distro that owns it. */
  distro?: string;
  /** True for a `C:\…` path, which WSL reaches through its slower `/mnt/c` file system bridge. */
  windowsDrive: boolean;
}

const DRIVE_RE = /^([A-Za-z]):[\\/]*(.*)$/u;
const WSL_UNC_PREFIX_RE = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]/iu;
const SEPARATOR_RE = /[\\/]/u;

function posixTail(rest: string): string {
  return rest
    .split(/[\\/]+/u)
    .filter((part) => part.length > 0)
    .join("/");
}

function parseWslUnc(windowsPath: string): { distro: string; rest: string } | null {
  const prefix = WSL_UNC_PREFIX_RE.exec(windowsPath);
  if (!prefix) return null;
  const after = windowsPath.slice(prefix[0].length);
  const separator = after.search(SEPARATOR_RE);
  const distro = separator < 0 ? after : after.slice(0, separator);
  if (!distro) return null;
  return { distro, rest: separator < 0 ? "" : after.slice(separator + 1) };
}

/** `C:\work\x` → `/mnt/c/work/x`; `\\wsl$\Ubuntu\home\me\p` → `/home/me/p`. Null for any other Windows path. */
export function windowsPathToWsl(windowsPath: string): MappedWslPath | null {
  const unc = parseWslUnc(windowsPath);
  if (unc) return { path: `/${posixTail(unc.rest)}`, distro: unc.distro, windowsDrive: false };
  const drive = DRIVE_RE.exec(windowsPath);
  if (drive) {
    const tail = posixTail(drive[2]);
    return { path: `/mnt/${drive[1].toLowerCase()}${tail ? `/${tail}` : ""}`, windowsDrive: true };
  }
  return null;
}

/** The distro a set of Windows paths names, when they agree; undefined when none names one. Throws when they disagree. */
export function distroOfPaths(windowsPaths: string[]): string | undefined {
  let found: string | undefined;
  for (const candidate of windowsPaths) {
    const mapped = windowsPathToWsl(candidate);
    if (!mapped?.distro) continue;
    if (found && found.toLowerCase() !== mapped.distro.toLowerCase()) {
      throw new Error(`The workspace folders live in different WSL distributions (${found} and ${mapped.distro}).`);
    }
    found = mapped.distro;
  }
  return found;
}
