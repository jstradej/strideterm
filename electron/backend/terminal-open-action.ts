import { parseCommandTemplate } from "./command-template.js";
import type { ParsedCommand } from "./command-template.js";

export type TerminalOpenAction =
  | { kind: "editor"; parsed: ParsedCommand }
  | { kind: "system" }
  | { kind: "command"; template: string }
  | { kind: "internal" };

export interface ResolveOpenActionInput {
  isDirectory: boolean;
  externalEditor: string;
  externalPathOpener: { mode?: string; command?: string };
}

/**
 * Decide how a clicked path link in terminal output should be opened.
 *
 * Resolution order:
 *
 * 1. **File + `externalEditor` set** → spawn the user's editor with the file
 *    path appended as the final argv slot. The editor string is tokenised
 *    argv-style (no shell), so `code --wait` becomes
 *    `spawn("code", ["--wait", <path>])`. Quote paths with spaces in
 *    settings (`"C:\\Program Files\\App\\app.exe"`).
 *
 *    Directories deliberately skip this branch — opening a directory in a
 *    code editor is occasionally useful but more often surprising; the user
 *    settled on "always System for dirs" when the field was wired up. Users
 *    who *do* want their editor to receive directories can switch the more
 *    expressive `externalPathOpener` to `command` mode.
 *
 *    Returns `kind: "editor"` only when tokenisation succeeds. A garbage
 *    template (empty after trim, unterminated quote) falls through to step
 *    2 so the user still gets *something* on click instead of a silent no-op.
 *
 * 2. **`externalPathOpener.mode`**:
 *    - `"command"` → spawn the user template with placeholder substitution
 *      (`${path}`, `${line}`, `${column}`).
 *    - `"internal"` → hand back to the renderer for the in-app Files pane.
 *    - anything else (including `"system"` and unrecognised) → `shell.openPath`.
 */
export function resolveTerminalOpenAction(input: ResolveOpenActionInput): TerminalOpenAction {
  const editor = (input.externalEditor || "").trim();
  if (editor && !input.isDirectory) {
    const parsed = parseCommandTemplate(editor);
    if (parsed) return { kind: "editor", parsed };
  }
  const rawMode = input.externalPathOpener?.mode;
  if (rawMode === "internal") return { kind: "internal" };
  if (rawMode === "command") {
    return { kind: "command", template: input.externalPathOpener?.command || "" };
  }
  return { kind: "system" };
}
