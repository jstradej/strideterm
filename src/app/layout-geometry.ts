export interface SlotBox {
  rMin: number;
  rMax: number;
  cMin: number;
  cMax: number;
}

export const SLOT_BOXES: Record<string, SlotBox[]> = {
  solo: [{ rMin: 0, rMax: 0, cMin: 0, cMax: 0 }],
  cols: [
    { rMin: 0, rMax: 0, cMin: 0, cMax: 0 },
    { rMin: 0, rMax: 0, cMin: 1, cMax: 1 },
  ],
  rows: [
    { rMin: 0, rMax: 0, cMin: 0, cMax: 0 },
    { rMin: 1, rMax: 1, cMin: 0, cMax: 0 },
  ],
  grid: [
    { rMin: 0, rMax: 0, cMin: 0, cMax: 0 },
    { rMin: 0, rMax: 0, cMin: 1, cMax: 1 },
    { rMin: 1, rMax: 1, cMin: 0, cMax: 0 },
    { rMin: 1, rMax: 1, cMin: 1, cMax: 1 },
  ],
  "top-split": [
    { rMin: 0, rMax: 0, cMin: 0, cMax: 1 },
    { rMin: 1, rMax: 1, cMin: 0, cMax: 0 },
    { rMin: 1, rMax: 1, cMin: 1, cMax: 1 },
  ],
  "left-split": [
    { rMin: 0, rMax: 1, cMin: 0, cMax: 0 },
    { rMin: 0, rMax: 0, cMin: 1, cMax: 1 },
    { rMin: 1, rMax: 1, cMin: 1, cMax: 1 },
  ],
};

export const AREA_NAMES = ["a", "b", "c", "d"] as const;
export const AREA_LAYOUTS = new Set(["top-split", "left-split"]);

export const LAYOUTS: Record<string, { slots: number; label: string }> = {
  solo: { slots: 1, label: "Solo" },
  cols: { slots: 2, label: "Columns" },
  rows: { slots: 2, label: "Rows" },
  "top-split": { slots: 3, label: "Top split" },
  "left-split": { slots: 3, label: "Left split" },
  grid: { slots: 4, label: "Grid" },
};

export function gridAreaStyle(index: number, layout: string): Record<string, string> {
  if (!AREA_LAYOUTS.has(layout)) return {};
  const area = AREA_NAMES[index];
  return area ? { gridArea: area } : {};
}

function boxCenter(box: SlotBox): { r: number; c: number } {
  return { r: (box.rMin + box.rMax) / 2, c: (box.cMin + box.cMax) / 2 };
}

// Direction from src → tgt. If the target's extent covers the source's
// center on an axis, that axis contributes 0.
export function swapDirection(srcBox: SlotBox, tgtBox: SlotBox): [number, number] {
  const src = boxCenter(srcBox);
  let dr = 0;
  if (tgtBox.rMax < src.r) dr = -1;
  else if (tgtBox.rMin > src.r) dr = 1;
  let dc = 0;
  if (tgtBox.cMax < src.c) dc = -1;
  else if (tgtBox.cMin > src.c) dc = 1;
  return [dr, dc];
}

export function swapArrow(dr: number, dc: number): string {
  if (dr < 0 && dc < 0) return "↖";
  if (dr < 0 && dc > 0) return "↗";
  if (dr > 0 && dc < 0) return "↙";
  if (dr > 0 && dc > 0) return "↘";
  if (dr < 0) return "↑";
  if (dr > 0) return "↓";
  if (dc < 0) return "←";
  if (dc > 0) return "→";
  return "⇄";
}
