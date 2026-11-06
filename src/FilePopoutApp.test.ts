import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("./components/shared/MonacoEditor.vue", () => ({
  __esModule: true,
  default: {
    name: "MonacoEditor",
    props: { modelValue: String, language: String, readOnly: Boolean, autoFocus: Boolean },
    emits: ["update:modelValue", "save"],
    template:
      '<textarea class="stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
}));
vi.mock("./lib/renderer-log.js", () => ({ rlog: vi.fn() }));

import FilePopoutApp from "./FilePopoutApp.vue";
import { rlog } from "./lib/renderer-log.js";

const base = { rootPath: "/r", relativePath: "src/a.ts", name: "a.ts" };

function setBridge(init: unknown, extra: Record<string, unknown> = {}) {
  const bridge = {
    getFilePopoutInit: vi.fn().mockResolvedValue(init),
    fileRead: vi.fn().mockResolvedValue({ content: "from disk" }),
    fileWrite: vi.fn().mockResolvedValue({ ok: true }),
    ...extra,
  };
  (window as unknown as { strideterm: unknown }).strideterm = bridge;
  return bridge;
}

const saveButton = (w: ReturnType<typeof mount>) => w.find("button.file-popout__save");

describe("FilePopoutApp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the file when no content is passed", async () => {
    const bridge = setBridge(base);
    const w = mount(FilePopoutApp);
    await flushPromises();
    expect(bridge.fileRead).toHaveBeenCalledWith({ rootPath: "/r", relativePath: "src/a.ts" });
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("from disk");
    expect(saveButton(w).attributes("disabled")).toBeDefined();
  });

  it("uses passed content and starts dirty when asked", async () => {
    const bridge = setBridge({ ...base, content: "draft", dirty: true });
    const w = mount(FilePopoutApp);
    await flushPromises();
    expect(bridge.fileRead).not.toHaveBeenCalled();
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("draft");
    expect(saveButton(w).attributes("disabled")).toBeUndefined();
    expect(w.find(".file-popout__dirty").exists()).toBe(true);
    expect(document.title).toBe("● a.ts");
  });

  it("saves the edited content and clears dirty", async () => {
    const bridge = setBridge(base);
    const w = mount(FilePopoutApp);
    await flushPromises();
    await w.find("textarea").setValue("edited");
    expect(saveButton(w).attributes("disabled")).toBeUndefined();
    await saveButton(w).trigger("click");
    await flushPromises();
    expect(bridge.fileWrite).toHaveBeenCalledWith({ rootPath: "/r", relativePath: "src/a.ts", content: "edited" });
    expect(saveButton(w).attributes("disabled")).toBeDefined();
    expect(w.find(".file-popout__dirty").exists()).toBe(false);
  });

  it("shows a failed save, logs it and stays dirty", async () => {
    const bridge = setBridge(base, { fileWrite: vi.fn().mockRejectedValue(new Error("EACCES")) });
    const w = mount(FilePopoutApp);
    await flushPromises();
    await w.find("textarea").setValue("edited");
    await saveButton(w).trigger("click");
    await flushPromises();
    expect(bridge.fileWrite).toHaveBeenCalled();
    expect(w.find(".file-popout__error").text()).toContain("EACCES");
    expect(w.find(".file-popout__dirty").exists()).toBe(true);
    expect(rlog).toHaveBeenCalledWith("error", expect.stringContaining("save failed"), expect.anything());
  });
  describe("changed on disk", () => {
    const conflictError = () => new Error("FILE_CHANGED_ON_DISK: src/a.ts changed on disk since it was opened");
    const buttons = (w: ReturnType<typeof mount>) => w.findAll(".file-popout__conflict-actions button");

    async function openAndEdit(extra: Record<string, unknown>) {
      const bridge = setBridge(base, {
        fileRead: vi.fn().mockResolvedValue({ content: "from disk", mtimeMs: 100 }),
        ...extra,
      });
      const w = mount(FilePopoutApp);
      await flushPromises();
      await w.find("textarea").setValue("edited");
      return { bridge, w };
    }

    it("sends the mtime it read and remembers the one the save returned", async () => {
      const { bridge, w } = await openAndEdit({ fileWrite: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 200 }) });
      await saveButton(w).trigger("click");
      await flushPromises();
      expect(bridge.fileWrite).toHaveBeenLastCalledWith({
        rootPath: "/r",
        relativePath: "src/a.ts",
        content: "edited",
        expectedMtimeMs: 100,
      });
      await w.find("textarea").setValue("edited again");
      await saveButton(w).trigger("click");
      await flushPromises();
      expect(bridge.fileWrite).toHaveBeenLastCalledWith(expect.objectContaining({ expectedMtimeMs: 200 }));
    });

    it("offers Overwrite and retries without the check", async () => {
      const fileWrite = vi.fn().mockRejectedValueOnce(conflictError()).mockResolvedValue({ ok: true, mtimeMs: 300 });
      const { bridge, w } = await openAndEdit({ fileWrite });
      await saveButton(w).trigger("click");
      await flushPromises();
      expect(w.find(".file-popout__error").text()).toContain("changed on disk");
      expect(buttons(w).map((b) => b.text())).toEqual(["Overwrite", "Cancel"]);
      expect(rlog).toHaveBeenCalledWith("warn", expect.stringContaining("changed on disk"), expect.anything());
      await buttons(w)[0].trigger("click");
      await flushPromises();
      expect(bridge.fileWrite).toHaveBeenLastCalledWith({
        rootPath: "/r",
        relativePath: "src/a.ts",
        content: "edited",
      });
      expect(w.find(".file-popout__error").exists()).toBe(false);
      expect(w.find(".file-popout__dirty").exists()).toBe(false);
    });

    it("Cancel keeps the editor dirty and writes nothing more", async () => {
      const fileWrite = vi.fn().mockRejectedValue(conflictError());
      const { bridge, w } = await openAndEdit({ fileWrite });
      await saveButton(w).trigger("click");
      await flushPromises();
      await buttons(w)[1].trigger("click");
      await flushPromises();
      expect(bridge.fileWrite).toHaveBeenCalledTimes(1);
      expect(w.find(".file-popout__error").exists()).toBe(false);
      expect(w.find(".file-popout__dirty").exists()).toBe(true);
    });
  });
});
