import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";

import PromptDialog from "./PromptDialog.vue";

// The branch-from-stash flow opens this dialog with a branch-name pattern; the
// import flow opens it with no pattern (non-empty only) and a checkbox-less
// shape. These cover both the validation gate and the submit payload.
const BRANCH_PROPS = {
  title: "Create branch from stash@{0}",
  label: "Branch name",
  submitLabel: "Create branch",
  pattern: "^[A-Za-z0-9._/-]+$",
  invalidHint: "Use letters, digits, and . _ / - only.",
  checkboxLabel: "Switch to the new branch immediately",
  checkboxInitial: true,
};

describe("PromptDialog", () => {
  test("submit is disabled while empty", () => {
    const wrapper = mount(PromptDialog, { props: BRANCH_PROPS });
    expect(wrapper.find("button[type=submit]").attributes("disabled")).toBeDefined();
  });

  test("rejects an invalid branch name: submit stays disabled and the hint shows", async () => {
    const wrapper = mount(PromptDialog, { props: BRANCH_PROPS });
    await wrapper.find("input[name=prompt-value]").setValue("bad name!");
    expect(wrapper.find("button[type=submit]").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".prompt-dialog__error").text()).toContain("letters, digits");
  });

  test("accepts a valid branch name: submit enables and emits the trimmed value + checkbox", async () => {
    const wrapper = mount(PromptDialog, { props: BRANCH_PROPS });
    await wrapper.find("input[name=prompt-value]").setValue("  fix-flaky-watcher  ");
    expect(wrapper.find("button[type=submit]").attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".prompt-dialog__error").exists()).toBe(false);
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0]).toEqual(["fix-flaky-watcher", true]);
  });

  test("checkbox reflects checkboxInitial and its toggled value rides along on submit", async () => {
    const wrapper = mount(PromptDialog, { props: { ...BRANCH_PROPS, checkboxInitial: false } });
    const checkbox = wrapper.find("input[name=prompt-checkbox]");
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
    await checkbox.setValue(true);
    await wrapper.find("input[name=prompt-value]").setValue("feature/x");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0]).toEqual(["feature/x", true]);
  });

  test("with no pattern, any non-empty value is valid (import-message shape)", async () => {
    const wrapper = mount(PromptDialog, {
      props: { title: "Import patch as stash", label: "Stash message", submitLabel: "Import", value: "from header" },
    });
    expect(wrapper.find("button[type=submit]").attributes("disabled")).toBeUndefined();
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0]).toEqual(["from header", false]);
  });

  test("Cancel emits cancel", async () => {
    const wrapper = mount(PromptDialog, { props: BRANCH_PROPS });
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Cancel")!
      .trigger("click");
    expect(wrapper.emitted("cancel")).toBeTruthy();
  });
});
