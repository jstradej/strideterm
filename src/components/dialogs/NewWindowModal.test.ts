/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.9:
 * createProfileAndOpen() used to fire the "create-and-open" event
 * fire-and-forget and rely on the dialog being unmounted by the parent on
 * success. If the parent's async handler (app-dialog-actions.js
 * openNewWindowModal's onCreate-and-open) rejected, the rejection was
 * unhandled and busy stayed true forever with no error shown. The dialog
 * now calls the parent's handler directly (via attrs) and awaits it.
 */
import { describe, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import NewWindowModal from "./NewWindowModal.vue";

function mountDialog(onCreateAndOpen: ReturnType<typeof vi.fn>) {
  return mount(NewWindowModal, {
    props: {
      profiles: [{ id: "default", name: "Default" }],
      windowSlots: [],
      workspaces: [],
      onCancel: vi.fn(),
      "onCreate-and-open": onCreateAndOpen,
    },
  });
}

describe("NewWindowModal", () => {
  test("on successful profile creation: calls the parent handler and resets busy", async () => {
    const onCreateAndOpen = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountDialog(onCreateAndOpen);

    await wrapper.find(".new-profile-input").setValue("Team A");
    await wrapper.findAll("button").find((b) => b.text() === "+ Add")!.trigger("click");
    await flushPromises();

    expect(onCreateAndOpen).toHaveBeenCalledTimes(1);
    expect(onCreateAndOpen).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Team A", color: "#ffa424", id: expect.stringMatching(/^profile-/) }),
    );
    // busy reset to false — inputs usable again.
    expect(wrapper.find(".new-profile-input").attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".dialog__error").exists()).toBe(false);
  });

  test("on rejected profile creation: stays open, resets busy, and shows the error inline", async () => {
    const onCreateAndOpen = vi.fn().mockRejectedValue(new Error("saveProfile failed"));
    const wrapper = mountDialog(onCreateAndOpen);

    await wrapper.find(".new-profile-input").setValue("Team A");
    await wrapper.findAll("button").find((b) => b.text() === "+ Add")!.trigger("click");
    await flushPromises();

    expect(onCreateAndOpen).toHaveBeenCalledTimes(1);
    // Not stuck: busy resets and the input/profile list are usable again.
    expect(wrapper.find(".new-profile-input").attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".dialog__error-text").text()).toBe("saveProfile failed");
  });
});
