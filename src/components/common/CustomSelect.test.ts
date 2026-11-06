import { afterEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import CustomSelect from "./CustomSelect.vue";

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
  document.body.innerHTML = "";
});

describe("CustomSelect popup placement", () => {
  test("positions the teleported list from the trigger after it mounts", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    const wrapper = mount(CustomSelect, {
      props: { options: [{ value: "a", label: "Alpha" }] },
      attachTo: document.body,
    });
    vi.spyOn(wrapper.get("button").element, "getBoundingClientRect").mockReturnValue({
      left: 276,
      right: 476,
      top: 248,
      bottom: 280,
      width: 200,
      height: 32,
      x: 276,
      y: 248,
      toJSON: () => ({}),
    } as DOMRect);

    await wrapper.get("button").trigger("click");
    await wrapper.vm.$nextTick();

    const popup = document.body.querySelector<HTMLElement>(".custom-select__list")!;
    expect(popup.style.position).toBe("fixed");
    expect(popup.style.left).toBe("276px");
    expect(popup.style.top).toBe("283px");
    wrapper.unmount();
  });

  test("flips above and clamps to viewport edges when resized", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    const wrapper = mount(CustomSelect, {
      props: { options: [{ value: "a", label: "Alpha" }] },
      attachTo: document.body,
    });
    vi.spyOn(wrapper.get("button").element, "getBoundingClientRect").mockReturnValue({
      left: 320,
      right: 350,
      top: 450,
      bottom: 482,
      width: 30,
      height: 32,
      x: 320,
      y: 450,
      toJSON: () => ({}),
    } as DOMRect);

    await wrapper.get("button").trigger("click");
    await wrapper.vm.$nextTick();
    const popup = document.body.querySelector<HTMLElement>(".custom-select__list")!;
    expect(popup.style.left).toBe("192px");
    expect(popup.style.maxWidth).toBe("344px");
    expect(popup.style.top).toBe("auto");
    expect(popup.style.bottom).toBe("53px");

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 300 });
    window.dispatchEvent(new Event("resize"));
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(popup.style.maxWidth).toBe("284px");
    wrapper.unmount();
  });
});

describe("CustomSelect loading", () => {
  const opts = [{ value: "a", label: "Alpha" }];

  test("shows a spinner row and never No matches while loading", async () => {
    const wrapper = mount(CustomSelect, {
      props: { options: [], searchable: true, loading: true },
      attachTo: document.body,
    });
    await wrapper.get("button").trigger("click");
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector(".custom-select__loading")).not.toBeNull();
    expect(document.body.textContent).not.toContain("No matches");
    await wrapper.setProps({ loading: false } as never);
    expect(document.body.querySelector(".custom-select__loading")).toBeNull();
    expect(document.body.textContent).toContain("No matches");
  });

  test("Load more options is disabled and silent while loading", async () => {
    const wrapper = mount(CustomSelect, {
      props: { options: opts, hasMore: true, loading: true },
      attachTo: document.body,
    });
    await wrapper.get("button").trigger("click");
    await wrapper.vm.$nextTick();
    const more = document.body.querySelector<HTMLButtonElement>(".custom-select__load-more")!;
    expect(more.disabled).toBe(true);
    expect(more.getAttribute("aria-busy")).toBe("true");
    more.click();
    expect(wrapper.emitted("loadMore")).toBeUndefined();
    await wrapper.setProps({ loading: false } as never);
    document.body.querySelector<HTMLButtonElement>(".custom-select__load-more")!.click();
    expect(wrapper.emitted("loadMore")).toHaveLength(1);
  });
});
