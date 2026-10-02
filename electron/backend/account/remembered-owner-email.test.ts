import { describe, expect, test } from "vitest";

import {
  matchesAccountDisplay,
  parseRememberedOwnerEmail,
  serializeRememberedOwnerEmail,
} from "./remembered-owner-email.js";

describe("matchesAccountDisplay", () => {
  test.each([
    ["tomas@stradej.cz", "t••••@stradej.cz", "match"],
    ["Tomas@Stradej.cz", "t••••@stradej.cz", "match"],
    ["owner@example.test", "o***@example.test", "match"],
    ["owner@example.test", "ow•••r@ex•••.test", "match"],
    ["jarek@stradej.cz", "t••••@stradej.cz", "mismatch"],
    ["tomas@other.cz", "t••••@stradej.cz", "mismatch"],
    ["t@stradej.cz", "t••••@stradej.cz", "mismatch"],
    ["owner@example.test", "owner@example.test", "match"],
    ["owner@example.test", "other@example.test", "mismatch"],
    ["owner@example.test", undefined, "uncheckable"],
    ["owner@example.test", "  ", "uncheckable"],
    ["owner@example.test", "Personal account", "uncheckable"],
  ] as const)("%s against %s is %s", (email, display, expected) => {
    expect(matchesAccountDisplay(email, display)).toBe(expected);
  });

  test("regex characters in the visible part are literal", () => {
    expect(matchesAccountDisplay("aXb1@example.test", "a.b•@example.test")).toBe("mismatch");
    expect(matchesAccountDisplay("a.b1@example.test", "a.b•@example.test")).toBe("match");
  });
});

describe("parseRememberedOwnerEmail", () => {
  test("round-trips", () => {
    const value = { email: "owner@example.test", uid: "uid-1", savedAt: 5 };
    expect(parseRememberedOwnerEmail(serializeRememberedOwnerEmail(value))).toEqual(value);
  });

  test("nothing stored is null, anything malformed is corrupt", () => {
    expect(parseRememberedOwnerEmail("")).toBeNull();
    expect(parseRememberedOwnerEmail(null)).toBeNull();
    expect(parseRememberedOwnerEmail("{")).toBe("corrupt");
    expect(parseRememberedOwnerEmail(JSON.stringify({ v: 2, email: "a@b", uid: "u", savedAt: 1 }))).toBe("corrupt");
    expect(parseRememberedOwnerEmail(JSON.stringify({ v: 1, email: "nope", uid: "u", savedAt: 1 }))).toBe("corrupt");
  });
});
