/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.4:
 * SshKeyManager used to gather the certificate text via window.prompt(),
 * which throws unconditionally in an Electron renderer.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SshCertImportDialog from "./SshCertImportDialog.vue";
import { useSshStore } from "../../stores/ssh.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("SshCertImportDialog", () => {
  test("submits the trimmed cert text with the given keyId, emits cancel (closes) on success", async () => {
    const importCertificate = vi.fn(async () => {});
    const store = useSshStore();
    store.importCertificate = importCertificate;

    const wrapper = mount(SshCertImportDialog, { props: { keyId: "k1" } });
    await wrapper.find("textarea").setValue("  ssh-ed25519-cert-v01@openssh.com AAAA...  ");
    await wrapper.find("button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(importCertificate).toHaveBeenCalledWith("k1", "ssh-ed25519-cert-v01@openssh.com AAAA...");
    expect(wrapper.emitted("cancel")).toBeTruthy();
  });

  test("keeps the dialog open and shows an inline error on failure", async () => {
    const store = useSshStore();
    store.importCertificate = vi.fn(async () => {
      throw new Error("no matching key");
    });

    const wrapper = mount(SshCertImportDialog, { props: { keyId: "k1" } });
    await wrapper.find("textarea").setValue("ssh-ed25519-cert-v01@openssh.com AAAA...");
    await wrapper.find("button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(wrapper.emitted("cancel")).toBeFalsy();
    expect(wrapper.text()).toContain("no matching key");
  });

  test("the import button is disabled until a certificate value is entered", async () => {
    const wrapper = mount(SshCertImportDialog, { props: { keyId: "k1" } });
    const importBtn = wrapper.find("button.button:not(.button--ghost)");
    expect(importBtn.attributes("disabled")).toBeDefined();
    await wrapper.find("textarea").setValue("ssh-ed25519-cert-v01@openssh.com AAAA...");
    expect(importBtn.attributes("disabled")).toBeUndefined();
  });
});
