/**
 * V2 plan, Fáze 4 — the recent projection reduced to a pure "recently worked"
 * shortcut selector: a flat, deduplicated, 24-hour list carrying each result's
 * own ancestor identity. No buckets, no active-workspace override, no context
 * rows, no re-derived copy of the tree.
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "../../electron/shared/types/state.js";
import { buildRecentWorkspaceShortcuts, RECENT_WINDOW_MS } from "./workspace-sidebar-projection.js";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** ISO timestamp `ageMs` before NOW. */
function iso(ageMs: number): string {
  return new Date(NOW - ageMs).toISOString();
}

function workspace(id: string, extra: Record<string, unknown> = {}): WorkspaceState {
  return { id, name: id, profileId: "p1", notes: "", panels: [], ...extra } as unknown as WorkspaceState;
}

function shortcuts(workspaces: WorkspaceState[], visibleIds?: Set<string> | null) {
  return buildRecentWorkspaceShortcuts({ workspaces, now: NOW, visibleIds });
}

function ids(workspaces: WorkspaceState[], visibleIds?: Set<string> | null): string[] {
  return shortcuts(workspaces, visibleIds).map((row) => row.workspaceId);
}

describe("buildRecentWorkspaceShortcuts — the 24h window", () => {
  it("includes a workspace worked in a minute ago", () => {
    expect(ids([workspace("a", { lastWorkedAt: iso(MINUTE) })])).toEqual(["a"]);
  });

  it("includes one worked in just under 24 hours ago", () => {
    expect(ids([workspace("a", { lastWorkedAt: iso(RECENT_WINDOW_MS - 1) })])).toEqual(["a"]);
  });

  it("drops one exactly 24 hours old — the boundary is exclusive", () => {
    expect(ids([workspace("a", { lastWorkedAt: iso(RECENT_WINDOW_MS) })])).toEqual([]);
  });

  it("drops anything older", () => {
    expect(ids([workspace("a", { lastWorkedAt: iso(RECENT_WINDOW_MS + MINUTE) })])).toEqual([]);
  });

  it("drops a workspace that was never worked in", () => {
    expect(ids([workspace("a")])).toEqual([]);
  });

  it("drops an unparseable timestamp instead of rendering an invalid date", () => {
    expect(ids([workspace("a", { lastWorkedAt: "not-a-date" })])).toEqual([]);
  });

  it("keeps a future timestamp (clock skew) rather than silently discarding it", () => {
    expect(ids([workspace("a", { lastWorkedAt: new Date(NOW + HOUR).toISOString() })])).toEqual(["a"]);
  });

  it("gives the active workspace no exemption at all", () => {
    // The old projection force-promoted the renderer's active workspace into
    // "Last hour" whether or not any work had happened there.
    const rows = ids([workspace("active-but-idle"), workspace("worked", { lastWorkedAt: iso(2 * HOUR) })]);
    expect(rows).toEqual(["worked"]);
  });
});

describe("buildRecentWorkspaceShortcuts — ordering", () => {
  it("is newest-first", () => {
    const rows = ids([
      workspace("middle", { lastWorkedAt: iso(20 * MINUTE) }),
      workspace("newest", { lastWorkedAt: iso(5 * MINUTE) }),
      workspace("oldest", { lastWorkedAt: iso(50 * MINUTE) }),
    ]);
    expect(rows).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks an exact tie by the canonical workspace order", () => {
    const sameTime = iso(5 * MINUTE);
    const rows = ids([workspace("second", { lastWorkedAt: sameTime }), workspace("first", { lastWorkedAt: sameTime })]);
    // "second" comes first because it comes first in the manual order.
    expect(rows).toEqual(["second", "first"]);
  });

  it("lists every qualifying workspace exactly once", () => {
    const rows = ids([
      workspace("a", { lastWorkedAt: iso(MINUTE) }),
      workspace("b", { lastWorkedAt: iso(2 * MINUTE), task: { parentWorkspaceId: "a" } }),
      workspace("c", { lastWorkedAt: iso(3 * MINUTE), task: { parentWorkspaceId: "a" } }),
    ]);
    expect(rows).toEqual(["a", "b", "c"]);
    expect(new Set(rows).size).toBe(rows.length);
  });
});

describe("buildRecentWorkspaceShortcuts — ancestor identity", () => {
  it("carries the full ancestor chain, root first", () => {
    const rows = shortcuts([
      workspace("root", { name: "Root" }),
      workspace("mid", { name: "Mid", quickfix: { parentWorkspaceId: "root" } }),
      workspace("leaf", { name: "Leaf", task: { parentWorkspaceId: "mid" }, lastWorkedAt: iso(MINUTE) }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].ancestors.map((a) => a.name)).toEqual(["Root", "Mid"]);
  });

  // V4 review, §"Datový model" — the box-in-box context header draws the
  // immediate parent the way its own tree card is drawn, so a name alone is
  // not enough: it needs the same badge glyph and accent colour.
  it("carries each ancestor's renderable identity, not just its name", () => {
    const rows = shortcuts([
      workspace("root", { name: "Root", icon: "R", color: "#123456", kind: "manual" }),
      workspace("leaf", { name: "Leaf", task: { parentWorkspaceId: "root" }, lastWorkedAt: iso(MINUTE) }),
    ]);

    expect(rows[0].ancestors).toEqual([{ id: "root", name: "Root", icon: "R", color: "#123456", kind: "manual" }]);
  });

  it("falls back to the id and empty identity for an ancestor with nothing set", () => {
    const rows = shortcuts([
      workspace("root", { name: "" }),
      workspace("leaf", { task: { parentWorkspaceId: "root" }, lastWorkedAt: iso(MINUTE) }),
    ]);

    expect(rows[0].ancestors).toEqual([{ id: "root", name: "root", icon: "", color: "", kind: "" }]);
  });

  it("names an ancestor even when the star filter hid it from the rows", () => {
    const rows = shortcuts(
      [
        workspace("root", { name: "Root" }),
        workspace("leaf", { name: "Leaf", task: { parentWorkspaceId: "root" }, lastWorkedAt: iso(MINUTE) }),
      ],
      new Set(["leaf"]),
    );
    expect(rows.map((r) => r.workspaceId)).toEqual(["leaf"]);
    expect(rows[0].ancestors.map((a) => a.name)).toEqual(["Root"]);
  });

  it("survives a missing parent, a cycle and a cross-profile parent", () => {
    const rows = shortcuts([
      workspace("orphan", { task: { parentWorkspaceId: "gone" }, lastWorkedAt: iso(MINUTE) }),
      workspace("cycle-a", { task: { parentWorkspaceId: "cycle-b" }, lastWorkedAt: iso(2 * MINUTE) }),
      workspace("cycle-b", { task: { parentWorkspaceId: "cycle-a" }, lastWorkedAt: iso(3 * MINUTE) }),
      workspace("foreign-parent", { name: "Secret", profileId: "p2" }),
      workspace("child", { task: { parentWorkspaceId: "foreign-parent" }, lastWorkedAt: iso(4 * MINUTE) }),
    ]);
    expect(rows.map((r) => r.workspaceId)).toEqual(["orphan", "cycle-a", "cycle-b", "child"]);
    for (const row of rows) expect(row.ancestors).toEqual([]);
  });

  it("exposes the raw stamp, its epoch ms and the display fields the row renders", () => {
    const stamp = iso(7 * MINUTE);
    const [row] = shortcuts([workspace("a", { name: "Alpha", icon: "🚀", lastWorkedAt: stamp })]);
    expect(row).toMatchObject({
      workspaceId: "a",
      name: "Alpha",
      icon: "🚀",
      lastWorkedAt: stamp,
      lastWorkedAtMs: Date.parse(stamp),
      ancestors: [],
    });
  });

  // The row NAMES its whole chain (its accessible name is the full path) even
  // though the shape it is drawn in now comes from the activity forest — so
  // the chain still has to be complete and still has to come from the same
  // tree index, guards included (V3 review, §3).
  it("carries the whole ancestor chain, root first", () => {
    const rows = shortcuts([
      workspace("root", { name: "Root", lastWorkedAt: iso(3 * MINUTE) }),
      workspace("mid", { name: "Mid", quickfix: { parentWorkspaceId: "root" }, lastWorkedAt: iso(2 * MINUTE) }),
      workspace("leaf", { name: "Leaf", task: { parentWorkspaceId: "mid" }, lastWorkedAt: iso(MINUTE) }),
    ]);

    expect(rows.map((row) => [row.workspaceId, row.ancestors.map((a) => a.name)])).toEqual([
      ["leaf", ["Root", "Mid"]],
      ["mid", ["Root"]],
      ["root", []],
    ]);
  });
});

describe("buildRecentWorkspaceShortcuts — filtering", () => {
  it("honours an explicit visible-id set", () => {
    const workspaces = [
      workspace("a", { lastWorkedAt: iso(MINUTE) }),
      workspace("b", { lastWorkedAt: iso(2 * MINUTE) }),
    ];
    expect(ids(workspaces, new Set(["b"]))).toEqual(["b"]);
  });

  it("returns everything qualifying when no visible-id set is given", () => {
    const workspaces = [
      workspace("a", { lastWorkedAt: iso(MINUTE) }),
      workspace("b", { lastWorkedAt: iso(2 * MINUTE) }),
    ];
    expect(ids(workspaces)).toEqual(["a", "b"]);
    expect(ids(workspaces, null)).toEqual(["a", "b"]);
  });

  it("is never truncated — the limit is the component's business", () => {
    const workspaces = Array.from({ length: 12 }, (_, i) =>
      workspace(`w${i}`, { lastWorkedAt: iso((i + 1) * MINUTE) }),
    );
    expect(ids(workspaces)).toHaveLength(12);
  });
});
