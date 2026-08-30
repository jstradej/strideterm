import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import WorkspaceActivityCluster from "./WorkspaceActivityCluster.vue";
import { MAX_ACTIVITY_VISUAL_DEPTH, type ActivityRowView } from "../../app/workspace-activity-tree.js";

/**
 * V5 review, §"2. Každý context/activity řádek bude samostatný navigační cíl".
 *
 * The rule the old entry component could not satisfy: a parent is a real
 * navigation target, but making it one must not turn the outer block into a
 * button wrapping other buttons. Every row is a SIBLING button instead, each
 * activating exactly the workspace it stands for.
 */
function row(overrides: Partial<ActivityRowView> = {}): ActivityRowView {
  return {
    key: "k",
    role: "activity",
    workspaceId: "ws-a",
    depth: 0,
    icon: "A",
    color: "#4a9eff",
    label: "Alpha",
    ariaLabel: "Alpha — worked in 2m ago, in Root › Alpha",
    title: "Alpha — worked in 2m ago, in Root › Alpha",
    summary: "main · 2 tabs",
    trailing: "2m",
    ...overrides,
  };
}

const CONTEXT = row({
  key: "context:ws-root",
  role: "context",
  workspaceId: "ws-root",
  icon: "R",
  label: "Root",
  ariaLabel: "Open Root",
  title: "Root — click to open this workspace.",
  summary: undefined,
  trailing: undefined,
});

function mountCluster(nodes: ActivityRowView[]) {
  return mount(WorkspaceActivityCluster, { props: { clusterKey: "ws-root", nodes } });
}

describe("WorkspaceActivityCluster", () => {
  it("renders one sibling button per node — never a button inside a button", () => {
    const wrapper = mountCluster([CONTEXT, row({ depth: 1 })]);

    const buttons = wrapper.findAll("button");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.element.querySelector("button")).toBeNull();
    // The cluster itself is inert scenery, not an interactive element.
    const section = wrapper.get('[data-role="activity-cluster"]');
    expect(section.element.tagName).toBe("SECTION");
    expect(section.attributes("role")).toBeUndefined();
  });

  it("activates exactly the workspace the clicked row stands for", async () => {
    const wrapper = mountCluster([CONTEXT, row({ depth: 1, workspaceId: "ws-a", viewId: "ws-a:worker" })]);

    await wrapper.get('[data-role="activity-context-row"]').trigger("click");
    await wrapper.get('[data-role="activity-node-row"]').trigger("click");

    expect(wrapper.emitted("activate")?.map((call) => (call[0] as ActivityRowView).workspaceId)).toEqual([
      "ws-root",
      "ws-a",
    ]);
    expect((wrapper.emitted("activate")![1][0] as ActivityRowView).viewId).toBe("ws-a:worker");
  });

  it("is keyboard-operable: native buttons turn Enter and Space into a click", () => {
    const wrapper = mountCluster([CONTEXT, row({ depth: 1 })]);

    for (const button of wrapper.findAll("button")) {
      expect(button.element.tagName).toBe("BUTTON");
      expect(button.attributes("type")).toBe("button");
      // Nothing takes the row out of the tab order.
      expect(button.attributes("tabindex")).toBeUndefined();
    }
  });

  it("gives every row an unambiguous accessible name and tooltip", () => {
    const wrapper = mountCluster([CONTEXT, row({ depth: 1 })]);

    const [context, activity] = wrapper.findAll("button");
    expect(context.attributes("aria-label")).toBe("Open Root");
    expect(context.attributes("title")).toBe("Root — click to open this workspace.");
    expect(activity.attributes("aria-label")).toContain("Root › Alpha");
    expect(activity.attributes("title")).toContain("Root › Alpha");
  });

  it("marks the active row, whether it is a context or an activity", () => {
    const activeContext = mountCluster([{ ...CONTEXT, active: true }, row({ depth: 1 })]);
    expect(activeContext.get('[data-role="activity-context-row"]').classes()).toContain("activity-row--active");
    expect(activeContext.get('[data-role="activity-context-row"]').attributes("aria-current")).toBe("true");
    expect(activeContext.get('[data-role="activity-node-row"]').classes()).not.toContain("activity-row--active");

    const activeRow = mountCluster([CONTEXT, row({ depth: 1, active: true })]);
    expect(activeRow.get('[data-role="activity-node-row"]').classes()).toContain("activity-row--active");
    expect(activeRow.get('[data-role="activity-context-row"]').classes()).not.toContain("activity-row--active");
  });

  it("carries the depth for the indent and the accent for the row's identity", () => {
    const wrapper = mountCluster([CONTEXT, row({ depth: 2, color: "#445566" })]);

    const activity = wrapper.get('[data-role="activity-node-row"]');
    expect(activity.attributes("data-depth")).toBe("2");
    expect(activity.attributes("style")).toContain("--activity-depth: 2");
    expect(activity.attributes("style")).toContain("--accent: #445566");
    // The indent lives in the row's own padding, never in a free margin that
    // could bridge two blocks.
    expect(activity.attributes("style")).not.toContain("margin");
  });

  it("draws a context row compactly: no summary line, no trailing slot", () => {
    const wrapper = mountCluster([CONTEXT, row({ depth: 1 })]);

    const context = wrapper.get('[data-role="activity-context-row"]');
    expect(context.find(".activity-row__summary").exists()).toBe(false);
    expect(context.find(".activity-row__trailing").exists()).toBe(false);
    // …while the activity keeps both, so its height never depends on content.
    const activity = wrapper.get('[data-role="activity-node-row"]');
    expect(activity.find(".activity-row__summary").exists()).toBe(true);
    expect(activity.get(".activity-row__trailing").text()).toBe("2m");
  });

  it("draws the grid-slot badge out of flow and the attention cue in the title line", () => {
    const wrapper = mountCluster([row({ slotIndex: 3, inGrid: true, attentionCount: 2 })]);

    const activity = wrapper.get('[data-role="activity-node-row"]');
    expect(activity.classes()).toContain("activity-row--in-grid");
    expect(activity.classes()).toContain("activity-row--attention");
    expect(activity.get(".activity-row__badge .activity-row__slot").text()).toBe("3");
    expect(activity.get(".activity-row__attention-count").text()).toBe("2");
  });

  it("a missing row keeps its slots, goes inert and never navigates", async () => {
    const wrapper = mountCluster([
      { ...CONTEXT, missing: true },
      row({ depth: 1, missing: true, slotIndex: 3, inGrid: true, attentionCount: 2, meta: "running" }),
    ]);

    const [context, activity] = wrapper.findAll("button");
    expect(context.classes()).toContain("activity-row--missing");
    expect(context.attributes("disabled")).toBeDefined();
    expect(activity.classes()).toContain("activity-row--missing");
    expect(activity.attributes("disabled")).toBeDefined();
    // The live cues that no longer mean anything are dropped; the SLOTS that
    // hold the row's height stay.
    expect(activity.find(".activity-row__slot").exists()).toBe(false);
    expect(activity.find(".activity-row__attention").exists()).toBe(false);
    expect(activity.classes()).not.toContain("activity-row--in-grid");
    expect(activity.get(".activity-row__state").text()).toBe("");
    expect(activity.get(".activity-row__trailing").text()).toBe("gone");

    await context.trigger("click");
    await activity.trigger("click");
    expect(wrapper.emitted("activate")).toBeUndefined();
  });

  // V5 review, the Azure/GitHub matrix: attention is the one cue a BACKGROUND
  // provider poll may change while the list is frozen, so it must be an
  // overlay or a fixed slot — never something that can resize a row or move
  // the hit target the user is aiming at.
  it("shows the parent's attention on the CONTEXT row too, out of the row's flow", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/styles/sidebar.css"), "utf8");

    const wrapper = mountCluster([{ ...CONTEXT, attentionCount: 3 }, row({ depth: 1 })]);
    const context = wrapper.get('[data-role="activity-context-row"]');
    expect(context.classes()).toContain("activity-row--attention");
    expect(context.get(".activity-row__attention-count").text()).toBe("3");

    const attentionRule = css.slice(css.indexOf(".activity-row__attention {"));
    expect(attentionRule.slice(0, attentionRule.indexOf("}"))).toContain("position: absolute");
  });

  // Hit targets are a CSS contract, so they are asserted where they live.
  it("declares a real hit target for both roles, larger on a coarse pointer", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/styles/sidebar.css"), "utf8");

    const block = (selector: string, from = 0): string => {
      const start = css.indexOf(selector, from);
      expect(start, selector).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf("}", start));
    };

    expect(block(".activity-row--context {")).toContain("min-height: 24px");
    expect(block(".activity-row--activity {")).toContain("min-height: 34px");

    // …and the coarse-pointer overrides, inside the media query.
    const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
    expect(block(".activity-row--context {", css.indexOf("@media (pointer: coarse)"))).toContain("min-height: 32px");
    expect(coarse).toContain("min-height: 40px");
  });

  it("renders the rows in the order it is given — it sorts nothing of its own", () => {
    const wrapper = mountCluster([
      CONTEXT,
      row({ key: "b", depth: 1, label: "Beta", workspaceId: "ws-b" }),
      row({ key: "a", depth: 1, label: "Alpha", workspaceId: "ws-a" }),
    ]);

    expect(wrapper.findAll("button").map((b) => b.attributes("data-workspace-id"))).toEqual([
      "ws-root",
      "ws-b",
      "ws-a",
    ]);
  });
  // --- V6: the canonical status dot and the responsive row geometry --------

  it("draws the canonical status dot on the badge, on activity AND context rows", () => {
    const wrapper = mountCluster([
      { ...CONTEXT, statusCue: { state: "pr-active", label: "PR open", heartbeat: true } },
      row({ depth: 1, statusCue: { state: "running", label: "Running…", heartbeat: true } }),
    ]);

    const dots = wrapper.findAll(".activity-row__status-dot");
    expect(dots).toHaveLength(2);
    // The dot lives INSIDE the icon badge, exactly like the tree card's, so
    // both renderings put it on the same corner of the same square.
    for (const dot of dots) {
      expect(dot.element.parentElement?.classList.contains("activity-row__badge")).toBe(true);
    }
    expect(dots[0].classes()).toContain("activity-row__status-dot--pr-active");
    expect(dots[0].attributes("title")).toBe("PR open");
    expect(dots[1].classes()).toContain("activity-row__status-dot--running");
  });

  it("has no dot for a workspace with no cue, and none on a missing placeholder", () => {
    const wrapper = mountCluster([
      CONTEXT,
      row({ key: "gone", depth: 1, missing: true, statusCue: { state: "failed", label: "Failed", heartbeat: false } }),
    ]);

    expect(wrapper.findAll(".activity-row__status-dot")).toHaveLength(0);
  });

  it("keeps the status dot out of flow, so a background change cannot move the row", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/styles/sidebar.css"), "utf8");

    const start = css.indexOf(".activity-row__status-dot {");
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("pointer-events: none");
  });

  it("puts the live state and the trailing time in one compact tail column", () => {
    const wrapper = mountCluster([CONTEXT, row({ depth: 1, meta: "judging", trailing: "12m" })]);

    const tail = wrapper.get('[data-role="activity-node-row"] .activity-row__tail');
    expect(tail.get(".activity-row__state").text()).toBe("judging");
    expect(tail.get(".activity-row__trailing").text()).toBe("12m");
    // A context row has neither, so it renders no tail at all.
    expect(wrapper.find('[data-role="activity-context-row"] .activity-row__tail').exists()).toBe(false);
  });

  it("lays the row out as badge + flexible text + tail, so only the text can shrink", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/styles/sidebar.css"), "utf8");

    const block = (selector: string): string => {
      const start = css.indexOf(selector);
      expect(start, selector).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf("}", start));
    };

    const rowRule = block(".activity-row {");
    expect(rowRule).toContain("grid-template-columns: auto minmax(0, 1fr) auto");
    expect(rowRule).toContain("max-width: 100%");
    expect(rowRule).toContain("box-sizing: border-box");

    // The whole containment chain, section → cluster → row → text → title.
    for (const selector of [".running-agents {", ".recent-shortcuts {", ".activity-cluster {"]) {
      expect(block(selector), selector).toContain("min-width: 0");
      expect(block(selector), selector).toContain("max-width: 100%");
    }
    expect(block(".activity-row__text {")).toContain("min-width: 0");
    expect(block(".activity-row__title {")).toContain("min-width: 0");
    // The label ellipsises; the reserved tail slots never wrap.
    expect(block(".activity-row__label {")).toContain("text-overflow: ellipsis");
    expect(block(".activity-row__state {")).toContain("white-space: nowrap");
    expect(block(".activity-row__state {")).toContain("text-overflow: ellipsis");
    expect(block(".activity-row__trailing {")).toContain("white-space: nowrap");
  });

  it("adapts to a narrow panel with a container query and never offers a horizontal scrollbar", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/styles/sidebar.css"), "utf8");

    expect(css).toContain("container-name: workspace-list");

    // Brace-match each at-rule, so the assertions below really are about the
    // narrow blocks and not about whatever happens to follow them.
    const blocks: string[] = [];
    for (let start = css.indexOf("@container workspace-list"); start > -1;) {
      let depth = 0;
      let end = css.length;
      for (let i = css.indexOf("{", start); i < css.length; i += 1) {
        if (css[i] === "{") depth += 1;
        else if (css[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      blocks.push(css.slice(start, end));
      start = css.indexOf("@container workspace-list", end);
    }

    // Two tiers: the first re-tunes the geometry knobs and drops the optional
    // summary line, the second drops the reserved state slot on the very
    // narrowest panel (the plan's width budget asks for the state only at the
    // default 248 px).
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("--activity-indent-step");
    expect(blocks[0]).toContain("--activity-badge-size");
    expect(blocks[0]).toContain(".activity-row__summary");
    expect(blocks[1]).toContain(".activity-row__state");

    for (const block of blocks) {
      // Never the trailing time and never the focus outline.
      expect(block).not.toContain(".activity-row__trailing {");
      expect(block).not.toContain("outline");
      // The cluster is only re-tuned through its geometry knobs — its border,
      // padding and width, i.e. the right edge the user must keep seeing, are
      // never redefined for a narrow panel.
      for (const declaration of block.matchAll(/\.activity-cluster \{([^}]*)\}/g)) {
        for (const line of declaration[1].split(";")) {
          const property = line.split(":")[0].trim();
          if (property) expect(property, property).toMatch(/^--activity-/);
        }
      }
    }
    expect(css).not.toContain("overflow-x: auto");
  });

  it("saturates the visual indent while keeping the true depth in the DOM", () => {
    const deep = row({ key: "deep", depth: 6, workspaceId: "ws-deep" });
    const wrapper = mountCluster([CONTEXT, row({ depth: 3 }), deep]);

    const rows = wrapper.findAll(".activity-row");
    // The data keeps the real position — it is what the rail, the tooltip and
    // the accessible name are built from.
    expect(rows[2].attributes("data-depth")).toBe("6");
    // The pixels stop growing at the cap, so a sixth level cannot spend the
    // whole text budget on a 200px panel.
    expect(rows[2].attributes("style")).toContain(`--activity-depth: ${MAX_ACTIVITY_VISUAL_DEPTH}`);
    expect(rows[1].attributes("style")).toContain("--activity-depth: 3");
    expect(rows[0].attributes("style")).toContain("--activity-depth: 0");
  });
});
