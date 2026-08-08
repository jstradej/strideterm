/**
 * Which paths the OS would *run* rather than *open*.
 *
 * `shell.openPath` delegates to the platform opener, and for these extensions
 * that means launching the file, not displaying it. The paths we turn into
 * clickable terminal links come from untrusted output — an agent's response, a
 * log, a file someone else wrote — so a bare click on one of these is a
 * one-click code execution path. Callers use this to interpose a confirmation.
 *
 * The set is deliberately **narrow**: true binaries, installers, script-host
 * formats and shortcut/indirection formats. Source files that merely *can* be
 * executed under an unusual file association are excluded, because their paths
 * appear in every stack trace and a prompt there would train users to click
 * through the one that matters.
 *
 * Known gap this leaves: on Windows the default association for `.js` is
 * Windows Script Host, so a clicked `.js` still runs. Excluding it is a
 * deliberate trade — see the narrow-list rationale above. Users who want no
 * OS-opener behaviour for files at all can set `externalEditor`, which routes
 * every file to their editor and never reaches `shell.openPath`.
 *
 * Not platform-gated on purpose. A `.exe` runs under Wine on Linux, a `.desktop`
 * file is inert on Windows but harmless to ask about, and there is no case
 * where the user wants any of these silently launched. One list is also one
 * behaviour to reason about across the three platforms we ship on.
 */
const RISKY_EXTENSIONS = new Set([
  // Windows executables, installers and script hosts.
  "exe",
  "com",
  "bat",
  "cmd",
  "scr",
  "msi",
  "msp",
  "cpl",
  "hta",
  "pif",
  "vbs",
  "vbe",
  "jar",
  // Indirection: the target is what runs, and it isn't visible in the link.
  "lnk",
  "url",
  "appref-ms",
  // macOS. `.app` is a *directory*, so this has to be checked before the
  // is-a-directory branch that otherwise treats folders as safe to open.
  "app",
  "command",
  "workflow",
  // Linux.
  "desktop",
  "appimage",
  "run",
]);

/**
 * True when handing `filePath` to the OS opener would launch it.
 *
 * Trailing separators are stripped first so a macOS bundle written as
 * `/Applications/Thing.app/` still matches. A leading-dot filename with no
 * other dot (`.bashrc`) is not an extension and never matches.
 */
export function isRiskyExecutable(filePath: string): boolean {
  if (!filePath) return false;
  const trimmed = filePath.replace(/[\\/]+$/, "").toLowerCase();
  const dot = trimmed.lastIndexOf(".");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (dot <= separator + 1) return false;
  return RISKY_EXTENSIONS.has(trimmed.slice(dot + 1));
}
