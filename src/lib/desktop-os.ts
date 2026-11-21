export type DesktopOs = "windows" | "macos" | "linux";

export function detectDesktopOs(): DesktopOs {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac")) return "macos";
  return "linux";
}
