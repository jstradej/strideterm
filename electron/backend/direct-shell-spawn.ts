// Detects when `panel.command` is "just a shell with args" (e.g.
// `wsl -- bash -lic "..."`, `pwsh -NoLogo`, `bash --login`) and parses it
// into `{ file, args }` so session-manager can spawn that shell as a direct
// PTY child instead of typing the command into the OS default shell.
//
// Why: on Windows the default shell is cmd/pwsh (per COMSPEC). When panel.command
// is a shell invocation, the current flow spawns the default shell as the PTY
// child and then types the command into it — producing a double-layered PTY
// (ConPTY → default shell → wsl/bash/pwsh). ConPTY's SIGWINCH propagation to a
// grandchild like wsl.exe is unreliable on Windows; the inner shell often
// sticks at the default 80×24, so `tput lines` / `stty size` lie and TUIs
// render with the wrong row count even though the xterm viewport is much
// taller.
//
// Bypassing the typed-injection path for known shells removes that
// intermediate layer entirely.

const KNOWN_SHELL_BASENAMES = new Set(["wsl", "pwsh", "powershell", "cmd", "bash", "sh", "zsh", "fish"]);

export interface DirectShellSpawn {
  file: string;
  args: string[];
}

/**
 * Try to parse `command` into a direct shell spawn. Returns null when the
 * command isn't a recognised shell, isn't a "plain invocation" (has top-level
 * operators that require a parent shell to interpret), or has malformed
 * quoting.
 *
 * The win32 flag is overridable so tests don't depend on the host platform.
 */
export function tryDirectShellSpawn(
  command: string | null | undefined,
  options: { win32?: boolean } = {},
): DirectShellSpawn | null {
  if (!command) return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (hasTopLevelShellOperator(trimmed)) return null;

  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return null;

  const first = tokens[0];
  const baseName = first.replace(/\.exe$/i, "").toLowerCase();
  if (!KNOWN_SHELL_BASENAMES.has(baseName)) return null;

  const isWin = options.win32 ?? process.platform === "win32";
  const file = isWin && !/\.exe$/i.test(first) ? `${first}.exe` : first;

  return { file, args: tokens.slice(1) };
}

/**
 * Shell-style tokenizer that respects single and double quotes. Returns null
 * if quoting is unterminated. Backslash escapes inside double quotes follow
 * POSIX rules (only `\"`, `\\`, `\$`, `\``). Single quotes are literal.
 */
function tokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (inSingle) {
      if (c === "'") {
        inSingle = false;
      } else {
        current += c;
      }
      continue;
    }

    if (inDouble) {
      if (c === "\\" && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          i++;
          continue;
        }
        current += c;
        continue;
      }
      if (c === '"') {
        inDouble = false;
      } else {
        current += c;
      }
      continue;
    }

    if (c === "'") {
      inSingle = true;
      started = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += c;
    started = true;
  }

  if (inSingle || inDouble) return null;
  if (started) tokens.push(current);
  return tokens;
}

/**
 * True if `input` contains a shell metacharacter outside of any quoted span.
 * We refuse to direct-spawn when the command relies on shell features (pipes,
 * sequencing, redirection, background, command substitution) — those need a
 * parent shell to interpret. Operators inside quotes (e.g. `bash -lic "cd && ls"`)
 * are fine because they're a single argument to the shell we're spawning.
 */
function hasTopLevelShellOperator(input: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === "\\" && i + 1 < input.length) {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === ">" || c === "<" || c === "`") {
      return true;
    }
  }
  return false;
}
