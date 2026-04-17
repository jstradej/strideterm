/**
 * Multi-signal confirmation helpers for T3 (silence-based) alerts.
 * Plan § 3.2.2.
 *
 * A silence timer firing is necessary but NOT sufficient.  Before we raise
 * a T3 alert we want more evidence that the terminal is actually quiet —
 * no cursor animation, no spinner, no scrollback updates in flight.
 * Pure functions; caller feeds them raw PTY output / ANSI bytes.
 */

// ANSI CSI cursor-movement sequences. If we see any of these in a chunk
// the program is redrawing — likely not idle.
//   CSI n A/B/C/D — cursor up/down/forward/back
//   CSI n;m H     — cursor position (H or f)
//   CSI n G       — cursor to column
//   CSI J / CSI K — erase display / line
//   CSI s / CSI u — save/restore cursor
//   ESC[?25h/l    — show/hide cursor
export const CURSOR_MOVEMENT_RE = /\u001b\[(?:\??\d*[hl]|\d*;?\d*[HfJK]|\d*[ABCDGs]|\d*u|\?25[hl])/;

// Progress bar characters — `-` isn't special inside a character class but some
// lint configs flag bare `\-`. Use literal dash at end of class instead.

// Braille spinner frames, block spinners, ASCII spinners.
export const SPINNER_RE = /[\u2800-\u28ff]|[▏▎▍▌▋▊▉█]|[/|\\-]/;

// Progress bar patterns common in install/build output.
export const PROGRESS_RE = /\[[=> -]+\]|\b\d{1,3}%\b/;

/**
 * Returns true if a recent PTY chunk shows the program is animating
 * (cursor movement, spinner) rather than sitting at a static prompt.
 *
 * The caller typically checks this right before firing a T3 alert —
 * if an animation is still going, we wait another round.
 */
export function hasRecentAnimation(chunkText) {
  if (!chunkText) return false;
  if (CURSOR_MOVEMENT_RE.test(chunkText)) return true;
  if (SPINNER_RE.test(chunkText)) return true;
  if (PROGRESS_RE.test(chunkText)) return true;
  return false;
}
