import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DockerLogToolbar from "./DockerLogToolbar.vue";

function defaultProps() {
  return {
    paused: false,
    timestamps: false,
    wrap: true,
    tail: 1000 as number | "all",
    lineCount: 0,
    byteCount: 0,
    searchIndex: 0,
    searchTotal: 0,
    copied: false,
  };
}

describe("DockerLogToolbar — visual + interaction with mock state", () => {
  it("renders Pause when stream is live and Resume when paused", async () => {
    const live = mount(DockerLogToolbar, { props: defaultProps() });
    expect(live.text()).toContain("Pause");
    const paused = mount(DockerLogToolbar, { props: { ...defaultProps(), paused: true } });
    expect(paused.text()).toContain("Resume");
  });

  it("emits toggle-pause on the pause/resume button", async () => {
    const w = mount(DockerLogToolbar, { props: defaultProps() });
    await w.findAll(".log-toolbar__btn")[0].trigger("click");
    expect(w.emitted("toggle-pause")).toBeTruthy();
  });

  it("renders stats with human-formatted line and byte counts", () => {
    const w = mount(DockerLogToolbar, {
      props: { ...defaultProps(), lineCount: 1234, byteCount: 2_500_000 },
    });
    expect(w.find(".log-toolbar__stats").text()).toContain("1.2k");
    expect(w.find(".log-toolbar__stats").text()).toContain("2.4 MiB");
  });

  it("shows match counter when search has hits", async () => {
    const w = mount(DockerLogToolbar, {
      props: { ...defaultProps(), searchIndex: 4, searchTotal: 17 },
    });
    // Counter chip only renders when the input is non-empty (acts as the
    // active-query indicator). Typing into the input populates it.
    await w.find(".log-toolbar__search-input").setValue("foo");
    expect(w.find(".log-toolbar__search-count").text()).toBe("5/17");
  });

  it("shows 'no matches' when query has no hits", async () => {
    const w = mount(DockerLogToolbar, {
      props: { ...defaultProps(), searchIndex: 0, searchTotal: 0 },
    });
    await w.find(".log-toolbar__search-input").setValue("nope");
    expect(w.find(".log-toolbar__search-count").text()).toContain("no matches");
  });

  it("emits search-next on Enter inside the search input", async () => {
    const w = mount(DockerLogToolbar, {
      props: { ...defaultProps(), searchIndex: 0, searchTotal: 3 },
    });
    const input = w.find(".log-toolbar__search-input");
    await input.setValue("foo");
    await input.trigger("keydown", { key: "Enter" });
    expect(w.emitted("search-next")).toBeTruthy();
  });

  it("emits search-prev on Shift+Enter", async () => {
    const w = mount(DockerLogToolbar, {
      props: { ...defaultProps(), searchIndex: 0, searchTotal: 3 },
    });
    const input = w.find(".log-toolbar__search-input");
    await input.setValue("foo");
    await input.trigger("keydown", { key: "Enter", shiftKey: true });
    expect(w.emitted("search-prev")).toBeTruthy();
  });

  it("emits tail-change with parsed numeric value", async () => {
    const w = mount(DockerLogToolbar, { props: defaultProps() });
    const select = w.find("select");
    await select.setValue("10000");
    const emitted = w.emitted("tail-change");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual([10000]);
  });

  it("emits tail-change with 'all' string when select chooses all", async () => {
    const w = mount(DockerLogToolbar, { props: defaultProps() });
    const select = w.find("select");
    await select.setValue("all");
    expect(w.emitted("tail-change")![0]).toEqual(["all"]);
  });

  it("highlights timestamps toggle when enabled", () => {
    const w = mount(DockerLogToolbar, { props: { ...defaultProps(), timestamps: true } });
    const toggles = w.findAll(".log-toolbar__toggle");
    expect(toggles.some((t) => t.classes().includes("log-toolbar__toggle--on"))).toBe(true);
  });

  it("renders Copied confirmation after copy", () => {
    const w = mount(DockerLogToolbar, { props: { ...defaultProps(), copied: true } });
    expect(w.text()).toContain("Copied");
  });
});
