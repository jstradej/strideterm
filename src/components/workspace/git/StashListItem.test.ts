import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import StashListItem from "./StashListItem.vue";
import type { StashEntry, StashFile } from "../../../stores/git-stash.js";

const entry: StashEntry = {
  index: 0,
  ref: "stash@{0}",
  date: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  author: "Tester",
  branch: "master",
  baseCommit: "abc1234",
  baseSubject: "prev",
  message: "On master: fix race",
  customMessage: "fix race",
  isWipDefault: false,
  fileCount: 2,
};

const files: StashFile[] = [
  { path: "src/foo.ts", code: "M", status: "modified", additions: 12, deletions: 3, isBinary: false },
  { path: "assets/logo.png", code: "M", status: "modified", additions: 0, deletions: 0, isBinary: true },
];

function mountItem(props: Record<string, unknown> = {}) {
  return mount(StashListItem, {
    props: {
      entry,
      files,
      selected: false,
      expanded: false,
      busy: "",
      currentBranch: "master",
      ...props,
    },
  });
}

describe("StashListItem", () => {
  test("renders ref, message, and file count", () => {
    const wrapper = mountItem();
    expect(wrapper.text()).toContain("stash@{0}");
    expect(wrapper.text()).toContain("fix race");
    expect(wrapper.text()).toContain("2 files");
  });

  test("collapsed view hides the action buttons and file list", () => {
    const wrapper = mountItem({ expanded: false });
    expect(wrapper.find(".stash-item__actions").exists()).toBe(false);
  });

  test("expanded view shows Apply / Pop / Drop and the file rows", () => {
    const wrapper = mountItem({ expanded: true });
    const text = wrapper.find(".stash-item__actions").text();
    expect(text).toContain("Apply");
    expect(text).toContain("Pop");
    expect(text).toContain("Drop");
    expect(wrapper.findAll(".stash-item__file")).toHaveLength(2);
    // Binary files render a "binary" marker instead of +/- counts.
    expect(wrapper.text()).toContain("binary");
  });

  test("clicking the row emits select; chevron emits toggle", async () => {
    const wrapper = mountItem();
    await wrapper.find(".stash-item__row").trigger("click");
    expect(wrapper.emitted("select")).toBeTruthy();
    await wrapper.find(".stash-item__chevron").trigger("click");
    expect(wrapper.emitted("toggle")).toBeTruthy();
  });

  test("kebab menu exposes Apply / Pop / Drop / Branch / Export / Copy and emits them", async () => {
    const wrapper = mountItem();
    await wrapper.find(".stash-item__kebab button").trigger("click");
    let menuButtons = wrapper.findAll(".stash-item__menu button");
    expect(menuButtons).toHaveLength(6);
    expect(menuButtons.map((b) => b.text())).toEqual([
      "Apply",
      "Pop",
      "Drop",
      "Branch from…",
      "Export .patch",
      "Copy ref",
    ]);
    await menuButtons[0].trigger("click"); // Apply
    expect(wrapper.emitted("apply")).toBeTruthy();
    // Clicking an item closes the menu — re-open before triggering another.
    await wrapper.find(".stash-item__kebab button").trigger("click");
    menuButtons = wrapper.findAll(".stash-item__menu button");
    await menuButtons[3].trigger("click"); // Branch from…
    expect(wrapper.emitted("branch")).toBeTruthy();
  });

  test("shows an 'other branch' chip when the stash branch differs from current", () => {
    const wrapper = mountItem({ currentBranch: "develop" });
    expect(wrapper.text()).toContain("other branch");
  });

  test("apply button emits apply", async () => {
    const wrapper = mountItem({ expanded: true });
    const applyBtn = wrapper.findAll(".stash-item__actions button")[0];
    await applyBtn.trigger("click");
    expect(wrapper.emitted("apply")).toBeTruthy();
  });
});
