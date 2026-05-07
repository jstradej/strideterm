/**
 * Tokeniser + substitutor for the `externalPathOpener.command` setting.
 *
 * The user types something like `code -g ${path}:${line}:${column}` (or
 * with quotes around the binary's path on Windows: `"C:\Program Files\App\bin\app.exe" -g ${path}`).
 * We need to:
 *
 * 1. Split it into argv (binary + args) without invoking a shell — passing
 *    the whole string to `sh -c` would let a filename with backticks /
 *    semicolons execute arbitrary commands. Tokenise here, spawn with
 *    `shell: false` later.
 * 2. Substitute the three placeholders inside each arg AFTER tokenisation,
 *    so a path containing spaces or quotes can't break out of its arg
 *    slot.
 *
 * Supported quoting: single (`'…'`) and double (`"…"`). No escaping
 * inside quotes, no shell expansions, no backslash escapes — strIDEterm
 * config strings are not a shell.
 */

export interface ParsedCommand {
  binary: string;
  args: string[];
}

/**
 * Tokenise a command template into binary + args. Returns null when the
 * template is empty or has an unterminated quote.
 */
export function parseCommandTemplate(template: string): ParsedCommand | null {
  if (typeof template !== "string") return null;
  const tokens: string[] = [];
  let current = "";
  let hasCurrent = false; // empty quoted strings ("" or '') still produce a token
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < template.length; i += 1) {
    const ch = template[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
        hasCurrent = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasCurrent = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (hasCurrent) {
        tokens.push(current);
        current = "";
        hasCurrent = false;
      }
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  if (quote !== null) return null;
  if (hasCurrent) tokens.push(current);
  if (tokens.length === 0) return null;
  return { binary: tokens[0], args: tokens.slice(1) };
}

/**
 * Replace `${path}`, `${line}`, `${column}` placeholders in a single arg.
 * Missing line/column come through as the empty string so users can write
 * a single template that works for both compiler refs (`foo.ts:42:5`) and
 * bare paths.
 */
export function substituteCommandArg(arg: string, filePath: string, line: number, column: number): string {
  return arg
    .replace(/\$\{path\}/g, filePath)
    .replace(/\$\{line\}/g, line ? String(line) : "")
    .replace(/\$\{column\}/g, column ? String(column) : "");
}
