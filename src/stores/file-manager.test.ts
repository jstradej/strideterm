import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useFileManagerStore } from "./file-manager.js";
import { useNotificationStore } from "./notifications.js";
import { useAppStore } from "./app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

function makeFakeApi(overrides = {}) {
  const calls: {
    fileList: AnyObj[];
    fileTree: AnyObj[];
    fileGitStatus: AnyObj[];
    fileGitDiff: AnyObj[];
    fileGitRefs: AnyObj[];
  } = {
    fileList: [],
    fileTree: [],
    fileGitStatus: [],
    fileGitDiff: [],
    fileGitRefs: [],
  };
  const api = {
    fileList: async (p: AnyObj) => {
      calls.fileList.push(p);
      return { entries: [], path: p.relativePath };
    },
    fileTree: async (p: AnyObj) => {
      calls.fileTree.push(p);
      return { entries: [] };
    },
    fileGitStatus: async (p: AnyObj) => {
      calls.fileGitStatus.push(p);
      return {
        isRepo: true,
        root: p.rootPath,
        entries: { "src/foo.js": { status: "modified" }, "untracked.txt": { status: "untracked" } },
        directories: { src: "modified" },
      };
    },
    fileGitDiff: async (p: AnyObj) => {
      calls.fileGitDiff.push(p);
      return {
        ok: true,
        leftContent: "old",
        rightContent: "new",
        leftLabel: "HEAD",
        rightLabel: "working tree",
        leftMissing: false,
        rightMissing: false,
        language: "javascript",
        revision: "HEAD",
        source: p.source || "head",
      };
    },
    fileGitRefs: async (p: AnyObj) => {
      calls.fileGitRefs.push(p);
      return { isRepo: true, branches: ["main", "feature"], tags: [], commits: [], currentBranch: "main" };
    },
    fileCreateFile: async () => ({ entry: {} }),
    fileCreateDir: async () => ({ entry: {} }),
    fileWrite: async () => ({ ok: true, size: 0 }),
    fileRead: async () => ({ content: "hi", size: 2, encoding: "utf-8" }),
    filePreview: async () => ({ kind: "text", content: "preview", mimeType: "text/plain" }),
    fileMove: async () => ({ entry: {} }),
    ...overrides,
  };
  return { api, calls };
}

describe("file-manager store", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("init populates rootPath, navigates root, and pulls git status", async () => {
    const { api, calls } = makeFakeApi();
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/repo/root");
    expect(store.rootPath).toBe("/repo/root");
    expect(calls.fileList[0].rootPath).toBe("/repo/root");
    expect(store.gitIsRepo).toBe(true);
    expect(store.dirtyCount).toBe(2);
    expect(store.getStatusFor("src/foo.js")?.status).toBe("modified");
    expect(store.getDirectoryStatusFor("src")).toBe("modified");
  });

  it("sortedEntries respects filterText and showHidden flags", async () => {
    const items = [
      { name: ".hidden", relativePath: ".hidden", kind: "file" as const, isHidden: true, extension: "" },
      { name: "alpha.js", relativePath: "alpha.js", kind: "file" as const, isHidden: false, extension: ".js" },
      { name: "beta.js", relativePath: "beta.js", kind: "file" as const, isHidden: false, extension: ".js" },
      {
        name: "node_modules",
        relativePath: "node_modules",
        kind: "directory" as const,
        isHidden: false,
        extension: "",
      },
    ];
    const { api } = makeFakeApi({
      fileList: async () => ({ entries: items, path: "" }),
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    // hidden hidden
    expect(store.sortedEntries.map((e) => e.name)).toEqual(["node_modules", "alpha.js", "beta.js"]);

    store.showHidden = true;
    expect(store.sortedEntries.map((e) => e.name)).toEqual(["node_modules", ".hidden", "alpha.js", "beta.js"]);

    store.setFilter("alpha");
    expect(store.sortedEntries.map((e) => e.name)).toEqual(["alpha.js"]);

    store.setFilter("");
    expect(store.sortedEntries.map((e) => e.name).length).toBe(4);
  });

  it("openDiff loads refs + diff payload, closeDiff resets state", async () => {
    const { api, calls } = makeFakeApi();
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    const entry = { name: "x.js", relativePath: "x.js", kind: "file" as const, extension: ".js" };
    await store.openDiff(entry);
    expect(store.diffOpen).toBe(true);
    expect(store.diffEntry).toEqual(entry);
    expect(store.diffSource).toBe("head");
    expect(store.diffPayload?.ok).toBe(true);
    const payload = store.diffPayload!;
    expect(payload.leftContent).toBe("old");
    expect(calls.fileGitRefs[0].relativePath).toBe("x.js");
    expect(calls.fileGitDiff[0].source).toBe("head");

    await store.setDiffSource("branch", "feature");
    expect(store.diffSource).toBe("branch");
    expect(store.diffRevisionRef).toBe("feature");
    expect(calls.fileGitDiff.length).toBe(2);
    expect(calls.fileGitDiff[1].source).toBe("branch");
    expect(calls.fileGitDiff[1].revisionRef).toBe("feature");

    store.closeDiff();
    expect(store.diffOpen).toBe(false);
    expect(store.diffEntry).toBe(null);
    expect(store.diffPayload).toBe(null);
  });

  it("selectDiffMode switches mode and clears ref+payload without fetching", async () => {
    const { api, calls } = makeFakeApi();
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    const entry = { name: "x.js", relativePath: "x.js", kind: "file" as const, extension: ".js" };
    await store.openDiff(entry);
    const callsBefore = calls.fileGitDiff.length;
    expect(store.diffPayload).not.toBe(null);

    store.selectDiffMode("branch");
    expect(store.diffSource).toBe("branch");
    expect(store.diffRevisionRef).toBe("");
    expect(store.diffPayload).toBe(null);
    expect(calls.fileGitDiff.length).toBe(callsBefore); // no extra fetch

    store.selectDiffMode("tag");
    expect(store.diffSource).toBe("tag");
    expect(calls.fileGitDiff.length).toBe(callsBefore);
  });

  it("moveEntryTo refuses moves into self / own subtree", async () => {
    let moveCalled = false;
    const { api } = makeFakeApi({
      fileMove: async () => {
        moveCalled = true;
        return { entry: {} };
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    const dir = { name: "src", relativePath: "src", kind: "directory" as const };
    await store.moveEntryTo(dir, "src");
    expect(moveCalled).toBe(false);
    await store.moveEntryTo(dir, "src/nested");
    expect(moveCalled).toBe(false);
  });

  it("expandTreeNode preserves child entry identity across re-expansion of parent", async () => {
    const treeResponses: Record<
      string,
      Array<{ name: string; relativePath: string; kind: "file" | "directory"; isHidden: boolean }>
    > = {
      "": [
        { name: "src", relativePath: "src", kind: "directory", isHidden: false },
        { name: "lib", relativePath: "lib", kind: "directory", isHidden: false },
      ],
      src: [{ name: "components", relativePath: "src/components", kind: "directory", isHidden: false }],
    };
    const { api } = makeFakeApi({
      fileList: async (p: AnyObj) => ({ entries: treeResponses[p.relativePath as string] || [], path: p.relativePath }),
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    await store.expandTreeNode("src");
    // Re-expand root; the previously expanded "src" node must still have the correct relativePath.
    await store.expandTreeNode("");

    const root = store.treeNodes.get("");
    expect(root).toBeDefined();
    const srcChild = root!.children!.find((c) => c.entry.name === "src");
    expect(srcChild).toBeDefined();
    expect(srcChild!.entry.relativePath).toBe("src");
    // No child should accidentally take on the root's empty relativePath.
    for (const child of root!.children!) {
      expect(child.entry.relativePath).not.toBe("");
    }
  });

  // Category D (code-review batch, 2026-07): expandTreeNode's catch used to
  // silently swallow a failed tree listing call. It now also logs via rlog — this
  // just confirms the failure stays non-throwing and doesn't corrupt
  // previously-loaded tree state (a log call to a no-op window.strideterm
  // stub isn't independently asserted; see report for rationale).
  it("expandTreeNode leaves prior tree state intact when the listing call rejects", async () => {
    const { api } = makeFakeApi({
      fileList: async (p: AnyObj) =>
        p.relativePath === "src" ? Promise.reject(new Error("EACCES")) : { entries: [], path: p.relativePath },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    const rootBefore = store.treeNodes.get("");
    await expect(store.expandTreeNode("src")).resolves.toBeUndefined();

    // The rejected expansion must not have touched the root node or thrown.
    expect(store.treeNodes.get("")).toBe(rootBefore);
    expect(store.treeNodes.get("src")).toBeUndefined();
  });

  it("clipboard cut + paste flow clears the clipboard, copy keeps it", async () => {
    const { api } = makeFakeApi();
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    const entry = { name: "f.txt", relativePath: "f.txt", kind: "file" as const };
    store.cutToClipboard(entry);
    expect(store.clipboard?.op).toBe("cut");
    await store.pasteEntry("dest");
    expect(store.clipboard).toBe(null);

    store.copyToClipboard(entry);
    expect(store.clipboard?.op).toBe("copy");
    await store.pasteEntry("dest");
    expect(store.clipboard?.op).toBe("copy"); // copy stays
  });

  it("keeps each editor tab draft and dirty state when switching between files", async () => {
    const files = [
      { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" },
      { name: "b.ts", relativePath: "b.ts", kind: "file" as const, extension: ".ts" },
    ];
    const { api } = makeFakeApi({
      filePreview: async (p: AnyObj) => ({ kind: "text", content: `preview:${p.relativePath}` }),
      fileRead: async (p: AnyObj) => ({ content: `source:${p.relativePath}` }),
    });
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");

    await store.selectEntry(files[0]!);
    expect(store.editMode).toBe(true);
    store.editContent = "draft A";
    store.editDirty = true;
    await store.selectEntry(files[1]!);
    store.editContent = "draft B";
    store.editDirty = true;
    store.activateTab("a.ts");

    expect(store.editContent).toBe("draft A");
    expect(store.editDirty).toBe(true);
    expect(store.editorTabs.map((tab) => tab.entry.name)).toEqual(["a.ts", "b.ts"]);
    expect(store.editorTabs.find((tab) => tab.entry.relativePath === "b.ts")?.editContent).toBe("draft B");
  });

  it("closes only unmodified tabs and activates the nearest remaining dirty tab", async () => {
    const files = ["a.ts", "b.ts", "c.ts"].map((name) => ({
      name,
      relativePath: name,
      kind: "file" as const,
      extension: ".ts",
    }));
    const { api } = makeFakeApi();
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");
    for (const file of files) await store.selectEntry(file);
    const dirty = store.editorTabs.find((tab) => tab.entry.relativePath === "b.ts")!;
    dirty.editContent = "keep this draft";
    dirty.editDirty = true;

    expect(store.closeUnmodifiedTabs()).toBe(2);
    expect(store.editorTabs.map((tab) => tab.entry.relativePath)).toEqual(["b.ts"]);
    expect(store.activeTabPath).toBe("b.ts");
    expect(store.editContent).toBe("keep this draft");
    expect(store.editDirty).toBe(true);
  });

  it("closes all tabs atomically after one aggregate confirmation and leaves other roots untouched", async () => {
    const fileA = { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" };
    const fileB = { name: "b.ts", relativePath: "b.ts", kind: "file" as const, extension: ".ts" };
    const { api } = makeFakeApi();
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo-a");
    await store.selectEntry(fileA);
    store.editContent = "unsaved A";
    store.editDirty = true;
    const tabA = store.editorTabs[0]!;
    await store.init("/repo-b");
    await store.selectEntry(fileB);
    store.editContent = "unsaved B";
    store.editDirty = true;
    await store.openDiff(fileB, "branch", "feature");
    const tabB = store.editorTabs[0]!;
    const confirm = vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await store.closeAllTabs()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0].message).toContain("1 open tab");
    expect(confirm.mock.calls[0]?.[0].message).toContain("1 file");
    expect(confirm.mock.calls[0]?.[0].message).toContain("b.ts");
    expect(confirm.mock.calls[0]?.[0].confirmLabel).toBe("Discard and close");
    expect(store.editorTabs).toHaveLength(1);
    expect(store.activeTabPath).toBe("b.ts");
    expect(store.diffOpen).toBe(true);

    expect(await store.closeAllTabs()).toBe(true);
    expect(store.editorTabs).toHaveLength(0);
    expect(store.activeTabPath).toBe(null);
    expect(store.selectedEntry).toBe(null);
    expect(tabB.diffOpen).toBe(false);

    await store.init("/repo-a");
    expect(store.editorTabs).toEqual([tabA]);
    expect(store.editContent).toBe("unsaved A");
    expect(store.editDirty).toBe(true);
  });

  it("closes clean tabs without confirmation and ignores late diff refs for closed tabs", async () => {
    const file = { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" };
    let resolveRefs!: (value: AnyObj) => void;
    let refsStarted!: () => void;
    const started = new Promise<void>((resolve) => (refsStarted = resolve));
    const { api, calls } = makeFakeApi({
      fileGitRefs: () => {
        refsStarted();
        return new Promise((resolve) => (resolveRefs = resolve));
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/repo");
    const openingDiff = store.openDiff(file);
    await started;
    const confirm = vi.spyOn(useAppStore(), "confirmInApp");

    expect(await store.closeAllTabs()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    resolveRefs({ branches: ["late"], tags: [], commits: [], currentBranch: "main" });
    await openingDiff;
    expect(store.editorTabs).toHaveLength(0);
    expect(calls.fileGitDiff).toHaveLength(0);
  });

  it("does not close a different workspace's tabs when confirmation resolves after switching roots", async () => {
    const fileA = { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" };
    const fileB = { name: "b.ts", relativePath: "b.ts", kind: "file" as const, extension: ".ts" };
    const { api } = makeFakeApi();
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo-a");
    await store.selectEntry(fileA);
    store.editContent = "draft A";
    store.editDirty = true;
    let resolveConfirm!: (accepted: boolean) => void;
    let confirmStarted!: () => void;
    const started = new Promise<void>((resolve) => (confirmStarted = resolve));
    vi.spyOn(useAppStore(), "confirmInApp").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConfirm = resolve;
          confirmStarted();
        }),
    );

    const closing = store.closeAllTabs();
    await started;
    await store.init("/repo-b");
    await store.selectEntry(fileB);
    resolveConfirm(true);

    expect(await closing).toBe(false);
    expect(store.rootPath).toBe("/repo-b");
    expect(store.editorTabs.map((tab) => tab.entry.relativePath)).toEqual(["b.ts"]);
    await store.init("/repo-a");
    expect(store.editorTabs[0]?.editContent).toBe("draft A");
    expect(store.editorTabs[0]?.editDirty).toBe(true);
  });

  it("does not discard a dirty draft after another tab becomes active during confirmation", async () => {
    const files = [
      { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" },
      { name: "b.ts", relativePath: "b.ts", kind: "file" as const, extension: ".ts" },
    ];
    const { api } = makeFakeApi();
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");
    await store.selectEntry(files[0]!);
    store.editContent = "draft A";
    store.editDirty = true;
    let resolveConfirm!: (accepted: boolean) => void;
    let confirmStarted!: () => void;
    const started = new Promise<void>((resolve) => (confirmStarted = resolve));
    vi.spyOn(useAppStore(), "confirmInApp").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConfirm = resolve;
          confirmStarted();
        }),
    );

    const discarding = store.discardEdit();
    await started;
    await store.selectEntry(files[1]!);
    resolveConfirm(true);
    await discarding;

    store.activateTab("a.ts");
    expect(store.editContent).toBe("draft A");
    expect(store.editDirty).toBe(true);
  });

  it("keeps a dirty tab and its draft when closing is cancelled", async () => {
    const file = { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" };
    const { api } = makeFakeApi();
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");
    await store.selectEntry(file);
    store.editContent = "draft";
    store.editDirty = true;
    const confirm = vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValue(false);

    expect(await store.closeTab(file.relativePath)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: "Discard and close", cancelLabel: "Cancel" }),
    );
    expect(store.editorTabs).toHaveLength(1);
    expect(store.editContent).toBe("draft");
    expect(store.editDirty).toBe(true);
  });

  it("asks before discarding a dirty draft and restores the full saved file in the editor", async () => {
    const file = { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" };
    const { api } = makeFakeApi({
      filePreview: async () => ({ kind: "text", content: "truncated preview" }),
      fileRead: async () => ({ content: "full saved file content" }),
    });
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");
    await store.selectEntry(file);
    store.editContent = "draft";
    store.editDirty = true;
    const confirm = vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await store.discardEdit();
    expect(store.editMode).toBe(true);
    expect(store.editContent).toBe("draft");
    expect(confirm).toHaveBeenCalledOnce();
    await store.discardEdit();
    expect(store.editMode).toBe(true);
    expect(store.editDirty).toBe(false);
    expect(store.editContent).toBe("full saved file content");
  });

  it("updates the discard baseline to submitted content even if newer edits arrive during save", async () => {
    const file = { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" };
    let finishWrite!: () => void;
    const { api } = makeFakeApi({
      fileWrite: () => new Promise((resolve) => (finishWrite = () => resolve({ ok: true, size: 12 }))),
      fileRead: async () => ({ content: "initial saved" }),
    });
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");
    await store.selectEntry(file);
    store.editContent = "submitted content";
    store.editDirty = true;
    const saving = store.saveEdit();
    await Promise.resolve();
    store.editContent = "newer draft";
    store.editDirty = true;
    finishWrite();
    await saving;

    vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValue(true);
    await store.discardEdit();
    expect(store.editMode).toBe(true);
    expect(store.editContent).toBe("submitted content");
    expect(store.editDirty).toBe(false);
  });

  it("marks restored content dirty when a pending save finishes after discard", async () => {
    const file = { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" };
    let finishWrite!: () => void;
    const { api } = makeFakeApi({
      fileWrite: () => new Promise((resolve) => (finishWrite = () => resolve({ ok: true, size: 12 }))),
      fileRead: async () => ({ content: "original saved content" }),
    });
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");
    await store.selectEntry(file);
    store.editContent = "submitted draft";
    store.editDirty = true;
    const saving = store.saveEdit();
    await Promise.resolve();

    vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValue(true);
    await store.discardEdit();
    expect(store.editContent).toBe("original saved content");
    expect(store.editDirty).toBe(false);
    finishWrite();
    await saving;

    expect(store.editContent).toBe("original saved content");
    expect(store.editDirty).toBe(true);
    expect(store.editMode).toBe(true);
  });

  it("saving one tab leaves another tab dirty", async () => {
    const files = [
      { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" },
      { name: "b.ts", relativePath: "b.ts", kind: "file" as const, extension: ".ts" },
    ];
    const { api } = makeFakeApi();
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");
    await store.selectEntry(files[0]!);
    store.editContent = "A draft";
    store.editDirty = true;
    await store.selectEntry(files[1]!);
    store.editContent = "B draft";
    store.editDirty = true;
    store.activateTab("a.ts");
    await store.saveEdit();

    expect(store.editorTabs.find((tab) => tab.entry.relativePath === "a.ts")?.editDirty).toBe(false);
    expect(store.editMode).toBe(true);
    expect(store.editorTabs.find((tab) => tab.entry.relativePath === "b.ts")?.editDirty).toBe(true);
    store.activateTab("b.ts");
    expect(store.editContent).toBe("B draft");
  });

  it("ignores late preview and read results after another tab becomes active", async () => {
    const files = [
      { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" },
      { name: "b.ts", relativePath: "b.ts", kind: "file" as const, extension: ".ts" },
    ];
    let resolvePreviewA!: (value: AnyObj) => void;
    let resolveReadA!: (value: AnyObj) => void;
    const { api } = makeFakeApi({
      filePreview: (p: AnyObj) =>
        p.relativePath === "a.ts"
          ? new Promise((resolve) => (resolvePreviewA = resolve))
          : Promise.resolve({ kind: "text", content: "preview B" }),
      fileRead: (p: AnyObj) =>
        p.relativePath === "a.ts"
          ? new Promise((resolve) => (resolveReadA = resolve))
          : Promise.resolve({ content: "source B" }),
    });
    const store = useFileManagerStore();
    store.layoutMode = "browser";
    store.setApi(api);
    await store.init("/repo");

    const openingA = store.selectEntry(files[0]!);
    await store.selectEntry(files[1]!);
    resolvePreviewA({ kind: "text", content: "preview A" });
    await openingA;
    expect(store.selectedEntry?.relativePath).toBe("b.ts");
    expect(store.preview?.content).toBe("preview B");

    store.activateTab("a.ts");
    const readingA = store.startEdit();
    await store.selectEntry(files[1]!);
    await store.startEdit();
    resolveReadA({ content: "source A" });
    await readingA;
    expect(store.editorTabs.find((tab) => tab.entry.relativePath === "a.ts")?.editMode).toBe(true);
    expect(store.editorTabs.find((tab) => tab.entry.relativePath === "a.ts")?.editContent).toBe("source A");
    expect(store.selectedEntry?.relativePath).toBe("b.ts");
    expect(store.editContent).toBe("source B");
    expect(store.editDirty).toBe(false);
  });

  it("keeps open tabs and drafts isolated in memory by workspace root", async () => {
    const file = { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" };
    const { api } = makeFakeApi();
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo-a");
    await store.selectEntry(file);
    store.editContent = "repo A draft";
    store.editDirty = true;

    await store.init("/repo-b");
    expect(store.editorTabs).toHaveLength(0);
    await store.init("/repo-a");

    expect(store.editorTabs).toHaveLength(1);
    expect(store.selectedEntry?.relativePath).toBe("a.ts");
    expect(store.editContent).toBe("repo A draft");
    expect(store.editDirty).toBe(true);
  });

  it("remaps or removes editor tabs when their files are renamed, moved or deleted", async () => {
    const file = { name: "a.ts", relativePath: "src/a.ts", kind: "file" as const, extension: ".ts" };
    const { api } = makeFakeApi({
      fileRename: async () => ({ entry: {} }),
      fileDelete: async () => ({ ok: true }),
      fileMove: async () => ({ entry: {} }),
    });
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");
    await store.selectEntry(file);
    store.editContent = "draft";
    store.editDirty = true;

    await store.renameEntry(file, "renamed.ts");
    expect(store.activeTabPath).toBe("src/renamed.ts");
    expect(store.selectedEntry?.relativePath).toBe("src/renamed.ts");
    expect(store.editContent).toBe("draft");
    await store.moveEntryTo({ ...file, name: "renamed.ts", relativePath: "src/renamed.ts" }, "dest");
    expect(store.activeTabPath).toBe("dest/renamed.ts");
    await store.deleteEntry({ ...file, name: "renamed.ts", relativePath: "dest/renamed.ts" });
    expect(store.editorTabs).toHaveLength(0);
    expect(store.activeTabPath).toBe(null);
  });

  it("keeps an inline diff and editor draft on its file tab while switching tabs", async () => {
    const files = [
      { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" },
      { name: "b.ts", relativePath: "b.ts", kind: "file" as const, extension: ".ts" },
    ];
    const { api } = makeFakeApi();
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");
    await store.selectEntry(files[0]!);
    store.editContent = "unsaved draft";
    store.editDirty = true;
    await store.openDiff(files[0]!, "branch", "feature");

    expect(store.diffOpen).toBe(true);
    expect(store.editContent).toBe("unsaved draft");
    expect(store.editDirty).toBe(true);
    await store.selectEntry(files[1]!);

    expect(store.diffOpen).toBe(false);
    expect(store.editorTabs.find((tab) => tab.entry.relativePath === "a.ts")?.editContent).toBe("unsaved draft");
    expect(store.selectedEntry?.relativePath).toBe("b.ts");

    await store.openDiff(files[1]!, "staged");
    store.activateTab("a.ts");
    expect(store.diffOpen).toBe(true);
    expect(store.diffSource).toBe("branch");
    expect(store.diffRevisionRef).toBe("feature");
    expect(store.diffPayload?.ok).toBe(true);
    expect(store.editContent).toBe("unsaved draft");
    store.closeDiff();
    expect(store.diffOpen).toBe(false);
    store.activateTab("b.ts");
    expect(store.diffOpen).toBe(true);
    expect(store.diffSource).toBe("staged");
  });

  it("ignores late diff refs after the inline diff closes", async () => {
    const file = { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" };
    let resolveRefs!: (value: AnyObj) => void;
    let refsStarted!: () => void;
    const started = new Promise<void>((resolve) => (refsStarted = resolve));
    const { api, calls } = makeFakeApi({
      fileGitRefs: () => {
        refsStarted();
        return new Promise((resolve) => (resolveRefs = resolve));
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/repo");
    const opening = store.openDiff(file);
    await started;
    store.closeDiff();
    resolveRefs({ branches: ["late"], tags: [], commits: [], currentBranch: "main" });
    await opening;

    expect(store.diffOpen).toBe(false);
    expect(store.diffPayload).toBe(null);
    expect(store.diffRefs.branches).toEqual([]);
    expect(calls.fileGitDiff).toHaveLength(0);
  });

  it("does not start the default comparison after a source picker is opened during ref loading", async () => {
    const file = { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" };
    let resolveRefs!: (value: AnyObj) => void;
    let refsStarted!: () => void;
    const started = new Promise<void>((resolve) => (refsStarted = resolve));
    const { api, calls } = makeFakeApi({
      fileGitRefs: () => {
        refsStarted();
        return new Promise((resolve) => (resolveRefs = resolve));
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/repo");
    const opening = store.openDiff(file);
    await started;
    store.selectDiffMode("branch");
    resolveRefs({ branches: ["feature"], tags: [], commits: [], currentBranch: "main" });
    await opening;

    expect(store.diffSource).toBe("branch");
    expect(store.diffRevisionRef).toBe("");
    expect(store.diffPayload).toBe(null);
    expect(calls.fileGitDiff).toHaveLength(0);
  });

  it("stores late diff results on their originating tab", async () => {
    const files = [
      { name: "a.ts", relativePath: "a.ts", kind: "file" as const, extension: ".ts" },
      { name: "b.ts", relativePath: "b.ts", kind: "file" as const, extension: ".ts" },
    ];
    let resolveDiffA!: (value: AnyObj) => void;
    let diffAStarted!: () => void;
    const started = new Promise<void>((resolve) => (diffAStarted = resolve));
    const { api } = makeFakeApi({
      fileGitDiff: (p: AnyObj) => {
        if (p.relativePath === "a.ts") {
          diffAStarted();
          return new Promise((resolve) => (resolveDiffA = resolve));
        }
        return Promise.resolve({ ok: true, leftContent: "B old", rightContent: "B new", source: "head" });
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/repo");
    const openingA = store.openDiff(files[0]!);
    await started;
    await store.openDiff(files[1]!);
    resolveDiffA({ ok: true, leftContent: "A old", rightContent: "A new", source: "head" });
    await openingA;

    expect(store.diffEntry?.relativePath).toBe("b.ts");
    expect(store.diffPayload?.rightContent).toBe("B new");
    expect(store.diffLoading).toBe(false);
    store.activateTab("a.ts");
    expect(store.diffEntry?.relativePath).toBe("a.ts");
    expect(store.diffPayload?.rightContent).toBe("A new");
    store.activateTab("b.ts");
    expect(store.diffPayload?.rightContent).toBe("B new");
  });

  it("copyToClipboard pushes the entry onto the OS clipboard via fileClipboardCopy", async () => {
    const calls: AnyObj[] = [];
    const { api } = makeFakeApi({
      fileClipboardCopy: async (p: AnyObj) => {
        calls.push(p);
        return { ok: true };
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/repo");

    store.copyToClipboard({ name: "f.txt", relativePath: "sub/f.txt", kind: "file" });
    // Microtask drain so the fire-and-forget IPC promise resolves.
    await Promise.resolve();
    expect(store.clipboard?.op).toBe("copy");
    expect(calls).toEqual([{ rootPath: "/repo", relativePath: "sub/f.txt" }]);
  });

  it("createFile failure sets store.error AND surfaces a notification toast (not a silent no-op)", async () => {
    const { api } = makeFakeApi({
      fileCreateFile: async () => {
        throw new Error("EPERM: locked");
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    expect(await store.createFile("newfile.txt")).toBe(false);
    expect(store.error).toBe("EPERM: locked");
    expect(store.editorTabs).toHaveLength(0);
    const notifications = useNotificationStore();
    expect(notifications.persistentToasts.at(-1)?.kind).toBe("error");
    expect(notifications.persistentToasts.at(-1)?.title).toBe("Create file failed");
    expect(notifications.persistentToasts.at(-1)?.body).toBe("EPERM: locked");
  });

  it("opens a newly created nested file for editing and preserves other tab drafts", async () => {
    const existing = { name: "existing.ts", relativePath: "existing.ts", kind: "file" as const, extension: ".ts" };
    const created = {
      name: "new.ts",
      relativePath: "src/components/new.ts",
      kind: "file" as const,
      extension: ".ts",
      size: 0,
    };
    let createParams: AnyObj | undefined;
    const { api } = makeFakeApi({
      fileCreateFile: async (p: AnyObj) => {
        createParams = p;
        return { entry: created };
      },
      filePreview: async () => ({ kind: "empty", content: "" }),
      fileRead: async () => ({ content: "" }),
    });
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");
    await store.selectEntry(existing);
    store.editContent = "keep this draft";
    store.editDirty = true;

    await store.createFile("new.ts", "src/components");

    expect(createParams).toMatchObject({ rootPath: "/repo", parentPath: "src/components", name: "new.ts" });
    expect(store.selectedEntry?.relativePath).toBe(created.relativePath);
    expect(store.activeTabPath).toBe(created.relativePath);
    expect(store.editMode).toBe(true);
    expect(store.editContent).toBe("");
    expect(store.editorTabs.find((tab) => tab.entry.relativePath === "existing.ts")?.editContent).toBe(
      "keep this draft",
    );
    expect(store.editorTabs.find((tab) => tab.entry.relativePath === "existing.ts")?.editDirty).toBe(true);
  });

  it("opens a newly created file in the editor while staying in browser layout", async () => {
    const { api } = makeFakeApi({
      fileCreateFile: async () => ({
        entry: { name: "new.txt", relativePath: "new.txt", kind: "file", extension: ".txt" },
      }),
      filePreview: async () => ({ kind: "text", content: "" }),
      fileRead: async () => ({ content: "" }),
    });
    const store = useFileManagerStore();
    store.layoutMode = "browser";
    store.setApi(api);
    await store.init("/repo");

    await store.createFile("new.txt");

    expect(store.layoutMode).toBe("browser");
    expect(store.selectedEntry?.relativePath).toBe("new.txt");
    expect(store.editMode).toBe(true);
    expect(store.editorTabs).toHaveLength(1);
  });

  it("surfaces an editor load failure without reporting file creation as failed", async () => {
    const { api } = makeFakeApi({
      fileCreateFile: async () => ({
        entry: { name: "new.txt", relativePath: "new.txt", kind: "file", extension: ".txt" },
      }),
      filePreview: async () => ({ kind: "error", content: "Preview failed" }),
      fileRead: async () => {
        throw new Error("Read failed");
      },
    });
    const store = useFileManagerStore();
    store.layoutMode = "editor";
    store.setApi(api);
    await store.init("/repo");

    expect(await store.createFile("new.txt")).toBe(true);
    expect(store.activeTabPath).toBe("new.txt");
    expect(store.editMode).toBe(false);
    expect(store.error).toBe(null);
    const notifications = useNotificationStore();
    expect(notifications.persistentToasts.at(-1)?.title).toBe("File created but could not be opened");
    expect(notifications.persistentToasts.at(-1)?.body).toBe("Read failed");
  });

  it("does not open a created file in another root when the workspace changes mid-request", async () => {
    let resolveCreate!: (result: AnyObj) => void;
    let createStarted!: () => void;
    const started = new Promise<void>((resolve) => (createStarted = resolve));
    const { api } = makeFakeApi({
      fileCreateFile: () => {
        createStarted();
        return new Promise((resolve) => (resolveCreate = resolve));
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/repo-a");
    const creating = store.createFile("new.txt");
    await started;
    await store.init("/repo-b");
    resolveCreate({ entry: { name: "new.txt", relativePath: "new.txt", kind: "file", extension: ".txt" } });
    await creating;

    expect(store.rootPath).toBe("/repo-b");
    expect(store.editorTabs).toHaveLength(0);
    await store.init("/repo-a");
    expect(store.editorTabs).toHaveLength(0);
  });

  it("createDirectory failure sets store.error AND surfaces a notification toast", async () => {
    const { api } = makeFakeApi({
      fileCreateDir: async () => {
        throw new Error("EACCES");
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    await store.createDirectory("newdir");
    expect(store.error).toBe("EACCES");
    const notifications = useNotificationStore();
    expect(notifications.persistentToasts.at(-1)?.title).toBe("Create folder failed");
  });

  it("renameEntry failure sets store.error AND surfaces a notification toast", async () => {
    const { api } = makeFakeApi({
      fileRename: async () => {
        throw new Error("Destination already exists");
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    const entry = { name: "a.txt", relativePath: "a.txt", kind: "file" as const };
    await store.renameEntry(entry, "b.txt");
    expect(store.error).toBe("Destination already exists");
    const notifications = useNotificationStore();
    expect(notifications.persistentToasts.at(-1)?.title).toBe("Rename failed");
  });

  it("deleteEntry failure sets store.error AND surfaces a notification toast", async () => {
    const { api } = makeFakeApi({
      fileDelete: async () => {
        throw new Error("EBUSY: file in use");
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    const entry = { name: "a.txt", relativePath: "a.txt", kind: "file" as const };
    await store.deleteEntry(entry);
    expect(store.error).toBe("EBUSY: file in use");
    const notifications = useNotificationStore();
    expect(notifications.persistentToasts.at(-1)?.title).toBe("Delete failed");
  });

  it("moveEntryTo failure sets store.error AND surfaces a notification toast", async () => {
    const { api } = makeFakeApi({
      fileMove: async () => {
        throw new Error("Source and destination are the same");
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    const entry = { name: "a.txt", relativePath: "a.txt", kind: "file" as const };
    await store.moveEntryTo(entry, "dest");
    expect(store.error).toBe("Source and destination are the same");
    const notifications = useNotificationStore();
    expect(notifications.persistentToasts.at(-1)?.title).toBe("Move failed");
  });

  it("saveEdit failure sets store.error AND surfaces a notification toast", async () => {
    const { api } = makeFakeApi({
      fileWrite: async () => {
        throw new Error("EACCES: read-only");
      },
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    const entry = { name: "a.txt", relativePath: "a.txt", kind: "file" as const };
    await store.selectEntry(entry);
    await store.startEdit();
    await store.saveEdit();
    expect(store.error).toBe("EACCES: read-only");
    const notifications = useNotificationStore();
    expect(notifications.persistentToasts.at(-1)?.title).toBe("Save failed");
  });

  it("copyToClipboard tolerates a missing or rejecting fileClipboardCopy", async () => {
    // Case 1: API doesn't implement fileClipboardCopy at all.
    const { api: api1 } = makeFakeApi();
    const store1 = useFileManagerStore();
    store1.setApi(api1);
    await store1.init("/r");
    expect(() => store1.copyToClipboard({ name: "a", relativePath: "a", kind: "file" })).not.toThrow();
    expect(store1.clipboard?.op).toBe("copy");

    // Case 2: API rejects — in-app clipboard should still be set.
    setActivePinia(createPinia());
    const { api: api2 } = makeFakeApi({
      fileClipboardCopy: () => Promise.reject(new Error("nope")),
    });
    const store2 = useFileManagerStore();
    store2.setApi(api2);
    await store2.init("/r");
    store2.copyToClipboard({ name: "b", relativePath: "b", kind: "file" });
    await Promise.resolve();
    expect(store2.clipboard?.op).toBe("copy");
  });
});
