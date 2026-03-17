import { describe, expect, test } from "vitest";
import { renderAppShell } from "./app-shell-view.js";

describe("renderAppShell", () => {
  test("renders the root workspace shell with stable roles", () => {
    const container = document.createElement("div");

    renderAppShell(container, { isRemote: true, sidebarCollapsed: true });

    expect(container.querySelector(".frame.frame--remote.frame--sidebar-collapsed")).not.toBeNull();
    expect(container.querySelector('[data-role="workspace-list"]')).not.toBeNull();
    expect(container.querySelector('[data-role="remote-access"]')).not.toBeNull();
    expect(container.querySelector('[data-role="tab-strip"]')).not.toBeNull();
    expect(container.querySelector('[data-role="terminal-stage"]')).not.toBeNull();
    expect(container.querySelector('[data-role="sidebar-collapse"]')?.getAttribute("aria-label")).toBe("Expand sidebar");
    expect(container.querySelector('.mobile-hamburger[data-action="toggle-sidebar"]')?.getAttribute("type")).toBe("button");
  });
});
