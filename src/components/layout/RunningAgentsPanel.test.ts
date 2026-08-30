import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import RunningAgentsPanel from "./RunningAgentsPanel.vue";
import type { RunningAgentRow } from "../../app/selectors.js";
import { buildActivityForest } from "../../app/workspace-activity-tree.js";
import { projectPresentedForest, type PresentedActivityCluster } from "../../app/sidebar-presented-rows.js";

/**
 * V5 review, §3 — RUNNING draws its hierarchy through the SAME activity forest
 * and the same cluster layout as "Recently worked". V4's flat
 * `parent / parent / name` line is gone: a nested task sits under context rows
 * it SHARES with its siblings, and every one of those rows is its own
 * navigable sibling button.
 */

const NOW = 10_000_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function row(overrides: Partial<RunningAgentRow> = {}): RunningAgentRow {
  return {
    key: "ws-a:claude",
    hostWorkspaceId: "ws-a",
    viewId: "ws-a:claude",
    workspaceName: "Alpha",
    workspaceIcon: "A",
    workspaceColor: "#4a9eff",
    ancestry: [],
    ancestors: [],
    label: "Claude",
    state: "running",
    startedAtMs: NOW - 90 * 60_000,
    pausedAtMs: 0,
    finishedAtMs: 0,
    totalPausedMs: 0,
    inGrid: false,
    source: "task",
    ...overrides,
  };
}

function workspace(id: string, overrides: AnyApi = {}): AnyApi {
  return { id, name: id, icon: "", profileId: "default", ...overrides };
}

/** Exactly what SidebarPanel hands the panel: a presented forest. */
function clusters(
  rows: RunningAgentRow[],
  workspaces: AnyApi[] = rows.map((r) => workspace(r.hostWorkspaceId, { name: r.workspaceName })),
  { missingIds = [] as string[] } = {},
): PresentedActivityCluster<RunningAgentRow>[] {
  const live = buildActivityForest({
    selected: rows.map((r) => ({
      key: r.key,
      workspaceId: r.hostWorkspaceId,
      metric: r.startedAtMs ? -r.startedAtMs : Number.NEGATIVE_INFINITY,
      payload: r,
    })),
    workspaces,
  });
  return projectPresentedForest({
    live,
    lockedForest: missingIds.length ? live : null,
    isAlive: (node) => !missingIds.includes(node.workspaceId),
  });
}

describe("RunningAgentsPanel", () => {
  it("renders nothing at all when no agent is running", () => {
    const wrapper = mount(RunningAgentsPanel, { props: { clusters: [], now: NOW } });
    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
    expect(wrapper.text()).toBe("");
  });

  it("renders one activity row per agent, each in its own cluster when unrelated", () => {
    const rows = [
      row({ key: "ws-a:claude" }),
      row({ key: "ws-b:codex", hostWorkspaceId: "ws-b", viewId: "ws-b:codex", workspaceName: "Beta" }),
      row({ key: "ws-c:gemini", hostWorkspaceId: "ws-c", viewId: "ws-c:gemini", workspaceName: "Gamma" }),
    ];
    const wrapper = mount(RunningAgentsPanel, { props: { clusters: clusters(rows), now: NOW } });

    expect(wrapper.findAll('[data-role="activity-cluster"]')).toHaveLength(3);
    expect(wrapper.findAll('[data-role="activity-node-row"]')).toHaveLength(3);
    // A root task needs no context row above it.
    expect(wrapper.findAll('[data-role="activity-context-row"]')).toHaveLength(0);
  });

  it("carries the AGENT count in a sticky header — context rows never inflate it", () => {
    const workspaces = [
      workspace("repo", { name: "Repo" }),
      workspace("task-a", { name: "Task A", task: { parentWorkspaceId: "repo" } }),
      workspace("task-b", { name: "Task B", task: { parentWorkspaceId: "repo" } }),
    ];
    const rows = [
      row({ key: "task-a:w", hostWorkspaceId: "task-a", workspaceName: "Task A" }),
      row({ key: "task-b:w", hostWorkspaceId: "task-b", workspaceName: "Task B" }),
    ];
    const wrapper = mount(RunningAgentsPanel, { props: { clusters: clusters(rows, workspaces), now: NOW } });

    expect(wrapper.get(".running-agents__title").text()).toContain("Running (2)");
    expect(wrapper.findAll('[data-role="activity-context-row"]')).toHaveLength(1);
  });

  it("two agents in one provider branch share their ancestry exactly once", () => {
    const workspaces = [
      workspace("azure", { name: "Azure DevOps" }),
      workspace("pr", {
        name: "mhub PR #30746",
        review: { checkout: { mode: "managed-worktree" }, parentWorkspaceId: "azure" },
      }),
      workspace("task-a", { name: "pr-30746", task: { parentWorkspaceId: "pr" } }),
      workspace("task-b", { name: "pr-30746-b", task: { parentWorkspaceId: "pr" } }),
    ];
    const rows = [
      row({ key: "task-a:w", hostWorkspaceId: "task-a", workspaceName: "pr-30746" }),
      row({ key: "task-b:w", hostWorkspaceId: "task-b", workspaceName: "pr-30746-b" }),
    ];
    const wrapper = mount(RunningAgentsPanel, { props: { clusters: clusters(rows, workspaces), now: NOW } });

    // One cluster, and the shared branch drawn once — not once per task.
    expect(wrapper.findAll('[data-role="activity-cluster"]')).toHaveLength(1);
    const contexts = wrapper.findAll('[data-role="activity-context-row"]');
    expect(contexts.map((c) => c.text())).toEqual(["Azure DevOps", "mhub PR #30746"]);
    // `mhub PR #30746` BRANCHES, so it keeps its own row instead of being
    // folded into the breadcrumb above it.
    expect(contexts[1].attributes("data-depth")).toBe("1");
    const activities = wrapper.findAll('[data-role="activity-node-row"]');
    expect(activities).toHaveLength(2);
    for (const activity of activities) expect(activity.attributes("data-depth")).toBe("2");
  });

  it("an unbranched context-only chain collapses into one breadcrumb row", () => {
    const workspaces = [
      workspace("azure", { name: "Azure DevOps" }),
      workspace("pr", {
        name: "mhub PR #30746",
        review: { checkout: { mode: "managed-worktree" }, parentWorkspaceId: "azure" },
      }),
      workspace("task-a", { name: "pr-30746", task: { parentWorkspaceId: "pr" } }),
    ];
    const rows = [row({ key: "task-a:w", hostWorkspaceId: "task-a", workspaceName: "pr-30746" })];
    const wrapper = mount(RunningAgentsPanel, { props: { clusters: clusters(rows, workspaces), now: NOW } });

    const contexts = wrapper.findAll('[data-role="activity-context-row"]');
    expect(contexts).toHaveLength(1);
    expect(contexts[0].text()).toContain("Azure DevOps › mhub PR #30746");
    // The breadcrumb navigates to the NEAREST parent of the activity below it.
    expect(contexts[0].attributes("data-workspace-id")).toBe("pr");
  });

  it("every row is a sibling button — never a button inside a button", () => {
    const workspaces = [
      workspace("repo", { name: "Repo" }),
      workspace("task-a", { name: "Task A", task: { parentWorkspaceId: "repo" } }),
    ];
    const rows = [row({ key: "task-a:w", hostWorkspaceId: "task-a", workspaceName: "Task A" })];
    const wrapper = mount(RunningAgentsPanel, { props: { clusters: clusters(rows, workspaces), now: NOW } });

    for (const button of wrapper.findAll("button")) {
      expect(button.element.querySelector("button")).toBeNull();
    }
  });

  it("a context click opens its own workspace and no agent panel; a task click opens both", async () => {
    const workspaces = [
      workspace("repo", { name: "Repo" }),
      workspace("task-a", { name: "Task A", task: { parentWorkspaceId: "repo" } }),
    ];
    const rows = [
      row({ key: "task-a:w", hostWorkspaceId: "task-a", viewId: "task-a:worker", workspaceName: "Task A" }),
    ];
    const wrapper = mount(RunningAgentsPanel, { props: { clusters: clusters(rows, workspaces), now: NOW } });

    await wrapper.get('[data-role="activity-context-row"]').trigger("click");
    expect(wrapper.emitted("activate")?.[0]).toEqual([{ hostWorkspaceId: "repo", viewId: "" }]);

    await wrapper.get('[data-role="activity-node-row"]').trigger("click");
    expect(wrapper.emitted("activate")?.[1]).toEqual([{ hostWorkspaceId: "task-a", viewId: "task-a:worker" }]);
  });

  it("emits the host workspace and view — never a workspace id as a view", async () => {
    const rows = [row({ hostWorkspaceId: "task-att", viewId: "attached-primary:task-att" })];
    const wrapper = mount(RunningAgentsPanel, {
      props: { clusters: clusters(rows, [workspace("task-att", { name: "Attached" })]), now: NOW },
    });

    await wrapper.get('[data-role="activity-node-row"]').trigger("click");
    expect(wrapper.emitted("activate")?.[0]).toEqual([
      { hostWorkspaceId: "task-att", viewId: "attached-primary:task-att" },
    ]);
  });

  it("gives an in-grid row the ghost class and its 1-based slot badge", () => {
    const ghost = mount(RunningAgentsPanel, {
      props: { clusters: clusters([row({ inGrid: true, gridSlotIndex: 3 })]), now: NOW },
    });
    expect(ghost.get('[data-role="activity-node-row"]').classes()).toContain("activity-row--in-grid");
    expect(ghost.get(".activity-row__slot").text()).toBe("3");

    const plain = mount(RunningAgentsPanel, { props: { clusters: clusters([row()]), now: NOW } });
    expect(plain.get('[data-role="activity-node-row"]').classes()).not.toContain("activity-row--in-grid");
    expect(plain.find(".activity-row__slot").exists()).toBe(false);
  });

  it("renders the state and the elapsed in their reserved slots, paused stretches removed", () => {
    const wrapper = mount(RunningAgentsPanel, {
      props: {
        clusters: clusters([row({ startedAtMs: NOW - 3 * 60 * 60_000, totalPausedMs: 60 * 60_000 })]),
        now: NOW,
      },
    });
    expect(wrapper.get(".activity-row__state").text()).toBe("running");
    expect(wrapper.get(".activity-row__trailing").text()).toBe("2h 00m");
  });

  it("keeps the longest-running agent on top", () => {
    const rows = [
      row({ key: "young", hostWorkspaceId: "ws-y", workspaceName: "Young", startedAtMs: NOW - 60_000 }),
      row({ key: "old", hostWorkspaceId: "ws-o", workspaceName: "Old", startedAtMs: NOW - 10 * 3600_000 }),
    ];
    const wrapper = mount(RunningAgentsPanel, {
      props: {
        clusters: clusters(rows, [workspace("ws-y", { name: "Young" }), workspace("ws-o", { name: "Old" })]),
        now: NOW,
      },
    });

    expect(wrapper.findAll('[data-role="activity-node-row"]').map((b) => b.text())).toEqual([
      expect.stringContaining("Old"),
      expect.stringContaining("Young"),
    ]);
  });

  // V3 review, §2 — the interaction-lock placeholder. The row's workspace was
  // hard-deleted while the list was frozen: it must hold its place without
  // being an active link to a dead id.
  it("renders a missing row as an inert placeholder of the same shape", async () => {
    const wrapper = mount(RunningAgentsPanel, {
      props: {
        clusters: clusters([row({ inGrid: true, gridSlotIndex: 3 })], undefined, { missingIds: ["ws-a"] }),
        now: NOW,
      },
    });

    const button = wrapper.get('[data-role="activity-node-row"]');
    expect(button.classes()).toContain("activity-row--missing");
    expect(button.classes()).not.toContain("activity-row--in-grid");
    expect(button.attributes("disabled")).toBeDefined();
    // The slots stay, so the row keeps its height; the live values that no
    // longer mean anything are replaced rather than dropped.
    expect(wrapper.find(".activity-row__slot").exists()).toBe(false);
    expect(wrapper.get(".activity-row__state").text()).toBe("");
    expect(wrapper.get(".activity-row__trailing").text()).toBe("gone");
    expect(button.attributes("title")).toContain("no longer available");

    await button.trigger("click");
    expect(wrapper.emitted("activate")).toBeUndefined();
  });

  it("still counts a missing placeholder in the header, so the count matches the rows", () => {
    const rows = [row({ key: "k1" }), row({ key: "k2", hostWorkspaceId: "ws-b", workspaceName: "Beta" })];
    const wrapper = mount(RunningAgentsPanel, {
      props: {
        clusters: clusters(rows, [workspace("ws-a", { name: "Alpha" }), workspace("ws-b", { name: "Beta" })], {
          missingIds: ["ws-a"],
        }),
        now: NOW,
      },
    });

    expect(wrapper.findAll('[data-role="activity-node-row"]')).toHaveLength(2);
    expect(wrapper.get(".running-agents__title").text()).toContain("Running (2)");
  });
});
