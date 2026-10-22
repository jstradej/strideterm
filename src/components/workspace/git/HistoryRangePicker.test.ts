import { afterEach, describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import HistoryRangePicker from "./HistoryRangePicker.vue";

const items = [
  { kind: "option" as const, value: "__ALL__", label: "All branches and tags" },
  { kind: "section" as const, label: "Local branches" },
  { kind: "option" as const, value: "main", label: "Branch · main" },
  { kind: "section" as const, label: "Tags" },
  { kind: "option" as const, value: "v1", label: "Tag · v1" },
];

const wrappers: Array<{ unmount: () => void }> = [];

function mountPicker(modelValue = "main") {
  const wrapper = mount(HistoryRangePicker, { props: { modelValue, items }, attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}

const rows = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));

afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers.length = 0;
});

describe("HistoryRangePicker", () => {
  test("shows the label of the selected value, falling back to the raw value", async () => {
    const picker = mountPicker("main");
    expect(picker.get("button").text()).toContain("Branch · main");
    expect(picker.get("button").attributes("data-value")).toBe("main");
    await picker.setProps({ modelValue: "unknown-ref" } as never);
    expect(picker.get("button").text()).toContain("unknown-ref");
  });

  test("opens on click and lists sections and options", async () => {
    const picker = mountPicker();
    expect(rows()).toHaveLength(0);
    await picker.get("button").trigger("click");
    expect(picker.get("button").attributes("aria-expanded")).toBe("true");
    expect(rows().map((row) => row.textContent?.trim())).toEqual([
      "All branches and tags",
      "Branch · main",
      "Tag · v1",
    ]);
    const sections = Array.from(document.body.querySelectorAll(".history-range-picker__section"));
    expect(sections.map((section) => section.textContent?.trim())).toEqual(["Local branches", "Tags"]);
    expect(document.body.querySelector('[aria-selected="true"]')?.textContent).toContain("Branch · main");
  });

  test("clicking an option emits change and update:modelValue and closes", async () => {
    const picker = mountPicker();
    await picker.get("button").trigger("click");
    rows()[2].click();
    await picker.vm.$nextTick();
    expect(picker.emitted("change")).toEqual([["v1"]]);
    expect(picker.emitted("update:modelValue")).toEqual([["v1"]]);
    expect(rows()).toHaveLength(0);
  });

  test("Escape closes the popover and keeps focus on the button", async () => {
    const picker = mountPicker();
    const button = picker.get("button");
    await button.trigger("click");
    expect(rows().length).toBeGreaterThan(0);
    await button.trigger("keydown", { key: "Escape" });
    expect(rows()).toHaveLength(0);
    expect(document.activeElement).toBe(button.element);
  });

  test("arrow keys skip sections and Enter selects the active row", async () => {
    const picker = mountPicker("__ALL__");
    const button = picker.get("button");
    await button.trigger("keydown", { key: "ArrowDown" });
    await button.trigger("keydown", { key: "ArrowDown" });
    await button.trigger("keydown", { key: "Enter" });
    expect(picker.emitted("change")).toEqual([["main"]]);
  });

  test("popover has a focused search that filters options, drops empty sections and keeps pinned entries", async () => {
    const picker = mountPicker();
    await picker.get("button").trigger("click");
    const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search history references"]')!;
    expect(search).not.toBeNull();
    expect(search.placeholder).toBe("Branches and tags…");
    expect(document.activeElement).toBe(search);
    expect(search.parentElement?.firstElementChild).toBe(search);

    search.value = "v1";
    search.dispatchEvent(new Event("input"));
    await picker.vm.$nextTick();
    expect(picker.emitted("update:searchQuery")).toEqual([["v1"]]);
    expect(rows().map((row) => row.textContent?.trim())).toEqual(["All branches and tags", "Tag · v1"]);
    expect(
      Array.from(document.body.querySelectorAll(".history-range-picker__section")).map((s) => s.textContent?.trim()),
    ).toEqual(["Tags"]);

    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await picker.vm.$nextTick();
    expect(picker.emitted("change")).toEqual([["v1"]]);
    expect(rows()).toHaveLength(0);
  });

  test("keeps HEAD and All pinned for a query that matches nothing, and arrows move the active row", async () => {
    const picker = mount(HistoryRangePicker, {
      props: {
        modelValue: "main",
        items: [{ kind: "option" as const, value: "HEAD", label: "HEAD · main" }, ...items],
      },
      attachTo: document.body,
    });
    wrappers.push(picker);
    await picker.get("button").trigger("click");
    const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search history references"]')!;
    search.value = "zzz";
    search.dispatchEvent(new Event("input"));
    await picker.vm.$nextTick();
    expect(rows().map((row) => row.textContent?.trim())).toEqual(["HEAD · main", "All branches and tags"]);
    expect(document.body.querySelector(".history-range-picker__section")).toBeNull();

    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await picker.vm.$nextTick();
    expect(rows()[1].classList.contains("history-range-picker__row--active")).toBe(true);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await picker.vm.$nextTick();
    expect(rows()).toHaveLength(0);
  });
});
