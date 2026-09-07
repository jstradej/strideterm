/**
 * Component tests for the "Select text" panel.
 *
 * jsdom cannot prove the thing the panel exists for — native selection
 * handles, the system Copy callout, real webview clipboard permissions. What
 * it CAN prove is everything around them: which text is copied, that a
 * selection is not lost when a button takes focus, that a selection belonging
 * to some other part of the UI is never copied, that a blocked clipboard is
 * reported as blocked, and that the snapshot does not move while the PTY keeps
 * writing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import TerminalTextSelectionDialog from "./TerminalTextSelectionDialog.vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import type { TerminalTextSnapshot } from "../../app/terminal-text-snapshot.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const SESSION_ID = "ws-a:panel-shell";
const SNAPSHOT_TEXT = "$ npm test\n  PASS  src/app/thing.test.ts\n  ok 42 tests";

function snapshotOf(overrides: Partial<TerminalTextSnapshot> = {}): TerminalTextSnapshot {
  return {
    text: SNAPSHOT_TEXT,
    rowCount: 3,
    scrollbackRows: 0,
    startsMidLine: false,
    endsMidLine: false,
    truncated: false,
    alternateBuffer: false,
    ...overrides,
  };
}

function seedPayload(profileId = "p1"): void {
  const store = useAppStore();
  store.payload = {
    appState: {
      activeWorkspaceId: "ws-a",
      profiles: [{ id: "p1", name: "Work" }],
      windowSlots: [{ id: "slot1", profileId }],
      workspaces: [
        {
          id: "ws-a",
          name: "acme",
          profileId: "p1",
          panels: [{ id: "panel-shell", title: "Shell", command: "bash" }],
        },
      ],
      settings: {},
    },
  } as AnyApi;
}

function mountDialog(snapshot: TerminalTextSnapshot | null = snapshotOf()): {
  wrapper: VueWrapper;
  onClose: ReturnType<typeof vi.fn>;
  getSnapshot: ReturnType<typeof vi.fn>;
} {
  const termStore = useTerminalStore();
  const getSnapshot = vi.fn(() => snapshot);
  vi.spyOn(termStore, "getTerminalTextSnapshot").mockImplementation(getSnapshot as AnyApi);
  const onClose = vi.fn();
  const wrapper = mount(TerminalTextSelectionDialog, {
    attachTo: document.body,
    props: {
      sessionId: SESSION_ID,
      workspaceId: "ws-a",
      panelId: "panel-shell",
      title: "acme — Shell",
      onClose,
    },
  });
  return { wrapper, onClose, getSnapshot };
}

function textNode(wrapper: VueWrapper): HTMLElement {
  return wrapper.find("[data-role='terminal-selection-text']").element as HTMLElement;
}

/** Select a slice of the snapshot exactly as a finger drag would. */
function selectInsideText(wrapper: VueWrapper, start: number, end: number): void {
  const host = textNode(wrapper);
  const node = host.firstChild!;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function buttonNamed(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll("button").find((b) => b.text() === label);
  expect(found, `button "${label}" should exist`).toBeTruthy();
  return found!;
}

let writeText: ReturnType<typeof vi.fn>;
let previousClipboard: unknown;

beforeEach(() => {
  setActivePinia(createPinia());
  (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  seedPayload();
  previousClipboard = navigator.clipboard;
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: previousClipboard, configurable: true });
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TerminalTextSelectionDialog", () => {
  it("shows the terminal name, the snapshot notice and the text itself", () => {
    const { wrapper } = mountDialog();

    expect(wrapper.text()).toContain("acme — Shell");
    expect(wrapper.text()).toContain("Snapshot — terminal continues running");
    expect(textNode(wrapper).textContent).toBe(SNAPSHOT_TEXT);
  });

  it("offers exactly the documented actions", () => {
    const { wrapper } = mountDialog();
    const labels = wrapper.findAll("button").map((b) => b.text());

    expect(labels).toContain("Copy selection");
    expect(labels).toContain("Copy all");
    expect(labels).toContain("Close");
    expect(labels).toContain("Select all");
    expect(labels).toContain("Include earlier output");
  });

  it("opts out of the overlay's autofocus so the keyboard stays down", () => {
    const { wrapper } = mountDialog();
    expect(wrapper.find(".dialog").attributes("data-no-autofocus")).toBeDefined();
  });

  it("renders the text as a text node, never as markup", () => {
    const { wrapper } = mountDialog(snapshotOf({ text: "<img src=x onerror=boom> & <b>bold</b>" }));

    const host = textNode(wrapper);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("b")).toBeNull();
    expect(host.textContent).toBe("<img src=x onerror=boom> & <b>bold</b>");
  });

  it("closes immediately when the session has no snapshot to give", () => {
    const { onClose } = mountDialog(null);
    expect(onClose).toHaveBeenCalled();
  });

  describe("copy", () => {
    it("Copy all copies the whole snapshot and reports success only once the write resolves", async () => {
      // A clipboard write the test controls: on a real webview the permission
      // prompt or the host's own gate can keep this pending, and claiming
      // success before it settles is claiming something that may never happen.
      let settle: () => void = () => {};
      writeText.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      );
      const { wrapper } = mountDialog();

      await buttonNamed(wrapper, "Copy all").trigger("click");
      expect(writeText).toHaveBeenCalledWith(SNAPSHOT_TEXT);
      expect(wrapper.text()).not.toContain("Copied the whole snapshot.");
      // …but the wait itself is announced, in a live region, so a screen
      // reader user is not left with silence while a permission prompt sits
      // there.
      expect(wrapper.find("[role='status']").attributes("aria-live")).toBe("polite");
      expect(wrapper.find("[role='status']").text()).toBe("Copying…");

      settle();
      await flushPromises();
      expect(wrapper.text()).toContain("Copied the whole snapshot.");
    });

    it("Copy selection copies only the highlighted text", async () => {
      const { wrapper } = mountDialog();
      selectInsideText(wrapper, 2, 10);
      await nextTick();

      await buttonNamed(wrapper, "Copy selection").trigger("click");
      await flushPromises();

      expect(writeText).toHaveBeenCalledWith(SNAPSHOT_TEXT.slice(2, 10));
    });

    it("keeps the success message when the same selection is re-announced, and drops it for a new one", async () => {
      const { wrapper } = mountDialog();
      selectInsideText(wrapper, 0, 10);
      await nextTick();

      await buttonNamed(wrapper, "Copy selection").trigger("click");
      await flushPromises();
      expect(wrapper.text()).toContain("Copied 10 characters.");

      // Browsers re-fire selectionchange around a button press with the same
      // range still in place.
      document.dispatchEvent(new Event("selectionchange"));
      await nextTick();
      expect(wrapper.text()).toContain("Copied 10 characters.");

      // A genuinely different selection is news.
      selectInsideText(wrapper, 0, 4);
      await nextTick();
      expect(wrapper.text()).toContain("4 characters selected.");
      expect(wrapper.text()).not.toContain("Copied 10 characters.");
    });

    it("Copy selection refuses when nothing is selected", async () => {
      const { wrapper } = mountDialog();

      await buttonNamed(wrapper, "Copy selection").trigger("click");
      await flushPromises();

      expect(writeText).not.toHaveBeenCalled();
      expect(wrapper.text()).toContain("Nothing selected");
    });

    it("keeps the captured selection when focus moves to a button", async () => {
      const { wrapper } = mountDialog();
      selectInsideText(wrapper, 0, 10);
      await nextTick();

      // What a mobile browser does on the way to the click: the selection
      // collapses and the caret ends up on the button.
      const copyButton = buttonNamed(wrapper, "Copy selection").element as HTMLElement;
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      const collapsed = document.createRange();
      collapsed.selectNodeContents(copyButton);
      collapsed.collapse(true);
      selection.addRange(collapsed);
      document.dispatchEvent(new Event("selectionchange"));

      await buttonNamed(wrapper, "Copy selection").trigger("click");
      await flushPromises();

      expect(writeText).toHaveBeenCalledWith(SNAPSHOT_TEXT.slice(0, 10));
    });

    it("never copies a selection made outside the panel", async () => {
      const { wrapper } = mountDialog();
      selectInsideText(wrapper, 0, 10);
      await nextTick();

      // The user selects something in another part of the UI — a composer
      // draft, a sidebar label. That text is not ours to put on the clipboard.
      const outside = document.createElement("p");
      outside.textContent = "someone else's text";
      document.body.append(outside);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(outside);
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));

      await buttonNamed(wrapper, "Copy selection").trigger("click");
      await flushPromises();

      expect(writeText).not.toHaveBeenCalled();
      expect(wrapper.text()).toContain("Nothing selected");
    });

    it("drops the captured selection when the user taps in the text to cancel it", async () => {
      const { wrapper } = mountDialog();
      selectInsideText(wrapper, 0, 10);
      await nextTick();

      // A tap inside the snapshot collapses the selection — a deliberate
      // cancel, not focus moving to a control.
      selectInsideText(wrapper, 4, 4);
      await nextTick();

      await buttonNamed(wrapper, "Copy selection").trigger("click");
      await flushPromises();

      expect(writeText).not.toHaveBeenCalled();
    });

    it("Select all selects the whole snapshot so Copy selection copies all of it", async () => {
      const { wrapper } = mountDialog();

      await buttonNamed(wrapper, "Select all").trigger("click");
      expect(document.getSelection()?.toString()).toBe(SNAPSHOT_TEXT);

      await buttonNamed(wrapper, "Copy selection").trigger("click");
      await flushPromises();

      expect(writeText).toHaveBeenCalledWith(SNAPSHOT_TEXT);
    });

    it("reports a blocked clipboard without claiming success, and keeps text and selection", async () => {
      writeText.mockRejectedValueOnce(new Error("NotAllowedError"));
      const { wrapper } = mountDialog();
      selectInsideText(wrapper, 0, 10);
      await nextTick();

      await buttonNamed(wrapper, "Copy selection").trigger("click");
      await flushPromises();

      expect(wrapper.text()).toContain("Copy was blocked");
      expect(wrapper.text()).not.toContain("Copied ");
      expect(textNode(wrapper).textContent).toBe(SNAPSHOT_TEXT);
      expect(document.getSelection()?.toString()).toBe(SNAPSHOT_TEXT.slice(0, 10));
    });

    it("handles a webview with no Clipboard API at all", async () => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      const { wrapper } = mountDialog();

      await buttonNamed(wrapper, "Copy all").trigger("click");
      await flushPromises();

      expect(wrapper.text()).toContain("system Copy");
      expect(textNode(wrapper).textContent).toBe(SNAPSHOT_TEXT);
    });
  });

  describe("snapshot stability", () => {
    it("does not change when the terminal produces more output", async () => {
      const { wrapper, getSnapshot } = mountDialog();
      getSnapshot.mockReturnValue(snapshotOf({ text: "the TUI repainted everything" }) as AnyApi);

      // Anything that would re-render the component must not re-read the
      // buffer: the snapshot is taken once, on open.
      await wrapper.vm.$forceUpdate();
      await nextTick();

      expect(textNode(wrapper).textContent).toBe(SNAPSHOT_TEXT);
    });

    it("stops listening for selection changes once it closes", async () => {
      const removeSpy = vi.spyOn(document, "removeEventListener");
      const { wrapper } = mountDialog();

      wrapper.unmount();

      expect(removeSpy).toHaveBeenCalledWith("selectionchange", expect.any(Function));
    });
  });

  describe("include earlier output", () => {
    it("warns that it replaces the text and clears the selection before doing it", async () => {
      const { wrapper } = mountDialog();
      selectInsideText(wrapper, 0, 10);
      await nextTick();

      await buttonNamed(wrapper, "Include earlier output").trigger("click");
      expect(wrapper.text()).toContain("replaces the text below and clears your current selection");
      // Nothing has happened yet.
      expect(textNode(wrapper).textContent).toBe(SNAPSHOT_TEXT);

      await buttonNamed(wrapper, "Cancel").trigger("click");
      expect(wrapper.text()).not.toContain("replaces the text below");
      expect(document.getSelection()?.toString()).toBe(SNAPSHOT_TEXT.slice(0, 10));
    });

    it("replaces the snapshot with a longer one and clears the selection", async () => {
      const { wrapper, getSnapshot } = mountDialog();
      selectInsideText(wrapper, 0, 10);
      await nextTick();
      getSnapshot.mockReturnValue(snapshotOf({ text: "older\n" + SNAPSHOT_TEXT, scrollbackRows: 120 }) as AnyApi);

      await buttonNamed(wrapper, "Include earlier output").trigger("click");
      await buttonNamed(wrapper, "Replace text").trigger("click");
      await nextTick();

      expect(getSnapshot).toHaveBeenLastCalledWith(SESSION_ID, { scrollbackLines: 500 });
      expect(textNode(wrapper).textContent).toBe("older\n" + SNAPSHOT_TEXT);
      expect(document.getSelection()?.toString()).toBe("");
      expect(wrapper.text()).toContain("Includes 120 lines from before the visible screen.");
      // One-way: the action is gone once the longer snapshot is in.
      expect(wrapper.findAll("button").map((b) => b.text())).not.toContain("Include earlier output");
    });
  });

  describe("notices", () => {
    it("reports a truncated snapshot outside the copied text", async () => {
      const { wrapper } = mountDialog(snapshotOf({ truncated: true }));

      expect(wrapper.text()).toContain("Trimmed to the most recent 200,000 characters.");
      // The warning must not end up on the clipboard.
      await buttonNamed(wrapper, "Copy all").trigger("click");
      expect(writeText).toHaveBeenCalledWith(SNAPSHOT_TEXT);
    });

    it("admits when the range is cut at either end", () => {
      const { wrapper } = mountDialog(snapshotOf({ startsMidLine: true, endsMidLine: true }));

      expect(wrapper.text()).toContain("The first line continues from output above this snapshot.");
      expect(wrapper.text()).toContain("The last line continues below this snapshot.");
    });

    it("explains that a full-screen app has no scrollback", () => {
      const { wrapper } = mountDialog(snapshotOf({ alternateBuffer: true }));

      expect(wrapper.text()).toContain("there is no scrollback");
    });
  });

  describe("context changes", () => {
    it("closes when the viewer switches profile", async () => {
      const { onClose } = mountDialog();
      const store = useAppStore();

      store.payload = {
        ...(store.payload as AnyApi),
        appState: {
          ...(store.payload as AnyApi).appState,
          windowSlots: [{ id: "slot1", profileId: "p2" }],
          profiles: [
            { id: "p1", name: "Work" },
            { id: "p2", name: "Other" },
          ],
        },
      } as AnyApi;
      await nextTick();

      expect(onClose).toHaveBeenCalled();
    });

    it("closes when the workspace moves to another profile", async () => {
      const { onClose } = mountDialog();
      const store = useAppStore();

      const appState = (store.payload as AnyApi).appState;
      store.payload = {
        ...(store.payload as AnyApi),
        appState: { ...appState, workspaces: [{ ...appState.workspaces[0], profileId: "p2" }] },
      } as AnyApi;
      await nextTick();

      expect(onClose).toHaveBeenCalled();
    });

    it("closes when the source pane is gone", async () => {
      const { onClose } = mountDialog();
      const store = useAppStore();

      const appState = (store.payload as AnyApi).appState;
      store.payload = {
        ...(store.payload as AnyApi),
        appState: { ...appState, workspaces: [{ ...appState.workspaces[0], panels: [] }] },
      } as AnyApi;
      await nextTick();

      expect(onClose).toHaveBeenCalled();
    });

    it("closes when the workspace is deleted", async () => {
      const { onClose } = mountDialog();
      const store = useAppStore();

      const appState = (store.payload as AnyApi).appState;
      store.payload = { ...(store.payload as AnyApi), appState: { ...appState, workspaces: [] } } as AnyApi;
      await nextTick();

      expect(onClose).toHaveBeenCalled();
    });

    it("stays open while nothing relevant changed", async () => {
      const { onClose } = mountDialog();
      const store = useAppStore();

      const appState = (store.payload as AnyApi).appState;
      store.payload = {
        ...(store.payload as AnyApi),
        appState: { ...appState, activeWorkspaceId: "ws-b" },
      } as AnyApi;
      await nextTick();

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("closing", () => {
    it("hands control back to the caller", async () => {
      const { wrapper, onClose } = mountDialog();
      await buttonNamed(wrapper, "Close").trigger("click");
      expect(onClose).toHaveBeenCalled();
    });

    it("gives the keyboard back to the terminal on a pointer machine", async () => {
      globalThis.setMatchMediaResult("(pointer: fine)", true);
      const focus = vi.spyOn(useTerminalStore(), "focusActiveTerminal").mockImplementation(() => {});
      const { wrapper } = mountDialog();

      await buttonNamed(wrapper, "Close").trigger("click");

      expect(focus).toHaveBeenCalled();
    });

    it("does NOT focus the terminal on touch — that would just raise the on-screen keyboard", async () => {
      globalThis.setMatchMediaResult("(pointer: fine)", false);
      const focus = vi.spyOn(useTerminalStore(), "focusActiveTerminal").mockImplementation(() => {});
      const { wrapper } = mountDialog();

      await buttonNamed(wrapper, "Close").trigger("click");

      expect(focus).not.toHaveBeenCalled();
    });
  });
});
