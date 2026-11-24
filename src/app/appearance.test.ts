import { afterEach, describe, expect, test, vi } from "vitest";
import { applyAppearance, normalizePalette } from "./appearance.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-palette");
});

describe("applyAppearance", () => {
  test("sets the palette attribute, and removes it for the default or an unknown value", () => {
    applyAppearance({ theme: "dark", palette: "winter" });
    expect(document.documentElement.getAttribute("data-palette")).toBe("winter");
    applyAppearance({ theme: "dark", palette: "default" });
    expect(document.documentElement.hasAttribute("data-palette")).toBe(false);
    applyAppearance({ theme: "dark", palette: "neon" });
    expect(document.documentElement.hasAttribute("data-palette")).toBe(false);
    expect(normalizePalette(undefined)).toBe("default");
  });

  test("tells terminals only when light/dark changes, never for a palette alone", () => {
    const listener = vi.fn();
    window.addEventListener("strideterm:theme-changed", listener);
    try {
      applyAppearance({ theme: "dark", palette: "autumn" });
      applyAppearance({ theme: "dark", palette: "forest" });
      expect(listener).not.toHaveBeenCalled();
      applyAppearance({ theme: "light", palette: "forest" });
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(listener).toHaveBeenCalledTimes(1);
      applyAppearance({ theme: "light", palette: "autumn" });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("strideterm:theme-changed", listener);
    }
  });

  test("a palette change alone tells only the terminals, once per actual change", () => {
    const palette = vi.fn();
    const theme = vi.fn();
    window.addEventListener("strideterm:palette-changed", palette);
    window.addEventListener("strideterm:theme-changed", theme);
    try {
      applyAppearance({ theme: "dark", palette: "default" });
      expect(palette).not.toHaveBeenCalled();
      applyAppearance({ theme: "dark", palette: "soft" });
      applyAppearance({ theme: "dark", palette: "soft" });
      expect(palette).toHaveBeenCalledTimes(1);
      applyAppearance({ theme: "dark", palette: "default" });
      expect(palette).toHaveBeenCalledTimes(2);
      applyAppearance({ theme: "light", palette: "winter" });
      expect(palette).toHaveBeenCalledTimes(2);
      expect(theme).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("strideterm:palette-changed", palette);
      window.removeEventListener("strideterm:theme-changed", theme);
    }
  });
});
