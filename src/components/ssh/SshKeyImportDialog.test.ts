/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.4:
 * SshKeyManager used to gather the PEM/label/passphrase via window.prompt(),
 * which throws unconditionally in an Electron renderer. This dialog replaces
 * it with real form fields wired directly to the ssh store.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SshKeyImportDialog from "./SshKeyImportDialog.vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("SshKeyImportDialog", () => {
  test("embedded mode keeps Back and Import in the header", () => {
    const wrapper = mount(SshKeyImportDialog, { props: { embedded: true, backLabel: "Back to host" } });
    expect(wrapper.get(".ssh-embedded-header").text()).toContain("Back to host");
    expect(wrapper.get(".ssh-embedded-header").text()).toContain("Import");
    expect(wrapper.find(".dialog__footer").exists()).toBe(false);
  });

  test("footer Cancel keeps the private-key draft when discard is declined", async () => {
    const app = useAppStore();
    const confirmInApp = vi.spyOn(app, "confirmInApp").mockResolvedValue(false);
    const wrapper = mount(SshKeyImportDialog);
    expect(wrapper.find(".dialog__header button").exists()).toBe(false);
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----";
    await wrapper.find("textarea").setValue(pem);

    await wrapper.get(".dialog__footer button.button--ghost").trigger("click");

    expect(confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ cancelLabel: "Keep editing", confirmLabel: "Discard changes" }),
    );
    expect(wrapper.emitted("cancel")).toBeFalsy();
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe(pem);
    wrapper.unmount();
  });

  test("submits trimmed pem/label/passphrase to the store and emits cancel (closes) on success", async () => {
    const importKey = vi.fn(async () => {});
    const store = useSshStore();
    store.init({ sshKeysList: async () => [], sshHostsList: async () => [], sshCertsList: async () => [] } as never);
    store.importKey = importKey;

    const wrapper = mount(SshKeyImportDialog);
    expect(wrapper.find(".dialog__header button").exists()).toBe(false);
    expect(wrapper.get(".dialog__footer button.button--ghost").text()).toBe("Cancel");
    await wrapper.find("textarea").setValue("  -----BEGIN KEY-----  ");
    await wrapper.find('input[type="text"]').setValue("  laptop  ");
    await wrapper.find('input[type="password"]').setValue("secret");
    await wrapper.find("button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(importKey).toHaveBeenCalledWith("-----BEGIN KEY-----", "laptop", "secret");
    expect(wrapper.emitted("cancel")).toBeTruthy();
  });

  test("defaults label to 'Imported key' when left blank", async () => {
    const importKey = vi.fn(async () => {});
    const store = useSshStore();
    store.importKey = importKey;

    const wrapper = mount(SshKeyImportDialog);
    await wrapper.find("textarea").setValue("-----BEGIN KEY-----");
    await wrapper.find("button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(importKey).toHaveBeenCalledWith("-----BEGIN KEY-----", "Imported key", "");
  });

  test("keeps the dialog open and shows an inline error on failure — does not emit cancel", async () => {
    const store = useSshStore();
    store.importKey = vi.fn(async () => {
      throw new Error("keychain locked");
    });

    const wrapper = mount(SshKeyImportDialog);
    await wrapper.find("textarea").setValue("-----BEGIN KEY-----");
    await wrapper.find("button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(wrapper.emitted("cancel")).toBeFalsy();
    expect(wrapper.text()).toContain("keychain locked");
  });

  test("the import button is disabled until a PEM value is entered", async () => {
    const wrapper = mount(SshKeyImportDialog);
    const importBtn = wrapper.find("button.button:not(.button--ghost)");
    expect(importBtn.attributes("disabled")).toBeDefined();
    await wrapper.find("textarea").setValue("-----BEGIN KEY-----");
    expect(importBtn.attributes("disabled")).toBeUndefined();
  });
});
