import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import GitTreeGraph from "./GitTreeGraph.vue";

/**
 * Linear commit chain with a single merge:
 *
 *   A ── B ── C ── D    (main)
 *         \
 *          E            (feature, merged into C)
 *
 * Topology: D → C → (B, E) ; E → B ; B → A.
 */
const linearCommits = [
  {
    hash: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    shortHash: "DDDDDDD",
    parents: ["CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"],
    subject: "tip on main",
    author: "Alice",
    relativeDate: "5 minutes ago",
    isoDate: "2026-05-20T10:00:00Z",
    refs: ["HEAD", "main"],
  },
  {
    hash: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    shortHash: "CCCCCCC",
    parents: ["BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
    subject: "merge feature into main",
    author: "Alice",
    relativeDate: "1 hour ago",
    isoDate: "2026-05-20T09:00:00Z",
    refs: [],
  },
  {
    hash: "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    shortHash: "EEEEEEE",
    parents: ["BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
    subject: "feature work",
    author: "Bob",
    relativeDate: "2 hours ago",
    isoDate: "2026-05-20T08:00:00Z",
    refs: ["feature"],
  },
  {
    hash: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    shortHash: "BBBBBBB",
    parents: ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    subject: "second commit",
    author: "Alice",
    relativeDate: "3 hours ago",
    isoDate: "2026-05-20T07:00:00Z",
    refs: [],
  },
  {
    hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    shortHash: "AAAAAAA",
    parents: [],
    subject: "initial commit",
    author: "Alice",
    relativeDate: "1 day ago",
    isoDate: "2026-05-19T10:00:00Z",
    refs: ["origin/main", "tag:v0.1"],
  },
];

function mountGraph(props: Record<string, unknown> = {}) {
  return mount(GitTreeGraph, {
    props: {
      commits: linearCommits,
      head: linearCommits[0].hash,
      selectedHash: "",
      ...props,
    },
  });
}

describe("GitTreeGraph", () => {
  test("renders one row per commit", () => {
    const wrapper = mountGraph();
    const rows = wrapper.findAll(".git-tree__row");
    expect(rows.length).toBe(linearCommits.length);
  });

  test("first row carries HEAD / main badges in the subject cell", () => {
    const wrapper = mountGraph();
    const firstRow = wrapper.find(".git-tree__row");
    expect(firstRow.html()).toContain("HEAD");
    expect(firstRow.html()).toContain("main");
  });

  test("merge commit row gets the --merge subject styling", () => {
    const wrapper = mountGraph();
    const mergeSubject = wrapper.findAll(".git-tree__subject--merge");
    // Exactly one of the 5 commits has 2+ parents (commit C).
    expect(mergeSubject.length).toBe(1);
    expect(mergeSubject[0].text()).toContain("merge feature into main");
  });

  test("tag ref gets the tag pill kind", () => {
    const wrapper = mountGraph();
    const tagBadges = wrapper.findAll(".git-tree__ref--tag");
    expect(tagBadges.length).toBe(1);
    expect(tagBadges[0].text()).toContain("v0.1");
  });

  test("renders the column header on desktop, hides it in compact mode", () => {
    const desktop = mountGraph();
    expect(desktop.findAll(".git-tree__header").length).toBe(1);
    const mobile = mountGraph({ compact: true });
    // CSS hides header in compact mode; the DOM element is still emitted
    // but a quick presence check would be ambiguous. Instead check that
    // hash/author columns aren't rendered per row (compact strips them).
    expect(mobile.findAll(".git-tree__cell--hash").length).toBe(0);
    expect(mobile.findAll(".git-tree__cell--author").length).toBe(0);
  });

  test("clicking a row emits select with its full hash", async () => {
    const wrapper = mountGraph();
    const rows = wrapper.findAll(".git-tree__row");
    await rows[2].trigger("click"); // commit E
    const emitted = wrapper.emitted("select");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual([linearCommits[2].hash]);
  });

  test("double-click emits open", async () => {
    const wrapper = mountGraph();
    const rows = wrapper.findAll(".git-tree__row");
    await rows[0].trigger("dblclick");
    const emitted = wrapper.emitted("open");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual([linearCommits[0].hash]);
  });

  test("empty commit list renders the No-commits placeholder", () => {
    const wrapper = mountGraph({ commits: [] });
    expect(wrapper.text()).toContain("No commits");
  });

  test("error string renders in the error placeholder", () => {
    const wrapper = mountGraph({ commits: [], error: "boom" });
    const ph = wrapper.find(".git-tree__placeholder--error");
    expect(ph.exists()).toBe(true);
    expect(ph.text()).toContain("boom");
  });
});
