// Cross-platform shell-integration init that doesn't leave a visible
// "source <path>" line in the terminal. Each shell gets its idiomatic
// invisible-init mechanism:
//
//  - bash / sh   → BASH_ENV env var (already invisible; nothing to do here)
//  - zsh         → ZDOTDIR override pointing at a loader dir whose .zshrc
//                  sources the user's real .zshrc first, then our integration
//  - pwsh / powershell → `-NoExit -Command "& '<script>'"` args so the script
//                  runs during pwsh init (before the first prompt) instead of
//                  being typed in afterwards
//
// The previous behaviour was to type the source command into the running
// shell via `processHandle.write` — invisible for bash, but a visible `.` /
// `source` line for zsh/pwsh. This module replaces that for known shells.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { strideDataDir } from "./default-state.js";

export interface ShellLauncher {
  file: string;
  args: string[];
}

export interface ShellIntegrationLaunchResult {
  launcher: ShellLauncher;
  env: Record<string, string>;
  /**
   * When true, the caller must NOT type a `source <script>` line into the
   * running shell — this helper already arranged for the script to load via
   * env vars or args. When false, the caller may fall back to the legacy
   * typed-source mechanism (e.g. for shells this helper doesn't know about).
   */
  skipTypedSource: boolean;
}

// zsh reads init files from $ZDOTDIR in this order:
//   .zshenv  (always)
//   .zprofile (login shells)
//   .zshrc   (interactive shells)
//   .zlogin  (login shells)
//   .zlogout (login shell exit)
// We override ZDOTDIR to a loader dir, so all five must be present here as
// chaining stubs — otherwise zsh silently skips the user's real dotfiles
// for everything but .zshrc (and the typical login-shell PATH / env setup
// in .zshenv / .zprofile gets lost). The shared `_strideterm_chain` helper
// is defined in .zshenv (always loaded first) and reused by the others.

const ZSH_ENV_LOADER = `# strIDEterm zsh init loader (.zshenv — auto-generated; safe to delete).
# Defines a helper that sources the same file from the user's real ZDOTDIR,
# then chains this file. Subsequent loader files (.zprofile, .zshrc, etc.)
# reuse the helper.
_strideterm_chain() {
  local user_zdotdir="\${__STRIDETERM_ORIGINAL_ZDOTDIR:-$HOME}"
  local target="$user_zdotdir/$1"
  if [[ -r "$target" ]]; then
    source "$target"
  fi
}
_strideterm_chain .zshenv
`;

const ZSH_PROFILE_LOADER = `# strIDEterm zsh init loader (.zprofile — auto-generated; safe to delete).
_strideterm_chain .zprofile
`;

const ZSH_RC_LOADER = `# strIDEterm zsh init loader (.zshrc — auto-generated; safe to delete).
# Sources user's real .zshrc first, then strIDEterm's OSC 133 integration.
_strideterm_chain .zshrc
if [[ -n "$STRIDETERM_SHELL_INTEGRATION_SCRIPT" && -r "$STRIDETERM_SHELL_INTEGRATION_SCRIPT" ]]; then
  source "$STRIDETERM_SHELL_INTEGRATION_SCRIPT"
fi
`;

const ZSH_LOGIN_LOADER = `# strIDEterm zsh init loader (.zlogin — auto-generated; safe to delete).
_strideterm_chain .zlogin
`;

const ZSH_LOGOUT_LOADER = `# strIDEterm zsh init loader (.zlogout — auto-generated; safe to delete).
_strideterm_chain .zlogout
`;

function shellBasename(filePath: string): string {
  return path
    .basename(filePath || "")
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/**
 * pwsh / powershell command-line flags that mean "run this and exit / run a
 * file". When any of these is present in user-supplied args, we MUST NOT
 * append our own -Command — it would either be ignored, conflict, or change
 * what the user explicitly asked for. PowerShell accepts unambiguous case-
 * insensitive prefixes (e.g. `-com` == `-Command`), which is what the regex
 * below captures.
 */
function pwshHasOwnEntryPoint(args: readonly string[]): boolean {
  // Conservative: -com[mand], -com[mandwithargs], -fil[e], -e[ncodedcommand],
  // and the short -c / -ec. `-File`'s short form is `-f`, but only when it's
  // followed by a value — we accept it if it appears as its own token.
  const re = /^-(?:com[a-z]*|fil[a-z]*|ec|encodedcommand|c|f)$/i;
  return args.some((a) => re.test(a));
}

/**
 * Path to the dir used as ZDOTDIR for zsh sessions. Ensures all five zsh
 * loader files exist on disk and are current. Cheap to rewrite every time
 * (tiny files), so we always overwrite to avoid stale content from older
 * versions.
 */
export function ensureZshLoaderDir(): string {
  const dir = path.join(strideDataDir(), "runtime", "zsh-init");
  mkdirSync(dir, { recursive: true });
  const files: ReadonlyArray<[string, string]> = [
    [".zshenv", ZSH_ENV_LOADER],
    [".zprofile", ZSH_PROFILE_LOADER],
    [".zshrc", ZSH_RC_LOADER],
    [".zlogin", ZSH_LOGIN_LOADER],
    [".zlogout", ZSH_LOGOUT_LOADER],
  ];
  for (const [name, body] of files) {
    writeFileSync(path.join(dir, name), body, { mode: 0o644 });
  }
  return dir;
}

/**
 * Wire shell integration into the launcher in the cleanest per-shell way.
 * Returns the (possibly modified) launcher + env that should be passed to
 * pty.spawn, and a flag telling the caller whether to skip the legacy
 * typed-source path.
 *
 * The `integrationEnv` argument is the output of shellIntegrationEnv() —
 * may be empty if integration is disabled or the shell is unrecognised, in
 * which case this function is a no-op.
 */
export function applyShellIntegrationLaunch(
  launcher: ShellLauncher,
  integrationEnv: Record<string, string>,
): ShellIntegrationLaunchResult {
  const env = { ...integrationEnv };
  const base = shellBasename(launcher.file);

  // No integration env at all → nothing for us to inject. (Either disabled
  // by setting, or shell not recognised by shellIntegrationEnv.)
  if (!integrationEnv.STRIDETERM_SHELL_INTEGRATION) {
    return { launcher, env, skipTypedSource: true };
  }

  if (base === "bash" || base === "sh") {
    // BASH_ENV does the work invisibly. No args / env change needed beyond
    // what shellIntegrationEnv already set.
    return { launcher, env, skipTypedSource: true };
  }

  if (base === "zsh") {
    const loaderDir = ensureZshLoaderDir();
    env.ZDOTDIR = loaderDir;
    return { launcher, env, skipTypedSource: true };
  }

  if (base === "pwsh" || base === "powershell") {
    const scriptPath = env.STRIDETERM_SHELL_INTEGRATION_SCRIPT;
    if (!scriptPath) {
      return { launcher, env, skipTypedSource: true };
    }
    // Respect the user's explicit entry-point: if they're running pwsh with
    // their own -Command / -File / -EncodedCommand, our injection would
    // either get overridden or worse, clash. Their script presumably manages
    // its own lifecycle.
    if (pwshHasOwnEntryPoint(launcher.args)) {
      return { launcher, env, skipTypedSource: true };
    }
    // Escape single quotes for pwsh single-quoted string literal: '' inside
    // '...' represents one literal single quote.
    const escapedPath = scriptPath.replace(/'/g, "''");
    // Dot-source (`.`), NOT call operator (`&`). `&` runs the script in a
    // child scope, so the global `function prompt { … }` defined in pwsh.ps1
    // would vanish when the script returns and OSC 133 D/A/B sequences would
    // never fire at subsequent prompts. Dot-source runs in the caller's
    // scope, which for `-Command` is the global one. (VSCode and Windows
    // Terminal use the same idiom for their pwsh integrations.)
    const nextArgs = [...launcher.args, "-NoExit", "-Command", `. '${escapedPath}'`];
    return {
      launcher: { file: launcher.file, args: nextArgs },
      env,
      skipTypedSource: true,
    };
  }

  // Unknown shell with integration env set — leave it alone and let the
  // caller fall back to the legacy typed-source mechanism if it wants to.
  return { launcher, env, skipTypedSource: false };
}

// Exported only for tests — gives them an isolated way to inspect the
// pwsh-flag detection without going through the whole pipeline.
export const __test = { pwshHasOwnEntryPoint };
