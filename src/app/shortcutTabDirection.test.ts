import { describe, expect, it } from "vitest";
import { shortcutTabDirection } from "./helpers.js";

/**
 * shortcutTabDirection was byte-identically duplicated in src/stores/terminal.ts
 * and src/composables/useKeyboardShortcuts.ts. This is the shared implementation
 * both were migrated to.
 */
describe("shortcutTabDirection", () => {
  it("returns 1 for PageDown key", () => {
    expect(shortcutTabDirection({ key: "PageDown", code: "" } as KeyboardEvent)).toBe(1);
  });

  it("returns 1 for the mobile/legacy 'Next' key alias", () => {
    expect(shortcutTabDirection({ key: "Next", code: "" } as KeyboardEvent)).toBe(1);
  });

  it("returns 1 when only event.code is PageDown", () => {
    expect(shortcutTabDirection({ key: "", code: "PageDown" } as KeyboardEvent)).toBe(1);
  });

  it("returns -1 for PageUp key", () => {
    expect(shortcutTabDirection({ key: "PageUp", code: "" } as KeyboardEvent)).toBe(-1);
  });

  it("returns -1 for the legacy 'Prior' key alias", () => {
    expect(shortcutTabDirection({ key: "Prior", code: "" } as KeyboardEvent)).toBe(-1);
  });

  it("returns -1 when only event.code is PageUp", () => {
    expect(shortcutTabDirection({ key: "", code: "PageUp" } as KeyboardEvent)).toBe(-1);
  });

  it("returns 0 for unrelated keys", () => {
    expect(shortcutTabDirection({ key: "a", code: "KeyA" } as KeyboardEvent)).toBe(0);
  });

  it("returns 0 for a malformed/missing event", () => {
    expect(shortcutTabDirection({} as KeyboardEvent)).toBe(0);
  });
});
