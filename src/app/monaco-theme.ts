import { isLightAppTheme } from "./app-theme.js";

// Monaco has no notion of the app theme, and its theme is page-global: one
// `monaco.editor.setTheme()` repaints every editor on the page.
export function monacoThemeName(): "vs" | "vs-dark" {
  return isLightAppTheme() ? "vs" : "vs-dark";
}
