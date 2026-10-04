import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DialogOverlay from "./DialogOverlay.vue";
import { useAppStore } from "../../stores/app.js";

describe("DialogOverlay", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { strideterm?: unknown }).strideterm;
    document.body.innerHTML = "";
  });

  test("releases xterm keyboard capture when the user interacts with the overlay", async () => {
    const firstXtermInput = document.createElement("textarea");
    firstXtermInput.className = "xterm-helper-textarea";
    const secondXtermInput = document.createElement("textarea");
    secondXtermInput.className = "xterm-helper-textarea";
    const firstBlur = vi.spyOn(firstXtermInput, "blur");
    const secondBlur = vi.spyOn(secondXtermInput, "blur");
    document.body.append(firstXtermInput, secondXtermInput);

    const store = useAppStore();
    store.overlay = "BusyOverlay";
    mount(DialogOverlay, { attachTo: document.body });
    await Promise.resolve();

    const overlay = document.body.querySelector(".overlay");
    expect(overlay).not.toBeNull();
    overlay?.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(firstBlur).toHaveBeenCalledTimes(1);
    expect(secondBlur).toHaveBeenCalledTimes(1);
  });

  test("Escape does not dismiss the busy overlay", async () => {
    const store = useAppStore();
    store.overlay = "BusyOverlay";
    const wrapper = mount(DialogOverlay, { attachTo: document.body });
    await Promise.resolve();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(store.overlay).toBe("BusyOverlay");
    expect(document.querySelector(".overlay")).not.toBeNull();
    wrapper.unmount();
  });

  test("Settings ignores backdrop clicks but still closes on Escape", async () => {
    const store = useAppStore();
    store.openSettingsDialog();
    const wrapper = mount(DialogOverlay, { attachTo: document.body });
    await vi.waitFor(() => expect(document.querySelector(".settings-dialog")).not.toBeNull(), { timeout: 10_000 });

    const overlay = document.querySelector<HTMLElement>(".overlay")!;
    overlay.click();
    await flushPromises();
    expect(document.querySelector(".settings-dialog")).not.toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(store.dialogLayers.map((layer) => layer.name)).toEqual(["SettingsDialog"]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".settings-dialog")).toBeNull(), { timeout: 10_000 });
    expect(store.dialogLayers).toHaveLength(0);
    wrapper.unmount();
  });

  test("Settings Cancel button still closes the dialog", async () => {
    const store = useAppStore();
    store.openSettingsDialog();
    const wrapper = mount(DialogOverlay, { attachTo: document.body });
    await vi.waitFor(() => expect(document.querySelector(".settings-dialog")).not.toBeNull(), { timeout: 10_000 });

    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>(".settings-dialog button")).find((button) =>
      button.textContent?.includes("Cancel settings"),
    );
    cancel!.click();
    await vi.waitFor(() => expect(document.querySelector(".settings-dialog")).toBeNull(), { timeout: 10_000 });
    expect(store.dialogLayers).toHaveLength(0);
    wrapper.unmount();
  });

  test("Escape on dirty Settings opens its discard confirmation", async () => {
    const store = useAppStore();
    store.openSettingsDialog();
    const wrapper = mount(DialogOverlay, { attachTo: document.body });
    await vi.waitFor(() => expect(document.querySelector(".settings-dialog")).not.toBeNull(), { timeout: 10_000 });
    await vi.waitFor(() => expect(document.querySelector(".settings-check__row input")).not.toBeNull(), {
      timeout: 10_000,
    });

    const checkbox = document.querySelector<HTMLInputElement>(".settings-check__row input")!;
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();

    expect(document.querySelector(".settings-dialog")).not.toBeNull();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Save these changes before leaving");
    expect(store.dialogLayers.map((layer) => layer.name)).toEqual(["SettingsDialog"]);
    wrapper.unmount();
  });

  test("preserves the active SSH test terminal while blurring background terminals", async () => {
    const background = document.createElement("textarea");
    background.className = "xterm-helper-textarea";
    const backgroundBlur = vi.spyOn(background, "blur");
    document.body.append(background);
    const store = useAppStore();
    store.overlay = "BusyOverlay";
    mount(DialogOverlay, { attachTo: document.body });
    await Promise.resolve();

    const overlay = document.body.querySelector(".overlay")!;
    const dialog = document.createElement("div");
    dialog.className = "dialog ssh-connection-test";
    const terminal = document.createElement("div");
    terminal.className = "ssh-connection-test__terminal";
    const activeTerminal = document.createElement("textarea");
    activeTerminal.className = "xterm-helper-textarea";
    const activeBlur = vi.spyOn(activeTerminal, "blur");
    terminal.append(activeTerminal);
    dialog.append(terminal);
    overlay.append(dialog);

    activeTerminal.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(activeBlur).not.toHaveBeenCalled();
    expect(backgroundBlur).toHaveBeenCalled();
    terminal.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(activeBlur).not.toHaveBeenCalled();
  });

  test("forces focus onto editable dialog targets after releasing terminal capture", async () => {
    let queuedFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    });
    const focusWindow = vi.fn(() => Promise.resolve(true));
    (window as unknown as { strideterm?: { focusWindow: typeof focusWindow } }).strideterm = { focusWindow };
    const xtermInput = document.createElement("textarea");
    xtermInput.className = "xterm-helper-textarea";
    const xtermBlur = vi.spyOn(xtermInput, "blur");
    document.body.append(xtermInput);

    const store = useAppStore();
    store.overlay = "BusyOverlay";
    mount(DialogOverlay, { attachTo: document.body });
    await Promise.resolve();

    const overlay = document.body.querySelector(".overlay");
    const assignment = document.createElement("textarea");
    assignment.placeholder = "Describe the task for the Worker agent";
    overlay?.append(assignment);
    expect(assignment).not.toBeNull();
    assignment.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (queuedFrame as any)?.(0);

    expect(xtermBlur).toHaveBeenCalled();
    expect(focusWindow).toHaveBeenCalled();
    expect(document.activeElement).toBe(assignment);
  });

  test("leaves a <select> alone so its native popup is not focused shut", async () => {
    // The dropdown list is an OS-level window owned by the BrowserWindow. Re-focusing the owner
    // (`window:focus-current` = show() + focus()) or the element itself closes it in the frame it
    // opened, which reads as a dropdown that never opens. Neither step may be taken for a select.
    let queuedFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    });
    const focusWindow = vi.fn(() => Promise.resolve(true));
    (window as unknown as { strideterm?: { focusWindow: typeof focusWindow } }).strideterm = { focusWindow };
    const windowFocus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const xtermInput = document.createElement("textarea");
    xtermInput.className = "xterm-helper-textarea";
    const xtermBlur = vi.spyOn(xtermInput, "blur");
    document.body.append(xtermInput);

    const store = useAppStore();
    store.overlay = "BusyOverlay";
    mount(DialogOverlay, { attachTo: document.body });
    await Promise.resolve();

    const overlay = document.body.querySelector(".overlay");
    const picker = document.createElement("select");
    picker.append(document.createElement("option"));
    overlay?.append(picker);
    const pickerFocus = vi.spyOn(picker, "focus");
    picker.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    // The terminal still has to let go of the keyboard, and that is all that may happen.
    expect(xtermBlur).toHaveBeenCalled();
    expect(focusWindow).not.toHaveBeenCalled();
    expect(windowFocus).not.toHaveBeenCalled();
    expect(queuedFrame).toBeNull();
    expect(pickerFocus).not.toHaveBeenCalled();
  });

  test("keeps the mounted host list and host draft when in-app discard confirmation is canceled", async () => {
    const store = useAppStore();
    store.openDialog("SshHostsDialog", { onCancel: store.closeDialog });
    expect(store.dialogLayers).toHaveLength(1);
    const wrapper = mount(DialogOverlay, { attachTo: document.body });
    await vi.waitFor(
      () => {
        expect(document.querySelector(".ssh-hosts-dialog__toolbar input")).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    const search = document.querySelector<HTMLInputElement>(".ssh-hosts-dialog__toolbar input")!;
    search!.value = "preserved query";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    store.openSshHostEditor();
    expect(store.dialogLayers).toHaveLength(2);
    await vi.waitFor(
      () => {
        expect(
          document.querySelector('.ssh-host-editor input[placeholder="server.example.com or prod"]'),
        ).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    const host = document.querySelector<HTMLInputElement>(
      '.ssh-host-editor input[placeholder="server.example.com or prod"]',
    )!;
    host!.value = "draft.example.com";
    host!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    const nativeConfirm = vi.spyOn(window, "confirm");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    expect(document.querySelector(".ssh-host-editor")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).toBeNull());
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="server.example.com or prod"]')
        ?.value,
    ).toBe("draft.example.com");

    document.querySelector<HTMLButtonElement>(".ssh-host-editor__footer button")!.click();
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    const discard = Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button")).find((button) =>
      button.textContent?.includes("Discard changes"),
    );
    discard!.click();
    await vi.waitFor(() => expect(document.querySelector(".ssh-host-editor")).toBeNull());
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>(".ssh-hosts-dialog__toolbar input")?.value).toBe("preserved query");
    wrapper.unmount();
  });

  test("renders legacy temporary overlays above a mounted dialog stack and restores the parent", async () => {
    const store = useAppStore();
    store.openDialog("SshHostsDialog", { onCancel: store.closeDialog });
    const wrapper = mount(DialogOverlay, { attachTo: document.body });
    await vi.waitFor(() => expect(document.querySelector(".ssh-hosts-dialog")).not.toBeNull(), { timeout: 10_000 });
    store.overlay = "ConfirmDialog";
    store.overlayProps = { title: "Confirm operation", message: "Continue?", onConfirm: vi.fn(), onCancel: vi.fn() };
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull(), { timeout: 10_000 });
    store.overlay = "SshHostsDialog";
    store.overlayProps = store.dialogLayers[0].props;
    await vi.waitFor(() => expect(document.querySelector(".ssh-hosts-dialog")).not.toBeNull(), { timeout: 10_000 });
    wrapper.unmount();
  });

  test("dialog autofocus skips help tooltip triggers", async () => {
    const queuedFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    const store = useAppStore();
    const wrapper = mount(DialogOverlay, { attachTo: document.body });
    store.openDialog("SshKeyManager");

    await vi.waitFor(() => expect(document.querySelector(".ssh-key-manager .help-tooltip__button")).not.toBeNull(), {
      timeout: 10_000,
    });
    await flushPromises();
    await vi.waitFor(() => expect(queuedFrames.length).toBeGreaterThan(0));
    queuedFrames.splice(0).forEach((callback) => callback(0));

    const helpButton = document.querySelector<HTMLButtonElement>(".ssh-key-manager .help-tooltip__button")!;
    expect(document.activeElement).not.toBe(helpButton);
    expect(helpButton.getAttribute("aria-expanded")).toBe("false");

    wrapper.unmount();
  });

  test("clears a mounted stack when a legacy overlay closes to null", () => {
    const store = useAppStore();
    store.openDialog("SshHostsDialog");
    store.overlay = "ConfirmDialog";
    store.overlay = null;
    expect(store.dialogLayers).toEqual([]);
    store.openSubDialog("SshKeyManager");
    expect(store.dialogLayers.map((layer) => layer.name)).toEqual(["SshKeyManager"]);
    store.closeDialog();
  });
});
