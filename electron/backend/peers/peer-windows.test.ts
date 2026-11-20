import { describe, expect, test } from "vitest";
import { normalizePeerWindows } from "./peer-windows.js";

const defaultBounds = { x: 100, y: 100, width: 1280, height: 800 };
const context = (windowSlotIds: string[] = ["window-main"]) => ({
  hostIds: new Set(["host-aaaaaaaa"]),
  windowSlotIds: new Set(windowSlotIds),
  defaultBounds,
});
const valid = {
  id: "peer-win-1",
  hostId: "host-aaaaaaaa",
  remoteProfileId: "work",
  bounds: { x: 10, y: 20, width: 900, height: 700 },
  displayId: 3,
  isMaximized: true,
  lastFocusedAt: 55,
};

describe("normalizePeerWindows", () => {
  test("anything but an array is an empty list", () => {
    for (const raw of [undefined, null, {}, "x", 4]) expect(normalizePeerWindows(raw, context())).toEqual([]);
  });

  test("keeps a valid entry with its geometry", () => {
    expect(normalizePeerWindows([valid], context())).toEqual([valid]);
  });

  test("drops an unknown host, a colliding id, a duplicate id and malformed entries", () => {
    const out = normalizePeerWindows(
      [
        valid,
        { ...valid, id: "peer-win-2", hostId: "host-unknown" },
        { ...valid, id: "window-main" },
        { ...valid, remoteProfileId: "other" },
        { ...valid, id: "peer-win-3", remoteProfileId: "" },
        { ...valid, id: "peer-win-4", remoteProfileId: 7 },
        { ...valid, id: "bad id!" },
        { ...valid, id: 5 },
        null,
        "x",
      ],
      context(),
    );
    expect(out.map((entry) => entry.id)).toEqual(["peer-win-1"]);
    expect(out[0]!.remoteProfileId).toBe("work");
  });

  test("fills only what is missing, without inventing a time", () => {
    const [entry] = normalizePeerWindows(
      [{ id: "peer-win-1", hostId: "host-aaaaaaaa", remoteProfileId: "p" }],
      context(),
    );
    expect(entry).toEqual({
      id: "peer-win-1",
      hostId: "host-aaaaaaaa",
      remoteProfileId: "p",
      bounds: defaultBounds,
      isMaximized: false,
      lastFocusedAt: 0,
    });
  });

  test("is idempotent", () => {
    const once = normalizePeerWindows(
      [valid, { id: "peer-win-9", hostId: "host-aaaaaaaa", remoteProfileId: "p" }],
      context(),
    );
    expect(normalizePeerWindows(once, context())).toEqual(once);
  });
});
