import { describe, expect, test } from "vitest";
import { render } from "lit";
import { renderTabActions, renderWorkspaceHero } from "./workspace-render.js";

function renderTemplate(template) {
  const container = document.createElement("div");
  render(template, container);
  return container;
}

describe("renderWorkspaceHero", () => {
  test("renders remote alert and git stats through Lit", () => {
    const container = renderTemplate(renderWorkspaceHero({
      workspace: {
        project: {
          cwd: "/repo",
          color: "#123456",
          kind: "terminal",
        },
        sessions: [{ status: "running" }, { status: "idle" }],
      },
      gitSnapshot: {
        available: true,
        branch: "feature-x",
        dirty: true,
        dirtyCount: 3,
      },
      attention: {
        count: 2,
        alerts: [{ title: "Build failed" }],
        latestAt: new Date().toISOString(),
      },
      remoteConnectionIssue: "Socket disconnected",
      isRemote: true,
    }));

    expect(container.querySelector(".workspace-remote-alert")?.textContent).toContain("Socket disconnected");
    expect(container.querySelector(".workspace-meta__path")?.textContent).toContain("/repo");
    expect(container.textContent).toContain("feature-x");
    expect(container.textContent).toContain("3 uncommitted");
  });
});

describe("renderTabActions", () => {
  test("renders tab actions with stable data-action hooks", () => {
    const container = renderTemplate(renderTabActions({
      workspaceKind: "terminal",
      splitGroup: { layout: "cols", viewIds: ["a", "b"] },
      currentLayout: "cols",
      layouts: { cols: { label: "Side by side" } },
    }));

    expect(container.querySelector('[data-action="toggle-tab-picker"]')?.getAttribute("type")).toBe("button");
    expect(container.querySelector('[data-action="disband-split"]')?.textContent).toContain("Unsplit");
    expect(container.querySelector('[data-action="open-layout-picker"]')?.textContent).toContain("Side by side");
  });
});
