import { describe, expect, test } from "vitest";
import { clampGitPaneSizes, getGitPaneSizes } from "./git-pane-sizing.js";

describe("getGitPaneSizes", () => {
  test.each([
    [1960, "branches", 260],
    [1760, "history", 280],
    [1100, "branches", 320],
    [760, "history", 280],
    [400, "branches", 280],
    [200, "history", 280],
  ] as const)("fits %s px in %s mode", (width, mode, intrinsicWidth) => {
    const { sizes, minSizes } = getGitPaneSizes(width, mode, intrinsicWidth);
    expect(sizes).toHaveLength(mode === "branches" ? 3 : 2);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(100);
    expect(minSizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(100.001);
    sizes.forEach((size, index) => expect(size).toBeGreaterThanOrEqual(minSizes[index]));
  });

  test("uses the measured tree content within its pixel bounds", () => {
    const narrowTree = getGitPaneSizes(1960, "branches", 170).sizes[0];
    const wideTree = getGitPaneSizes(1960, "branches", 335).sizes[0];
    expect(narrowTree * 19.6).toBeCloseTo(220);
    expect(wideTree * 19.6).toBeCloseTo(335);
  });

  test("gives a long commit list a readable bounded width", () => {
    const sizes = getGitPaneSizes(1760, "history").sizes;
    expect(sizes[0] * 17.6).toBeGreaterThanOrEqual(700);
    expect(sizes[0] * 17.6).toBeLessThanOrEqual(800);
    expect(sizes[1]).toBeGreaterThan(50);
  });

  test("preserves manual proportions until narrower minimums require clamping", () => {
    const manual = [15, 45, 40];
    expect(clampGitPaneSizes(manual, [11, 18, 18])).toEqual(manual);
    expect(clampGitPaneSizes(manual, [22, 36, 36])).toEqual([22, 42, 36]);
  });
});
