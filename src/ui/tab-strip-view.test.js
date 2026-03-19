import { describe, expect, test } from "vitest";
import { renderTabStrip } from "./tab-strip-view.js";

describe("renderTabStrip", () => {
  test("renders stable tab action icons without mojibake", () => {
    const container = document.createElement("div");

    renderTabStrip(container, [{
      id: "tab-1",
      title: "Claude Code",
      status: "running",
      tone: "running",
      active: true,
      grouped: false,
      persistent: true,
      closable: true,
      attention: true,
      attentionFresh: false,
      attentionTooltip: "Needs attention",
      titleTooltip: "Claude Code",
    }]);

    expect(container.textContent).toContain("\u{1F514}");
    expect(container.textContent).toContain("\u270E");
    expect(container.textContent).toContain("\u00D7");
  });
});
