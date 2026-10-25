import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import TextInputDialog from "./TextInputDialog.vue";

describe("TextInputDialog", () => {
  test("shows optional context above the input while keeping the entered value as the submit payload", async () => {
    const wrapper = mount(TextInputDialog, {
      props: {
        eyebrow: "Git",
        title: "Create branch",
        label: "Branch name",
        placeholder: "feature/my-branch",
        submitLabel: "Create",
        context: {
          summary: "Improve branch comparison flow",
          detail: "Commit caf13caf4 · Alex Rivera · 2 hours ago",
        },
      },
    });

    expect(wrapper.find(".text-input-dialog__context-label").text()).toBe("Starting point");
    expect(wrapper.find(".text-input-dialog__context-summary").text()).toBe("Improve branch comparison flow");
    expect(wrapper.find(".text-input-dialog__context-detail").text()).toBe(
      "Commit caf13caf4 · Alex Rivera · 2 hours ago",
    );

    await wrapper.get("input[name=value]").setValue("feature/new-flow");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0]).toEqual(["feature/new-flow"]);
  });
});
