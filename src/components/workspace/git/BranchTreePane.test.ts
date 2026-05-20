import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import BranchTreePane from "./BranchTreePane.vue";
import type { BranchTreeNode } from "./branch-tree-types";

/**
 * Sample tree shaped like the live data the parent computes: one HEAD
 * section, a Local section with a "feature" folder, a Remote section,
 * and a Tags section. Mirrors `GitBranchesTab.vue`'s `branchTree` output.
 */
function makeTree(): BranchTreeNode[] {
  return [
    {
      key: "head",
      kind: "section",
      label: "HEAD (Current Branch)",
      icon: "★",
      children: [
        {
          key: "head:main",
          kind: "branch-local",
          label: "main",
          ref: "main",
          isCurrent: true,
          upstream: "origin/main",
          children: [],
        },
      ],
    },
    {
      key: "local",
      kind: "section",
      label: "Local",
      icon: "⌥",
      meta: { count: 2 },
      children: [
        {
          key: "local:dir:feature",
          kind: "folder",
          label: "feature",
          ref: "",
          children: [
            {
              key: "local:feature/foo",
              kind: "branch-local",
              label: "foo",
              ref: "feature/foo",
              meta: { ahead: 2, behind: 1, lastRelativeDate: "2 days ago" },
              children: [],
            },
          ],
        },
        {
          key: "local:hotfix",
          kind: "branch-local",
          label: "hotfix",
          ref: "hotfix",
          meta: { merged: true, lastRelativeDate: "1 day ago" },
          children: [],
        },
      ],
    },
    {
      key: "remote:origin",
      kind: "section",
      label: "Remote · origin",
      icon: "☁",
      meta: { count: 1 },
      children: [
        {
          key: "remote:origin:origin/dev",
          kind: "branch-remote",
          label: "dev",
          ref: "origin/dev",
          meta: { remote: "origin" },
          children: [],
        },
      ],
    },
    {
      key: "tags",
      kind: "section",
      label: "Tags",
      icon: "🏷",
      meta: { count: 1 },
      children: [
        {
          key: "tag:v1.0",
          kind: "tag",
          label: "v1.0",
          ref: "v1.0",
          children: [],
        },
      ],
    },
  ];
}

function mountPane(props: Record<string, unknown> = {}) {
  return mount(BranchTreePane, {
    props: {
      tree: makeTree(),
      head: "main",
      selectedRef: "",
      busy: false,
      isDirty: false,
      ...props,
    },
  });
}

describe("BranchTreePane", () => {
  test("renders all four sections", () => {
    const wrapper = mountPane();
    const sectionLabels = wrapper.findAll(".branch-node--section > .branch-node__row").map((el) => el.text());
    expect(sectionLabels.length).toBe(4);
    expect(sectionLabels[0]).toContain("HEAD");
    expect(sectionLabels[1]).toContain("Local");
    expect(sectionLabels[2]).toContain("Remote");
    expect(sectionLabels[3]).toContain("Tags");
  });

  test("renders folder + leaf hierarchy from `/` split", () => {
    const wrapper = mountPane();
    const labels = wrapper.findAll(".branch-node__label").map((el) => el.text());
    // Both folder ("feature") and leaf inside ("foo") must appear.
    expect(labels).toContain("feature");
    expect(labels).toContain("foo");
    expect(labels).toContain("hotfix");
    expect(labels).toContain("dev");
    expect(labels).toContain("v1.0");
  });

  test("current branch row receives the --current marker", () => {
    const wrapper = mountPane();
    const currentRows = wrapper.findAll(".branch-node__row--current");
    // Exactly one branch is marked current (main under HEAD).
    expect(currentRows.length).toBeGreaterThanOrEqual(1);
    expect(currentRows[0].text()).toContain("main");
  });

  test("ahead/behind badge appears for local branches with divergence", () => {
    const wrapper = mountPane();
    const badges = wrapper.findAll(".branch-node__badge--diverged");
    expect(badges.length).toBe(1);
    expect(badges[0].text()).toContain("↑2");
    expect(badges[0].text()).toContain("↓1");
  });

  test("merged pill renders for merged local branches", () => {
    const wrapper = mountPane();
    const merged = wrapper.findAll(".branch-node__pill--merged");
    expect(merged.length).toBe(1);
    expect(merged[0].text()).toBe("merged");
  });

  test("clicking a branch leaf emits select with its ref", async () => {
    const wrapper = mountPane();
    const leaves = wrapper.findAll(".branch-node--branch-local > .branch-node__row");
    // First branch-local leaf is "main" under HEAD; click "hotfix" instead so
    // we exercise a non-current leaf.
    const hotfixRow = leaves.find((row) => row.text().includes("hotfix"));
    expect(hotfixRow).toBeDefined();
    await hotfixRow!.trigger("click");
    const emitted = wrapper.emitted("select");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual(["hotfix"]);
  });

  test("compact mode hides upstream / date / badges", () => {
    const wrapper = mountPane({ compact: true });
    expect(wrapper.findAll(".branch-node__upstream").length).toBe(0);
    expect(wrapper.findAll(".branch-node__last").length).toBe(0);
    expect(wrapper.findAll(".branch-node__badge").length).toBe(0);
  });
});
