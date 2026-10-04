/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.4:
 * pasteKey()/pasteCert() used to call window.prompt(), which throws
 * unconditionally in an Electron renderer ("prompt() is and will not be
 * supported"). They now open in-app dialogs instead.
 */
import { describe, expect, test, beforeEach, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const openSshKeyGenerateDialog = vi.fn();
const openSshKeyImportDialog = vi.fn();
const openSshCertImportDialog = vi.fn();
const openSshKeyTransferDialog = vi.fn();
const confirmInApp = vi.fn();

vi.mock("../../stores/app.js", () => ({
  useAppStore: () => ({
    openSshKeyGenerateDialog,
    openSshKeyImportDialog,
    openSshCertImportDialog,
    openSshKeyTransferDialog,
    confirmInApp,
  }),
}));

import SshKeyManager from "./SshKeyManager.vue";
import { useSshStore } from "../../stores/ssh.js";

function stubClipboard(writeText: (value: string) => Promise<void>): () => void {
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return () => {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  openSshKeyGenerateDialog.mockClear();
  openSshKeyImportDialog.mockClear();
  openSshCertImportDialog.mockClear();
  openSshKeyTransferDialog.mockClear();
  confirmInApp.mockReset();
});

describe("SshKeyManager", () => {
  test("closes from the bottom-right footer without a duplicate header action", async () => {
    const wrapper = mount(SshKeyManager);
    expect(wrapper.find(".dialog__header button").exists()).toBe(false);
    await wrapper.get(".ssh-key-manager__footer button").trigger("click");
    expect(wrapper.emitted("cancel")).toBeTruthy();
    wrapper.unmount();
  });

  test("opens transfer for the stable key id from its row", async () => {
    const store = useSshStore();
    store.keys = [{ id: "key-1", label: "laptop", publicKey: "ssh-ed25519 AAAA" } as never];
    const wrapper = mount(SshKeyManager);
    await wrapper
      .findAll(".key-card-actions button")
      .find((button) => button.text() === "Transfer public key…")!
      .trigger("click");

    expect(openSshKeyTransferDialog).toHaveBeenCalledWith("key-1");
    wrapper.unmount();
  });

  test("embedded transfer expands inside its key card and does not push a dialog", async () => {
    const store = useSshStore();
    store.keys = [{ id: "key-1", label: "laptop", publicKey: "ssh-ed25519 AAAA" } as never];
    const wrapper = mount(SshKeyManager, { props: { embedded: true } });
    await wrapper
      .findAll(".key-card-actions button")
      .find((button) => button.text() === "Transfer public key…")!
      .trigger("click");

    expect(wrapper.find(".ssh-key-transfer-dialog--inline").exists()).toBe(true);
    expect(openSshKeyTransferDialog).not.toHaveBeenCalled();
    await wrapper
      .findAll(".key-card-actions button")
      .find((button) => button.text() === "Close key setup")!
      .trigger("click");
    expect(wrapper.find(".ssh-key-transfer-dialog--inline").exists()).toBe(false);
    wrapper.unmount();
  });

  test("keeps a key rename draft when Generate is canceled", async () => {
    const store = useSshStore();
    store.keys = [{ id: "key-1", label: "laptop", publicKey: "ssh-ed25519 AAAA" } as never];
    confirmInApp.mockResolvedValue(false);
    const wrapper = mount(SshKeyManager, { props: { embedded: true } });
    await wrapper.get(".key-card-actions .button--ghost").trigger("click");
    await flushPromises();
    await wrapper.get(".key-rename-form input").setValue("draft label");
    await wrapper
      .findAll(".manager-section .section-header button")
      .find((button) => button.text() === "Generate")!
      .trigger("click");
    await flushPromises();

    expect(confirmInApp).toHaveBeenCalledWith(expect.objectContaining({ cancelLabel: "Keep editing" }));
    expect(openSshKeyGenerateDialog).not.toHaveBeenCalled();
    expect((wrapper.get(".key-rename-form input").element as HTMLInputElement).value).toBe("draft label");
    wrapper.unmount();
  });

  test("shows the key's added date and renames it by stable id", async () => {
    const store = useSshStore();
    store.keys = [
      {
        id: "key-1",
        label: "old label",
        kind: "ed25519",
        publicKey: "ssh-ed25519 AAAA",
        createdAt: "2026-08-10T12:00:00Z",
      } as never,
    ];
    const renamedKey = {
      id: "key-1",
      label: "new label",
      kind: "ed25519",
      publicKey: "ssh-ed25519 AAAA",
      createdAt: "2026-08-10T12:00:00Z",
    };
    const rename = vi.spyOn(store, "renameKey").mockImplementation(async () => {
      store.keys = [renamedKey as never];
      return renamedKey as never;
    });
    const wrapper = mount(SshKeyManager);

    expect(wrapper.text()).toContain(`Added ${new Date("2026-08-10T12:00:00Z").toLocaleString()}`);
    await wrapper.get(".key-card-actions button").trigger("click");
    await flushPromises();
    await wrapper.get(".key-rename-form input").setValue("  new label  ");
    await wrapper.get(".key-rename-form button").trigger("click");
    await flushPromises();

    expect(rename).toHaveBeenCalledWith("key-1", "new label");
    expect(wrapper.text()).toContain("new label");
    wrapper.unmount();
  });

  test("keeps the rename draft available and shows an inline error after failure", async () => {
    const store = useSshStore();
    store.keys = [{ id: "key-1", label: "old label" } as never];
    vi.spyOn(store, "renameKey").mockRejectedValue(new Error("rename rejected"));
    const wrapper = mount(SshKeyManager);
    await wrapper.get(".key-card-actions button").trigger("click");
    await flushPromises();
    await wrapper.get(".key-rename-form input").setValue("new label");
    await wrapper.get(".key-rename-form button").trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("Could not rename SSH key: rename rejected");
    expect((wrapper.get(".key-rename-form input").element as HTMLInputElement).value).toBe("new label");
    wrapper.unmount();
  });

  test("shows and clears success feedback after copying a key's public key", async () => {
    const writeText = vi.fn(async () => undefined);
    const restoreClipboard = stubClipboard(writeText);
    vi.useFakeTimers();
    try {
      const store = useSshStore();
      store.keys = [{ id: "key-1", label: "laptop", publicKey: "ssh-ed25519 AAAA" } as never];
      const wrapper = mount(SshKeyManager);
      const copyButton = wrapper
        .findAll(".key-card-actions button")
        .find((button) => button.text() === "Copy public key")!;

      await copyButton.trigger("click");
      await flushPromises();
      expect(writeText).toHaveBeenCalledWith("ssh-ed25519 AAAA");
      expect(copyButton.text()).toBe("Copied public key");

      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      expect(copyButton.text()).toBe("Copy public key");
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
      restoreClipboard();
    }
  });

  test("shows clipboard failures in the dialog instead of rejecting the click handler", async () => {
    const restoreClipboard = stubClipboard(vi.fn(async () => Promise.reject(new Error("clipboard blocked"))));
    try {
      const store = useSshStore();
      store.keys = [{ id: "key-1", label: "laptop", publicKey: "ssh-ed25519 AAAA" } as never];
      const wrapper = mount(SshKeyManager);
      await wrapper
        .findAll(".key-card-actions button")
        .find((button) => button.text() === "Copy public key")!
        .trigger("click");
      await flushPromises();
      await flushPromises();

      expect(wrapper.get('[role="alert"]').text()).toContain("Could not copy public key: clipboard blocked");
      wrapper.unmount();
    } finally {
      restoreClipboard();
    }
  });

  test("does not schedule copied feedback when a clipboard write finishes after unmount", async () => {
    vi.useFakeTimers();
    let finishWrite!: () => void;
    const restoreClipboard = stubClipboard(vi.fn(() => new Promise<void>((resolve) => (finishWrite = resolve))));
    try {
      const store = useSshStore();
      store.keys = [{ id: "key-1", label: "laptop", publicKey: "ssh-ed25519 AAAA" } as never];
      const wrapper = mount(SshKeyManager);
      await wrapper
        .findAll(".key-card-actions button")
        .find((button) => button.text() === "Copy public key")!
        .trigger("click");
      wrapper.unmount();

      finishWrite();
      await flushPromises();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      restoreClipboard();
    }
  });

  test("'Import key…' opens the in-app import dialog, never window.prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const wrapper = mount(SshKeyManager);

    const pasteKeyBtn = wrapper.findAll("button").find((b) => b.text() === "Import key…")!;
    await pasteKeyBtn.trigger("click");

    expect(openSshKeyImportDialog).toHaveBeenCalledTimes(1);
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  test("'Import certificate…' opens the in-app import dialog with the first key's id when keys exist", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const store = useSshStore();
    store.keys = [{ id: "k1", label: "laptop" } as never];

    const wrapper = mount(SshKeyManager);
    const pasteCertBtn = wrapper.findAll("button").find((b) => b.text() === "Import certificate…")!;
    await pasteCertBtn.trigger("click");
    await flushPromises();

    expect(openSshCertImportDialog).toHaveBeenCalledWith("k1");
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  test("'Import certificate…' shows an in-app message when no key has been imported yet", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const store = useSshStore();
    store.keys = [];

    const wrapper = mount(SshKeyManager);
    const pasteCertBtn = wrapper.findAll("button").find((b) => b.text() === "Import certificate…")!;
    await pasteCertBtn.trigger("click");
    await flushPromises();

    expect(openSshCertImportDialog).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain("Import a private key before adding a certificate.");
    alertSpy.mockRestore();
  });

  test("canceling the in-app key deletion confirmation leaves the key intact", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    confirmInApp.mockResolvedValue(false);
    const store = useSshStore();
    store.keys = [{ id: "k1", label: "laptop" } as never];
    const deleteKey = vi.spyOn(store, "deleteKey");
    const wrapper = mount(SshKeyManager);
    await wrapper.get(".key-card .button--danger").trigger("click");

    expect(confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ cancelLabel: "Cancel", confirmLabel: "Delete key", danger: true }),
    );
    expect(deleteKey).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(store.keys).toHaveLength(1);
    wrapper.unmount();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
