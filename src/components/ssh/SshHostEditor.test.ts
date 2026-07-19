/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.9:
 * save() used to await sshStore.saveHost() with no busy/error tracking at
 * all — a rejection became an unhandled promise rejection with no feedback
 * to the user and no way to tell the Save action had failed. save() now
 * owns local busy/error state and shows the failure inline.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SshHostEditor from "./SshHostEditor.vue";
import { useSshStore } from "../../stores/ssh.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("SshHostEditor", () => {
  test("on successful save: calls sshStore.saveHost and emits cancel (closes)", async () => {
    const saveHost = vi.fn(async () => {});
    const store = useSshStore();
    store.saveHost = saveHost;

    const wrapper = mount(SshHostEditor);
    await wrapper.find("button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(saveHost).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted("cancel")).toBeTruthy();
    // busy reset to false — Save button re-enabled and label restored.
    const saveBtn = wrapper.find("button.button:not(.button--ghost)");
    expect(saveBtn.text()).toBe("Save");
    expect(saveBtn.attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".dialog__error").exists()).toBe(false);
  });

  test("on rejected save: keeps the dialog open, resets busy, and shows the error inline", async () => {
    const store = useSshStore();
    store.saveHost = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const wrapper = mount(SshHostEditor);
    await wrapper.find("button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(wrapper.emitted("cancel")).toBeFalsy();
    const saveBtn = wrapper.find("button.button:not(.button--ghost)");
    expect(saveBtn.text()).toBe("Save");
    expect(saveBtn.attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".dialog__error-text").text()).toBe("connection refused");
  });
});
