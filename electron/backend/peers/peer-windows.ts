import type { PeerWindowSlot } from "../../shared/peers.js";
import type { WindowSlotBounds } from "../../shared/types/state.js";

const WINDOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeBounds(raw: unknown, fallback: WindowSlotBounds): WindowSlotBounds {
  const bounds = record(raw);
  if (!bounds) return { ...fallback };
  return {
    x: finiteNumber(bounds.x) ?? fallback.x,
    y: finiteNumber(bounds.y) ?? fallback.y,
    width: finiteNumber(bounds.width) || fallback.width,
    height: finiteNumber(bounds.height) || fallback.height,
  };
}

/**
 * Windows that show a profile of another desktop. Kept apart from `windowSlots` so the local runtime never takes
 * one for a window of a local profile. Pure and idempotent; it invents no ids or timestamps.
 */
export function normalizePeerWindows(
  raw: unknown,
  context: { hostIds: ReadonlySet<string>; windowSlotIds: ReadonlySet<string>; defaultBounds: WindowSlotBounds },
): PeerWindowSlot[] {
  if (!Array.isArray(raw)) return [];
  const out: PeerWindowSlot[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = record(item);
    if (!entry) continue;
    const { id, hostId, remoteProfileId } = entry;
    if (typeof id !== "string" || !WINDOW_ID_PATTERN.test(id)) continue;
    if (seen.has(id) || context.windowSlotIds.has(id)) continue;
    if (typeof hostId !== "string" || !context.hostIds.has(hostId)) continue;
    if (typeof remoteProfileId !== "string" || !remoteProfileId.trim() || remoteProfileId.length > 200) continue;
    seen.add(id);
    const displayId = finiteNumber(entry.displayId);
    out.push({
      id,
      hostId,
      remoteProfileId,
      bounds: normalizeBounds(entry.bounds, context.defaultBounds),
      ...(displayId !== undefined ? { displayId } : {}),
      isMaximized: entry.isMaximized === true,
      lastFocusedAt: finiteNumber(entry.lastFocusedAt) ?? 0,
    });
  }
  return out;
}
