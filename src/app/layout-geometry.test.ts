import { describe, expect, test } from "vitest";
import { LAYOUTS } from "./layout-geometry.js";

/**
 * LAYOUTS is the single source of truth for the layout → slot-count/label
 * mapping, imported by app-workspace-actions.ts, app.ts, ContextMenu.vue,
 * LayoutPicker.vue, TabActions.vue, and WorkspaceLayoutChip.vue. This test
 * pins its exact shape so a future edit to one call site's needs doesn't
 * silently change what every other consumer renders.
 */
describe("LAYOUTS", () => {
  test("has the exact expected keys, slot counts, and labels", () => {
    expect(LAYOUTS).toEqual({
      solo: { slots: 1, label: "Solo", shortLabel: "Solo" },
      cols: { slots: 2, label: "Columns", shortLabel: "Side by side" },
      rows: { slots: 2, label: "Rows", shortLabel: "Stacked" },
      "top-split": { slots: 3, label: "Top split", shortLabel: "Top + 2 bottom" },
      "left-split": { slots: 3, label: "Left split", shortLabel: "Left + 2 right" },
      grid: { slots: 4, label: "Grid", shortLabel: "2 × 2 grid" },
    });
  });
});
