/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.9:
 * onSubmit used to fire an "submit" event fire-and-forget and rely on a
 * setError() exposed via defineExpose that nothing ever called (the dialog
 * is mounted through DialogOverlay's dynamic <component :is="..."> without a
 * ref, so defineExpose was unreachable). If the parent's async submit
 * handler rejected, busy stayed true forever with no error shown. The dialog
 * now calls the parent's onSubmit directly (via attrs) and awaits it.
 */
import { describe, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CreatePullRequestDialog from "./CreatePullRequestDialog.vue";

function mountDialog(onSubmit: ReturnType<typeof vi.fn>) {
  return mount(CreatePullRequestDialog, {
    props: {
      workspaceId: "ws1",
      sourceBranch: "feature/foo",
      defaultTargetBranch: "main",
      remoteBranches: ["origin/main", "origin/develop"],
      onCancel: vi.fn(),
      onRefreshBranches: vi.fn(),
      onSubmit,
    },
  });
}

describe("CreatePullRequestDialog", () => {
  test("on successful submit: calls the parent onSubmit with the payload and resets busy", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountDialog(onSubmit);

    await wrapper.find('input[placeholder="Pull request title"]').setValue("My PR title");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      title: "My PR title",
      description: "",
      targetBranch: "main",
      isDraft: false,
    });
    // busy reset to false — submit button re-enabled and label restored.
    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.text()).toBe("Create pull request");
    expect(submitBtn.attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".create-pr__error").exists()).toBe(false);
  });

  test("on rejected submit: stays open, resets busy, and shows the error inline", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("backend PR creation failed"));
    const wrapper = mountDialog(onSubmit);

    await wrapper.find('input[placeholder="Pull request title"]').setValue("My PR title");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Not stuck: busy resets and the Cancel/Submit buttons are usable again.
    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.text()).toBe("Create pull request");
    expect(submitBtn.attributes("disabled")).toBeUndefined();
    const cancelBtn = wrapper.find('button[type="button"]');
    expect(cancelBtn.attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".create-pr__error").text()).toBe("backend PR creation failed");
  });

  test("the dead setError()/defineExpose has been removed — nothing exposes it", () => {
    const wrapper = mountDialog(vi.fn());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((wrapper.vm as any).setError).toBeUndefined();
  });
});
