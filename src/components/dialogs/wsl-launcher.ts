// WSL launcher command helpers — used by EditTabDialog's WSL mode to convert
// between structured fields (distro / cwd / command / keep-open) and the
// concrete `wsl [-d <distro>] -- bash -lic "…"` boilerplate that ends up in
// panel.command. Extracted from the SFC so the parse / build logic can be
// unit-tested independently of the dialog UI.

export interface WslState {
  distro: string;
  cwd: string;
  command: string;
  keepOpen: boolean;
}

function escapeForDoubleQuoted(s: string): string {
  // Inside bash double-quotes only `"`, `\`, `$`, and backtick need escaping.
  // Single-quoted args inside the inner command stay as the user wrote them.
  return s.replace(/(["\\$`])/g, "\\$1");
}

/**
 * Quote a path that may contain whitespace or shell metacharacters so it
 * survives intact through `bash -lic "cd <path> && …"`. Paths without any
 * special chars pass through unchanged so the generated command stays
 * readable in the common case.
 *
 * Single quotes (rather than double) so we don't have to escape `$`, `` ` ``,
 * etc. inside; the only thing single quotes can't contain is a literal
 * single quote, which we work around with the `'\''` close+escape+reopen
 * idiom.
 */
function quoteShellPath(value: string): string {
  if (!value) return value;
  // No metacharacters → pass through as-is for readability.
  if (!/[\s'"\\$`*?[\](){}<>|&;#~!]/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildWslCommand(state: WslState): string {
  const distro = state.distro.trim();
  const cwd = state.cwd.trim();
  const cmd = state.command.trim();
  const cwdQuoted = cwd ? quoteShellPath(cwd) : "";
  // `&&` between cd and command so we don't keep running on a failed cd.
  const cdAndCmd = cwdQuoted && cmd ? `cd ${cwdQuoted} && ${cmd}` : cwdQuoted ? `cd ${cwdQuoted}` : cmd;
  // `; exec bash` (not `&&`) so the shell stays open even if the command fails.
  const inner = state.keepOpen ? (cdAndCmd ? `${cdAndCmd}; exec bash` : "exec bash") : cdAndCmd;
  if (!inner) return "";
  const distroFlag = distro ? ` -d ${distro}` : "";
  return `wsl${distroFlag} -- bash -lic "${escapeForDoubleQuoted(inner)}"`;
}

export function parseWslCommand(raw: string): WslState | null {
  // Capture group 2 uses `(?:[^"\\]|\\.)*` to consume escaped characters
  // without backtracking — keeps eslint's ReDoS heuristic happy. The
  // `commandInput` field is capped at 500 chars anyway; no realistic risk.
  // eslint-disable-next-line security/detect-unsafe-regex
  const m = /^wsl(?:\s+-d\s+(\S+))?\s+--\s+bash\s+-l?ic?\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw.trim());
  if (!m) return null;
  const distro = m[1] || "";
  // Reverse the escaping we applied on build.
  let inner = m[2].replace(/\\(["\\$`])/g, "$1");
  let keepOpen = false;
  const execMatch = /;\s*exec\s+bash\s*$/.exec(inner);
  if (execMatch) {
    keepOpen = true;
    inner = inner.slice(0, execMatch.index).trim();
  } else if (/^exec\s+bash\s*$/.test(inner)) {
    keepOpen = true;
    inner = "";
  }
  let cwd = "";
  let command = inner.trim();
  // Accept `cd "<path>"`, `cd '<path>'`, or bare `cd <word>`. The quoted
  // forms are what buildWslCommand emits for paths with whitespace; the
  // bare form is for round-tripping legacy commands a user typed by hand
  // before the helper existed. Single-quote contents pass through
  // verbatim (apart from the `'\''` escape sequence we emit in build);
  // double-quote contents are un-escaped the same way as the outer.
  // eslint-disable-next-line security/detect-unsafe-regex
  const cdMatch = /^cd\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'\\'')*)'|(\S+))\s*(?:&&\s*(.*))?$/.exec(command);
  if (cdMatch) {
    if (cdMatch[1] !== undefined) {
      cwd = cdMatch[1].replace(/\\(["\\$`])/g, "$1");
    } else if (cdMatch[2] !== undefined) {
      cwd = cdMatch[2].replace(/'\\''/g, "'");
    } else {
      cwd = cdMatch[3];
    }
    command = (cdMatch[4] || "").trim();
  }
  return { distro, cwd, command, keepOpen };
}
