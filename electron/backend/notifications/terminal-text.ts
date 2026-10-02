/**
 * The one place that turns terminal BYTES into text a human reads in a
 * notification (phone push, Notification Center body, anything built from a
 * terminal tail). `stripAnsi()` in runtime-utils.ts stays as it is: it feeds
 * the prompt/idle detectors, which want sequences gone and nothing else.
 * Showing the text to a person is different on two counts:
 *
 * 1. A TUI (Claude Code, Ink) draws a gap between words with cursor movement
 *    instead of a literal space. Deleting `CSI n C` glues the words together,
 *    so cursor-forward becomes n spaces and a move to another row becomes a
 *    line break BEFORE the sequence is dropped.
 * 2. A shell can echo terminal INPUT as output. PSReadLine treats ESC as a key
 *    prefix and types the rest of a focus / mouse report into the line, so the
 *    output contains `[O`, `[I` and `[<35;104;24M` with no ESC in front of
 *    them. No ESC means no escape-sequence parser can see them; they are
 *    recognised by shape (see ESC_LESS_RE).
 *
 * Regexes below run on terminal output, never on attacker-controlled network
 * input, so safe-regex's structural heuristics are not a ReDoS signal.
 */
/* eslint-disable security/detect-unsafe-regex */

const MAX_CURSOR_FORWARD = 200;

// Alternatives, in priority order. ESC [ must come before the generic two-byte
// form or `ESC [` would be taken as a complete ESC sequence.
//   1: OSC  ESC ] ... (BEL | ESC \ | ST). Never spans a line, so an
//      unterminated one cannot swallow the rest of the tail.
//   2: DCS / APC / PM / SOS  ESC P|_|^|X ... (ESC \ | ST), same limit.
//   3: CSI  (ESC [ | 0x9B) params intermediates final
//   4: any other ESC sequence: ESC, intermediates, final byte (ESC ( B, ESC 7, ESC =, a stray ESC \)
const TERMINAL_SEQUENCE_RE =
  /\u001B\][^\u0007\u001B\u009C\r\n]*(?:\u0007|\u001B\\|\u009C)?|\u001B[P_^X][^\u001B\u009C\r\n]*(?:\u001B\\|\u009C)?|(?:\u001B\[|\u009B)([0-?]*)[ -/]*([@-~])|\u001B[ -/]*[0-~]/g;

/**
 * What an already-parsed CSI becomes. Only the ones that decide whether two
 * pieces of text were apart on screen leave something behind.
 */
function csiReplacement(params: string, final: string): string {
  // `<`, `=`, `>`, `?` prefixes mark private-mode sequences and input reports.
  if (/^[<=>?]/.test(params)) return "";
  switch (final) {
    case "C": {
      // CUF: n columns forward, a missing or zero count means 1.
      const count = Number.parseInt(params, 10) || 1;
      return " ".repeat(Math.min(count, MAX_CURSOR_FORWARD));
    }
    case "G": // CHA: absolute column
    case "`": // HPA
      return " ";
    case "H": // CUP / HVP: absolute position, i.e. another row
    case "f":
    case "d": // VPA
    case "A": // CUU / CUD / CNL / CPL
    case "B":
    case "E":
    case "F":
      return "\n";
    default:
      return "";
  }
}

// A focus / mouse / bracketed-paste report after its ESC was dropped:
//   [<35;104;24M   [<0;104;24m   [?2004h   [1;5C   [38;5;123m   [200~
// Each form needs something prose does not have: a private prefix before
// digits, or digits joined by `;`.
// `[I` and `[O` alone are ordinary text ("[I]", "[Ok]"), so a focus report is
// only taken as one when it sits in a run with a sequence or another report.
const ESC_LESS_RUN_RE = /(?:\[[IO]|\[(?:[<>?=][0-9]+(?:;[0-9]+)*[A-Za-z]|[0-9]+(?:;[0-9]+)+[A-Za-z]|20[01]~))+/g;
const ESC_LESS_FOCUS_ONLY_RE = /^\[[IO]$/;
const ESC_LESS_ANY_SEQUENCE_RE = /\[(?:[<>?=]|[0-9]+;|20[01]~)/;

function dropEscLessReports(text: string): string {
  return text.replace(ESC_LESS_RUN_RE, (run) => {
    if (ESC_LESS_ANY_SEQUENCE_RE.test(run)) return "";
    // Only focus reports: `[O[I` is a report, a lone `[I` is text.
    return ESC_LESS_FOCUS_ONLY_RE.test(run) ? run : "";
  });
}

/**
 * Plain, readable text for a notification preview. Lines are kept (a tail is
 * several lines), each trimmed with whitespace runs collapsed to one space,
 * empty lines dropped. `\r\n` and a lone `\r` both start a new line.
 */
export function sanitizeTerminalText(value: unknown): string {
  let text = String(value ?? "");
  if (!text) return "";
  text = text.replace(TERMINAL_SEQUENCE_RE, (match, params: string | undefined, final: string | undefined) =>
    final === undefined ? "" : csiReplacement(params ?? "", final),
  );
  text = dropEscLessReports(text);
  return (
    text
      .replace(/\r\n?/g, "\n")
      // C0 except \t and \n, DEL, C1 (and any ESC left over from a truncated sequence).
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
      .split("\n")
      // [^\S\n] is horizontal whitespace, NBSP included.
      .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
  );
}
