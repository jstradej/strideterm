import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useAppStore } from "../../stores/app.js";
import SshKeyGenerateDialog from "./SshKeyGenerateDialog.vue";

describe("SshKeyGenerateDialog", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("footer Cancel keeps an unfinished key draft when discard is declined", async () => {
    const app = useAppStore();
    const confirmInApp = vi.spyOn(app, "confirmInApp").mockResolvedValue(false);
    const wrapper = mount(SshKeyGenerateDialog);
    expect(wrapper.find(".dialog__header button").exists()).toBe(false);
    const commentInput = wrapper.get('input[placeholder="e.g. user@laptop"]');
    await commentInput.setValue("unfinished key");

    await wrapper.get(".dialog__footer button.button--ghost").trigger("click");

    expect(confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ cancelLabel: "Keep editing", confirmLabel: "Discard changes" }),
    );
    expect(wrapper.emitted("cancel")).toBeFalsy();
    expect((commentInput.element as HTMLInputElement).value).toBe("unfinished key");
    wrapper.unmount();
  });

  test("embedded mode keeps Back and Generate in the header", () => {
    const wrapper = mount(SshKeyGenerateDialog, { props: { embedded: true, backLabel: "Back to host" } });
    expect(wrapper.get(".ssh-embedded-header").text()).toContain("Back to host");
    expect(wrapper.get(".ssh-embedded-header").text()).toContain("Generate");
    expect(wrapper.find(".dialog__footer").exists()).toBe(false);
  });
});
