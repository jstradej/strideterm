import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useTerminalPathDrop } from "./useTerminalPathDrop.js";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useTerminalStore } from "../stores/terminal.js";
import { apiKey } from "../types/keys.js";
import { PATHS_MIME } from "../lib/terminal-path-drop.js";

const SESSION = "ws1:p1";

function makeEvent(type: "dragover" | "drop", data: { paths?: string[]; files?: unknown[] }) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  const types: string[] = [];
  if (data.paths) types.push(PATHS_MIME);
  if (data.files) types.push("Files");
  event.dataTransfer = {
    types,
    files: data.files || [],
    dropEffect: "none",
    getData: (t: string) => (t === PATHS_MIME && data.paths ? JSON.stringify(data.paths) : ""),
  };
  return event;
}

describe("useTerminalPathDrop", () => {
  let wrapper: VueWrapper;
  let paste: ReturnType<typeof vi.fn>;
  let toasts: ReturnType<typeof vi.fn>;

  function setup(opts: { platform?: string; panel?: Record<string, unknown>; api?: Record<string, unknown> }) {
    setActivePinia(createPinia());
    const app = useAppStore();
    app.payload = {
      meta: { platform: opts.platform || "linux" },
      appState: { workspaces: [{ id: "ws1", panels: [{ id: "p1", title: "t", command: "", ...opts.panel }] }] },
    } as never;
    paste = vi.fn(() => true);
    useTerminalStore().pasteToTerminal = paste as never;
    toasts = vi.fn();
    useNotificationStore().pushEphemeralToast = toasts as never;
    const Host = defineComponent({
      setup() {
        const el = ref<HTMLElement | null>(null);
        useTerminalPathDrop(() => SESSION, el);
        return () => h("div", { ref: el, class: "host" });
      },
    });
    wrapper = mount(Host, { global: { provide: { [apiKey as symbol]: { isRemote: false, ...opts.api } } } });
    return wrapper.element as HTMLElement;
  }

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => wrapper?.unmount());

  it("single-quotes paths for a PowerShell tab", () => {
    const el = setup({ platform: "win32", panel: { command: "pwsh" } });
    el.dispatchEvent(makeEvent("drop", { paths: ["C:\\My $Docs\\a.txt"] }));
    expect(paste).toHaveBeenCalledWith(SESSION, "'C:\\My $Docs\\a.txt' ");
  });

  it("pastes quoted absolute paths with a trailing space", () => {
    const el = setup({});
    el.dispatchEvent(makeEvent("drop", { paths: ["/home/me/my dir/a.txt", "/home/me/b.txt"] }));
    expect(paste).toHaveBeenCalledWith(SESSION, "'/home/me/my dir/a.txt' /home/me/b.txt ");
    expect(toasts).not.toHaveBeenCalled();
  });

  it("quotes by the runtime platform and converts for WSL", () => {
    const el = setup({ platform: "win32", panel: { command: "wsl" } });
    el.dispatchEvent(makeEvent("drop", { paths: ["C:\\my dir\\a.txt"] }));
    expect(paste).toHaveBeenCalledWith(SESSION, "'/mnt/c/my dir/a.txt' ");
  });

  it("accepts the drag over a terminal", () => {
    const el = setup({});
    const event = makeEvent("dragover", { paths: ["/a"] });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect((event.dataTransfer as { dropEffect: string }).dropEffect).toBe("copy");
  });

  it("ignores unrelated drags", () => {
    const el = setup({});
    const event = makeEvent("drop", {});
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(paste).not.toHaveBeenCalled();
  });

  it("refuses SSH terminals with an error toast", () => {
    const el = setup({ panel: { launch: { kind: "ssh" } } });
    el.dispatchEvent(makeEvent("drop", { paths: ["/a"] }));
    expect(paste).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });

  it("refuses OS file drops on a remote client", () => {
    const el = setup({ api: { isRemote: true } });
    el.dispatchEvent(makeEvent("drop", { files: [{ name: "x.txt" }] }));
    expect(paste).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error", body: expect.stringContaining("desktop app") }),
    );
  });

  it("resolves OS file drops through the preload on desktop", () => {
    const getPathForDroppedFile = vi.fn((file: { name: string }) => `/drop/${file.name}`);
    const el = setup({ api: { getPathForDroppedFile } });
    el.dispatchEvent(makeEvent("drop", { files: [{ name: "a b.txt" }, { name: "c.txt" }] }));
    expect(paste).toHaveBeenCalledWith(SESSION, "'/drop/a b.txt' /drop/c.txt ");
  });

  it("toasts when a dropped file has no path", () => {
    const el = setup({ api: { getPathForDroppedFile: () => "" } });
    el.dispatchEvent(makeEvent("drop", { files: [{ name: "x" }] }));
    expect(paste).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });

  it("toasts when the terminal view is not there", () => {
    const el = setup({});
    paste.mockReturnValue(false);
    el.dispatchEvent(makeEvent("drop", { paths: ["/a"] }));
    expect(toasts).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });
});
