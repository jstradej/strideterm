import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const css = readFileSync("src/components/workspace/jira/jira-inbox.css", "utf8");
const themeSources = readdirSync("src/styles")
  .filter((file) => file.endsWith(".css"))
  .map((file) => readFileSync(`src/styles/${file}`, "utf8"))
  .concat(readFileSync("src/App.vue", "utf8"))
  .join("\n");
const paneLocalTokens = new Set([
  "--jira-menu-top",
  "--jira-menu-left",
  "--jira-tone",
  "--jira-type",
  "--jira-drawer-w",
  "--jira-surface",
]);

describe("jira-inbox.css theme discipline", () => {
  it("contains no hard-coded hex colour", () => {
    const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex).toEqual([]);
  });

  it("uses no literal rgb/rgba/hsl colour except the theme tint", () => {
    const literals = (css.match(/\b(?:rgba?|hsla?)\([^)]*\)/g) || []).filter((value) => !value.includes("var(--tint)"));
    expect(literals).toEqual([]);
  });

  it("reads only defined variables and never overrides --muted", () => {
    for (const token of new Set(css.match(/var\(--[a-zA-Z0-9-]+/g) || [])) {
      const name = token.slice(4);
      const defined = themeSources.includes(`${name}:`) || paneLocalTokens.has(name);
      expect(defined, `${name} is defined`).toBe(true);
    }
    expect(css).not.toMatch(/^\s*--muted:/m);
  });

  it("styles every status tone the badges can emit", () => {
    for (const tone of ["progress", "waiting", "blocked", "review", "testing", "done", "cancelled"]) {
      expect(css).toContain(`[data-tone="${tone}"]`);
    }
  });

  it("keeps the type scale on the font-size tokens", () => {
    const pixelSizes = css.match(/font-size:\s*[0-9.]+px/g) || [];
    expect(pixelSizes).toEqual([]);
  });

  it("hides the unusable content under the sign-in card and keeps the card in compact detail", () => {
    const signInHide = css.match(/\.jira-inbox\.jira-inbox--sign-in\s*>\s*:not\([^{]*\{\s*display:\s*none/);
    expect(signInHide?.[0]).toContain(":not(.jira-sign-in-card)");
    expect(signInHide?.[0]).not.toContain(":not(.jira-columns)");
    const compactHide = css.match(/\.jira-inbox\.jira-inbox--compact-detail\s*>\s*:not\([^{]*\{\s*display:\s*none/);
    expect(compactHide?.[0]).toContain(":not(.jira-sign-in-card)");
  });

  it("styles the status pill in the teleported hover preview too", () => {
    expect(css).toContain(".jira-issue-preview .jira-status-pill");
    expect(css).toContain('.jira-issue-preview [data-tone="done"]');
  });
});
