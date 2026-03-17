import { describe, expect, test } from "vitest";
import { render } from "lit";
import {
  renderBrowserUrlBar,
  renderEmptyTerminalState,
  renderTabActions,
  renderWelcomeScreen,
  renderWorkspaceHero,
} from "./workspace-render.js";

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

describe("workspace helper views", () => {
  test("renders browser url bar with button actions and seeded value", () => {
    const container = renderTemplate(renderBrowserUrlBar({ homeUrl: "https://example.com" }));

    expect(container.querySelector('[data-browser-action="back"]')?.getAttribute("type")).toBe("button");
    expect(container.querySelector(".browser-url-bar__input")?.value).toBe("https://example.com");
    expect(container.querySelector('[data-browser-action="external"]')?.textContent).toContain("\u{1F517}");
  });

  test("renders empty terminal and welcome screens through Lit", () => {
    const empty = renderTemplate(renderEmptyTerminalState());
    const welcome = renderTemplate(renderWelcomeScreen());

    expect(empty.querySelector(".terminal-empty")?.textContent).toContain("No active terminal");
    expect(welcome.querySelector(".welcome-screen__title")?.textContent).toContain("strIDEterm");
    expect(welcome.querySelector('[data-action="new-workspace"]')?.getAttribute("type")).toBe("button");
  });
});
