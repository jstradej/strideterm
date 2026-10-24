import { describe, expect, it } from "vitest";
import { guessLanguageFromPath } from "./language-map.js";

describe("guessLanguageFromPath", () => {
  it.each([
    ["src/app.ts", "typescript"],
    ["component.vue", "html"],
    ["package.json", "json"],
    ["README.md", "markdown"],
    ["server.py", "python"],
    ["main.rs", "rust"],
    ["Dockerfile", "dockerfile"],
    ["Makefile", "shell"],
    [".env", "ini"],
  ])("maps %s to a Monaco language", (path, language) => {
    expect(guessLanguageFromPath(path)).toBe(language);
  });

  it("uses plaintext for unknown files", () => {
    expect(guessLanguageFromPath("notes.unknown")).toBe("plaintext");
  });
});
