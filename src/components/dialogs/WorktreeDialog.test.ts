import { describe, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import WorktreeDialog from "./WorktreeDialog.vue";

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(WorktreeDialog, { props: { onCancel: vi.fn(), ...props } });
}

describe("WorktreeDialog", () => {
  test("submits the trimmed branch name (slashes included) exactly once", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountDialog({ onSubmit, preselectedRootPath: "/repo" });

    await wrapper.find('input[name="name"]').setValue("  feature/my-branch  ");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    // Once: without inheritAttrs: false the root div would also get onSubmit
    // as a native listener and fire it a second time with the DOM event.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ name: "feature/my-branch", rootPath: "/repo" });
    expect(wrapper.find(".dialog__error").exists()).toBe(false);
  });

  test("hides the repository picker for a single-repo workspace", () => {
    const wrapper = mountDialog({ repoChoices: [] });
    expect(wrapper.text()).not.toContain("Repository");
  });

  // Regression: a failed create used to close the dialog with no feedback
  // and no log line — the user saw "nothing happens".
  test("a rejection stays open and shows the error without Electron's IPC prefix", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'git:create-worktree': Error: Failed to create git worktree: fatal: invalid reference",
        ),
      );
    const wrapper = mountDialog({ onSubmit });

    await wrapper.find('input[name="name"]').setValue("feature-x");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.find(".dialog__error").text()).toContain("Failed to create git worktree: fatal: invalid reference");
    expect(wrapper.text()).not.toContain("Error invoking remote method");
    expect(wrapper.emitted("cancel")).toBeUndefined();
    // Input kept, button re-enabled so the user can correct the name and retry.
    expect((wrapper.find('input[name="name"]').element as HTMLInputElement).value).toBe("feature-x");
    expect((wrapper.find('button[type="submit"]').element as HTMLButtonElement).disabled).toBe(false);
  });

  test("clears a previous error when the retry succeeds", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const wrapper = mountDialog({ onSubmit });

    await wrapper.find('input[name="name"]').setValue("feature-x");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find(".dialog__error").exists()).toBe(true);

    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find(".dialog__error").exists()).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
