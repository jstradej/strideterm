import { describe, expect, test } from "vitest";
import { render } from "lit";
import {
  renderBootstrapErrorCard,
  renderLayoutPicker,
  renderTabContextMenu,
} from "./chrome-render.js";

function renderTemplate(template) {
  const container = document.createElement("div");
  render(template, container);
  return container;
}

describe("renderTabContextMenu", () => {
  test("renders terminal actions as buttons", () => {
    const container = renderTemplate(renderTabContextMenu({
      viewId: "ws:tab-1",
      isTerminal: true,
      hasRenameAction: true,
      inGroup: false,
      canAddToSplit: true,
    }));

    expect(container.querySelector('[data-action="restart-session"]')?.getAttribute("type")).toBe("button");
    expect(container.querySelector('[data-action="rename-tab"]')?.getAttribute("type")).toBe("button");
    expect(container.querySelector('[data-action="ctx-add-to-group"]')?.textContent).toContain("Add to split");
  });
});

describe("renderLayoutPicker", () => {
  test("renders layout buttons with svg thumbnails", () => {
    const container = renderTemplate(renderLayoutPicker({
      currentLayout: "cols",
      layouts: {
        solo: { label: "Solo" },
        cols: { label: "Side by side" },
        rows: { label: "Stacked" },
      },
    }));

    expect(container.querySelectorAll(".layout-picker__item").length).toBe(2);
    expect(container.querySelector('.layout-picker__item--active[data-layout="cols"]')).not.toBeNull();
    expect(container.querySelector("svg.layout-thumb rect")).not.toBeNull();
  });
});

describe("renderBootstrapErrorCard", () => {
  test("renders remote auth form and local retry button variants", () => {
    const remote = renderTemplate(renderBootstrapErrorCard({
      isRemote: true,
      message: "Token missing",
      remoteToken: "abc123",
    }));
    const local = renderTemplate(renderBootstrapErrorCard({
      isRemote: false,
      message: "Socket failed",
    }));

    expect(remote.querySelector('[data-role="remote-auth-form"] input')?.value).toBe("abc123");
    expect(remote.querySelector('[data-role="remote-auth-form"] button[type="submit"]')).not.toBeNull();
    expect(local.querySelector('[data-action="retry-bootstrap"]')?.getAttribute("type")).toBe("button");
  });
});
