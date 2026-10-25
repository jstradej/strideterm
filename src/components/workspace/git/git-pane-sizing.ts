export interface GitPaneSizes {
  sizes: number[];
  minSizes: number[];
}

export function clampGitPaneSizes(sizes: number[], minSizes: number[]): number[] {
  const count = Math.min(sizes.length, minSizes.length);
  const result = sizes.slice(0, count).map((size, index) => Math.max(size, minSizes[index]));
  let total = result.reduce((sum, size) => sum + size, 0);
  for (let index = result.length - 1; index >= 0 && total > 100; index--) {
    const reducible = result[index] - minSizes[index];
    const reduction = Math.min(reducible, total - 100);
    result[index] -= reduction;
    total -= reduction;
  }
  if (total < 100 && result.length) result[result.length - 1] += 100 - total;
  return result;
}

function normalizeWidths(widths: number[], availableWidth: number): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= availableWidth) return widths.map((width) => (width / availableWidth) * 100);
  return widths.map((width) => (width / total) * 100);
}

export function getGitPaneSizes(
  availableWidth: number,
  mode: "branches" | "history",
  treeIntrinsicWidth = 280,
): GitPaneSizes {
  const width = Math.max(1, availableWidth);
  const minWidths =
    mode === "branches"
      ? [Math.min(220, width * 0.22), Math.min(360, width * 0.36), Math.min(360, width * 0.36)]
      : [Math.min(420, width * 0.48), Math.min(360, width * 0.36)];
  const minTotal = minWidths.reduce((sum, paneWidth) => sum + paneWidth, 0);
  const feasibleMinWidths = minTotal > width ? minWidths.map((paneWidth) => (paneWidth / minTotal) * width) : minWidths;
  const minSizes = feasibleMinWidths.map((paneWidth) => (paneWidth / width) * 100);

  const targetWidths =
    mode === "branches"
      ? [Math.min(340, Math.max(220, treeIntrinsicWidth)), Math.min(800, Math.max(640, width * 0.36))]
      : [Math.min(800, Math.max(700, width * 0.4))];
  const initialWidths = [
    ...targetWidths,
    Math.max(0, width - targetWidths.reduce((sum, paneWidth) => sum + paneWidth, 0)),
  ];
  const clampedWidths = initialWidths.map((paneWidth, index) => Math.max(feasibleMinWidths[index], paneWidth));
  let excess = clampedWidths.reduce((sum, paneWidth) => sum + paneWidth, 0) - width;
  for (let index = clampedWidths.length - 1; index >= 0 && excess > 0; index--) {
    const reducible = clampedWidths[index] - feasibleMinWidths[index];
    const reduction = Math.min(reducible, excess);
    clampedWidths[index] -= reduction;
    excess -= reduction;
  }
  const sizes = normalizeWidths(clampedWidths, width);
  return { sizes, minSizes };
}
