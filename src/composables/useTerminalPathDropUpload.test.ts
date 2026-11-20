import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useTerminalPathDrop } from "./useTerminalPathDrop.js";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useTerminalStore } from "../stores/terminal.js";
import { apiKey } from "../types/keys.js";

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("../lib/terminal-attachment-upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/terminal-attachment-upload.js")>()),
  uploadFilesToTerminal: upload,
}));

function dropEvent(files: unknown[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  event.dataTransfer = { types: ["Files"], files, dropEffect: "none", getData: () => "" };
  return event;
}

describe("dropping files on a terminal in a window whose backend is another machine", () => {
  let wrapper: VueWrapper;
  let paste: ReturnType<typeof vi.fn>;
  let toasts: ReturnType<typeof vi.fn>;

  function setup(api: Record<string, unknown>) {
    setActivePinia(createPinia());
    useAppStore().payload = { meta: { platform: "linux" }, appState: { workspaces: [] } } as never;
    paste = vi.fn(() => true);
    useTerminalStore().pasteToTerminal = paste as never;
    toasts = vi.fn();
    useNotificationStore().pushEphemeralToast = toasts as never;
    const Host = defineComponent({
      setup() {
        const el = ref<HTMLElement | null>(null);
        useTerminalPathDrop(() => "ws1:p1", el);
        return () => h("div", { ref: el });
      },
    });
    wrapper = mount(Host, { global: { provide: { [apiKey as symbol]: api } } });
    return wrapper.element as HTMLElement;
  }

  const uploadApi = {
    isRemote: true,
    attachmentUploadBegin: vi.fn(),
    attachmentUploadChunk: vi.fn(),
    attachmentUploadFinish: vi.fn(),
    attachmentUploadCancel: vi.fn(),
  };

  beforeEach(() => {
    upload.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => wrapper?.unmount());

  it("uploads the files into the session's workspace and types through the terminal store", async () => {
    const el = setup(uploadApi);
    const file = { name: "a.txt" };
    const event = dropEvent([file]);
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(upload).toHaveBeenCalledOnce();
    const request = upload.mock.calls[0][0];
    expect(request.sessionId).toBe("ws1:p1");
    expect(request.files).toEqual([file]);
    request.write("typed ");
    expect(paste).toHaveBeenCalledWith("ws1:p1", "typed ");
    expect(toasts).not.toHaveBeenCalled();
  });

  it("keeps refusing a file drop in a remote window that cannot upload", () => {
    const el = setup({ isRemote: true });
    el.dispatchEvent(dropEvent([{ name: "a.txt" }]));
    expect(upload).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledWith(expect.objectContaining({ title: "Cannot drop here", kind: "error" }));
    expect(paste).not.toHaveBeenCalled();
  });

  it("leaves a local window on the path-typing drop", () => {
    const el = setup({ ...uploadApi, isRemote: false, getPathForDroppedFile: () => "/home/a/b.txt" });
    el.dispatchEvent(dropEvent([{ name: "b.txt" }]));
    expect(upload).not.toHaveBeenCalled();
    expect(paste).toHaveBeenCalledWith("ws1:p1", "/home/a/b.txt ");
  });
});
