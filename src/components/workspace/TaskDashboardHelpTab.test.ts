import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import TaskDashboardHelpTab from "./TaskDashboardHelpTab.vue";

/**
 * Category B (code-review batch, 2026-07): copyExample() did
 * `navigator.clipboard.writeText(...).catch(() => {})` with zero
 * user-visible feedback on either success or failure. It now mirrors the
 * Copied!/Failed pattern used elsewhere in this file's sibling
 * (TaskDashboardLogTab.vue's copyLog).
 */
describe("TaskDashboardHelpTab — copy-to-clipboard feedback", () => {
  it("shows 'Copied!' on the clicked button after a successful copy", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    const wrapper = mount(TaskDashboardHelpTab);
    const btn = wrapper.findAll(".td__copy-btn")[0];
    await btn.trigger("click");
    await flushPromises();
    expect(btn.text()).toBe("Copied!");
  });

  it("shows 'Failed' on the clicked button when the clipboard write rejects", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    const wrapper = mount(TaskDashboardHelpTab);
    const btn = wrapper.findAll(".td__copy-btn")[0];
    await btn.trigger("click");
    await flushPromises();
    expect(btn.text()).toBe("Failed");
  });

  it("only the clicked button shows feedback — the other two stay 'copy'", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    const wrapper = mount(TaskDashboardHelpTab);
    const buttons = wrapper.findAll(".td__copy-btn");
    expect(buttons).toHaveLength(3);
    await buttons[0].trigger("click");
    await flushPromises();
    expect(buttons[0].text()).toBe("Failed");
    expect(buttons[1].text()).toBe("copy");
    expect(buttons[2].text()).toBe("copy");
  });
});
