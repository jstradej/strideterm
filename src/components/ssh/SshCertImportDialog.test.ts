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
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("SshCertImportDialog", () => {
  test("embedded mode keeps Back and Import in the header", () => {
    const wrapper = mount(SshCertImportDialog, {
      props: { keyId: "k1", embedded: true, backLabel: "Back to keys" },
    });
    expect(wrapper.get(".ssh-embedded-header").text()).toContain("Back to keys");
    expect(wrapper.get(".ssh-embedded-header").text()).toContain("Import");
    expect(wrapper.find(".dialog__footer").exists()).toBe(false);
  });

  test("footer Cancel keeps the certificate draft when discard is declined", async () => {
    const app = useAppStore();
    const confirmInApp = vi.spyOn(app, "confirmInApp").mockResolvedValue(false);
    const wrapper = mount(SshCertImportDialog, { props: { keyId: "k1" } });
    expect(wrapper.find(".dialog__header button").exists()).toBe(false);
    const cert = "ssh-ed25519-cert-v01@openssh.com AAAA...";
    await wrapper.find("textarea").setValue(cert);

    await wrapper.get(".dialog__footer button.button--ghost").trigger("click");

    expect(confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ cancelLabel: "Keep editing", confirmLabel: "Discard changes" }),
    );
    expect(wrapper.emitted("cancel")).toBeFalsy();
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe(cert);
    wrapper.unmount();
  });

  test("submits the trimmed cert text with the given keyId, emits cancel (closes) on success", async () => {
    const importCertificate = vi.fn(async () => {});
    const store = useSshStore();
    store.importCertificate = importCertificate;

    const wrapper = mount(SshCertImportDialog, { props: { keyId: "k1" } });
    expect(wrapper.find(".dialog__header button").exists()).toBe(false);
    expect(wrapper.get(".dialog__footer button.button--ghost").text()).toBe("Cancel");
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
