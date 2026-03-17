import { describe, expect, test } from "vitest";
import { render } from "lit";
import { renderTabPickerDropdown } from "./action-render.js";

function renderTemplate(template) {
  const container = document.createElement("div");
  render(template, container);
  return container;
}

describe("renderTabPickerDropdown", () => {
  test("renders template buttons and a custom action with safe attributes", () => {
    const container = renderTemplate(renderTabPickerDropdown([
      { title: "Shell", command: "", icon: "\u{1F4BB}" },
      { title: "Browser", command: "https://", icon: "\u{1F310}" },
    ]));

    expect(container.querySelectorAll('.tab-picker-dropdown__item[data-action="quick-add-template-tab"]').length).toBe(2);
    expect(container.querySelector('[data-command="https://"]')?.getAttribute("type")).toBe("button");
    expect(container.querySelector('[data-action="quick-add-tab"]')?.textContent).toContain("Custom");
  });
});
