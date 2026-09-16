import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkspaceAttachments from "./WorkspaceAttachments.vue";
import { apiKey } from "../../types/keys.js";
import type { AttachmentRecord } from "../../attachments.js";

const attachment: AttachmentRecord = {
  transferId: "transfer-1",
  path: ".strideterm/attachments/transfer-1/photo.png",
  size: 2048,
  sha256: "a".repeat(64),
  name: "photo.png",
};

function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mountPanel(
  api: Record<string, unknown>,
  props: Partial<{ workspaceId: string; workspaceRoot: string; openByDefault: boolean; panel: boolean }> = {},
) {
  return mount(WorkspaceAttachments, {
    props: { workspaceId: "workspace-a", ...props },
    global: { provide: { [apiKey as symbol]: api } },
  });
}

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WorkspaceAttachments", () => {
  it("groups uploads by day newest first and combines day and text filters", async () => {
    const today = new Date();
    today.setHours(10, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const wrapper = mountPanel({
      attachmentList: vi.fn().mockResolvedValue([
        { ...attachment, transferId: "old", name: "old.png", uploadedAt: yesterday.getTime() },
        { ...attachment, transferId: "unknown", name: "legacy.png" },
        { ...attachment, transferId: "new", name: "new.png", uploadedAt: today.getTime() },
      ]),
    });
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".notif-day-separator__label").map((label) => label.text())).toEqual([
      "Today",
      "Yesterday",
      "Unknown date",
    ]);
    expect(wrapper.findAll(".workspace-attachments__details strong").map((name) => name.text())).toEqual([
      "new.png",
      "old.png",
      "legacy.png",
    ]);
    await wrapper.get("select").setValue("yesterday");
    expect(wrapper.findAll(".workspace-attachments__row")).toHaveLength(1);
    expect(wrapper.get(".workspace-attachments__details strong").text()).toBe("old.png");
    await wrapper.get("input").setValue("no-match");
    expect(wrapper.text()).toContain("No matching attachments.");
    await wrapper.setProps({ workspaceId: "workspace-b" });
    expect((wrapper.get("select").element as HTMLSelectElement).value).toBe("");
    wrapper.unmount();
  });

  it("keeps rows and the menu during refresh and reports refresh errors", async () => {
    const attachmentList = vi.fn().mockResolvedValueOnce([attachment]).mockRejectedValueOnce(new Error("offline"));
    const wrapper = mountPanel({ attachmentList });
    await wrapper.get("button").trigger("click");
    await flushPromises();
    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    await wrapper.get(".workspace-attachments__refresh").trigger("click");
    await flushPromises();
    expect(wrapper.find(".workspace-attachments__row").exists()).toBe(true);
    expect(wrapper.find("[role='menu']").exists()).toBe(true);
    expect(wrapper.get("[role='alert']").text()).toBe("offline");
    wrapper.unmount();
  });

  it("copies an absolute path when the workspace is the filesystem root", async () => {
    const writeText = mockClipboard();
    const wrapper = mountPanel({ attachmentList: vi.fn().mockResolvedValue([attachment]) }, { workspaceRoot: "/" });
    await wrapper.get("button").trigger("click");
    await flushPromises();
    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    await wrapper.get("[role='menuitem']").trigger("click");
    expect(writeText).toHaveBeenCalledWith(`/${attachment.path}`);
    wrapper.unmount();
  });

  it("filters case-insensitively and copies the row relative path with feedback", async () => {
    const writeText = mockClipboard();
    const wrapper = mountPanel({
      attachmentList: vi.fn().mockResolvedValue([
        attachment,
        {
          ...attachment,
          transferId: "transfer-2",
          name: "notes.md",
          path: ".strideterm/attachments/transfer-2/notes.md",
        },
      ]),
    });

    await wrapper.get("button").trigger("click");
    await flushPromises();
    await wrapper.get("input[type='search']").setValue("PHOTO");
    expect(wrapper.findAll(".workspace-attachments__item")).toHaveLength(1);
    await wrapper.get(".workspace-attachments__row").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(attachment.path);
    expect(wrapper.text()).toContain("Relative path copied");
  });

  it("copies an absolute path and uses native file clipboard only on desktop", async () => {
    const writeText = mockClipboard();
    const fileClipboardCopy = vi.fn().mockResolvedValue({ ok: true });
    const wrapper = mountPanel(
      { attachmentList: vi.fn().mockResolvedValue([attachment]), fileClipboardCopy, isRemote: false },
      { workspaceRoot: "C:\\repo" },
    );
    await wrapper.get("button").trigger("click");
    await flushPromises();
    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    await wrapper.get("[role='menuitem']").trigger("click");
    expect(writeText).toHaveBeenCalledWith("C:\\repo\\.strideterm\\attachments\\transfer-1\\photo.png");

    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    await wrapper
      .findAll("[role='menuitem']")
      .find((button) => button.text() === "Copy into clipboard")!
      .trigger("click");
    expect(fileClipboardCopy).toHaveBeenCalledWith({ rootPath: "C:\\repo", relativePath: attachment.path });
  });

  it("does not call the remote native clipboard no-op and closes its menu on Escape", async () => {
    const fileClipboardCopy = vi.fn().mockResolvedValue({ ok: true });
    const wrapper = mountPanel(
      { attachmentList: vi.fn().mockResolvedValue([attachment]), fileClipboardCopy, isRemote: true },
      { workspaceRoot: "/repo" },
    );
    await wrapper.get("button").trigger("click");
    await flushPromises();
    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    expect(wrapper.find("[role='menu']").exists()).toBe(true);
    await wrapper.get("[role='menu']").trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.find("[role='menu']").exists()).toBe(false);
    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    const nativeCopy = wrapper.findAll("[role='menuitem']").find((button) => button.text() === "Copy into clipboard")!;
    expect(nativeCopy.attributes("disabled")).toBeDefined();
    expect(fileClipboardCopy).not.toHaveBeenCalled();
  });

  it("ignores a stale list response after switching workspace", async () => {
    const first = deferred<AttachmentRecord[]>();
    const second = deferred<AttachmentRecord[]>();
    const attachmentList = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const wrapper = mountPanel({ attachmentList });

    await wrapper.get("button").trigger("click");
    await wrapper.setProps({ workspaceId: "workspace-b" } as never);
    first.resolve([attachment]);
    await flushPromises();
    expect(wrapper.text()).toContain("Loading attachments…");

    second.resolve([{ ...attachment, name: "new.png", path: ".strideterm/attachments/transfer-1/new.png" }]);
    await flushPromises();
    expect(wrapper.text()).toContain("new.png");
    expect(wrapper.text()).not.toContain("photo.png");
    expect(attachmentList).toHaveBeenNthCalledWith(2, { workspaceId: "workspace-b" });
  });

  it("polls while open and stops polling when closed or unmounted", async () => {
    vi.useFakeTimers();
    const attachmentList = vi.fn().mockResolvedValue([]);
    const wrapper = mountPanel({ attachmentList });

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(attachmentList).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    await flushPromises();
    expect(attachmentList).toHaveBeenCalledTimes(2);

    await wrapper.get("button").trigger("click");
    vi.advanceTimersByTime(10000);
    expect(attachmentList).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    vi.advanceTimersByTime(10000);
    expect(attachmentList).toHaveBeenCalledTimes(2);
  });

  it("cancels deletion and sends the captured workspace on confirmation", async () => {
    const attachmentList = vi.fn().mockResolvedValue([attachment]);
    const attachmentDelete = vi.fn().mockResolvedValue({ ok: true });
    const wrapper = mountPanel({ attachmentList, attachmentDelete });
    await wrapper.get("button").trigger("click");
    await flushPromises();

    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    await wrapper.get(".workspace-attachments__menu-delete").trigger("click");
    expect(attachmentDelete).not.toHaveBeenCalled();

    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    await wrapper.get("[data-role='attachment-menu-trigger']").trigger("click");
    await wrapper.get(".workspace-attachments__menu-delete").trigger("click");
    await flushPromises();
    expect(attachmentDelete).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      transferId: attachment.transferId,
      name: attachment.name,
    });
  });

  it("shows list errors", async () => {
    const attachmentList = vi.fn().mockRejectedValue(new Error("offline"));
    const wrapper = mountPanel({ attachmentList });
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("offline");
  });
});
