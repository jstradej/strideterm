import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceAttachments from "./WorkspaceAttachments.vue";
import { apiKey } from "../../types/keys.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { setWindowBackend } from "../../window-backend.js";
import type { AttachmentRecord } from "../../attachments.js";
import { ATTACHMENT_READ_MAX_BYTES } from "../../../electron/shared/attachment-upload.js";

const existing: AttachmentRecord = {
  transferId: "t-old",
  path: ".strideterm/attachments/t-old/old.png",
  size: 2048,
  sha256: "a".repeat(64),
  name: "old.png",
};

function record(name: string): AttachmentRecord {
  return { ...existing, transferId: `t-${name}`, path: `.strideterm/attachments/t-${name}/${name}`, name, size: 5 };
}

function fakeFile(name: string, size = 5): File {
  return {
    name,
    size,
    type: "",
    slice: () => ({ arrayBuffer: async () => new Uint8Array(size).buffer }),
  } as unknown as File;
}

function uploadApi(overrides: Record<string, unknown> = {}) {
  return {
    isRemote: true,
    attachmentList: vi.fn().mockResolvedValue([existing]),
    attachmentUploadBegin: vi.fn(async (_req: { name: string }) => ({
      transferId: "xfer",
      chunkBytes: 1024,
      received: 0,
    })),
    attachmentUploadChunk: vi.fn(async (req: { offset: number }) => ({ received: req.offset + 5 })),
    attachmentUploadFinish: vi.fn(async (_req: { transferId: string }) => record("new.txt")),
    attachmentUploadCancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

let showError: ReturnType<typeof vi.fn>;

function mountPanel(api: Record<string, unknown>, props: Record<string, unknown> = {}) {
  return mount(WorkspaceAttachments, {
    props: { workspaceId: "ws-a", workspaceRoot: "/srv/proj", openByDefault: true, panel: true, ...props },
    global: { provide: { [apiKey as symbol]: api }, stubs: { teleport: true } },
  });
}

function fileEvent(type: string, files: unknown[], types = ["Files"]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
  event.dataTransfer = { types, files, dropEffect: "none" };
  event.clipboardData = { files };
  return event;
}

beforeEach(() => {
  setActivePinia(createPinia());
  showError = vi.fn();
  useNotificationStore().showError = showError as never;
  setWindowBackend({ kind: "local" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkspaceAttachments uploads", () => {
  it("renders no upload or save controls without the upload API", async () => {
    const wrapper = mountPanel({ isRemote: true, attachmentList: vi.fn().mockResolvedValue([existing]) });
    await flushPromises();
    expect(wrapper.find("[data-role='attachment-add']").exists()).toBe(false);
    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    expect(wrapper.find("[data-role='attachment-save']").exists()).toBe(false);
    const drop = fileEvent("drop", [fakeFile("a.txt")]);
    wrapper.get("section").element.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    wrapper.unmount();
  });

  it("uploads the files chosen with Add file and refreshes the list once at the end", async () => {
    const api = uploadApi();
    const wrapper = mountPanel(api);
    await flushPromises();
    const input = wrapper.get("[data-role='attachment-file-input']").element as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [fakeFile("a.txt"), fakeFile("b.txt")] });
    api.attachmentUploadFinish.mockResolvedValueOnce(record("a.txt")).mockResolvedValueOnce(record("b.txt"));
    await wrapper.get("[data-role='attachment-file-input']").trigger("change");
    await flushPromises();
    expect(api.attachmentUploadBegin).toHaveBeenCalledTimes(2);
    expect(api.attachmentUploadBegin.mock.calls[0][0]).toMatchObject({ workspaceId: "ws-a", name: "a.txt", size: 5 });
    expect(wrapper.find("[data-role='attachment-transfers']").exists()).toBe(false);
    expect(api.attachmentList).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("appends the finished record to the list without waiting for a refresh", async () => {
    const api = uploadApi();
    const wrapper = mountPanel(api);
    await flushPromises();
    api.attachmentList.mockImplementation(() => new Promise(() => undefined));
    const input = wrapper.get("[data-role='attachment-file-input']").element as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [fakeFile("new.txt")] });
    await wrapper.get("[data-role='attachment-file-input']").trigger("change");
    await flushPromises();
    expect(wrapper.findAll(".workspace-attachments__details strong").map((n) => n.text())).toContain("new.txt");
    wrapper.unmount();
  });

  it("highlights while files are dragged over, ignores drags without files, and uploads on drop", async () => {
    const api = uploadApi();
    const wrapper = mountPanel(api);
    await flushPromises();
    const section = wrapper.get("section").element;

    const textDrag = fileEvent("dragenter", [], ["text/plain"]);
    section.dispatchEvent(textDrag);
    expect(textDrag.defaultPrevented).toBe(false);
    expect(wrapper.find("[data-role='attachment-dropzone']").exists()).toBe(false);

    section.dispatchEvent(fileEvent("dragenter", []));
    await flushPromises();
    expect(wrapper.find("[data-role='attachment-dropzone']").exists()).toBe(true);
    expect(wrapper.classes()).toContain("workspace-attachments--dragging");

    section.dispatchEvent(fileEvent("drop", [fakeFile("new.txt")]));
    await flushPromises();
    expect(wrapper.find("[data-role='attachment-dropzone']").exists()).toBe(false);
    expect(api.attachmentUploadBegin).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("uploads pasted files, naming a generic screenshot like pasted-<timestamp>.png", async () => {
    const api = uploadApi();
    const wrapper = mountPanel(api);
    await flushPromises();
    const shot = fakeFile("image.png");
    Object.assign(shot, { type: "image/png" });
    vi.stubGlobal(
      "File",
      class {
        name: string;
        size = 5;
        type: string;
        constructor(_parts: unknown[], name: string, options: { type: string }) {
          this.name = name;
          this.type = options.type;
        }
        slice() {
          return { arrayBuffer: async () => new Uint8Array(5).buffer };
        }
      },
    );
    const paste = fileEvent("paste", [shot]);
    wrapper.get("section").element.dispatchEvent(paste);
    await flushPromises();
    vi.unstubAllGlobals();
    expect(paste.defaultPrevented).toBe(true);
    expect(api.attachmentUploadBegin.mock.calls[0][0].name).toMatch(/^pasted-\d{8}-\d{6}\.png$/);
    wrapper.unmount();
  });

  it("leaves a text-only paste alone", async () => {
    const api = uploadApi();
    const wrapper = mountPanel(api);
    await flushPromises();
    const paste = fileEvent("paste", []);
    wrapper.get("section").element.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    expect(api.attachmentUploadBegin).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("shows progress with a cancel button and drops the row when cancelled", async () => {
    let release!: (value: { received: number }) => void;
    const api = uploadApi({
      attachmentUploadChunk: vi.fn(() => new Promise<{ received: number }>((resolve) => (release = resolve))),
    });
    const wrapper = mountPanel(api);
    await flushPromises();
    wrapper.get("section").element.dispatchEvent(fileEvent("drop", [fakeFile("big.bin", 10)]));
    await flushPromises();
    const row = wrapper.get(".workspace-attachments__transfer");
    expect(row.text()).toContain("big.bin");
    expect(row.get("[role='progressbar']").attributes("aria-valuenow")).toBe("0");
    await row.get("button").trigger("click");
    release({ received: 5 });
    await flushPromises();
    expect(api.attachmentUploadCancel).toHaveBeenCalledOnce();
    expect(wrapper.find(".workspace-attachments__transfer").exists()).toBe(false);
    expect(showError).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps a failure visible with the server sentence and raises an error toast", async () => {
    const sentence = "The file is larger than the 1 GiB limit.";
    const api = uploadApi({
      attachmentUploadBegin: vi.fn(async () => {
        throw new Error(sentence);
      }),
    });
    const wrapper = mountPanel(api);
    await flushPromises();
    wrapper.get("section").element.dispatchEvent(fileEvent("drop", [fakeFile("huge.bin")]));
    await flushPromises();
    expect(wrapper.get(".workspace-attachments__transfer-error").text()).toBe(sentence);
    expect(showError).toHaveBeenCalledWith("Upload failed", sentence, { workspaceId: "ws-a" });
    await wrapper.get(".workspace-attachments__transfer-button").trigger("click");
    expect(wrapper.find(".workspace-attachments__transfer").exists()).toBe(false);
    wrapper.unmount();
  });

  it("disables the controls with the reason and refuses a drop in an SSH or container workspace", async () => {
    const api = uploadApi();
    const reason = "Attachments are not available in SSH workspaces.";
    const wrapper = mountPanel(api, { unavailableReason: reason });
    await flushPromises();
    const add = wrapper.get("[data-role='attachment-add']");
    expect(add.attributes("disabled")).toBeDefined();
    expect(add.attributes("title")).toBe(reason);
    wrapper.get("section").element.dispatchEvent(fileEvent("drop", [fakeFile("a.txt")]));
    await flushPromises();
    expect(api.attachmentUploadBegin).not.toHaveBeenCalled();
    expect(wrapper.get("[role='status']").text()).toBe(reason);
    wrapper.unmount();
  });
});

describe("WorkspaceAttachments save and menu wording", () => {
  function b64(text: string) {
    return btoa(text);
  }

  it("saves the whole file through attachmentRead windows and stops at eof", async () => {
    const attachmentRead = vi
      .fn()
      .mockResolvedValueOnce({ data: b64("abc"), size: 6, eof: false })
      .mockResolvedValueOnce({ data: b64("def"), size: 6, eof: true });
    const api = { ...uploadApi(), attachmentRead };
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const wrapper = mountPanel(api);
    await flushPromises();
    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    await wrapper.get("[data-role='attachment-save']").trigger("click");
    await flushPromises();
    expect(attachmentRead.mock.calls.map(([req]) => [req.offset, req.length, req.name, req.transferId])).toEqual([
      [0, ATTACHMENT_READ_MAX_BYTES, "old.png", "t-old"],
      [3, ATTACHMENT_READ_MAX_BYTES, "old.png", "t-old"],
    ]);
    expect(click).toHaveBeenCalledOnce();
    expect(wrapper.find(".workspace-attachments__transfer").exists()).toBe(false);
    wrapper.unmount();
  });

  it("reports a failed save and keeps it visible", async () => {
    const attachmentRead = vi.fn().mockRejectedValue(new Error("The file is gone."));
    const wrapper = mountPanel({ ...uploadApi(), attachmentRead });
    await flushPromises();
    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    await wrapper.get("[data-role='attachment-save']").trigger("click");
    await flushPromises();
    expect(wrapper.get(".workspace-attachments__transfer-error").text()).toBe("The file is gone.");
    expect(showError).toHaveBeenCalledWith("Download failed", expect.any(Error), { workspaceId: "ws-a" });
    wrapper.unmount();
  });

  it("offers Save only when the backend is another machine", async () => {
    const local = mountPanel({
      isRemote: false,
      attachmentList: vi.fn().mockResolvedValue([existing]),
      attachmentRead: vi.fn(),
    });
    await flushPromises();
    await local.get("[data-role='attachment-menu-trigger']").trigger("click");
    expect(local.find("[data-role='attachment-save']").exists()).toBe(false);
    local.unmount();
  });

  it("words the absolute-path hint for each kind of window and hides desktop-only actions in a peer window", async () => {
    const list = vi.fn().mockResolvedValue([existing]);
    const inspect = async (api: Record<string, unknown>) => {
      const wrapper = mountPanel(api);
      await flushPromises();
      const hasOpen = wrapper.find(".workspace-attachments__open").exists();
      await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
      const items = wrapper.findAll("[role='menuitem']");
      const title = items[0].attributes("title");
      const clipboard = items.find((item) => item.text() === "Copy into clipboard")!;
      const clipboardDisabled = clipboard.attributes("disabled") !== undefined;
      wrapper.unmount();
      return { title, hasOpen, clipboardDisabled };
    };
    expect(
      await inspect({
        isRemote: false,
        attachmentList: list,
        fileClipboardCopy: vi.fn(),
        openTerminalPath: vi.fn(),
      }),
    ).toEqual({ title: "Copy the path on this computer", hasOpen: true, clipboardDisabled: false });
    expect(await inspect({ isRemote: true, attachmentList: list })).toEqual({
      title: "Copy the path on the desktop workspace",
      hasOpen: false,
      clipboardDisabled: true,
    });
    setWindowBackend({
      kind: "peer",
      hostId: "h1",
      hostLabel: "Studio Mac",
      remoteProfileId: "p",
      clientId: "c",
      terminalFontSize: 13,
    } as never);
    expect(
      await inspect({
        isRemote: true,
        hasNativeShell: true,
        attachmentList: list,
        fileClipboardCopy: vi.fn(),
        openTerminalPath: vi.fn(),
      }),
    ).toEqual({ title: "Copy the path on Studio Mac", hasOpen: false, clipboardDisabled: true });
  });
});

describe("WorkspaceAttachments busy indicators", () => {
  function deferred<T = unknown>() {
    let resolve!: (_value: T) => void;
    let reject!: (_reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it.each([["resolves"], ["rejects"]])(
    "the first list shows a spinner, not an empty state, until it %s",
    async (how) => {
      const list = deferred<AttachmentRecord[]>();
      const wrapper = mountPanel({ isRemote: true, attachmentList: vi.fn().mockReturnValue(list.promise) });
      await flushPromises();
      const status = wrapper.get(".workspace-attachments__status--wait");
      expect(status.attributes("role")).toBe("status");
      expect(status.text()).toContain("Loading attachments…");
      expect(status.find(".spinner").exists()).toBe(true);
      expect(wrapper.text()).not.toContain("No attachments yet.");

      if (how === "resolves") list.resolve([]);
      else list.reject(new Error("The other computer is not answering."));
      await flushPromises();
      expect(wrapper.find(".workspace-attachments__status--wait").exists()).toBe(false);
      expect(wrapper.find(".spinner").exists()).toBe(false);
      if (how === "resolves") expect(wrapper.text()).toContain("No attachments yet.");
      else {
        expect(wrapper.get("[role='alert']").text()).toContain("The other computer is not answering.");
        expect(wrapper.text()).not.toContain("No attachments yet.");
      }
      wrapper.unmount();
    },
  );

  it.each([["resolves"], ["rejects"]])("the refresh button spins and is locked until the reload %s", async (how) => {
    const api = uploadApi();
    const wrapper = mountPanel(api);
    await flushPromises();
    const reload = deferred<AttachmentRecord[]>();
    api.attachmentList.mockReturnValue(reload.promise);
    const refresh = wrapper.get(".workspace-attachments__refresh");
    await refresh.trigger("click");
    expect(refresh.attributes("aria-busy")).toBe("true");
    expect(refresh.attributes("disabled")).toBeDefined();
    expect(refresh.find(".spinner").exists()).toBe(true);
    expect(wrapper.text()).toContain("old.png");

    if (how === "resolves") reload.resolve([existing]);
    else reload.reject(new Error("unreachable"));
    await flushPromises();
    expect(refresh.attributes("aria-busy")).toBeUndefined();
    expect(refresh.attributes("disabled")).toBeUndefined();
    expect(refresh.find(".spinner").exists()).toBe(false);
    if (how === "rejects") expect(wrapper.get("[role='alert']").text()).toContain("unreachable");
    wrapper.unmount();
  });

  it.each([["resolves"], ["rejects"]])(
    "Delete leaves a spinner on its row, which cannot be deleted twice, until it %s",
    async (how) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const call = deferred<void>();
      const attachmentDelete = vi.fn().mockReturnValue(call.promise);
      const api = uploadApi({ attachmentDelete });
      const wrapper = mountPanel(api);
      await flushPromises();
      await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
      await wrapper.get(".workspace-attachments__menu-delete").trigger("click");
      await flushPromises();
      const item = wrapper.get(".workspace-attachments__item");
      expect(item.attributes("aria-busy")).toBe("true");
      expect(item.find("[data-role='attachment-deleting']").exists()).toBe(true);

      await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
      await wrapper.get(".workspace-attachments__menu-delete").trigger("click");
      await flushPromises();
      expect(attachmentDelete).toHaveBeenCalledTimes(1);

      if (how === "resolves") {
        api.attachmentList.mockResolvedValue([]);
        call.resolve();
      } else call.reject(new Error("The file is in use."));
      await flushPromises();
      expect(wrapper.find("[data-role='attachment-deleting']").exists()).toBe(false);
      if (how === "rejects") {
        expect(wrapper.find(".workspace-attachments__item").attributes("aria-busy")).toBeUndefined();
        expect(wrapper.get("[role='alert']").text()).toContain("The file is in use.");
      } else expect(wrapper.find(".workspace-attachments__item").exists()).toBe(false);
      wrapper.unmount();
    },
  );

  it.each([["resolves"], ["rejects"]])(
    "an upload at 100 % says Finishing… and cannot be cancelled until the host answers (%s)",
    async (how) => {
      const finish = deferred<AttachmentRecord>();
      const api = uploadApi({ attachmentUploadFinish: vi.fn().mockReturnValue(finish.promise) });
      const wrapper = mountPanel(api);
      await flushPromises();
      const input = wrapper.get("[data-role='attachment-file-input']").element as HTMLInputElement;
      Object.defineProperty(input, "files", { configurable: true, value: [fakeFile("big.bin")] });
      await wrapper.get("[data-role='attachment-file-input']").trigger("change");
      await flushPromises();

      const transfer = wrapper.get(".workspace-attachments__transfer");
      expect(transfer.text()).toContain("Finishing…");
      expect(transfer.text()).not.toContain("100 %");
      expect(transfer.get(".workspace-attachments__transfer-button").attributes("disabled")).toBeDefined();
      expect(transfer.find("[role='progressbar']").attributes("aria-valuenow")).toBe("100");

      if (how === "resolves") finish.resolve(record("big.bin"));
      else finish.reject(new Error("The checksum did not match."));
      await flushPromises();
      if (how === "resolves") expect(wrapper.find(".workspace-attachments__transfer").exists()).toBe(false);
      else {
        const failed = wrapper.get(".workspace-attachments__transfer");
        expect(failed.text()).not.toContain("Finishing…");
        expect(failed.get("[role='alert']").text()).toContain("The checksum did not match.");
        expect(showError).toHaveBeenCalled();
      }
      wrapper.unmount();
    },
  );
});
