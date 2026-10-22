import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import HistoryRangePicker from "./HistoryRangePicker.vue";

const baseProps = {
  modelValue: "__ALL__",
  current: "jstradej/fix-waitingperiod",
  favorites: ["origin/master"],
  recent: [] as string[],
  local: ["jstradej/fix-waitingperiod", "jstradej/alpha", "MSP-91164-azuretest", "master"],
  remotes: ["origin/master", "origin/feature/x", "origin/feature/y"],
  remoteNames: ["origin"],
  tags: ["v2", "v1"],
  defaultBranch: "master",
  defaultRemote: "origin",
};

const wrappers: Array<{ unmount: () => void }> = [];

function mountPicker(props: Record<string, unknown> = {}) {
  const wrapper = mount(HistoryRangePicker, { props: { ...baseProps, ...props }, attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}

const clean = (node: Element) => node.textContent?.replace(/\s+/g, " ").trim();
const menus = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menu"]'));
const rowsOf = (menu: HTMLElement | undefined) =>
  Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
const texts = (level = 0) => rowsOf(menus()[level]).map(clean);
const unstarred = (node: Element) => clean(node)?.replace(/^[★☆]/, "");
const labels = (level = 0) => rowsOf(menus()[level]).map(unstarred);
const find = (text: string, level = 0) =>
  rowsOf(menus()[level]).find((item) => clean(item)?.startsWith(text) || unstarred(item)?.startsWith(text))!;
const searchInput = () => document.body.querySelector<HTMLInputElement>('[aria-label="Search history references"]')!;
const options = () => Array.from(document.body.querySelectorAll('[role="option"]')).map(unstarred);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openMenu(picker: ReturnType<typeof mountPicker>) {
  await picker.get("button").trigger("click");
}

async function press(key: string, target: Element | null = document.activeElement) {
  (target ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await flush();
}

async function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await flush();
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers.length = 0;
  document.body.innerHTML = "";
});

describe("HistoryRangePicker", () => {
  test("button reads Branch without a filter and Branch: <name> with one", async () => {
    const picker = mountPicker();
    expect(picker.get("button").text()).toBe("Branch▾");
    expect(picker.get("button").attributes("aria-haspopup")).toBe("menu");
    await picker.setProps({ modelValue: "feature/x" } as never);
    expect(picker.get("button").text()).toContain("Branch: feature/x");
    expect(picker.get("button").attributes("data-value")).toBe("feature/x");
    await picker.setProps({ modelValue: "HEAD" } as never);
    expect(picker.get("button").text()).toContain("Branch: HEAD");
    await picker.setProps({ modelValue: "feature/x", loadingRef: "feature/x" } as never);
    expect(picker.get("button").text()).toContain("Branch: feature/x…");
  });

  test("root menu lists Select, Favorites, Local, remotes and Tags in order", async () => {
    const picker = mountPicker();
    await openMenu(picker);
    expect(picker.get("button").attributes("aria-expanded")).toBe("true");
    expect(texts()).toEqual(["Select…", "★HEAD", "★origin/master", "Local›", "origin/…›", "Tags›"]);
    expect(find("Local").getAttribute("aria-haspopup")).toBe("menu");
    const sections = Array.from(document.body.querySelectorAll('[role="presentation"]')).map(clean);
    expect(sections).toEqual(["Favorites"]);
  });

  test("All branches and tags appears only when filtered and resets to __ALL__; Recent shows when present", async () => {
    const picker = mountPicker({ modelValue: "master", recent: ["develop"] });
    await openMenu(picker);
    expect(texts().slice(0, 3)).toEqual(["All branches and tags", "Select…", "Recent›"]);
    find("Recent").click();
    await flush();
    expect(labels(1)).toEqual(["develop"]);
    find("All branches and tags").click();
    await flush();
    expect(picker.emitted("change")).toEqual([["__ALL__"]]);
    expect(menus()).toHaveLength(0);
  });

  test("Local submenu lists full names flat, working branch first with a suffix", async () => {
    const picker = mountPicker();
    await openMenu(picker);
    find("Local").click();
    await flush();
    expect(menus()).toHaveLength(2);
    expect(labels(1)).toEqual([
      "jstradej/fix-waitingperiod (working branch)",
      "jstradej/alpha",
      "master",
      "MSP-91164-azuretest",
    ]);
    expect(labels(1).some((text) => text?.startsWith("jstradej›"))).toBe(false);
    find("jstradej/fix-waitingperiod", 1).click();
    await flush();
    expect(picker.emitted("change")).toEqual([["jstradej/fix-waitingperiod"]]);
    expect(menus()).toHaveLength(0);
  });

  test("remote submenu lists full remote names flat with the default branch first", async () => {
    const picker = mountPicker();
    await openMenu(picker);
    find("origin/…").click();
    await flush();
    expect(labels(1)).toEqual(["origin/masterdefault", "origin/feature/x", "origin/feature/y"]);
    find("origin/feature/y", 1).click();
    await flush();
    expect(picker.emitted("change")).toEqual([["origin/feature/y"]]);
  });

  test("a long list is capped at 300 rows with a note", async () => {
    const local = Array.from({ length: 305 }, (_, i) => `b${String(i).padStart(3, "0")}`);
    const picker = mountPicker({ local, current: "" });
    await openMenu(picker);
    find("Local").click();
    await flush();
    expect(rowsOf(menus()[1])).toHaveLength(300);
    const notes = Array.from(menus()[1].querySelectorAll(".history-range-picker__note")).map(clean);
    expect(notes).toEqual(["… 5 more — use Select…"]);
  });

  test("Tags submenu is flat and alphabetical", async () => {
    const picker = mountPicker();
    await openMenu(picker);
    find("Tags").click();
    await flush();
    expect(labels(1)).toEqual(["v1", "v2"]);
  });

  test("hovering a non-favourite row shows a hollow star; clicking it toggles without picking", async () => {
    const picker = mountPicker();
    await openMenu(picker);
    find("Tags").click();
    await flush();
    const row = find("v2", 1);
    expect(row.querySelector(".history-range-picker__star")?.textContent).toBe("");
    row.dispatchEvent(new MouseEvent("mouseenter"));
    await flush();
    const star = find("v2", 1).querySelector<HTMLElement>(".history-range-picker__star")!;
    expect(star.textContent).toBe("☆");
    star.click();
    await flush();
    expect(picker.emitted("toggle-favorite")).toEqual([["v2"]]);
    expect(picker.emitted("change")).toBeUndefined();
    expect(menus()).toHaveLength(2);
  });

  test("a favourite row shows the filled star and HEAD has no toggle", async () => {
    const picker = mountPicker();
    await openMenu(picker);
    const fav = find("★origin/master");
    expect(fav.querySelector(".history-range-picker__star--on")?.textContent).toBe("★");
    fav.querySelector<HTMLElement>(".history-range-picker__star")!.click();
    await flush();
    expect(picker.emitted("toggle-favorite")).toEqual([["origin/master"]]);
    expect(picker.emitted("change")).toBeUndefined();
    const head = find("★HEAD");
    head.dispatchEvent(new MouseEvent("mouseenter"));
    await flush();
    head.querySelector<HTMLElement>(".history-range-picker__star")!.click();
    await flush();
    expect(picker.emitted("toggle-favorite")).toHaveLength(1);
    expect(picker.emitted("change")).toEqual([["HEAD"]]);
  });

  test("hover opens a submenu after the delay and a sibling row closes it", async () => {
    vi.useFakeTimers();
    const picker = mountPicker();
    await openMenu(picker);
    find("Tags").dispatchEvent(new MouseEvent("mouseenter"));
    expect(menus()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(130);
    expect(menus()).toHaveLength(2);
    find("Select…").dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(130);
    expect(menus()).toHaveLength(1);
  });

  test("Select… searches across local, remote and tags; Enter picks", async () => {
    const picker = mountPicker();
    await openMenu(picker);
    find("Select…").click();
    await flush();
    expect(searchInput().placeholder).toBe("Branches and tags…");
    expect(options()).toHaveLength(1 + 4 + 3 + 2);
    await typeInto(searchInput(), "feature");
    expect(options()).toEqual(["origin/feature/x", "origin/feature/y"]);
    await typeInto(searchInput(), "v1");
    expect(options()).toEqual(["v1"]);
    await press("Enter", searchInput());
    expect(picker.emitted("change")).toEqual([["v1"]]);
    expect(menus()).toHaveLength(0);
    expect(searchInput()).toBeNull();
  });

  test("Escape and Backspace in the search go back to the menu root", async () => {
    const picker = mountPicker();
    await openMenu(picker);
    find("Select…").click();
    await flush();
    await press("Escape", searchInput());
    expect(searchInput()).toBeNull();
    expect(menus()).toHaveLength(1);
    find("Select…").click();
    await flush();
    await press("Backspace", searchInput());
    expect(searchInput()).toBeNull();
    expect(menus()).toHaveLength(1);
  });

  test("keyboard: ArrowRight opens a submenu, ArrowLeft and Escape close it, Escape at the root closes", async () => {
    const picker = mountPicker();
    await picker.get("button").trigger("keydown", { key: "ArrowDown" });
    await flush();
    expect(menus()).toHaveLength(1);
    for (let i = 0; i < 4; i++) await press("ArrowDown");
    expect(find("Local").className).toContain("--active");
    await press("ArrowRight");
    expect(menus()).toHaveLength(2);
    await press("ArrowLeft");
    expect(menus()).toHaveLength(1);
    await press("ArrowRight");
    await press("Escape");
    expect(menus()).toHaveLength(1);
    await press("Escape");
    expect(menus()).toHaveLength(0);
    expect(picker.emitted("change")).toBeUndefined();
  });

  test("keyboard Enter picks the active leaf", async () => {
    const picker = mountPicker();
    await openMenu(picker);
    await press("ArrowDown");
    await press("ArrowDown");
    expect(find("★HEAD").className).toContain("--active");
    await press("Enter");
    expect(picker.emitted("change")).toEqual([["HEAD"]]);
  });
});
