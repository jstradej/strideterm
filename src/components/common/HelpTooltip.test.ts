import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import HelpTooltip from "./HelpTooltip.vue";

describe("HelpTooltip", () => {
  test("focus opens it, the following click pins it, and Escape closes it", async () => {
    const wrapper = mount(HelpTooltip, { props: { text: "Details" }, attachTo: document.body });
    const button = wrapper.get("button");
    await button.trigger("focus");
    const tooltip = document.body.querySelector('[role="tooltip"]')!;
    expect(tooltip.getAttribute("data-open")).toBe("true");
    await button.trigger("click");
    expect(tooltip.getAttribute("data-open")).toBe("true");
    await button.trigger("keydown", { key: "Escape" });
    expect(tooltip.getAttribute("data-open")).toBe("false");
    wrapper.unmount();
  });
});
