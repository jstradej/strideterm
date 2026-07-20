import { describe, expect, test, afterEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import BranchSelectPopover from "./BranchSelectPopover.vue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wrapper: VueWrapper<any> | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = "";
});

// The popover is rendered via <Teleport to="body">, so it lands outside the
// component's own root element — wrapper.find() can't see it. Attach to
// document.body and query it with plain DOM APIs, matching how other
// Teleport-using components in this repo are tested (ContextMenu.test.ts,
// TabPickerDropdown.test.ts, GitBranchesTab.test.ts).

interface RowInfo {
  label: string;
  title: string;
  isSection: boolean;
  isFolder: boolean;
  depth: number;
  count: number | null;
}

function popoverEl(): HTMLElement {
  const el = document.body.querySelector(".branch-picker__popover");
  if (!el) throw new Error("popover is not open");
  return el as HTMLElement;
}

function rowElements(): HTMLElement[] {
  return Array.from(popoverEl().querySelectorAll(".branch-picker__row"));
}

function toRowInfo(li: HTMLElement): RowInfo {
  const labelEl = li.querySelector(".branch-picker__label") as HTMLElement;
  const toggle = li.querySelector(".branch-picker__toggle");
  const indent = li.querySelector(".branch-picker__indent") as HTMLElement | null;
  const countEl = li.querySelector(".branch-picker__count");
  return {
    label: labelEl.textContent?.trim() ?? "",
    title: labelEl.getAttribute("title") ?? "",
    isSection: li.classList.contains("branch-picker__row--section"),
    isFolder: !!toggle && !toggle.classList.contains("branch-picker__toggle--leaf"),
    depth: indent?.style.width ? Math.round(parseInt(indent.style.width, 10) / 12) : 0,
    count: countEl ? Number(countEl.textContent) : null,
  };
}

function getRows(): RowInfo[] {
  return rowElements().map(toRowInfo);
}

function findFolderEl(label: string, occurrence = 0): HTMLElement {
  const matches = rowElements().filter((li) => {
    const info = toRowInfo(li);
    return info.label === label && info.isFolder && !info.isSection;
  });
  const el = matches[occurrence];
  if (!el) throw new Error(`folder row "${label}" (occurrence ${occurrence}) not found`);
  return el;
}

function findLeafByRef(ref: string): HTMLElement {
  const el = rowElements().find((li) => li.querySelector(".branch-picker__label")?.getAttribute("title") === ref);
  if (!el) throw new Error(`leaf row with ref "${ref}" not found`);
  return el;
}

function mousedown(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openPopover(w: VueWrapper<any>): Promise<void> {
  await w.find(".branch-picker__button").trigger("click");
  await flushPromises();
}

const OPTIONS = ["main", "feature/auth", "feature/ui", "origin/main", "origin/feature/auth"];

describe("BranchSelectPopover — real buildBranchForest wiring", () => {
  test("nests /-delimited local refs under a folder row with leaf children", async () => {
    wrapper = mount(BranchSelectPopover, {
      props: { options: OPTIONS, remoteNames: ["origin"], defaultBranch: "main" },
      attachTo: document.body,
    });
    await openPopover(wrapper);

    const rows = getRows();
    const localIdx = rows.findIndex((r) => r.isSection && r.label === "Local");
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(rows[localIdx].count).toBe(3);

    const featureIdx = rows.findIndex((r, i) => i > localIdx && r.isFolder && r.label === "feature");
    expect(featureIdx).toBeGreaterThan(localIdx);
    expect(rows[featureIdx].depth).toBe(1);
    // "feature/auth" and "feature/ui" render as nested leaves under the folder, not flat siblings.
    expect(rows[featureIdx + 1]).toMatchObject({ label: "auth", isFolder: false, depth: 2, title: "feature/auth" });
    expect(rows[featureIdx + 2]).toMatchObject({ label: "ui", isFolder: false, depth: 2, title: "feature/ui" });
  });

  test("independently nests the remote ref under its own stripped-prefix folder", async () => {
    wrapper = mount(BranchSelectPopover, {
      props: { options: OPTIONS, remoteNames: ["origin"], defaultBranch: "main" },
      attachTo: document.body,
    });
    await openPopover(wrapper);

    const rows = getRows();
    const remoteIdx = rows.findIndex((r) => r.isSection && r.label === "Remote · origin");
    expect(remoteIdx).toBeGreaterThanOrEqual(0);
    expect(rows[remoteIdx].count).toBe(2);

    const featureIdx = rows.findIndex((r, i) => i > remoteIdx && r.isFolder && r.label === "feature");
    expect(featureIdx).toBeGreaterThan(remoteIdx);
    expect(rows[featureIdx].depth).toBe(1);
    // Label is stripped of the "origin/" prefix ("auth"), but the underlying ref stays the full name.
    expect(rows[featureIdx + 1]).toMatchObject({
      label: "auth",
      isFolder: false,
      depth: 2,
      title: "origin/feature/auth",
    });
  });

  test("toggling a folder hides its children, toggling again reveals them", async () => {
    wrapper = mount(BranchSelectPopover, {
      props: { options: OPTIONS, remoteNames: ["origin"], defaultBranch: "main" },
      attachTo: document.body,
    });
    await openPopover(wrapper);

    expect(getRows().some((r) => r.title === "feature/auth")).toBe(true);

    mousedown(findFolderEl("feature", 0).querySelector(".branch-picker__toggle") as HTMLElement);
    await flushPromises();

    let rows = getRows();
    expect(rows.some((r) => r.title === "feature/auth")).toBe(false);
    expect(rows.some((r) => r.title === "feature/ui")).toBe(false);
    // The Remote section's own "feature" folder has an independent collapse key and stays open.
    expect(rows.some((r) => r.title === "origin/feature/auth")).toBe(true);

    mousedown(findFolderEl("feature", 0).querySelector(".branch-picker__toggle") as HTMLElement);
    await flushPromises();

    rows = getRows();
    expect(rows.some((r) => r.title === "feature/auth")).toBe(true);
    expect(rows.some((r) => r.title === "feature/ui")).toBe(true);
  });

  test("search filters to flat leaves matched against the full ref", async () => {
    wrapper = mount(BranchSelectPopover, {
      props: { options: OPTIONS, remoteNames: ["origin"], defaultBranch: "main" },
      attachTo: document.body,
    });
    await openPopover(wrapper);

    const searchEl = popoverEl().querySelector(".branch-picker__search") as HTMLInputElement;
    searchEl.value = "auth";
    searchEl.dispatchEvent(new Event("input"));
    await flushPromises();

    const rows = getRows();
    expect(rows.map((r) => r.label)).toEqual(["feature/auth", "origin/feature/auth"]);
    expect(rows.every((r) => !r.isFolder && !r.isSection)).toBe(true);
  });

  test("selecting a nested leaf emits the full ref and closes the popover", async () => {
    wrapper = mount(BranchSelectPopover, {
      props: { options: OPTIONS, remoteNames: ["origin"], defaultBranch: "main" },
      attachTo: document.body,
    });
    await openPopover(wrapper);

    mousedown(findLeafByRef("feature/auth"));
    await flushPromises();

    expect(wrapper.emitted("update:modelValue")).toEqual([["feature/auth"]]);
    expect(wrapper.emitted("change")).toEqual([["feature/auth"]]);
    expect(document.body.querySelector(".branch-picker__popover")).toBeNull();
  });

  test("pinned Off row renders above every section and selecting it emits offValue", async () => {
    wrapper = mount(BranchSelectPopover, {
      props: {
        options: OPTIONS,
        remoteNames: ["origin"],
        defaultBranch: "main",
        offLabel: "Off",
        offValue: "__off__",
      },
      attachTo: document.body,
    });
    await openPopover(wrapper);

    const rows = getRows();
    expect(rows[0]).toMatchObject({ label: "Off", isFolder: false, isSection: false });

    mousedown(rowElements()[0]);
    await flushPromises();

    expect(wrapper.emitted("update:modelValue")).toEqual([["__off__"]]);
    expect(wrapper.emitted("change")).toEqual([["__off__"]]);
    expect(document.body.querySelector(".branch-picker__popover")).toBeNull();
  });
});
