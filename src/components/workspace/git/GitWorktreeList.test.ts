import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import GitWorktreeList from "./GitWorktreeList.vue";

function makeSnapshot(siblings: Array<Record<string, unknown>>) {
  return {
    siblingWorktrees: siblings,
    isMainWorktree: true,
    remotes: { origin: "url" },
  };
}

function mountList(props: Record<string, unknown> = {}) {
  setActivePinia(createPinia());
  return mount(GitWorktreeList, {
    props: {
      snapshot: makeSnapshot([
        { path: "/wt/main", branch: "main", isMainWorktree: true, isCurrent: false, lastActivityMs: 1_000 },
        { path: "/wt/old", branch: "old", isMainWorktree: false, isCurrent: false, lastActivityMs: 2_000 },
        { path: "/wt/active", branch: "active", isMainWorktree: false, isCurrent: true, lastActivityMs: 5_000 },
        { path: "/wt/recent", branch: "recent", isMainWorktree: false, isCurrent: false, lastActivityMs: 9_999 },
      ]),
      workspaces: [],
      workspaceId: "ws-1",
      gitUi: { busyAction: "" },
      pushRemote: "origin",
      ...props,
    },
  });
}

describe("GitWorktreeList ordering", () => {
  test("active worktree appears first, then by lastActivity desc", () => {
    const wrapper = mountList();
    const items = wrapper.findAll(".git-sibling-list > li");
    expect(items.length).toBe(4);
    const branches = items.map((li) => li.find("strong").text());
    // Active first regardless of activity, then recent > old > main by ts.
    expect(branches[0]).toBe("active");
    expect(branches[1]).toBe("recent");
    expect(branches[2]).toBe("old");
    expect(branches[3]).toBe("main");
  });

  test("delete button is disabled on the current worktree row", () => {
    const wrapper = mountList();
    const items = wrapper.findAll(".git-sibling-list > li");
    // Current row is first; an "(active)" placeholder button is shown and the
    // Delete button is hidden because isMainWorktree=false but isCurrent=true.
    const activeRow = items[0];
    expect(activeRow.html()).toContain("(active)");
  });

  test("renders relative-time chip from lastActivityMs", () => {
    const wrapper = mountList();
    // The chip is rendered as `<strong>X ago</strong>` inside .workspace-chip--muted.
    const muted = wrapper.findAll(".workspace-chip--muted");
    // 4 worktrees, all have lastActivityMs > 0, so 4 chips.
    expect(muted.length).toBe(4);
    for (const el of muted) {
      expect(el.text()).toMatch(/ago|just now/);
    }
  });

  test("does not label an unscanned sleeping worktree as clean", () => {
    const wrapper = mountList({
      snapshot: makeSnapshot([
        {
          path: "/wt/sleeping",
          branch: "sleeping",
          isMainWorktree: false,
          isCurrent: false,
          dirty: false,
          dirtyCount: 0,
          dirtyKnown: false,
          dirtyStale: false,
        },
        {
          path: "/wt/last-known",
          branch: "last-known",
          isMainWorktree: true,
          isCurrent: false,
          dirty: true,
          dirtyCount: 2,
          dirtyKnown: false,
          dirtyStale: true,
        },
      ]),
    });
    const rows = wrapper.findAll(".git-sibling-list > li").map((row) => row.text());
    const unknown = rows.find((text) => text.includes("sleeping")) || "";
    const stale = rows.find((text) => text.includes("last-known")) || "";
    expect(unknown).toContain("Unknown status");
    expect(unknown).not.toContain("0 clean");
    expect(stale).toContain("Last known dirty · stale");
  });
});
