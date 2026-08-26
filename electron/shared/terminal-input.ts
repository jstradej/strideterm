/**
 * Escape sequences a terminal emits on its own behalf — never because the user
 * typed something. Two families:
 *
 *  - Passive input bookkeeping: mouse tracking and focus in/out, which xterm
 *    emits when the user clicks into or focuses a pane without typing.
 *  - Replies the emulator sends when the *running program* interrogates it
 *    (device attributes, cursor position, mode state, window size, colours).
 *    Agent TUIs issue these on startup and on every resize, so treating them
 *    as input would let a window resize masquerade as the user acting.
 *
 * Patterns are deliberately anchored on the report-specific final byte so they
 * cannot swallow real keys: arrows are `ESC [ A-D` (uppercase), bracketed
 * paste ends in `~`, and none of the finals below collide with either.
 */
const PASSIVE_SEQUENCES: RegExp[] = [
  // --- Passive input bookkeeping ---
  // SGR mouse: \x1b[<btn;x;yM or m
  /\x1b\[<\d+;\d+;\d+[Mm]/g,
  // X10/normal mouse: \x1b[M followed by 3 bytes (btn, x, y) — any bytes incl newline
  /\x1b\[M[\s\S]{3}/g,
  // xterm highlight mouse: \x1b[T followed by 6 bytes
  /\x1b\[T[\s\S]{6}/g,
  // Focus in / focus out
  /\x1b\[[IO]/g,

  // --- Emulator replies to a program's query ---
  // Device attributes (DA1/DA2/DA3): \x1b[?1;2c, \x1b[>0;276;0c, …
  // Final byte is lowercase `c`; Right-arrow is uppercase `\x1b[C`.
  /\x1b\[[?>]?[\d;]*c/g,
  // Cursor position report (CPR/DECXCPR): \x1b[24;80R, \x1b[?24;80R
  /\x1b\[\??\d+;\d+R/g,
  // Device status report "ready": \x1b[0n
  /\x1b\[\??\d+n/g,
  // Mode report (DECRPM): \x1b[?2026;2$y
  /\x1b\[\??\d+;\d+\$y/g,
  // Window/text-area/cell size reports: \x1b[8;40;120t, \x1b[4;h;wt, \x1b[6;h;wt
  /\x1b\[\d+;[\d;]*t/g,
  // `\x5c` below is a literal backslash: ESC + backslash is the String Terminator.
  // DECRQSS reply (DCS ... ST): ESC P 1 $ r 0 m ESC \
  /\x1bP[\s\S]*?\x1b\x5c/g,
  // OSC reply, e.g. background colour: ESC ] 11 ; rgb:1e1e/1e1e/1e1e ESC \ (or BEL-terminated)
  /\x1b\][\s\S]*?(?:\x1b\x5c|\x07)/g,
];

/**
 * Returns true if the PTY write data represents a real keypress or pasted text
 * from the user. Returns false if the data is purely passive terminal
 * bookkeeping or an emulator reply — neither means the user did anything.
 *
 * Shared because both sides need the same definition of "the user actually
 * typed here": the backend uses it to decide whether a terminal write should
 * pause a running task workspace, and the renderer uses it to decide whether a
 * write acknowledges that session's notification. Without this filter, clicking
 * into a panel to watch it — or merely resizing the window, which makes agent
 * TUIs re-query the terminal — would pause the task / clear the bell without
 * the user having done anything with the result.
 */
export function hasMeaningfulUserInput(data: string | Buffer | null | undefined): boolean {
  if (!data) return false;
  const str = typeof data === "string" ? data : data.toString("binary");
  // Strip all known passive sequences; if anything remains, it's real input.
  let stripped = str;
  for (const pattern of PASSIVE_SEQUENCES) {
    stripped = stripped.replace(pattern, "");
  }
  return stripped.length > 0;
}
