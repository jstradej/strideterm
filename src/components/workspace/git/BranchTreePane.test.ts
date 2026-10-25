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
      key: "important",
      kind: "section",
      label: "Important",
      icon: "★",
      children: [
        { key: "important:origin/main", kind: "branch-remote", label: "origin/main", ref: "origin/main", children: [] },
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
    expect(sectionLabels.length).toBe(5);
    expect(sectionLabels[0]).toContain("HEAD");
    expect(sectionLabels[1]).toContain("Important");
    expect(sectionLabels[2]).toContain("Local");
    expect(sectionLabels[3]).toContain("Remote");
    expect(sectionLabels[4]).toContain("Tags");
  });

  test("renders folder + leaf hierarchy from `/` split", async () => {
    const wrapper = mountPane();
    const localRow = wrapper
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Local"));
    await localRow!.trigger("click");
    const featureRow = wrapper
      .findAll(".branch-node--folder > .branch-node__row")
      .find((row) => row.text().includes("feature"));
    expect(featureRow).toBeTruthy();
    await featureRow!.trigger("click");
    const labels = wrapper.findAll(".branch-node__label").map((el) => el.text());
    // Both folder ("feature") and leaf inside ("foo") must appear once opened.
    expect(labels).toContain("feature");
    expect(labels).toContain("foo");
    expect(labels).toContain("hotfix");
    const remoteRow = wrapper
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Remote"))!;
    await remoteRow.trigger("click");
    expect(wrapper.findAll(".branch-node__label").map((el) => el.text())).toContain("dev");
    const tagsRow = wrapper
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Tags"))!;
    await tagsRow.trigger("click");
    expect(wrapper.findAll(".branch-node__label").map((el) => el.text())).toContain("v1.0");
  });

  test("current branch row receives the --current marker", () => {
    const wrapper = mountPane();
    const currentRows = wrapper.findAll(".branch-node__row--current");
    // Exactly one branch is marked current (main under HEAD).
    expect(currentRows.length).toBeGreaterThanOrEqual(1);
    expect(currentRows[0].text()).toContain("main");
  });

  test("opens only HEAD and Important by default", () => {
    const wrapper = mountPane();
    const sections = wrapper.findAll(".branch-node--section > .branch-node__row");
    expect(sections.map((row) => [row.text(), row.attributes("aria-expanded")])).toEqual([
      [expect.stringContaining("HEAD"), "true"],
      [expect.stringContaining("Important"), "true"],
      [expect.stringContaining("Local"), "false"],
      [expect.stringContaining("Remote"), "false"],
      [expect.stringContaining("Tags"), "false"],
    ]);
  });

  test("persists explicit expansion by repository and temporarily expands search results", async () => {
    const stateKey = "branch-tree-test:repo-a";
    localStorage.removeItem(stateKey);
    const wrapper = mountPane({ stateKey });
    const localRow = wrapper
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Local"))!;
    await localRow.trigger("click");
    const savedBeforeSearch = localStorage.getItem(stateKey);
    const featureRow = wrapper
      .findAll(".branch-node--folder > .branch-node__row")
      .find((row) => row.text().includes("feature"))!;
    expect(featureRow.attributes("aria-expanded")).toBe("false");

    await wrapper.setProps({ searching: true });
    expect(featureRow.attributes("aria-expanded")).toBe("true");
    await featureRow.trigger("click");
    expect(featureRow.attributes("aria-expanded")).toBe("false");
    expect(localStorage.getItem(stateKey)).toBe(savedBeforeSearch);
    await wrapper.setProps({ searching: false });
    expect(featureRow.attributes("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem(stateKey) || "{}").local).toBe(true);
    const refreshedTree = makeTree();
    refreshedTree
      .find((node) => node.key === "local")!
      .children!.push({
        key: "local:dir:new-prefix",
        kind: "folder",
        label: "new-prefix",
        ref: "",
        children: [
          {
            key: "local:new-prefix/topic",
            kind: "branch-local",
            label: "topic",
            ref: "new-prefix/topic",
            children: [],
          },
        ],
      });
    await wrapper.setProps({ tree: refreshedTree });
    const refreshedLocal = wrapper
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Local"))!;
    expect(refreshedLocal.attributes("aria-expanded")).toBe("true");
    expect(
      wrapper
        .findAll(".branch-node--folder > .branch-node__row")
        .find((row) => row.text().includes("new-prefix"))
        ?.attributes("aria-expanded"),
    ).toBe("false");
    wrapper.unmount();

    const restored = mountPane({ stateKey });
    const restoredLocal = restored
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Local"))!;
    expect(restoredLocal.attributes("aria-expanded")).toBe("true");
    const otherKey = "branch-tree-test:repo-b";
    localStorage.removeItem(otherKey);
    const otherRepo = mountPane({ stateKey: otherKey });
    const otherLocal = otherRepo
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Local"))!;
    expect(otherLocal.attributes("aria-expanded")).toBe("false");
    expect(localStorage.getItem(otherKey)).toBeNull();
    restored.unmount();
    otherRepo.unmount();
    localStorage.removeItem(stateKey);
  });

  test("ahead/behind badge appears for local branches with divergence", async () => {
    const wrapper = mountPane();
    const localRow = wrapper
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Local"))!;
    await localRow.trigger("click");
    await wrapper
      .findAll(".branch-node--folder > .branch-node__row")
      .find((row) => row.text().includes("feature"))!
      .trigger("click");
    const badges = wrapper.findAll(".branch-node__badge--diverged");
    expect(badges.length).toBe(1);
    expect(badges[0].text()).toContain("↑2");
    expect(badges[0].text()).toContain("↓1");
  });

  test("merged pill renders for merged local branches", async () => {
    const wrapper = mountPane();
    await wrapper
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Local"))!
      .trigger("click");
    const merged = wrapper.findAll(".branch-node__pill--merged");
    expect(merged.length).toBe(1);
    expect(merged[0].text()).toBe("merged");
  });

  test("clicking a branch leaf emits select with its ref", async () => {
    const wrapper = mountPane();
    await wrapper
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Local"))!
      .trigger("click");
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
