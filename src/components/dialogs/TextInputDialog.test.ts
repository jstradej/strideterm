import { describe, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import TextInputDialog from "./TextInputDialog.vue";

describe("TextInputDialog", () => {
  test("shows optional context above the input while keeping the entered value as the submit payload", async () => {
    const onSubmit = vi.fn();
    const wrapper = mount(TextInputDialog, {
      props: {
        onSubmit,
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
    expect(onSubmit).toHaveBeenCalledWith("feature/new-flow");
  });

  test("shows a rejected submit inside the dialog, stays open and can be retried", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'jira:rename': Error: name already used"))
      .mockResolvedValueOnce(undefined);
    const wrapper = mount(TextInputDialog, { props: { onSubmit, title: "Rename", label: "View name" } });
    await wrapper.get("input[name=value]").setValue("Board");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get(".dialog__error-text").text()).toBe("name already used");
    expect(wrapper.find("button[type=submit]").attributes("disabled")).toBeUndefined();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(wrapper.find("[role=alert]").exists()).toBe(false);
  });

  test("is pending while the submit runs and ignores a second submit", async () => {
    let finish!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const wrapper = mount(TextInputDialog, { props: { onSubmit, title: "Rename", label: "View name" } });
    await wrapper.get("input[name=value]").setValue("Board");
    await wrapper.get("form").trigger("submit");
    await wrapper.get("form").trigger("submit");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submit = wrapper.get("button[type=submit]");
    expect(submit.classes()).toContain("button--pending");
    expect(submit.attributes("disabled")).toBeDefined();
    expect(wrapper.get("button[type=button]").attributes("disabled")).toBeDefined();
    finish();
    await flushPromises();
    expect(wrapper.get("button[type=submit]").classes()).not.toContain("button--pending");
  });
});
