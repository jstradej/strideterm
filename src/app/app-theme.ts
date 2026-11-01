// The resolved app theme lives on <html data-theme>. The app store sets it and fires
// `strideterm:theme-changed` on every switch.

export function isLightAppTheme(): boolean {
  return document.documentElement.dataset.theme === "light";
}

/** Runs `apply` on every app theme switch. Returns the unsubscribe. */
export function onAppThemeChange(apply: () => void): () => void {
  window.addEventListener("strideterm:theme-changed", apply);
  return () => window.removeEventListener("strideterm:theme-changed", apply);
}
