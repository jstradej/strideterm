import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
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
    queuedFrame?.(0);

    expect(xtermBlur).toHaveBeenCalled();
    expect(focusWindow).toHaveBeenCalled();
    expect(document.activeElement).toBe(assignment);
  });
});
