/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.4:
 * pasteKey()/pasteCert() used to call window.prompt(), which throws
 * unconditionally in an Electron renderer ("prompt() is and will not be
 * supported"). They now open in-app dialogs instead.
 */
import { describe, expect, test, beforeEach, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const openSshKeyGenerateDialog = vi.fn();
const openSshKeyImportDialog = vi.fn();
const openSshCertImportDialog = vi.fn();

vi.mock("../../stores/app.js", () => ({
  useAppStore: () => ({ openSshKeyGenerateDialog, openSshKeyImportDialog, openSshCertImportDialog }),
}));

import SshKeyManager from "./SshKeyManager.vue";
import { useSshStore } from "../../stores/ssh.js";

beforeEach(() => {
  setActivePinia(createPinia());
  openSshKeyGenerateDialog.mockClear();
  openSshKeyImportDialog.mockClear();
  openSshCertImportDialog.mockClear();
});

describe("SshKeyManager", () => {
  test("'Paste key…' opens the in-app import dialog, never window.prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const wrapper = mount(SshKeyManager);

    const pasteKeyBtn = wrapper.findAll("button").find((b) => b.text() === "Paste key…")!;
    await pasteKeyBtn.trigger("click");

    expect(openSshKeyImportDialog).toHaveBeenCalledTimes(1);
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  test("'Paste certificate…' opens the in-app import dialog with the first key's id when keys exist", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const store = useSshStore();
    store.keys = [{ id: "k1", label: "laptop" } as never];

    const wrapper = mount(SshKeyManager);
    const pasteCertBtn = wrapper.findAll("button").find((b) => b.text() === "Paste certificate…")!;
    await pasteCertBtn.trigger("click");

    expect(openSshCertImportDialog).toHaveBeenCalledWith("k1");
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  test("'Paste certificate…' alerts instead of opening a dialog when no key has been imported yet", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const store = useSshStore();
    store.keys = [];

    const wrapper = mount(SshKeyManager);
    const pasteCertBtn = wrapper.findAll("button").find((b) => b.text() === "Paste certificate…")!;
    await pasteCertBtn.trigger("click");

    expect(openSshCertImportDialog).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith("Import a private key before adding a certificate.");
    alertSpy.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
