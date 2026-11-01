import type { ITheme } from "@xterm/xterm";
import { isLightAppTheme } from "./app-theme.js";

// xterm's built-in ANSI palette is tuned for a dark background: its yellow,
// bright green / yellow / cyan and both whites all but vanish on a light one.
// This palette (GitHub light, with a warmer yellow) is readable on white. Programs that
// paint in a 256-colour or truecolor shade of their own are not covered by a
// palette, so the light theme also sets a minimum contrast ratio and lets xterm
// darken whatever would still be too faint.
export const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#18181b",
  cursor: "#18181b",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(0,0,0,0.15)",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#8a6100",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  // Light on purpose: Codex paints the user's prompt rows with ANSI 8 as the background.
  // Used as a text colour it is still readable, because the minimum contrast ratio darkens it.
  brightBlack: "#e6e8ec",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#9a7200",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

/** WCAG AA for body text in the light theme; xterm's default of 1 leaves colours untouched. */
export function terminalMinimumContrastRatio(): number {
  return isLightAppTheme() ? 4.5 : 1;
}
