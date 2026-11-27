import { afterEach, describe, expect, it } from "vitest";
import { readUsageStatusBarVisible, writeUsageStatusBarVisible } from "./helpers.js";

describe("usage status bar preference", () => {
  afterEach(() => window.localStorage.removeItem("strideterm.usageStatusBarVisible"));

  it("defaults to off and persists the user's choice locally", () => {
    expect(readUsageStatusBarVisible()).toBe(false);
    writeUsageStatusBarVisible(true);
    expect(readUsageStatusBarVisible()).toBe(true);
    writeUsageStatusBarVisible(false);
    expect(readUsageStatusBarVisible()).toBe(false);
  });
});
