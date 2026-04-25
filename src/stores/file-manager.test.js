import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useFileManagerStore } from "./file-manager.js";

function makeFakeApi(overrides = {}) {
  const calls = { fileList: [], fileTree: [], fileGitStatus: [], fileGitDiff: [], fileGitRefs: [] };
  const api = {
    fileList: async (p) => {
      calls.fileList.push(p);
      return { entries: [], path: p.relativePath };
    },
    fileTree: async (p) => {
      calls.fileTree.push(p);
      return { entries: [] };
    },
    fileGitStatus: async (p) => {
      calls.fileGitStatus.push(p);
      return {
        isRepo: true,
        root: p.rootPath,
        entries: { "src/foo.js": { status: "modified" }, "untracked.txt": { status: "untracked" } },
        directories: { src: "modified" },
      };
    },
    fileGitDiff: async (p) => {
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
    fileGitRefs: async (p) => {
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
      { name: ".hidden", relativePath: ".hidden", kind: "file", isHidden: true, extension: "" },
      { name: "alpha.js", relativePath: "alpha.js", kind: "file", isHidden: false, extension: ".js" },
      { name: "beta.js", relativePath: "beta.js", kind: "file", isHidden: false, extension: ".js" },
      { name: "node_modules", relativePath: "node_modules", kind: "directory", isHidden: false, extension: "" },
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

    const entry = { name: "x.js", relativePath: "x.js", kind: "file", extension: ".js" };
    await store.openDiff(entry);
    expect(store.diffOpen).toBe(true);
    expect(store.diffEntry).toEqual(entry);
    expect(store.diffSource).toBe("head");
    expect(store.diffPayload?.ok).toBe(true);
    expect(store.diffPayload.leftContent).toBe("old");
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

    const entry = { name: "x.js", relativePath: "x.js", kind: "file", extension: ".js" };
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

    const dir = { name: "src", relativePath: "src", kind: "directory" };
    await store.moveEntryTo(dir, "src");
    expect(moveCalled).toBe(false);
    await store.moveEntryTo(dir, "src/nested");
    expect(moveCalled).toBe(false);
  });

  it("expandTreeNode preserves child entry identity across re-expansion of parent", async () => {
    const treeResponses = {
      "": [
        { name: "src", relativePath: "src", kind: "directory", isHidden: false },
        { name: "lib", relativePath: "lib", kind: "directory", isHidden: false },
      ],
      src: [{ name: "components", relativePath: "src/components", kind: "directory", isHidden: false }],
    };
    const { api } = makeFakeApi({
      fileTree: async (p) => ({ entries: treeResponses[p.relativePath] || [] }),
    });
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    await store.expandTreeNode("src");
    // Re-expand root; the previously expanded "src" node must still have the correct relativePath.
    await store.expandTreeNode("");

    const root = store.treeNodes.get("");
    const srcChild = root.children.find((c) => c.entry.name === "src");
    expect(srcChild).toBeDefined();
    expect(srcChild.entry.relativePath).toBe("src");
    // No child should accidentally take on the root's empty relativePath.
    for (const child of root.children) {
      expect(child.entry.relativePath).not.toBe("");
    }
  });

  it("clipboard cut + paste flow clears the clipboard, copy keeps it", async () => {
    const { api } = makeFakeApi();
    const store = useFileManagerStore();
    store.setApi(api);
    await store.init("/r");

    const entry = { name: "f.txt", relativePath: "f.txt", kind: "file" };
    store.cutToClipboard(entry);
    expect(store.clipboard?.op).toBe("cut");
    await store.pasteEntry("dest");
    expect(store.clipboard).toBe(null);

    store.copyToClipboard(entry);
    expect(store.clipboard?.op).toBe("copy");
    await store.pasteEntry("dest");
    expect(store.clipboard?.op).toBe("copy"); // copy stays
  });
});
