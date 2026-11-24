export const PALETTES = ["default", "soft", "autumn", "winter", "forest"] as const;
export type Palette = (typeof PALETTES)[number];

export const PALETTE_LABELS: Record<Palette, string> = {
  default: "Default",
  soft: "Soft gray",
  autumn: "Autumn",
  winter: "Winter",
  forest: "Forest",
};

export function normalizePalette(value: unknown): Palette {
  return PALETTES.includes(value as Palette) ? (value as Palette) : "default";
}

export function resolveTheme(theme: unknown): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme === "light" ? "light" : "dark";
}

/**
 * Puts the theme and the palette on <html>. Settings previews through this before saving and the app store applies
 * the saved values through it, so the document always reflects whichever was applied last. Editors and other themed
 * widgets are told only when light/dark actually changes; a palette change alone only re-tints the terminals.
 */
export function applyAppearance({ theme, palette }: { theme: unknown; palette: unknown }): void {
  const root = document.documentElement;
  const resolved = resolveTheme(theme);
  const themeChanged = (root.getAttribute("data-theme") === "light" ? "light" : "dark") !== resolved;
  if (resolved === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  const normalized = normalizePalette(palette);
  const paletteChanged = (root.getAttribute("data-palette") ?? "default") !== normalized;
  if (normalized === "default") root.removeAttribute("data-palette");
  else root.setAttribute("data-palette", normalized);
  if (themeChanged) window.dispatchEvent(new CustomEvent("strideterm:theme-changed"));
  else if (paletteChanged) window.dispatchEvent(new CustomEvent("strideterm:palette-changed"));
}
