import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import WorkspaceCard from "./WorkspaceCard.vue";
import { heartbeatTargetCount, resetHeartbeatForTests } from "../../app/status-heartbeat.js";

/**
 * The sidebar card owns three of the shared heartbeat's primary targets: the
 * running task dot, the active-PR dot, and the pending-checks dot. Each must
 * register only in its own state, drop out again without a remount when the
 * state moves on, and keep carrying that state statically (colour class,
 * glyph, title) between beats.
 */

/** The subset of WorkspaceCardData these tests drive. */
interface CardWorkspace {
  active: boolean;
  attentionCount: number;
  attentionFresh: boolean;
  depth: number;
  name: string;
  id: string;
  kind?: string;
  taskState?: string;
  prStatus?: string;
  checksState?: string;
  starred?: boolean;
  lastActivity?: string;
  lastActivityTitle?: string;
}

function props(overrides: Partial<CardWorkspace> = {}): { workspace: CardWorkspace } {
  return {
    workspace: {
      active: false,
      attentionCount: 0,
      attentionFresh: false,
      depth: 0,
      name: "ws",
      id: "ws-1",
      ...overrides,
    },
  };
}

describe("WorkspaceCard — shared heartbeat targets", () => {
  beforeEach(() => {
    resetHeartbeatForTests();
  });

  afterEach(() => {
    resetHeartbeatForTests();
  });

  test("a running task dot registers exactly one target", () => {
    const wrapper = mount(WorkspaceCard, { props: props({ kind: "task", taskState: "running" }) });

    expect(heartbeatTargetCount()).toBe(1);
    const dot = wrapper.get(".workspace-card__status-dot");
    expect(dot.classes()).toContain("workspace-card__status-dot--running");
    expect(dot.attributes("title")).toBe("Running…");

    wrapper.unmount();
    expect(heartbeatTargetCount()).toBe(0);
  });

  test("running → completed deregisters without remounting the dot", async () => {
    const wrapper = mount(WorkspaceCard, { props: props({ kind: "task", taskState: "running" }) });
    const el = wrapper.get(".workspace-card__status-dot").element;
    expect(heartbeatTargetCount()).toBe(1);

    // setProps's typing is too strict on script-setup components; cast to
    // accept the prop name the component does take (same precedent as
    // AgentProviderConfig.test.ts / TerminalSearchOverlay.test.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper as any).setProps(props({ kind: "task", taskState: "completed" }));

    expect(heartbeatTargetCount()).toBe(0);
    const dot = wrapper.get(".workspace-card__status-dot");
    // Same DOM node — the binding, not a v-if, drives registration.
    expect(dot.element).toBe(el);
    // Static semantics survive: colour class and title still say "completed".
    expect(dot.classes()).toContain("workspace-card__status-dot--completed");
    expect(dot.attributes("title")).toBe("Completed");

    wrapper.unmount();
  });

  test.each([
    ["completed", "workspace-card__status-dot--completed"],
    ["failed", "workspace-card__status-dot--failed"],
    ["stopped", "workspace-card__status-dot--stopped"],
    ["paused", "workspace-card__status-dot--paused"],
  ])("a %s task dot is static", (taskState, expectedClass) => {
    const wrapper = mount(WorkspaceCard, { props: props({ kind: "task", taskState }) });

    expect(heartbeatTargetCount()).toBe(0);
    expect(wrapper.get(".workspace-card__status-dot").classes()).toContain(expectedClass);

    wrapper.unmount();
  });

  test("an open PR dot registers; merged and abandoned ones do not", () => {
    const open = mount(WorkspaceCard, { props: props({ prStatus: "active" }) });
    expect(heartbeatTargetCount()).toBe(1);
    expect(open.get(".workspace-card__status-dot").classes()).toContain("workspace-card__status-dot--pr-active");
    open.unmount();

    for (const prStatus of ["completed", "abandoned"]) {
      const wrapper = mount(WorkspaceCard, { props: props({ prStatus }) });
      expect(heartbeatTargetCount()).toBe(0);
      wrapper.unmount();
    }
  });

  test("only the pending checks dot registers, and it keeps its title", async () => {
    const wrapper = mount(WorkspaceCard, { props: props({ checksState: "pending" }) });

    expect(heartbeatTargetCount()).toBe(1);
    const dot = wrapper.get(".workspace-card__checks-dot");
    expect(dot.classes()).toContain("workspace-card__checks-dot--pending");
    expect(dot.attributes("title")).toContain("still running");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper as any).setProps(props({ checksState: "passed" }));
    expect(heartbeatTargetCount()).toBe(0);
    expect(wrapper.get(".workspace-card__checks-dot").classes()).toContain("workspace-card__checks-dot--passed");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper as any).setProps(props({ checksState: "failed" }));
    expect(heartbeatTargetCount()).toBe(0);

    wrapper.unmount();
  });

  test("a running task with pending checks registers both dots and no more", () => {
    const wrapper = mount(WorkspaceCard, {
      props: props({ kind: "task", taskState: "running", checksState: "pending" }),
    });

    expect(heartbeatTargetCount()).toBe(2);

    wrapper.unmount();
    expect(heartbeatTargetCount()).toBe(0);
  });

  test("a card with no live state registers nothing", () => {
    const wrapper = mount(WorkspaceCard, { props: props() });

    expect(wrapper.find(".workspace-card__status-dot").exists()).toBe(false);
    expect(heartbeatTargetCount()).toBe(0);

    wrapper.unmount();
  });
});

// The card's timestamp chip has exactly one meaning again: PR/git/attention
// "last activity". V2 moved "when did I last work here" out of the card and
// into the recent shortcut card, so the card no longer takes a second,
// recent-view-only timestamp that silently outranked this one.
describe("WorkspaceCard — last-activity timestamp", () => {
  test("shows the tree-view last activity with its own tooltip", () => {
    const wrapper = mount(WorkspaceCard, {
      props: props({ lastActivity: "2h", lastActivityTitle: "Last activity: yesterday" }),
    });

    const chip = wrapper.get(".workspace-card__last-activity");
    expect(chip.text()).toBe("2h");
    expect(chip.attributes("title")).toBe("Last activity: yesterday");

    wrapper.unmount();
  });

  test("shows no timestamp chip when there is no activity to report", () => {
    const wrapper = mount(WorkspaceCard, { props: props() });
    expect(wrapper.find(".workspace-card__last-activity").exists()).toBe(false);
    wrapper.unmount();
  });

  test("existing status indicators (task dot, star, attention) render unchanged alongside it", () => {
    const wrapper = mount(WorkspaceCard, {
      props: props({
        kind: "task",
        taskState: "running",
        starred: true,
        attentionCount: 2,
        lastActivity: "5m",
        lastActivityTitle: "Last activity: 5 minutes ago",
      }),
    });

    expect(wrapper.get(".workspace-card__status-dot").classes()).toContain("workspace-card__status-dot--running");
    expect(wrapper.get(".workspace-card__star").classes()).toContain("workspace-card__star--active");
    expect(wrapper.get(".workspace-card__attention-count").text()).toBe("2");
    expect(wrapper.get(".workspace-card__last-activity").text()).toBe("5m");

    wrapper.unmount();
  });
});
