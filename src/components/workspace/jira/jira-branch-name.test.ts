import { describe, expect, test } from "vitest";
import { jiraBranchName } from "./jira-branch-name.js";

describe("jiraBranchName", () => {
  test("builds feature/<KEY>-<summary words> in lowercase ASCII", () => {
    expect(jiraBranchName("ENG-1", "Login fix")).toBe("feature/ENG-1-login-fix");
  });

  test("drops diacritics, punctuation and repeated separators", () => {
    expect(jiraBranchName("ENG-12", "  Přihlášení: oprav “login”!! (urgent) ")).toBe(
      "feature/ENG-12-prihlaseni-oprav-login-urgent",
    );
  });

  test("falls back to the key alone when the summary has nothing usable", () => {
    expect(jiraBranchName("ENG-3", "???")).toBe("feature/ENG-3");
    expect(jiraBranchName("ENG-3")).toBe("feature/ENG-3");
  });

  test("keeps the part after the prefix within 50 characters and cuts at a word boundary", () => {
    const branch = jiraBranchName(
      "ENG-100",
      "Rework the whole authentication and session handling pipeline end to end",
    );
    expect(branch.startsWith("feature/ENG-100-")).toBe(true);
    expect(branch.length - "feature/".length).toBeLessThanOrEqual(50);
    expect(branch.endsWith("-")).toBe(false);
    expect(branch).toBe("feature/ENG-100-rework-the-whole-authentication-and");
  });

  test("never produces a name git rejects", () => {
    const branch = jiraBranchName("ENG 7/..", "a..b @{ c~d^e:f?g*h[i\\j");
    expect(branch).toMatch(/^feature\/[A-Za-z0-9_-]+$/);
    expect(branch).not.toContain("..");
    expect(branch).not.toMatch(/-$/);
  });

  test("a very long key still leaves a valid name", () => {
    const branch = jiraBranchName("K".repeat(80) + "-1", "fix");
    expect(branch.length - "feature/".length).toBeLessThanOrEqual(50);
    expect(branch).not.toMatch(/-$/);
  });
});
