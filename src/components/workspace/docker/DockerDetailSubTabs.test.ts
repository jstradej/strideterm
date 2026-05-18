import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import DockerDetailSubTabs from "./DockerDetailSubTabs.vue";
import { isMobileViewport } from "../../../composables/useIsNarrow.js";

describe("DockerDetailSubTabs — visual + interaction", () => {
  // The component hides the Shell sub-tab when `window.strideterm` is missing
  // (its proxy for "running in remote/web transport"). happy-dom's window has
  // no preload script, so without this stub every test would see the remote
  // branch and fail the 6-tab expectation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let origStrideterm: any;
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    origStrideterm = (window as any).strideterm;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).strideterm = {};
  });
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).strideterm = origStrideterm;
  });

  it("renders all 6 sub-tabs in expected order", () => {
    const wrapper = mount(DockerDetailSubTabs, { props: { activeSubTab: "logs" } });
    const labels = wrapper.findAll(".sub-tabs__tab").map((b) => b.text());
    expect(labels).toEqual(["Logs", "Stats", "Shell", "Inspect", "Env", "Top"]);
  });

  it("marks active sub-tab with aria-selected and active class", () => {
    const wrapper = mount(DockerDetailSubTabs, { props: { activeSubTab: "stats" } });
    const buttons = wrapper.findAll(".sub-tabs__tab");
    const active = buttons.filter((b) => b.classes().includes("sub-tabs__tab--active"));
    expect(active.length).toBe(1);
    expect(active[0].text()).toBe("Stats");
    expect(active[0].attributes("aria-selected")).toBe("true");
  });

  it("emits change event with tab id on click", async () => {
    const wrapper = mount(DockerDetailSubTabs, { props: { activeSubTab: "logs" } });
    await wrapper.findAll(".sub-tabs__tab")[3].trigger("click"); // Inspect (4th button, index 3)
    const emitted = wrapper.emitted("change");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual(["inspect"]);
  });

  it("hides the Shell sub-tab when running on remote transport (no window.strideterm)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).strideterm;
    const wrapper = mount(DockerDetailSubTabs, { props: { activeSubTab: "logs" } });
    const labels = wrapper.findAll(".sub-tabs__tab").map((b) => b.text());
    expect(labels).toEqual(["Logs", "Stats", "Inspect", "Env", "Top"]);
  });
});

describe("DockerDetailSubTabs — mobile popover branch", () => {
  // The module-level isMobileViewport is shared across all consumers. We flip
  // it for these tests, then reset so other component tests don't inherit the
  // mobile branch. We also stub window.matchMedia so the useIsNarrow's
  // onMounted hook doesn't immediately overwrite our flag from the (default
  // happy-dom) match-nothing media query list.
  let initial = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let origMatchMedia: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let origStrideterm: any;
  beforeEach(() => {
    initial = isMobileViewport.value;
    isMobileViewport.value = true;
    origMatchMedia = window.matchMedia;
    // Stub a desktop-like environment: window.strideterm present so the
    // component keeps the full 6-tab list (Shell included) in the popover.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    origStrideterm = (window as any).strideterm;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).strideterm = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).matchMedia = (q: string) => ({
      matches: q.includes("max-width: 768px") || q.includes("max-height: 500px"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    });
  });
  afterEach(() => {
    isMobileViewport.value = initial;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).matchMedia = origMatchMedia;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).strideterm = origStrideterm;
  });

  it("renders a single trigger button labelled with the active sub-tab", () => {
    const wrapper = mount(DockerDetailSubTabs, { props: { activeSubTab: "stats" } });
    expect(wrapper.findAll(".sub-tabs__tab").length).toBe(0);
    const trigger = wrapper.find(".sub-tabs-mobile__trigger");
    expect(trigger.exists()).toBe(true);
    expect(trigger.text()).toContain("Stats");
    // popover is closed by default
    expect(wrapper.find(".sub-tabs-mobile__popover").exists()).toBe(false);
  });

  it("opens the popover and lists all 6 tabs on trigger click", async () => {
    const wrapper = mount(DockerDetailSubTabs, { props: { activeSubTab: "logs" } });
    await wrapper.find(".sub-tabs-mobile__trigger").trigger("click");
    await flushPromises();
    const items = wrapper.findAll(".sub-tabs-mobile__item");
    expect(items.map((i) => i.text())).toEqual(["Logs", "Stats", "Shell", "Inspect", "Env", "Top"]);
  });

  it("emits change + closes popover on item click", async () => {
    const wrapper = mount(DockerDetailSubTabs, { props: { activeSubTab: "logs" } });
    await wrapper.find(".sub-tabs-mobile__trigger").trigger("click");
    await flushPromises();
    await wrapper.findAll(".sub-tabs-mobile__item")[2].trigger("click"); // Shell
    expect(wrapper.emitted("change")?.[0]).toEqual(["shell"]);
    await flushPromises();
    expect(wrapper.find(".sub-tabs-mobile__popover").exists()).toBe(false);
  });

  it("backdrop click closes the popover without emitting change", async () => {
    const wrapper = mount(DockerDetailSubTabs, { props: { activeSubTab: "logs" } });
    await wrapper.find(".sub-tabs-mobile__trigger").trigger("click");
    await flushPromises();
    await wrapper.find(".sub-tabs-mobile__backdrop").trigger("click");
    await flushPromises();
    expect(wrapper.find(".sub-tabs-mobile__popover").exists()).toBe(false);
    expect(wrapper.emitted("change")).toBeUndefined();
  });
});
