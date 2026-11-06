import { computed } from "vue";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import FileCommander from "./FileCommander.vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import { useAppStore } from "../../../stores/app.js";
import { rememberCommanderRoot } from "./commander-helpers.js";
import { filesOwnerWorkspaceIdKey } from "../../../types/keys.js";

vi.mock("../../shared/MonacoEditor.vue", () => ({
  __esModule: true,
  default: {
    props: { modelValue: String, language: String, readOnly: Boolean },
    template:
      '<pre class="monaco-stub" :data-language="language" :data-read-only="String(readOnly)">{{ modelValue }}</pre>',
  },
}));

vi.mock("../../shared/MonacoDiffPanel.vue", () => ({
  __esModule: true,
  default: {
    props: { payload: Object },
    template: '<pre class="diff-stub">{{ payload?.leftContent }}|{{ payload?.rightContent }}</pre>',
  },
}));

vi.mock("../TerminalPane.vue", () => ({
  __esModule: true,
  default: { props: { sessionId: String }, template: '<div class="terminal-stub" :data-session="sessionId"></div>' },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

const entry = (relativePath: string, kind: "file" | "directory", extra: AnyObj = {}) => {
  const name = relativePath.split("/").pop() as string;
  return {
    name,
    relativePath,
    kind,
    size: kind === "file" ? 1234 : undefined,
    modifiedAt: "2026-10-10T12:00:00.000Z",
    extension: kind === "file" && name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".")) : "",
    isHidden: name.startsWith("."),
    ...extra,
  };
};

const TREE: Record<string, AnyObj[]> = {
  "": [
    entry("zeta.txt", "file"),
    entry("src", "directory"),
    entry("archive.tar.gz", "file", { size: 2048 }),
    entry(".gitignore", "file"),
    entry("docs", "directory"),
    entry("alpha.ts", "file"),
  ],
  src: [entry("src/inner", "directory"), entry("src/main.ts", "file")],
  docs: [entry("docs/readme.md", "file")],
  "src/inner": [entry("src/inner/deep.txt", "file")],
};

function makeApi(overrides: AnyObj = {}) {
  const calls = { fileList: [] as AnyObj[], filePreview: [] as AnyObj[], fileRead: [] as AnyObj[] };
  const api = {
    fileList: async (p: AnyObj) => {
      calls.fileList.push(p);
      return { entries: TREE[p.relativePath || ""] || [], path: p.relativePath || "" };
    },
    filePreview: async (p: AnyObj) => {
      calls.filePreview.push(p);
      return { kind: "text", content: `content of ${p.relativePath}` };
    },
    fileRead: async (p: AnyObj) => {
      calls.fileRead.push(p);
      return { content: "" };
    },
    fileGitStatus: async () => ({ isRepo: true, root: "/repo", entries: { "alpha.ts": { status: "modified" } } }),
    ...overrides,
  };
  return { api, calls };
}

let wrapper: VueWrapper | null = null;
let seq = 0;

async function setup(options: { narrow?: boolean; api?: AnyObj; provide?: AnyObj } = {}) {
  const store = useFileManagerStore();
  const { api, calls } = makeApi(options.api);
  store.setApi(api);
  await store.init(`/repo-${(seq += 1)}`);
  wrapper = mount(FileCommander, {
    props: { narrow: options.narrow ?? false, hostViewId: "files:files1" },
    attachTo: document.body,
    global: {
      provide: {
        "fm-context-menu": vi.fn(),
        "fm-rename": vi.fn(),
        "fm-delete": vi.fn(),
        "fm-create-dir": vi.fn(),
        ...options.provide,
      },
    },
  });
  await flushPromises();
  return { store, calls, w: wrapper };
}

const label = (el: ReturnType<VueWrapper["find"]>) =>
  el.find(".fcp__base").exists() ? el.find(".fcp__base").text() : el.text();
const names = (w: VueWrapper, side = 0) =>
  w
    .findAll(".fcp")
    [side].findAll(".fcp__row .fcp__name")
    .map((el) => label(el));
const cursorName = (w: VueWrapper, side = 0) => {
  return label(w.findAll(".fcp")[side].find(".fcp__row--cursor .fcp__name"));
};

async function press(w: VueWrapper, key: string, init: KeyboardEventInit = {}) {
  await w.find(".fc").trigger("keydown", { key, ...init });
  await flushPromises();
}

describe("FileCommander", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
  });

  it("splits names and extensions, lists directories first as [dir] / <DIR>, and has no [..] at the root", async () => {
    const { w } = await setup();
    const store = useFileManagerStore();
    store.showHidden = true;
    await flushPromises();
    expect(names(w)).toEqual(["[docs]", "[src]", ".gitignore", "alpha", "archive.tar", "zeta"]);
    const rows = w.findAll(".fcp")[0].findAll(".fcp__row");
    expect(rows[0].find(".fcp__c--size").text()).toBe("<DIR>");
    const gitignore = rows[2];
    expect(gitignore.find(".fcp__c--ext").text()).toBe("");
    const archive = rows[4];
    expect(archive.find(".fcp__c--ext").text()).toBe("gz");
    expect(archive.find(".fcp__c--size").text()).toBe((2048).toLocaleString());
    expect(rows[3].find(".fcp__c--git").text()).toBe("M");
  });

  it("hides dot-files unless showHidden is on", async () => {
    const { w } = await setup();
    expect(names(w)).not.toContain(".gitignore");
  });

  it("moves the cursor with the arrow, Home and End keys", async () => {
    const { w } = await setup();
    expect(cursorName(w)).toBe("[docs]");
    await press(w, "ArrowDown");
    expect(cursorName(w)).toBe("[src]");
    await press(w, "End");
    expect(cursorName(w)).toBe("zeta");
    await press(w, "ArrowUp");
    expect(cursorName(w)).toBe("archive.tar");
    await press(w, "Home");
    expect(cursorName(w)).toBe("[docs]");
  });

  it("enters a directory with Enter and returns with the cursor on the folder we came from", async () => {
    const { w } = await setup();
    await press(w, "ArrowDown");
    await press(w, "Enter");
    expect(names(w)).toEqual(["[..]", "[inner]", "main"]);
    expect(cursorName(w)).toBe("[..]");
    await press(w, "ArrowDown");
    await press(w, "Enter");
    expect(names(w)).toEqual(["[..]", "deep"]);
    await press(w, "Backspace");
    expect(names(w)).toEqual(["[..]", "[inner]", "main"]);
    expect(cursorName(w)).toBe("[inner]");
    await press(w, "Backspace");
    expect(cursorName(w)).toBe("[src]");
  });

  it("Enter on [..] goes to the parent with the cursor on the folder we came from", async () => {
    const { w } = await setup();
    await press(w, "ArrowDown");
    await press(w, "Enter");
    await press(w, "Enter");
    expect(names(w)).toContain("[src]");
    expect(cursorName(w)).toBe("[src]");
  });

  it("Tab switches the active panel and aligns the store with its folder", async () => {
    const { w, store } = await setup();
    await press(w, "ArrowDown");
    await press(w, "Enter");
    await flushPromises();
    expect(store.currentPath).toBe("src");
    const navigate = vi.spyOn(store, "navigate");
    await press(w, "Tab");
    await flushPromises();
    expect(w.findAll(".fcp")[1].classes()).toContain("fcp--active");
    expect(navigate).toHaveBeenCalledWith("");
    expect(store.currentPath).toBe("");
  });

  it("Insert marks the cursor entry, moves down and updates the status line", async () => {
    const { w } = await setup();
    await press(w, "ArrowDown", {});
    await press(w, "ArrowDown", {});
    expect(cursorName(w)).toBe("alpha");
    await press(w, "Insert");
    expect(cursorName(w)).toBe("archive.tar");
    expect(w.findAll(".fcp__row--marked")).toHaveLength(1);
    expect(w.findAll(".fcp")[0].find(".fcp__status").text()).toBe("1.2 k / 4.4 k in 1 / 3 files, 0 / 2 folders");
    await press(w, " ");
    expect(w.findAll(".fcp")[0].find(".fcp__status").text()).toContain("in 2 / 3 files");
  });

  it("F3 opens Quick View through fileList and filePreview and never adds an editor tab", async () => {
    const { w, store, calls } = await setup();
    await press(w, "ArrowDown");
    await press(w, "ArrowDown");
    await press(w, "F3");
    await flushPromises();
    expect(w.find(".fcq").exists()).toBe(true);
    expect(w.findAll(".fcp")).toHaveLength(1);
    expect(w.find(".fcq__title-text").text()).toBe("Quick View: alpha.ts");
    const code = w.find(".fcq__code .monaco-stub");
    expect(code.text()).toBe("content of alpha.ts");
    expect(code.attributes("data-language")).toBe("typescript");
    expect(code.attributes("data-read-only")).toBe("true");
    expect(calls.filePreview.at(-1)).toMatchObject({ relativePath: "alpha.ts" });
    expect(store.editorTabs).toHaveLength(0);
    expect(store.selectedEntry).toBeNull();
    await press(w, "F3");
    expect(w.find(".fcq").exists()).toBe(false);
    expect(w.findAll(".fcp")).toHaveLength(2);
  });

  it("Quick View follows the cursor after a short delay and Escape closes it", async () => {
    const { w, calls } = await setup();
    await press(w, "ArrowDown");
    await press(w, "ArrowDown");
    await press(w, "F3");
    await flushPromises();
    vi.useFakeTimers();
    await press(w, "ArrowDown");
    const before = calls.filePreview.length;
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    expect(calls.filePreview.length).toBe(before + 1);
    expect(w.find(".fcq__title-text").text()).toBe("Quick View: archive.tar.gz");
    await press(w, "Escape");
    expect(w.find(".fcq").exists()).toBe(false);
  });

  async function setupEditor(options: { api?: AnyObj } = {}) {
    localStorage.setItem("files.layoutMode", "commander");
    setActivePinia(createPinia());
    const ctx = await setup({
      api: { fileRead: async (p: AnyObj) => ({ content: `saved ${p.relativePath}` }), ...options.api },
    });
    expect(ctx.store.layoutMode).toBe("commander");
    await press(ctx.w, "ArrowDown");
    await press(ctx.w, "ArrowDown");
    return ctx;
  }

  it("F4 edits the cursor file in the other panel and F4 again closes it with its tab", async () => {
    const { w, store } = await setupEditor();
    await press(w, "F4");
    await flushPromises();
    expect(store.layoutMode).toBe("commander");
    expect(w.findAll(".fcp")).toHaveLength(1);
    expect(w.find(".fce__title-text").text()).toContain("Edit: alpha.ts");
    const editor = w.find(".fce .monaco-stub");
    expect(editor.text()).toBe("saved alpha.ts");
    expect(editor.attributes("data-language")).toBe("typescript");
    expect(editor.attributes("data-read-only")).toBe("false");
    expect(store.editorTabs.map((tab) => tab.entry.relativePath)).toEqual(["alpha.ts"]);
    await press(w, "F4");
    await flushPromises();
    expect(w.find(".fce").exists()).toBe(false);
    expect(w.findAll(".fcp")).toHaveLength(2);
    expect(store.editorTabs).toHaveLength(0);
  });

  it("keeps a tab the user already had open when the commander editor closes", async () => {
    const { w, store } = await setupEditor();
    await store.selectEntry(store.entries.find((item) => item.relativePath === "alpha.ts")!);
    await press(w, "F4");
    await press(w, "Escape");
    expect(w.find(".fce").exists()).toBe(false);
    expect(store.editorTabs.map((tab) => tab.entry.relativePath)).toEqual(["alpha.ts"]);
  });

  it("does not close the editor when the user keeps unsaved changes", async () => {
    const { w, store } = await setupEditor();
    await press(w, "F4");
    const closeTab = vi.spyOn(store, "closeTab").mockResolvedValue(false);
    await press(w, "F4");
    expect(closeTab).toHaveBeenCalledWith("alpha.ts");
    expect(w.find(".fce").exists()).toBe(true);
  });

  it("keys typed in the editor never move the commander cursor", async () => {
    const { w } = await setupEditor();
    await press(w, "F4");
    await w.find(".fce .monaco-stub").trigger("keydown", { key: "ArrowDown" });
    await w.find(".fce .monaco-stub").trigger("keydown", { key: "F8" });
    expect(cursorName(w)).toBe("alpha");
    expect(w.find(".fce").exists()).toBe(true);
  });

  it("pops the editor out into a separate window when the desktop offers one", async () => {
    const openFilePopout = vi.fn(async () => ({ ok: true }));
    (window as AnyObj).strideterm = { openFilePopout };
    try {
      const { w, store } = await setupEditor();
      await press(w, "F4");
      await w.find(".fce [aria-label='Open in a separate window']").trigger("click");
      await flushPromises();
      expect(openFilePopout).toHaveBeenCalledWith({
        rootPath: store.rootPath,
        relativePath: "alpha.ts",
        name: "alpha.ts",
      });
      expect(w.find(".fce").exists()).toBe(false);
      expect(store.editorTabs).toHaveLength(0);
    } finally {
      delete (window as AnyObj).strideterm;
    }
  });

  it("offers no pop-out without the desktop bridge", async () => {
    const { w } = await setupEditor();
    await press(w, "F4");
    expect(w.find(".fce [aria-label='Open in a separate window']").exists()).toBe(false);
  });

  it("F2, F8 and F7 use the pane dialogs", async () => {
    const rename = vi.fn();
    const remove = vi.fn();
    const createDir = vi.fn();
    const { w } = await setup({
      provide: { "fm-rename": rename, "fm-delete": remove, "fm-create-dir": createDir },
    });
    await press(w, "F2");
    expect(rename).toHaveBeenCalledWith(expect.objectContaining({ relativePath: "docs" }));
    await press(w, "F8");
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ relativePath: "docs" }));
    await press(w, "F7");
    expect(createDir).toHaveBeenCalled();
  });

  it("a key pressed while a folder is still loading never acts on the previous folder's entries", async () => {
    const remove = vi.fn();
    const pending: (() => void)[] = [];
    const { w, store } = await setup({ provide: { "fm-delete": remove } });
    const { api } = makeApi({
      fileList: (p: AnyObj) =>
        new Promise((resolve) => {
          pending.push(() => resolve({ entries: TREE[p.relativePath || ""] || [], path: p.relativePath || "" }));
        }),
    });
    store.setApi(api);
    await w.find(".fc").trigger("keydown", { key: "Enter" });
    await w.find(".fc").trigger("keydown", { key: "ArrowDown" });
    await w.find(".fc").trigger("keydown", { key: "F8" });
    expect(remove).not.toHaveBeenCalled();
    await flushPromises();
    pending.splice(0).forEach((resolve) => resolve());
    await flushPromises();
    pending.splice(0).forEach((resolve) => resolve());
    await flushPromises();
    expect(names(w, 0)).toEqual(["[..]", "readme"]);
  });

  it("reloads both panels when the listing revision changes", async () => {
    const { w, store, calls } = await setup();
    const before = calls.fileList.length;
    store.listingRevision += 1;
    await flushPromises();
    expect(calls.fileList.length).toBe(before + 2);
    expect(names(w, 1)).toContain("[docs]");
  });

  it("shows one panel with a switcher in narrow mode and enters a directory with a single tap", async () => {
    const { w } = await setup({ narrow: true });
    expect(w.findAll(".fcp")).toHaveLength(1);
    const switcher = w.find(".fc__switch");
    expect(switcher.findAll("button").map((b) => b.text())).toEqual(["Left", "Right"]);
    await w.findAll(".fcp__row")[1].trigger("click");
    await flushPromises();
    expect(names(w)).toEqual(["[..]", "[inner]", "main"]);
    await w.findAll(".fcp__row")[2].trigger("click");
    await flushPromises();
    expect(names(w)).toEqual(["[..]", "[inner]", "main"]);
    expect(cursorName(w)).toBe("main");
    await switcher.findAll("button")[1].trigger("click");
    await flushPromises();
    expect(w.find(".fcp").classes()).toContain("fcp--active");
    expect(names(w)).toEqual(["[docs]", "[src]", "alpha", "archive.tar", "zeta"]);
  });

  it("restores both panels for a root when it is shown again", async () => {
    const { w, store } = await setup();
    await press(w, "ArrowDown");
    await press(w, "Enter");
    await press(w, "End");
    const root = store.rootPath;
    wrapper?.unmount();
    const again = mount(FileCommander, {
      attachTo: document.body,
      global: { provide: { "fm-context-menu": vi.fn() } },
    });
    wrapper = again;
    await flushPromises();
    expect(store.rootPath).toBe(root);
    expect(names(again)).toEqual(["[..]", "[inner]", "main"]);
    expect(cursorName(again)).toBe("main");
  });

  it("keeps marks across an unmount and drops the mark of a file that vanished", async () => {
    const { w, store } = await setup();
    await press(w, "ArrowDown");
    await press(w, "ArrowDown");
    await press(w, "Insert");
    await press(w, "Insert");
    expect(w.findAll(".fcp__row--marked")).toHaveLength(2);
    const root = store.rootPath;
    wrapper?.unmount();
    const remount = async () => {
      wrapper = mount(FileCommander, {
        attachTo: document.body,
        global: { provide: { "fm-context-menu": vi.fn() } },
      });
      await flushPromises();
      return wrapper;
    };
    const again = await remount();
    expect(store.rootPath).toBe(root);
    expect(again.findAll(".fcp__row--marked").map((row) => label(row.find(".fcp__name")))).toEqual([
      "alpha",
      "archive.tar",
    ]);
    again.unmount();
    store.setApi(
      makeApi({
        fileList: async () => ({ entries: [entry("alpha.ts", "file")], path: "" }),
      }).api,
    );
    const third = await remount();
    expect(third.findAll(".fcp__row--marked").map((row) => label(row.find(".fcp__name")))).toEqual(["alpha"]);
  });

  it("keeps each workspace's panels and cursors when switching workspace and back", async () => {
    const { w, store } = await setup();
    const first = store.rootPath;
    await press(w, "ArrowDown");
    await press(w, "Enter");
    await press(w, "End");
    await store.init("/other-root");
    await flushPromises();
    expect(names(w)).toEqual(["[docs]", "[src]", "alpha", "archive.tar", "zeta"]);
    await store.init(first);
    await flushPromises();
    expect(names(w)).toEqual(["[..]", "[inner]", "main"]);
    expect(cursorName(w)).toBe("main");
  });

  describe("quick search", () => {
    const searchBox = (w: VueWrapper) => w.find(".fcp__search");

    it("jumps to the first row starting with the typed prefix and shows it", async () => {
      const { w } = await setup();
      await press(w, "a");
      expect(cursorName(w)).toBe("alpha");
      expect(searchBox(w).text()).toBe("Search: a");
      await press(w, "r");
      expect(cursorName(w)).toBe("archive.tar");
      expect(searchBox(w).text()).toBe("Search: ar");
    });

    it("matches folders without their brackets and ignores case", async () => {
      const { w } = await setup();
      await press(w, "S");
      expect(cursorName(w)).toBe("[src]");
    });

    it("rejects a character that matches nothing and keeps the prefix", async () => {
      const { w } = await setup();
      await press(w, "a");
      await press(w, "q");
      expect(cursorName(w)).toBe("alpha");
      expect(searchBox(w).text()).toBe("Search: a");
    });

    it("Backspace edits the prefix instead of going to the parent, and ends an emptied search", async () => {
      const { w } = await setup();
      await press(w, "ArrowDown");
      await press(w, "Enter");
      await press(w, "m");
      expect(cursorName(w)).toBe("main");
      await press(w, "Backspace");
      expect(searchBox(w).exists()).toBe(false);
      expect(names(w)).toEqual(["[..]", "[inner]", "main"]);
      await press(w, "Backspace");
      expect(names(w)).toContain("[src]");
    });

    it("Escape, arrows and the timeout end the search; Space still marks", async () => {
      const { w } = await setup();
      await press(w, "a");
      await press(w, "Escape");
      expect(searchBox(w).exists()).toBe(false);
      await press(w, "z");
      await press(w, "ArrowUp");
      expect(searchBox(w).exists()).toBe(false);
      vi.useFakeTimers();
      await press(w, "a");
      expect(searchBox(w).exists()).toBe(true);
      await vi.advanceTimersByTimeAsync(1600);
      expect(searchBox(w).exists()).toBe(false);
      vi.useRealTimers();
      await press(w, " ");
      expect(w.findAll(".fcp__row--marked")).toHaveLength(1);
    });
  });

  describe("copy and move between panels", () => {
    async function setupTransfer(api: AnyObj = {}, confirmed = true) {
      const ctx = await setup({ api });
      const confirm = vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValue(confirmed);
      await press(ctx.w, "Tab");
      await press(ctx.w, "ArrowDown");
      await press(ctx.w, "Enter");
      await press(ctx.w, "Tab");
      return { ...ctx, confirm };
    }

    it("F5 copies the cursor entry into the other panel's folder after a confirm", async () => {
      const fileCopy = vi.fn(async () => ({}));
      const { w, store, confirm } = await setupTransfer({ fileCopy });
      await press(w, "ArrowDown");
      await press(w, "ArrowDown");
      await press(w, "F5");
      await flushPromises();
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: "Copy", danger: false }));
      expect(fileCopy).toHaveBeenCalledWith({ rootPath: store.rootPath, fromPath: "alpha.ts", toPath: "src/alpha.ts" });
    });

    it("F6 moves every marked entry and keeps the mark of the one that failed", async () => {
      const fileMove = vi.fn(async (p: AnyObj) => {
        if (p.fromPath === "alpha.ts") throw new Error("locked");
        return {};
      });
      const { w } = await setupTransfer({ fileMove });
      await press(w, "ArrowDown");
      await press(w, "ArrowDown");
      await press(w, "Insert");
      await press(w, "Insert");
      await press(w, "F6");
      await flushPromises();
      expect(fileMove.mock.calls.map((call) => (call[0] as AnyObj).toPath)).toEqual([
        "src/alpha.ts",
        "src/archive.tar.gz",
      ]);
      expect(w.findAll(".fcp__row--marked").map((r) => r.find(".fcp__base").text())).toEqual(["alpha"]);
    });

    it("does nothing when the confirm is declined", async () => {
      const fileCopy = vi.fn(async () => ({}));
      const { w } = await setupTransfer({ fileCopy }, false);
      await press(w, "ArrowDown");
      await press(w, "ArrowDown");
      await press(w, "F5");
      await flushPromises();
      expect(fileCopy).not.toHaveBeenCalled();
    });

    it("refuses the same folder and a folder's own subtree with a toast", async () => {
      const fileCopy = vi.fn(async () => ({}));
      const { w, store } = await setup({ api: { fileCopy } });
      const notify = vi.spyOn(store, "notifyOpError").mockResolvedValue();
      const confirm = vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValue(true);
      await press(w, "ArrowDown");
      await press(w, "F5");
      expect(notify).toHaveBeenCalledWith("Copy not possible", expect.stringContaining("already in that folder"));
      await press(w, "Tab");
      await press(w, "ArrowDown");
      await press(w, "Enter");
      await press(w, "Tab");
      await press(w, "F6");
      expect(notify).toHaveBeenLastCalledWith("Move not possible", expect.stringContaining("into itself"));
      expect(confirm).not.toHaveBeenCalled();
      expect(fileCopy).not.toHaveBeenCalled();
    });

    it("never copies the [..] row", async () => {
      const { w, confirm } = await setupTransfer();
      await press(w, "Tab");
      await press(w, "Home");
      await press(w, "F5");
      expect(confirm).not.toHaveBeenCalled();
    });

    it("Ctrl+R refreshes", async () => {
      const { w, calls } = await setup();
      const before = calls.fileList.length;
      await press(w, "r", { ctrlKey: true });
      expect(calls.fileList.length).toBeGreaterThan(before);
    });
  });

  describe("hosted terminal", () => {
    const HOST = "files:files1";
    const hostedPanel = (extra: AnyObj = {}) => ({
      id: "hosted",
      title: "Terminal 2",
      command: "",
      cwd: "/repo/src",
      hostedBy: HOST,
      ...extra,
    });

    function setPanels(panels: AnyObj[]) {
      useAppStore().payload = {
        workspace: { workspace: { id: "ws1", kind: "terminal", panels }, sessions: [] },
        appState: { workspaces: [] },
      } as never;
    }

    const filesPanel = { id: "files1", title: "Files", command: "__files__" };

    function stubOpen() {
      const app = useAppStore();
      return vi.spyOn(app, "openHostedTerminal").mockImplementation(async (_ws, _host, options = {}) => {
        const existing = (useAppStore().payload as AnyObj).workspace.workspace.panels.filter(
          (p: AnyObj) => p.hostedBy === HOST,
        );
        const id = existing.length ? `hosted${existing.length + 1}` : "hosted";
        setPanels([
          filesPanel,
          ...existing,
          hostedPanel({ id, command: options.command || "", title: options.title || "Terminal 2", cwd: options.cwd }),
        ]);
        return `ws1:${id}`;
      });
    }

    beforeEach(() => {
      setPanels([filesPanel]);
    });

    it("Ctrl+Shift+T hosts a terminal in the active panel's folder in the other panel, never as a tab", async () => {
      const { w, store } = await setup();
      const open = stubOpen();
      const quickAddTab = vi.spyOn(useAppStore(), "quickAddTab").mockResolvedValue();
      await press(w, "ArrowDown");
      await press(w, "Enter");
      await press(w, "t", { ctrlKey: true, shiftKey: true });
      await flushPromises();
      expect(open).toHaveBeenCalledWith("ws1", HOST, {
        cwd: `${store.rootPath}/src`,
        command: "",
        title: expect.stringContaining("Shell"),
      });
      expect(quickAddTab).not.toHaveBeenCalled();
      expect(w.find(".fct").exists()).toBe(true);
      expect(w.findAll(".fcp")).toHaveLength(1);
      expect(useAppStore().activeSessionId).toBe("ws1:hosted");
    });

    it("the >_ button with a terminal running adds a second one without asking and selects it", async () => {
      setPanels([filesPanel, hostedPanel({ id: "first", title: "First" })]);
      const { w } = await setup();
      const open = stubOpen();
      const confirm = vi.spyOn(useAppStore(), "confirmInApp");
      await w.find("[aria-label='Open a terminal in this folder']").trigger("click");
      await flushPromises();
      expect(open).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
      expect(w.findAll(".fct__tab")).toHaveLength(2);
      expect(w.findAll("[role='tab']").map((t) => t.attributes("aria-selected"))).toEqual(["false", "true"]);
      expect(useAppStore().activeSessionId).toBe("ws1:hosted2");
    });

    describe("several hosted terminals", () => {
      const two = () =>
        setPanels([
          filesPanel,
          hostedPanel({ id: "ta", title: "Alpha", cwd: "/repo/a" }),
          hostedPanel({ id: "tb", title: "Beta", cwd: "/repo/b" }),
        ]);
      const tabs = (w: Awaited<ReturnType<typeof setup>>["w"]) => w.findAll("[role='tab']");

      it("renders one tab per terminal, the last one selected, with the cwd as its title", async () => {
        two();
        const { w } = await setup();
        expect(tabs(w).map((t) => t.text())).toEqual(["Alpha", "Beta"]);
        expect(tabs(w).map((t) => t.attributes("aria-selected"))).toEqual(["false", "true"]);
        expect(w.findAll(".fct__tab")[0].attributes("title")).toBe("/repo/a");
        expect(w.find("[role='tablist']").exists()).toBe(true);
        expect(useAppStore().hostedTerminal).toEqual({ hostViewId: HOST, sessionId: "ws1:tb" });
      });

      it("selecting a tab switches the session and focuses it", async () => {
        two();
        const { w } = await setup();
        await tabs(w)[0].trigger("click");
        await flushPromises();
        expect(tabs(w).map((t) => t.attributes("aria-selected"))).toEqual(["true", "false"]);
        expect(useAppStore().activeSessionId).toBe("ws1:ta");
        expect(useAppStore().hostedTerminal).toEqual({ hostViewId: HOST, sessionId: "ws1:ta" });
      });

      it("closing the selected terminal selects its neighbour; closing the last hides the area", async () => {
        two();
        const { w } = await setup();
        const closeTab = vi.spyOn(useAppStore(), "closeTab").mockImplementation((viewId: string) => {
          const id = viewId.split(":")[1];
          const remaining = (useAppStore().payload as AnyObj).workspace.workspace.panels.filter(
            (p: AnyObj) => p.hostedBy === HOST && p.id !== id,
          );
          setPanels([filesPanel, ...remaining]);
        });
        await tabs(w)[1].trigger("click");
        await w.findAll(".fct__tab .fct__btn--close")[1].trigger("click");
        await flushPromises();
        expect(closeTab).toHaveBeenCalledWith("ws1:tb");
        expect(tabs(w).map((t) => t.text())).toEqual(["Alpha"]);
        expect(tabs(w)[0].attributes("aria-selected")).toBe("true");
        await w.find(".fct__tab .fct__btn--close").trigger("click");
        await flushPromises();
        expect(w.find(".fct").exists()).toBe(false);
        expect(w.findAll(".fcp")).toHaveLength(2);
      });

      it("a middle click closes a tab", async () => {
        two();
        const { w } = await setup();
        const closeTab = vi.spyOn(useAppStore(), "closeTab").mockImplementation(() => {});
        await w.findAll(".fct__tab")[0].trigger("auxclick", { button: 1 });
        expect(closeTab).toHaveBeenCalledWith("ws1:ta");
      });

      it("a reveal request selects the requested terminal", async () => {
        two();
        const { w } = await setup();
        useAppStore().hostedTerminalReveal = { panelId: "ta", nonce: 1 };
        await flushPromises();
        expect(tabs(w)[0].attributes("aria-selected")).toBe("true");
        expect(useAppStore().hostedTerminalReveal).toBeNull();
      });

      it("Move to a tab acts on the selected terminal", async () => {
        two();
        const { w } = await setup();
        const move = vi.spyOn(useAppStore(), "moveHostedTerminalToTab").mockResolvedValueOnce();
        await tabs(w)[0].trigger("click");
        await w.find(".fct__btn[aria-label='Move to a tab']").trigger("click");
        await flushPromises();
        expect(move).toHaveBeenCalledWith("ws1", "ta");
      });

      it("remembers the selection across a remount", async () => {
        two();
        const first = await setup();
        await tabs(first.w)[0].trigger("click");
        first.w.unmount();
        wrapper = null;
        const { w } = await setup();
        expect(tabs(w).map((t) => t.attributes("aria-selected"))).toEqual(["true", "false"]);
      });

      it("shows the strip in the phone-width Terminal slot", async () => {
        two();
        const { w } = await setup({ narrow: true });
        await w
          .findAll(".fc__switch button")
          .find((button) => button.text() === "Terminal")!
          .trigger("click");
        expect(tabs(w)).toHaveLength(2);
      });
    });

    it("shows a terminal that is already hosted when the commander appears", async () => {
      setPanels([filesPanel, hostedPanel({ title: "Claude", cwd: "/repo/src" })]);
      const { w } = await setup();
      expect(w.find("[role='tab']").text()).toContain("Claude");
      expect(w.find(".fct__tab").attributes("title")).toBe("/repo/src");
      expect(w.findAll(".fcp")).toHaveLength(1);
    });

    it("the agent button starts the last used agent template and remembers a pick from the menu", async () => {
      const { w } = await setup();
      const open = stubOpen();
      vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValue(true);
      await w.find("[aria-label='Open an agent in this folder']").trigger("click");
      await flushPromises();
      expect(open).toHaveBeenLastCalledWith(
        "ws1",
        HOST,
        expect.objectContaining({ command: "claude", title: expect.stringContaining("Claude Code") }),
      );
      await w.find("[aria-label='Choose an agent']").trigger("click");
      const codex = w.findAll(".fcl__item").find((item) => item.text().includes("Codex"));
      await codex!.trigger("click");
      await flushPromises();
      expect(open).toHaveBeenLastCalledWith("ws1", HOST, expect.objectContaining({ command: "codex" }));
      expect(localStorage.getItem("strideterm-commander-agent")).toBe("Codex");
      expect(w.find(".fcl__item").exists()).toBe(false);
    });

    it("lists only agent templates for the runtime platform", async () => {
      useAppStore().payload = {
        workspace: { workspace: { id: "ws1", kind: "terminal", panels: [filesPanel] }, sessions: [] },
        appState: {
          workspaces: [],
          tabTemplates: [
            { title: "PowerShell", command: "powershell", platforms: ["win32"] },
            { title: "Claude Code", command: "claude" },
            { title: "Win agent", command: "codex", platforms: ["win32"] },
            { title: "Mac agent", command: "gemini", platforms: ["darwin"] },
          ],
        },
        meta: { platform: "win32" },
      } as never;
      const { w } = await setup();
      await w.find("[aria-label='Choose an agent']").trigger("click");
      expect(w.findAll(".fcl__item").map((item) => item.text())).toEqual(["Claude Code", "Win agent"]);
    });

    function withShellTemplates(platform: string) {
      useAppStore().payload = {
        workspace: { workspace: { id: "ws1", kind: "terminal", panels: [filesPanel] }, sessions: [] },
        appState: {
          workspaces: [],
          tabTemplates: [
            { title: "Shell", command: "", icon: "S" },
            { title: "PowerShell", command: "powershell", icon: "P", platforms: ["win32"] },
            { title: "Git Bash", command: "bash", icon: "G", platforms: ["win32"] },
            { title: "Zsh", command: "zsh", icon: "Z", platforms: ["darwin", "linux"] },
            { title: "Claude Code", command: "claude" },
            { title: "Browser", command: "https://" },
            { title: "Files", command: "__files__" },
          ],
        },
        meta: { platform },
      } as never;
    }

    it("lists the shells of the runtime platform, without agents or virtual tabs", async () => {
      withShellTemplates("win32");
      const { w } = await setup();
      await w.find("[aria-label='Choose a shell']").trigger("click");
      expect(w.findAll(".fcl__item").map((item) => item.text())).toEqual(["SShell", "PPowerShell", "GGit Bash"]);
      w.unmount();
      withShellTemplates("darwin");
      const mac = await setup();
      await mac.w.find("[aria-label='Choose a shell']").trigger("click");
      expect(mac.w.findAll(".fcl__item").map((item) => item.text())).toEqual(["SShell", "ZZsh"]);
    });

    it("opens the picked shell, remembers it and uses it for the >_ button and Ctrl+Shift+T", async () => {
      withShellTemplates("win32");
      const { w } = await setup();
      const open = stubOpen();
      await w.find("[aria-label='Choose a shell']").trigger("click");
      await w
        .findAll(".fcl__item")
        .find((item) => item.text().includes("PowerShell"))!
        .trigger("click");
      await flushPromises();
      expect(open).toHaveBeenLastCalledWith("ws1", HOST, expect.objectContaining({ command: "powershell" }));
      expect(localStorage.getItem("strideterm-commander-shell")).toBe("PowerShell");
      expect(w.find("[aria-label='Open a terminal in this folder']").attributes("title")).toContain("PowerShell");
    });

    it("the agent button adds an agent terminal beside a running one without asking", async () => {
      setPanels([filesPanel, hostedPanel()]);
      const { w } = await setup();
      const open = stubOpen();
      const confirm = vi.spyOn(useAppStore(), "confirmInApp");
      await w.find("[aria-label='Open an agent in this folder']").trigger("click");
      await flushPromises();
      expect(confirm).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith("ws1", HOST, expect.objectContaining({ command: "claude" }));
      expect(w.findAll(".fct__tab")).toHaveLength(2);
    });

    it("the close button uses the ordinary close-tab action", async () => {
      setPanels([filesPanel, hostedPanel()]);
      const { w } = await setup();
      const closeTab = vi.spyOn(useAppStore(), "closeTab").mockImplementation(() => {});
      await w.find(".fct__tab .fct__btn--close").trigger("click");
      expect(closeTab).toHaveBeenCalledWith("ws1:hosted");
    });

    it("Move to a tab hands the panel over, and reports a refusal", async () => {
      setPanels([filesPanel, hostedPanel()]);
      const { w, store } = await setup();
      const move = vi.spyOn(useAppStore(), "moveHostedTerminalToTab").mockResolvedValueOnce();
      await w.find(".fct__btn[aria-label='Move to a tab']").trigger("click");
      await flushPromises();
      expect(move).toHaveBeenCalledWith("ws1", "hosted");
      move.mockRejectedValueOnce(new Error("refused"));
      const notify = vi.spyOn(store, "notifyOpError").mockResolvedValue();
      await w.find(".fct__btn[aria-label='Move to a tab']").trigger("click");
      await flushPromises();
      expect(notify).toHaveBeenCalledWith("Could not move the terminal to a tab", "refused");
    });

    it("keys pressed inside the terminal never reach the commander", async () => {
      setPanels([filesPanel, hostedPanel()]);
      const { w } = await setup();
      const before = cursorName(w, 0);
      const field = document.createElement("div");
      field.className = "xterm-stub";
      w.find(".fct__body").element.appendChild(field);
      for (const key of ["ArrowDown", "Tab", "Escape", "F3", "a"]) {
        field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      }
      await flushPromises();
      expect(cursorName(w, 0)).toBe(before);
      expect(w.find(".fct").exists()).toBe(true);
      expect(w.find(".fcq").exists()).toBe(false);
    });

    it("Ctrl+O hides and shows the terminal without closing it", async () => {
      setPanels([filesPanel, hostedPanel()]);
      const { w } = await setup();
      const closeTab = vi.spyOn(useAppStore(), "closeTab").mockImplementation(() => {});
      await press(w, "o", { ctrlKey: true });
      expect(w.find(".fct").exists()).toBe(false);
      expect(w.findAll(".fcp")).toHaveLength(2);
      await press(w, "o", { ctrlKey: true });
      expect(w.find(".fct").exists()).toBe(true);
      expect(closeTab).not.toHaveBeenCalled();
    });

    it("Ctrl+O does nothing without a hosted terminal", async () => {
      const { w } = await setup();
      await press(w, "o", { ctrlKey: true });
      expect(w.find(".fct").exists()).toBe(false);
    });

    it("Quick View takes the slot back from the terminal, and the terminal can return", async () => {
      setPanels([filesPanel, hostedPanel()]);
      const { w } = await setup();
      await press(w, "F3");
      expect(w.find(".fct").exists()).toBe(false);
      expect(w.find(".fcq").exists()).toBe(true);
      await press(w, "Escape");
      await press(w, "o", { ctrlKey: true });
      expect(w.find(".fct").exists()).toBe(true);
      expect(w.find(".fcq").exists()).toBe(false);
    });

    it("a reveal request for the hosted terminal shows it again", async () => {
      setPanels([filesPanel, hostedPanel()]);
      const { w } = await setup();
      await press(w, "o", { ctrlKey: true });
      useAppStore().hostedTerminalReveal = { panelId: "hosted", nonce: 1 };
      await flushPromises();
      expect(w.find(".fct").exists()).toBe(true);
      expect(useAppStore().hostedTerminalReveal).toBeNull();
    });

    it("tells the mobile composer which session the visible terminal owns, and lets go on unmount", async () => {
      setPanels([filesPanel, hostedPanel()]);
      const { w } = await setup();
      expect(useAppStore().hostedTerminal).toEqual({ hostViewId: HOST, sessionId: "ws1:hosted" });
      useAppStore().activeSessionId = "ws1:hosted";
      w.unmount();
      wrapper = null;
      expect(useAppStore().hostedTerminal).toBeNull();
      expect(useAppStore().activeSessionId).toBeNull();
    });

    it("offers the terminal as a slot of the narrow panel switcher", async () => {
      setPanels([filesPanel, hostedPanel()]);
      const { w } = await setup({ narrow: true });
      expect(w.find(".fct").exists()).toBe(false);
      const slot = w.findAll(".fc__switch button").find((button) => button.text() === "Terminal");
      expect(slot).toBeTruthy();
      await slot!.trigger("click");
      expect(w.find(".fct").exists()).toBe(true);
    });

    describe("a Files pane of a workspace that is not the active one", () => {
      const sharedFiles = { id: "files1", title: "Files", command: "__files__" };
      const workspaceWith = (id: string, panels: AnyObj[]) => ({
        id,
        kind: "terminal",
        profileId: "default",
        panels,
        activePanelId: "files1",
      });

      function setTwoWorkspaces() {
        const wsA = workspaceWith("wsA", [
          sharedFiles,
          { id: "a-term", title: "A shell", command: "", hostedBy: HOST },
        ]);
        const wsB = workspaceWith("wsB", [sharedFiles]);
        useAppStore().payload = {
          workspace: { workspace: wsA, sessions: [] },
          appState: { activeWorkspaceId: "wsA", workspaces: [wsA, wsB] },
        } as never;
      }

      const asWorkspace = (id: string) => ({ [filesOwnerWorkspaceIdKey as symbol]: computed(() => id) });

      it("does not show the terminal of another workspace that shares the Files panel id", async () => {
        setTwoWorkspaces();
        const { w } = await setup({ provide: asWorkspace("wsB") });
        expect(w.find(".fct").exists()).toBe(false);
        expect(useAppStore().hostedTerminal).toBeNull();
      });

      it("shows its own workspace's terminal and keeps it away from the mobile composer", async () => {
        setTwoWorkspaces();
        const { w } = await setup({ provide: asWorkspace("wsA") });
        expect(w.find(".fct").exists()).toBe(true);
        expect(w.find(".terminal-stub").attributes("data-session")).toBe("wsA:a-term");
        expect(useAppStore().hostedTerminal).toEqual({ hostViewId: HOST, sessionId: "wsA:a-term" });
      });

      it("opens the terminal in the owning workspace", async () => {
        setTwoWorkspaces();
        const { w } = await setup({ provide: asWorkspace("wsB") });
        const open = vi.spyOn(useAppStore(), "openHostedTerminal").mockResolvedValue("wsB:new");
        await w.find("[aria-label='Open a terminal in this folder']").trigger("click");
        await flushPromises();
        expect(open).toHaveBeenCalledWith("wsB", HOST, expect.objectContaining({ command: "" }));
      });

      it("moves and closes a hosted terminal through its own workspace", async () => {
        const wsB = workspaceWith("wsB", [
          sharedFiles,
          { id: "b-term", title: "B shell", command: "", hostedBy: HOST },
        ]);
        const wsA = workspaceWith("wsA", [sharedFiles]);
        useAppStore().payload = {
          workspace: { workspace: wsA, sessions: [] },
          appState: { activeWorkspaceId: "wsA", workspaces: [wsA, wsB] },
        } as never;
        const { w } = await setup({ provide: asWorkspace("wsB") });
        const move = vi.spyOn(useAppStore(), "moveHostedTerminalToTab").mockResolvedValueOnce();
        const closeTab = vi.spyOn(useAppStore(), "closeTab").mockImplementation(() => undefined);
        await w.find(".fct__btn[aria-label='Move to a tab']").trigger("click");
        await flushPromises();
        expect(move).toHaveBeenCalledWith("wsB", "b-term");
        await w.find(".fct__tab .fct__btn--close").trigger("click");
        expect(closeTab).toHaveBeenCalledWith("wsB:b-term");
      });
    });

    it("reports a failing terminal launch", async () => {
      const { w, store } = await setup();
      vi.spyOn(useAppStore(), "openHostedTerminal").mockRejectedValue(new Error("nope"));
      const notify = vi.spyOn(store, "notifyOpError").mockResolvedValue();
      await w.find("[aria-label='Open a terminal in this folder']").trigger("click");
      await flushPromises();
      expect(notify).toHaveBeenCalledWith("Could not open a terminal", "nope");
    });
  });

  describe("compare", () => {
    const readApi = { fileRead: async (p: AnyObj) => ({ content: `body of ${p.relativePath}` }) };

    it("diffs the two marked files in the inactive panel slot and Escape closes it", async () => {
      const { w, store } = await setup({ api: readApi });
      await press(w, "ArrowDown");
      await press(w, "ArrowDown");
      await press(w, "Insert");
      await press(w, "Insert");
      await press(w, "d", { ctrlKey: true, shiftKey: true });
      await flushPromises();
      expect(w.find(".fcq__title-text").text()).toBe("Compare: alpha.ts ↔ archive.tar.gz");
      expect(w.find(".diff-stub").text()).toBe("body of alpha.ts|body of archive.tar.gz");
      expect(w.findAll(".fcp")).toHaveLength(1);
      expect(store.editorTabs).toHaveLength(0);
      await press(w, "Escape");
      expect(w.find(".fcq").exists()).toBe(false);
      expect(w.findAll(".fcp")).toHaveLength(2);
    });

    it("compares the cursor file with its namesake in the other panel", async () => {
      TREE.docs.push(entry("docs/alpha.ts", "file"));
      try {
        const { w } = await setup({ api: readApi });
        await press(w, "Tab");
        await press(w, "Enter");
        await press(w, "Tab");
        await press(w, "ArrowDown");
        await press(w, "ArrowDown");
        await press(w, "d", { ctrlKey: true, shiftKey: true });
        await flushPromises();
        expect(w.find(".fcq__title-text").text()).toBe("Compare: alpha.ts ↔ docs/alpha.ts");
        expect(w.find(".diff-stub").text()).toBe("body of alpha.ts|body of docs/alpha.ts");
      } finally {
        TREE.docs.pop();
      }
    });

    it("toasts when there is nothing to compare", async () => {
      const { w, store } = await setup();
      const notify = vi.spyOn(store, "notifyOpError").mockResolvedValue();
      await press(w, "d", { ctrlKey: true, shiftKey: true });
      expect(notify).toHaveBeenCalledWith("Cannot compare", expect.stringContaining("file"));
      await press(w, "Tab");
      await press(w, "Enter");
      await press(w, "Tab");
      await press(w, "End");
      await press(w, "d", { ctrlKey: true, shiftKey: true });
      expect(notify).toHaveBeenLastCalledWith("Cannot compare", expect.stringContaining('no file named "zeta.txt"'));
      expect(w.find(".fcq").exists()).toBe(false);
    });
  });

  describe("history and persistence", () => {
    it("Alt+Left / Alt+Right walk the panel's own history and the cursor lands on the folder we left", async () => {
      const { w } = await setup();
      await press(w, "ArrowDown");
      await press(w, "Enter");
      await press(w, "ArrowDown");
      await press(w, "Enter");
      expect(names(w)).toEqual(["[..]", "deep"]);
      await press(w, "ArrowLeft", { altKey: true });
      expect(names(w)).toEqual(["[..]", "[inner]", "main"]);
      expect(cursorName(w)).toBe("[inner]");
      await press(w, "ArrowLeft", { altKey: true });
      expect(cursorName(w)).toBe("[src]");
      await press(w, "ArrowLeft", { altKey: true });
      expect(cursorName(w)).toBe("[src]");
      await press(w, "ArrowRight", { altKey: true });
      expect(names(w)).toEqual(["[..]", "[inner]", "main"]);
    });

    it("navigating somewhere new drops the forward history", async () => {
      const { w } = await setup();
      await press(w, "ArrowDown");
      await press(w, "Enter");
      await press(w, "ArrowLeft", { altKey: true });
      await press(w, "Home");
      await press(w, "Enter");
      expect(names(w)).toEqual(["[..]", "readme"]);
      await press(w, "ArrowRight", { altKey: true });
      expect(names(w)).toEqual(["[..]", "readme"]);
    });

    it("persists the panels per root in localStorage", async () => {
      const { w, store } = await setup();
      await press(w, "ArrowDown");
      await press(w, "Enter");
      const saved = JSON.parse(localStorage.getItem("files.commanderPanels") || "[]");
      expect(saved.find((item: [string, AnyObj]) => item[0] === store.rootPath)?.[1]).toMatchObject({
        paths: ["src", ""],
        active: 0,
      });
    });

    it("falls back to the root when a restored folder no longer exists", async () => {
      rememberCommanderRoot(`/repo-${seq + 1}`, { paths: ["gone", ""], cursors: [null, null], active: 0 });
      const { w } = await setup({
        api: {
          fileList: async (p: AnyObj) => {
            if (p.relativePath === "gone") throw new Error("ENOENT");
            return { entries: TREE[p.relativePath || ""] || [], path: p.relativePath || "" };
          },
        },
      });
      expect(names(w)).toEqual(["[docs]", "[src]", "alpha", "archive.tar", "zeta"]);
      expect(w.find(".fcp__status--error").exists()).toBe(false);
    });
  });
});
