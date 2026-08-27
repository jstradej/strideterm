import { describe, it, expect } from "vitest";
import {
  buildRecentProjection,
  resolveParentId,
  type WorkspaceCardLike,
  type RecentRenderItem,
  type RecentContextRenderItem,
  type RecentWorkspaceRenderItem,
} from "./workspace-sidebar-projection.js";
import type { WorkspaceState } from "../../electron/shared/types/state.js";

const NOW = new Date("2024-01-15T12:00:00.000Z").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ws(id: string, overrides: Record<string, any> = {}): WorkspaceState {
  return {
    id,
    name: id,
    icon: "🗂",
    color: "#fff",
    kind: "terminal",
    source: "manual",
    pluginId: "",
    cwd: "/tmp",
    gitRoots: [],
    activeRootPath: "",
    notes: "",
    profileId: "default",
    connectionId: "",
    activePanelId: null,
    activeViewId: null,
    splitLayout: null,
    splitViewIds: [],
    panels: [],
    review: null,
    quickfix: null,
    starred: false,
    task: null,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as WorkspaceState;
}

function card(id: string, overrides: Partial<WorkspaceCardLike> = {}): WorkspaceCardLike {
  return { id, active: false, attentionCount: 0, attentionFresh: false, depth: 0, name: id, ...overrides };
}

/** Narrow a projection result to just its context rows (typed, not a union). */
function contextItems(items: RecentRenderItem[]): RecentContextRenderItem[] {
  return items.filter((i): i is RecentContextRenderItem => i.type === "context");
}

/** Narrow a projection result to just its real workspace cards (typed, not a union). */
function workspaceItems(items: RecentRenderItem[]): RecentWorkspaceRenderItem[] {
  return items.filter((i): i is RecentWorkspaceRenderItem => i.type === "workspace");
}

function project(opts: {
  workspaces: WorkspaceState[];
  activeWorkspaceId?: string;
  now?: number;
  visibleIds?: Set<string>;
}): RecentRenderItem[] {
  return buildRecentProjection({
    workspaces: opts.workspaces,
    cards: opts.workspaces.map((w) => card(w.id)),
    activeWorkspaceId: opts.activeWorkspaceId || "",
    now: opts.now ?? NOW,
    visibleIds: opts.visibleIds || new Set(opts.workspaces.map((w) => w.id)),
  });
}

describe("buildRecentProjection — bucket edges", () => {
  it.each([
    ["exactly 1h old → last-hour", HOUR, "last-hour"],
    ["1h + 1ms old → last-day", HOUR + 1, "last-day"],
    ["exactly 24h old → last-day", DAY, "last-day"],
    ["24h + 1ms old → last-7-days", DAY + 1, "last-7-days"],
    ["exactly 7d old → last-7-days", WEEK, "last-7-days"],
    ["7d + 1ms old → older", WEEK + 1, "older"],
  ])("%s", (_label, ageMs, expectedSection) => {
    const workspaces = [ws("a", { lastUsedAt: iso(ageMs) })];
    const items = workspaceItems(project({ workspaces }));
    expect(items.find((i) => i.workspaceId === "a")?.sectionKey).toBe(expectedSection);
  });

  it("no recorded lastUsedAt at all → older", () => {
    const items = workspaceItems(project({ workspaces: [ws("a")] }));
    expect(items.find((i) => i.workspaceId === "a")?.sectionKey).toBe("older");
  });
});

describe("buildRecentProjection — ordering", () => {
  it("sorts real workspaces within a section descending by lastUsedAt", () => {
    const workspaces = [
      ws("newest", { lastUsedAt: iso(5 * 60 * 1000) }),
      ws("oldest", { lastUsedAt: iso(50 * 60 * 1000) }),
      ws("middle", { lastUsedAt: iso(20 * 60 * 1000) }),
    ];
    const ids = workspaceItems(project({ workspaces })).map((i) => i.workspaceId);
    expect(ids).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks exact-timestamp ties by stable original array order", () => {
    const sameTime = iso(10 * 60 * 1000);
    const workspaces = [ws("first", { lastUsedAt: sameTime }), ws("second", { lastUsedAt: sameTime })];
    const ids = workspaceItems(project({ workspaces })).map((i) => i.workspaceId);
    expect(ids).toEqual(["first", "second"]);
  });

  it("sorts a real parent's group by its newest real child, not its own timestamp", () => {
    const workspaces = [
      ws("R", { lastUsedAt: iso(4 * DAY) }),
      ws("P", { lastUsedAt: iso(6 * DAY) }),
      ws("C", { task: { parentWorkspaceId: "P" }, lastUsedAt: iso(2 * DAY) }),
    ];
    const items = project({ workspaces });
    const ids = items.filter((i) => i.type !== "section").map((i) => (i as { workspaceId: string }).workspaceId);
    expect(ids).toEqual(["P", "C", "R"]);
  });
});

describe("buildRecentProjection — parent-path context", () => {
  it("puts two children of the same parent in different time sections, each with its own parent context row", () => {
    const workspaces = [
      ws("parent", {}),
      ws("child-recent", { task: { parentWorkspaceId: "parent" }, lastUsedAt: iso(5 * 60 * 1000) }),
      ws("child-old", { task: { parentWorkspaceId: "parent" }, lastUsedAt: iso(3 * DAY) }),
    ];
    // Restrict visibleIds to the two children — "parent" is only reachable
    // through context-path resolution over the full `workspaces` list, not
    // because it is itself eligible to render as a real card here.
    const items = project({ workspaces, visibleIds: new Set(["child-recent", "child-old"]) });
    const contexts = contextItems(items);

    expect(contexts.find((i) => i.sectionKey === "last-hour")?.workspaceId).toBe("parent");
    expect(contexts.find((i) => i.sectionKey === "last-7-days")?.workspaceId).toBe("parent");
    // The parent never renders as a real card — it was excluded from visibleIds.
    expect(workspaceItems(items).some((i) => i.workspaceId === "parent")).toBe(false);
  });

  it("merges a shared ancestor path into a single context row per section", () => {
    const workspaces = [
      ws("root", {}),
      ws("mid", { task: { parentWorkspaceId: "root" } }),
      ws("leaf-a", { task: { parentWorkspaceId: "mid" }, lastUsedAt: iso(5 * 60 * 1000) }),
      ws("leaf-b", { task: { parentWorkspaceId: "mid" }, lastUsedAt: iso(10 * 60 * 1000) }),
    ];
    const contexts = contextItems(project({ workspaces }));

    // Both leaves land in last-hour — "root" and "mid" must each appear
    // exactly once for that section, not once per leaf.
    expect(contexts.filter((i) => i.workspaceId === "root" && i.sectionKey === "last-hour")).toHaveLength(1);
    expect(contexts.filter((i) => i.workspaceId === "mid" && i.sectionKey === "last-hour")).toHaveLength(1);
  });

  it("renders the parent as a full card in its own section and as context in another", () => {
    const workspaces = [
      ws("parent", { lastUsedAt: iso(3 * DAY) }), // last-7-days on its own merit
      ws("child", { task: { parentWorkspaceId: "parent" }, lastUsedAt: iso(5 * 60 * 1000) }), // last-hour
    ];
    const items = project({ workspaces });

    expect(workspaceItems(items).some((i) => i.workspaceId === "parent" && i.sectionKey === "last-7-days")).toBe(true);
    expect(contextItems(items).some((i) => i.workspaceId === "parent" && i.sectionKey === "last-hour")).toBe(true);
  });

  it("projects a multi-level Azure DevOps → review/worktree → task tree with correct depths", () => {
    const workspaces = [
      ws("azure-root", { kind: "azure" }),
      ws("review-branch", {
        review: { provider: "azure-devops", checkout: { mode: "managed-worktree" }, parentWorkspaceId: "azure-root" },
      }),
      ws("task-leaf", {
        kind: "task",
        task: { parentWorkspaceId: "review-branch" },
        lastUsedAt: iso(5 * 60 * 1000),
      }),
    ];
    const items = project({ workspaces });
    const contexts = contextItems(items);

    expect(contexts.find((i) => i.workspaceId === "azure-root")?.depth).toBe(0);
    expect(contexts.find((i) => i.workspaceId === "review-branch")?.depth).toBe(1);
    expect(workspaceItems(items).find((i) => i.workspaceId === "task-leaf")?.depth).toBe(2);
  });
});

describe("buildRecentProjection — missing / cyclic / cross-profile parents", () => {
  it("treats a parentWorkspaceId that doesn't resolve in this profile's list as no parent", () => {
    const workspaces = [ws("orphan", { task: { parentWorkspaceId: "nowhere" }, lastUsedAt: iso(5 * 60 * 1000) })];
    const items = project({ workspaces });
    expect(workspaceItems(items).find((i) => i.workspaceId === "orphan")?.depth).toBe(0);
    expect(contextItems(items)).toHaveLength(0);
  });

  it("does not hang or throw on a cyclic parent relationship, and still renders both workspaces", () => {
    const workspaces = [
      ws("a", { task: { parentWorkspaceId: "b" }, lastUsedAt: iso(5 * 60 * 1000) }),
      ws("b", { task: { parentWorkspaceId: "a" }, lastUsedAt: iso(10 * 60 * 1000) }),
    ];
    expect(() => project({ workspaces })).not.toThrow();
    const ids = workspaceItems(project({ workspaces })).map((i) => i.workspaceId);
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("resolveParentId never resolves a parent outside the supplied (profile-scoped) list", () => {
    const child = ws("child", { task: { parentWorkspaceId: "foreign" } });
    // `resolveParentId` itself just returns the raw id — the profile scoping
    // guarantee comes from buildRecentProjection only ever passing a
    // profile-scoped `workspaces` array, so "foreign" is absent from `byId`.
    expect(resolveParentId(child, [child])).toBe("foreign");

    const items = project({ workspaces: [{ ...child, lastUsedAt: iso(5 * 60 * 1000) } as unknown as WorkspaceState] });
    expect(workspaceItems(items).find((i) => i.workspaceId === "child")?.depth).toBe(0);
  });
});

describe("buildRecentProjection — active-workspace override", () => {
  it("buckets a workspace with no lastUsedAt into Older when it isn't the active workspace", () => {
    const items = workspaceItems(project({ workspaces: [ws("stale")], activeWorkspaceId: "" }));
    expect(items.find((i) => i.workspaceId === "stale")?.sectionKey).toBe("older");
  });

  it("always shows this renderer's active workspace first in Last hour, even without lastUsedAt", () => {
    const workspaces = [
      ws("recent-other", { lastUsedAt: iso(2 * 60 * 1000) }),
      ws("active-migrated", {}), // no lastUsedAt — pre-migration record
    ];
    const items = workspaceItems(project({ workspaces, activeWorkspaceId: "active-migrated" }));
    expect(items[0]?.workspaceId).toBe("active-migrated");
    expect(items[0]?.sectionKey).toBe("last-hour");
  });

  it("promotes a real parent's group to the top of Last hour when the active workspace is nested under it", () => {
    const workspaces = [
      ws("X", { lastUsedAt: iso(10 * 60 * 1000) }),
      ws("P", { lastUsedAt: iso(30 * 60 * 1000) }),
      ws("ACT", { task: { parentWorkspaceId: "P" } }), // no lastUsedAt — active, migrated
    ];
    const items = workspaceItems(project({ workspaces, activeWorkspaceId: "ACT" }));
    const ids = items.map((i) => i.workspaceId);
    expect(ids).toEqual(["P", "ACT", "X"]);
  });
});

describe("buildRecentProjection — the chip never borrows background activity", () => {
  it("drops the tree view's lastActivity so an Older card can't show a fresh age", () => {
    const workspaces = [ws("never-opened")]; // no lastUsedAt
    const items = workspaceItems(
      buildRecentProjection({
        workspaces,
        // The tree view's chip: an agent notification arrived 4 minutes ago.
        cards: [card("never-opened", { lastActivity: "4m", lastActivityTitle: "Last activity: …" })],
        activeWorkspaceId: "",
        now: NOW,
        visibleIds: new Set(["never-opened"]),
      }),
    );
    expect(items[0]?.sectionKey).toBe("older");
    expect(items[0]?.card.lastUsedRelative).toBe("");
    expect(items[0]?.card.lastActivity).toBe("");
    expect(items[0]?.card.lastActivityTitle).toBe("");
  });

  it("keeps showing the last-used age when there is one", () => {
    const workspaces = [ws("worked-in", { lastUsedAt: iso(4 * 60 * 1000) })];
    const items = workspaceItems(
      buildRecentProjection({
        workspaces,
        cards: [card("worked-in", { lastActivity: "2d" })],
        activeWorkspaceId: "",
        now: NOW,
        visibleIds: new Set(["worked-in"]),
      }),
    );
    expect(items[0]?.sectionKey).toBe("last-hour");
    expect(items[0]?.card.lastUsedRelative).toBe("4m");
    expect(items[0]?.card.lastActivity).toBe("");
  });
});
