import { defineStore } from "pinia";
import { ref, computed, shallowRef, watch } from "vue";
import { rlog } from "../lib/renderer-log.js";

interface FileEntry {
  name: string;
  kind: "file" | "directory";
  relativePath: string;
  isHidden?: boolean;
  size?: number;
  modifiedAt?: string;
  extension?: string;
}

interface EditorTab {
  rootPath: string;
  entry: FileEntry;
  preview: FilePreview | null;
  editMode: boolean;
  editContent: string;
  baselineContent: string;
  editDirty: boolean;
  editLoading?: boolean;
  diffOpen: boolean;
  diffSource: "head" | "staged" | "commit" | "branch" | "tag";
  diffRevisionRef: string;
  diffPayload: DiffPayload | null;
  diffLoading: boolean;
  diffRefs: DiffRefs;
  diffRefsLoading: boolean;
  diffSession: number;
  diffRun: number;
}

interface TreeNode {
  entry: FileEntry;
  children: TreeNode[] | null;
  expanded: boolean;
}

interface FilePreview {
  kind: string;
  content: string;
  mimeType?: string;
}

interface ClipboardEntry {
  entry: FileEntry;
  op: "copy" | "cut";
}

interface GitStatusEntry {
  status: string;
  stagedStatus?: string;
  unstagedStatus?: string;
}

interface DiffPayload {
  ok: boolean;
  leftContent?: string;
  rightContent?: string;
  leftLabel?: string;
  rightLabel?: string;
  leftMissing?: boolean;
  rightMissing?: boolean;
  language?: string;
  revision?: string;
  source?: string;
  leftError?: string;
}

interface DiffRefs {
  branches: string[];
  tags: string[];
  commits: string[];
  currentBranch: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FileApi = any;

export const useFileManagerStore = defineStore("fileManager", () => {
  let _api: FileApi | null = null;
  function setApi(api: FileApi): void {
    _api = api;
  }

  // State
  const rootPath = ref("");
  const currentPath = ref("");
  const entries = shallowRef<FileEntry[]>([]);
  const treeNodes = ref(new Map<string, TreeNode>());
  const selectedEntry = ref<FileEntry | null>(null);
  const preview = ref<FilePreview | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const clipboard = ref<ClipboardEntry | null>(null); // { entry, op: 'copy' | 'cut' } | null

  // Edit state
  const editMode = ref(false);
  const editContent = ref("");
  const editDirty = ref(false);
  const columnSelection = ref(false);
  const focusNextEditor = ref(false);
  const editorTabs = ref<EditorTab[]>([]);
  const activeTabPath = ref<string | null>(null);
  const activeEditorTab = computed(() =>
    editorTabs.value.find((tab) => tab.rootPath === rootPath.value && tab.entry.relativePath === activeTabPath.value),
  );
  const rootTabs = ref(new Map<string, { tabs: EditorTab[]; activePath: string | null }>());
  let restoringTabState = false;
  let rootChangeSequence = 0;

  function syncActiveTab(): void {
    if (restoringTabState) return;
    const tab = editorTabs.value.find((item) => item.entry.relativePath === activeTabPath.value);
    if (!tab || selectedEntry.value?.relativePath !== activeTabPath.value) return;
    tab.preview = preview.value;
    tab.editMode = editMode.value;
    tab.editContent = editContent.value;
    tab.editDirty = editDirty.value;
  }

  function hasOpenTab(tab: EditorTab): boolean {
    if (editorTabs.value.includes(tab)) return true;
    for (const saved of rootTabs.value.values()) if (saved.tabs.includes(tab)) return true;
    return false;
  }

  function createEditorTab(entry: FileEntry): EditorTab {
    return {
      rootPath: rootPath.value,
      entry,
      preview: null,
      editMode: false,
      editContent: "",
      baselineContent: "",
      editDirty: false,
      diffOpen: false,
      diffSource: "head",
      diffRevisionRef: "",
      diffPayload: null,
      diffLoading: false,
      diffRefs: { branches: [], tags: [], commits: [], currentBranch: "" },
      diffRefsLoading: false,
      diffSession: 0,
      diffRun: 0,
    };
  }

  function tabsForRoot(root: string): EditorTab[] {
    return root === rootPath.value ? editorTabs.value : rootTabs.value.get(root)?.tabs || [];
  }

  function remapOpenTabs(fromPath: string, toPath: string, root = rootPath.value): void {
    if (root === rootPath.value) syncActiveTab();
    const rewrite = (path: string) =>
      path === fromPath || path.startsWith(`${fromPath}/`) ? `${toPath}${path.slice(fromPath.length)}` : path;
    for (const tab of tabsForRoot(root)) {
      if (tab.entry.relativePath === fromPath || tab.entry.relativePath.startsWith(`${fromPath}/`)) {
        const relativePath = rewrite(tab.entry.relativePath);
        tab.entry = { ...tab.entry, relativePath, name: relativePath.split("/").pop() || tab.entry.name };
      }
    }
    if (root === rootPath.value) activeTabPath.value = activeTabPath.value ? rewrite(activeTabPath.value) : null;
    else {
      const saved = rootTabs.value.get(root);
      if (saved?.activePath) saved.activePath = rewrite(saved.activePath);
    }
    if (
      root === rootPath.value &&
      selectedEntry.value &&
      (selectedEntry.value.relativePath === fromPath || selectedEntry.value.relativePath.startsWith(`${fromPath}/`))
    ) {
      const relativePath = rewrite(selectedEntry.value.relativePath);
      selectedEntry.value = {
        ...selectedEntry.value,
        relativePath,
        name: relativePath.split("/").pop() || selectedEntry.value.name,
      };
    }
  }

  function removeOpenTabs(path: string, root = rootPath.value): void {
    if (root === rootPath.value) syncActiveTab();
    const tabs = tabsForRoot(root);
    if (root !== rootPath.value) {
      const saved = rootTabs.value.get(root);
      if (saved) {
        const activeWasRemoved = saved.activePath === path || saved.activePath?.startsWith(`${path}/`);
        const activeIndex = saved.tabs.findIndex((tab) => tab.entry.relativePath === saved.activePath);
        saved.tabs = saved.tabs.filter(
          (tab) => tab.entry.relativePath !== path && !tab.entry.relativePath.startsWith(`${path}/`),
        );
        if (activeWasRemoved)
          saved.activePath = saved.tabs[Math.min(activeIndex, saved.tabs.length - 1)]?.entry.relativePath || null;
      }
      return;
    }
    const wasActive = activeTabPath.value === path || activeTabPath.value?.startsWith(`${path}/`);
    const index = editorTabs.value.findIndex((tab) => tab.entry.relativePath === activeTabPath.value);
    editorTabs.value = tabs.filter(
      (tab) => tab.entry.relativePath !== path && !tab.entry.relativePath.startsWith(`${path}/`),
    );
    if (!wasActive) return;
    const next = editorTabs.value[Math.min(index, editorTabs.value.length - 1)];
    if (next) void activateTab(next.entry.relativePath);
    else {
      activeTabPath.value = null;
      selectedEntry.value = null;
      preview.value = null;
      editMode.value = false;
      editContent.value = "";
      editDirty.value = false;
    }
  }

  watch([preview, editMode, editContent, editDirty], syncActiveTab, { flush: "sync" });

  // View preferences
  const viewMode = ref("list");
  const layoutMode = ref<"editor" | "browser">(
    typeof localStorage !== "undefined" && localStorage.getItem("files.layoutMode") === "browser"
      ? "browser"
      : "editor",
  );
  const showHidden = ref(false);
  const sortBy = ref("name");
  const sortAsc = ref(true);
  const filterText = ref(""); // search/filter within current folder

  // Git status state
  const gitStatusFiles = shallowRef<Record<string, GitStatusEntry>>({}); // { relativePath: { status, stagedStatus, unstagedStatus } }
  const gitStatusDirectories = shallowRef<Record<string, string>>({}); // { relativePath: status }
  const gitIsRepo = ref(false);
  const gitRoot = ref("");

  // Diff fields are exposed as adapters over the active file tab below.
  const emptyDiffRefs: DiffRefs = { branches: [], tags: [], commits: [], currentBranch: "" };
  const diffOpen = computed({
    get: () => activeEditorTab.value?.diffOpen || false,
    set: (value: boolean) => {
      if (activeEditorTab.value) activeEditorTab.value.diffOpen = value;
    },
  });
  const diffEntry = computed(() => (activeEditorTab.value?.diffOpen ? activeEditorTab.value.entry : null));
  const diffSource = computed({
    get: () => activeEditorTab.value?.diffSource || "head",
    set: (value: "head" | "staged" | "commit" | "branch" | "tag") => {
      if (activeEditorTab.value) activeEditorTab.value.diffSource = value;
    },
  });
  const diffRevisionRef = computed({
    get: () => activeEditorTab.value?.diffRevisionRef || "",
    set: (value: string) => {
      if (activeEditorTab.value) activeEditorTab.value.diffRevisionRef = value;
    },
  });
  const diffPayload = computed({
    get: () => activeEditorTab.value?.diffPayload || null,
    set: (value: DiffPayload | null) => {
      if (activeEditorTab.value) activeEditorTab.value.diffPayload = value;
    },
  });
  const diffLoading = computed({
    get: () => activeEditorTab.value?.diffLoading || false,
    set: (value: boolean) => {
      if (activeEditorTab.value) activeEditorTab.value.diffLoading = value;
    },
  });
  const diffRefs = computed({
    get: () => activeEditorTab.value?.diffRefs || emptyDiffRefs,
    set: (value: DiffRefs) => {
      if (activeEditorTab.value) activeEditorTab.value.diffRefs = value;
    },
  });
  const diffRefsLoading = computed({
    get: () => activeEditorTab.value?.diffRefsLoading || false,
    set: (value: boolean) => {
      if (activeEditorTab.value) activeEditorTab.value.diffRefsLoading = value;
    },
  });

  // Computed
  const breadcrumbs = computed(() => {
    const parts = currentPath.value.split("/").filter(Boolean);
    return [
      { name: rootPath.value.split(/[/\\]/).pop() || "Root", path: "" },
      ...parts.map((part, i) => ({
        name: part,
        path: parts.slice(0, i + 1).join("/"),
      })),
    ];
  });

  const sortedEntries = computed(() => {
    let items = [...entries.value];
    if (!showHidden.value) {
      items = items.filter((e) => !e.isHidden);
    }
    const filter = filterText.value.trim().toLowerCase();
    if (filter) {
      items = items.filter((e) => e.name.toLowerCase().includes(filter));
    }
    items.sort((a, b) => {
      if (a.kind !== b.kind) {
        if (a.kind === "directory" && b.kind !== "directory") return -1;
        if (a.kind !== "directory" && b.kind === "directory") return 1;
      }
      let cmp: number;
      switch (sortBy.value) {
        case "size":
          cmp = (a.size || 0) - (b.size || 0);
          break;
        case "modified":
          cmp = new Date(a.modifiedAt || 0).getTime() - new Date(b.modifiedAt || 0).getTime();
          break;
        case "type":
          cmp = (a.extension || "").localeCompare(b.extension || "");
          break;
        default:
          cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }
      return sortAsc.value ? cmp : -cmp;
    });
    return items;
  });

  const dirtyCount = computed(() => Object.keys(gitStatusFiles.value || {}).length);

  // Lookups
  function getStatusFor(relativePath: string): GitStatusEntry | null {
    if (!relativePath) return null;
    return gitStatusFiles.value[relativePath] || null;
  }

  function getDirectoryStatusFor(relativePath: string): string | null {
    if (!relativePath) return null;
    return gitStatusDirectories.value[relativePath] || null;
  }

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  async function init(root: string): Promise<void> {
    if (rootPath.value === root && entries.value.length > 0) return;
    syncActiveTab();
    if (rootPath.value !== root) {
      rootChangeSequence += 1;
      focusNextEditor.value = false;
    }
    if (rootPath.value) {
      rootTabs.value.set(rootPath.value, { tabs: editorTabs.value, activePath: activeTabPath.value });
    }
    rootPath.value = root;
    const requestRoot = root;
    const saved = rootTabs.value.get(root);
    editorTabs.value = saved?.tabs || [];
    activeTabPath.value = saved?.activePath || null;
    rootTabs.value.delete(root);
    treeNodes.value = new Map();
    selectedEntry.value = null;
    preview.value = null;
    editMode.value = false;
    editContent.value = "";
    editDirty.value = false;
    filterText.value = "";
    await navigate("");
    if (rootPath.value !== requestRoot) return;
    await expandTreeNode("");
    if (rootPath.value !== requestRoot) return;
    if (activeTabPath.value) await activateTab(activeTabPath.value);
    if (rootPath.value !== requestRoot) return;
    await refreshGitStatus();
  }

  async function navigate(relativePath: string): Promise<void> {
    if (!_api) return;
    const requestRoot = rootPath.value;
    const preserveEditor = layoutMode.value === "editor" && !!activeTabPath.value;
    loading.value = true;
    error.value = null;
    filterText.value = "";
    try {
      const result = (await _api.fileList({ rootPath: rootPath.value, relativePath: relativePath || "" })) as {
        entries: FileEntry[];
        path: string;
      };
      if (rootPath.value !== requestRoot) return;
      entries.value = result.entries;
      currentPath.value = result.path || relativePath || "";
      if (!preserveEditor) {
        syncActiveTab();
        selectedEntry.value = null;
        preview.value = null;
        editMode.value = false;
        editContent.value = "";
        editDirty.value = false;
      }
      // Keep dirty markers in sync with what the user just moved into.
      // Run in the background so navigation isn't blocked.
      refreshGitStatus().catch(() => {});
    } catch (err) {
      if (rootPath.value === requestRoot) error.value = (err as Error).message || "Failed to list directory";
    } finally {
      loading.value = false;
    }
  }

  async function expandTreeNode(relativePath: string): Promise<void> {
    if (!_api) return;
    const requestRoot = rootPath.value;
    try {
      const result = (await _api.fileList({ rootPath: rootPath.value, relativePath: relativePath || "" })) as {
        entries: FileEntry[];
      };
      if (rootPath.value !== requestRoot) return;
      let dirs = result.entries;
      if (!showHidden.value) {
        dirs = dirs.filter((e) => !e.isHidden);
      }
      dirs.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

      const next = new Map(treeNodes.value);
      const existing = next.get(relativePath);
      const fallbackEntry: FileEntry = relativePath
        ? { name: relativePath.split("/").pop() || relativePath, relativePath, kind: "directory" }
        : { name: rootPath.value.split(/[/\\]/).pop() || "Root", relativePath: "", kind: "directory" };
      next.set(relativePath, {
        entry: existing?.entry || fallbackEntry,
        children: dirs.map((e) => {
          const prev = next.get(e.relativePath);
          return prev ? { ...prev, entry: e } : { entry: e, children: null, expanded: false };
        }),
        expanded: true,
      });
      treeNodes.value = next;
    } catch (err) {
      if (rootPath.value !== requestRoot) return;
      rlog("warn", "file-manager: expandTreeNode failed", {
        relativePath,
        err: (err as Error)?.message || String(err),
      });
    }
  }

  function collapseTreeNode(relativePath: string): void {
    const next = new Map(treeNodes.value);
    const node = next.get(relativePath);
    if (node) {
      next.set(relativePath, { ...node, expanded: false });
      treeNodes.value = next;
    }
  }

  async function selectEntry(entry: FileEntry): Promise<boolean> {
    if (entry.kind === "file") {
      syncActiveTab();
      const existing = editorTabs.value.find((item) => item.entry.relativePath === entry.relativePath);
      const tab = existing || createEditorTab(entry);
      tab.entry = entry;
      if (!existing) editorTabs.value = [...editorTabs.value, tab];
      activeTabPath.value = entry.relativePath;
      selectedEntry.value = null;
      preview.value = tab.preview;
      editMode.value = tab.editMode;
      editContent.value = tab.editContent;
      editDirty.value = tab.editDirty;
      selectedEntry.value = entry;
      if (!tab.preview) await loadPreview(entry);
      if (
        activeTabPath.value === entry.relativePath &&
        selectedEntry.value?.relativePath === entry.relativePath &&
        layoutMode.value === "editor" &&
        !tab.editMode &&
        !tab.editLoading &&
        (tab.preview?.kind === "text" || tab.preview?.kind === "empty")
      ) {
        await startEdit();
      }
      return true;
    }
    syncActiveTab();
    selectedEntry.value = entry;
    editMode.value = false;
    preview.value = null;
    return true;
  }

  async function activateTab(relativePath: string): Promise<void> {
    const tab = editorTabs.value.find((item) => item.entry.relativePath === relativePath);
    if (!tab) return;
    syncActiveTab();
    activeTabPath.value = relativePath;
    selectedEntry.value = null;
    preview.value = tab.preview;
    editMode.value = tab.editMode;
    editContent.value = tab.editContent;
    editDirty.value = tab.editDirty;
    selectedEntry.value = tab.entry;
    if (!tab.preview) await loadPreview(tab.entry);
    if (
      layoutMode.value === "editor" &&
      !tab.editMode &&
      !tab.editLoading &&
      (tab.preview?.kind === "text" || tab.preview?.kind === "empty")
    ) {
      await startEdit();
    }
  }

  async function confirmInApp(options: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger: boolean;
  }): Promise<boolean> {
    const { useAppStore } = await import("./app.js");
    return useAppStore().confirmInApp(options);
  }

  async function closeTab(relativePath: string): Promise<boolean> {
    syncActiveTab();
    const requestRoot = rootPath.value;
    const requestRootSequence = rootChangeSequence;
    const tab = editorTabs.value.find((item) => item.entry.relativePath === relativePath);
    if (!tab) return true;
    if (tab.editDirty) {
      const requestedContent = tab.editContent;
      const confirmed = await confirmInApp({
        title: "Close file with unsaved changes?",
        message: `Discard unsaved changes to ${tab.entry.relativePath}?`,
        confirmLabel: "Discard and close",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (
        !confirmed ||
        rootChangeSequence !== requestRootSequence ||
        rootPath.value !== requestRoot ||
        !editorTabs.value.includes(tab) ||
        !tab.editDirty ||
        tab.editContent !== requestedContent
      ) {
        return false;
      }
    }
    retireTab(tab);
    const index = editorTabs.value.indexOf(tab);
    editorTabs.value = editorTabs.value.filter((item) => item !== tab);
    if (activeTabPath.value === relativePath) {
      const next = editorTabs.value[Math.min(index, editorTabs.value.length - 1)];
      if (next) void activateTab(next.entry.relativePath);
      else {
        activeTabPath.value = null;
        selectedEntry.value = null;
        preview.value = null;
        editMode.value = false;
        editContent.value = "";
        editDirty.value = false;
      }
    }
    return true;
  }

  function retireTab(tab: EditorTab): void {
    if (tab.rootPath === rootPath.value && tab.entry.relativePath === activeTabPath.value)
      focusNextEditor.value = false;
    tab.diffSession += 1;
    tab.diffRun += 1;
    tab.diffOpen = false;
    tab.diffLoading = false;
    tab.diffRefsLoading = false;
    tab.editLoading = false;
  }

  function removeTabs(tabsToClose: EditorTab[]): void {
    if (!tabsToClose.length) return;
    syncActiveTab();
    const previousActivePath = activeTabPath.value;
    const previousIndex = editorTabs.value.findIndex((tab) => tab.entry.relativePath === previousActivePath);
    const closing = new Set(tabsToClose);
    for (const tab of tabsToClose) retireTab(tab);
    editorTabs.value = editorTabs.value.filter((tab) => !closing.has(tab));

    if (previousActivePath && !editorTabs.value.some((tab) => tab.entry.relativePath === previousActivePath)) {
      const next = editorTabs.value[Math.min(previousIndex, editorTabs.value.length - 1)];
      if (next) void activateTab(next.entry.relativePath);
      else {
        activeTabPath.value = null;
        selectedEntry.value = null;
        preview.value = null;
        editMode.value = false;
        editContent.value = "";
        editDirty.value = false;
      }
    }
  }

  function closeUnmodifiedTabs(): number {
    syncActiveTab();
    const unmodified = editorTabs.value.filter((tab) => !tab.editDirty);
    removeTabs(unmodified);
    return unmodified.length;
  }

  async function closeAllTabs(): Promise<boolean> {
    syncActiveTab();
    const requestRoot = rootPath.value;
    const requestRootSequence = rootChangeSequence;
    const activePath = activeTabPath.value;
    const tabs = [...editorTabs.value];
    if (!tabs.length) return true;
    const dirty = tabs.filter((tab) => tab.editDirty);
    const drafts = tabs.map((tab) => ({ tab, content: tab.editContent, dirty: tab.editDirty }));
    if (dirty.length) {
      const confirmed = await confirmInApp({
        title: "Close all files?",
        message: `Close all ${tabs.length} open tab${tabs.length === 1 ? "" : "s"} and discard unsaved changes in ${dirty.length} ${dirty.length === 1 ? "file" : "files"}?\n\n${dirty.map((tab) => tab.entry.relativePath).join("\n")}`,
        confirmLabel: "Discard and close",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (
        !confirmed ||
        rootChangeSequence !== requestRootSequence ||
        rootPath.value !== requestRoot ||
        activeTabPath.value !== activePath ||
        editorTabs.value.length !== tabs.length ||
        tabs.some(
          (tab, index) =>
            editorTabs.value[index] !== tab ||
            tab.editContent !== drafts[index]?.content ||
            tab.editDirty !== drafts[index]?.dirty,
        )
      ) {
        return false;
      }
    }
    removeTabs(tabs);
    return true;
  }

  async function loadPreview(entry: FileEntry | null): Promise<void> {
    if (!_api || !entry) return;
    const requestRoot = rootPath.value;
    const requestTab = editorTabs.value.find(
      (item) => item.entry.relativePath === entry.relativePath && item.rootPath === requestRoot,
    );
    try {
      const result = (await _api.filePreview({
        rootPath: rootPath.value,
        relativePath: entry.relativePath,
      })) as FilePreview;
      if (rootPath.value !== requestRoot) {
        if (requestTab && hasOpenTab(requestTab)) requestTab.preview = result;
        return;
      }
      if (requestTab && hasOpenTab(requestTab)) requestTab.preview = result;
      if (
        requestRoot === rootPath.value &&
        requestTab &&
        editorTabs.value.includes(requestTab) &&
        activeTabPath.value === entry.relativePath &&
        selectedEntry.value?.relativePath === entry.relativePath
      )
        preview.value = result;
    } catch (err) {
      if (
        rootPath.value === requestRoot &&
        requestTab &&
        editorTabs.value.includes(requestTab) &&
        selectedEntry.value?.relativePath === entry.relativePath &&
        activeTabPath.value === entry.relativePath
      ) {
        preview.value = { kind: "error", content: (err as Error).message || "Failed to load preview" };
      }
    }
  }

  /**
   * Navigate the file-manager pane to a path (file or directory) by
   * absolute path. Used by the terminal path-link provider when the user
   * has chosen the "internal" external-path-opener mode.
   *
   * Behaviour by entry kind:
   *   - file       → list its parent dir, select the file (preview opens)
   *   - directory  → list the directory itself (descend into it)
   *
   * Returns false if the path is outside the current workspace root
   * (caller falls back to the system opener) or if the parent directory
   * doesn't list the target. Caller must `init(workspaceCwd)` first so
   * `rootPath` is set.
   */
  async function openFileAbsPath(absPath: string): Promise<boolean> {
    if (!rootPath.value || !absPath) return false;
    const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
    const rootNorm = norm(rootPath.value);
    const pathNorm = norm(absPath);
    if (pathNorm === rootNorm) {
      // The path *is* the workspace root — list the root itself.
      await navigate("");
      return true;
    }
    if (!pathNorm.startsWith(rootNorm + "/")) return false;
    const relPath = pathNorm.slice(rootNorm.length + 1);
    const lastSlash = relPath.lastIndexOf("/");
    const parentDir = lastSlash >= 0 ? relPath.slice(0, lastSlash) : "";
    const lastSegment = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
    await navigate(parentDir);
    const entry = entries.value.find((e) => e.name === lastSegment);
    if (!entry) return false;
    if (entry.kind === "directory") {
      // Descend into the directory rather than just highlighting it in the
      // parent listing — that's almost always what the user clicked the
      // link for.
      await navigate(entry.relativePath);
    } else {
      await selectEntry(entry);
    }
    return true;
  }

  async function createFile(name: string, parentPath = currentPath.value): Promise<boolean> {
    if (!_api) return false;
    const requestRoot = rootPath.value;
    error.value = null;
    try {
      const result = (await _api.fileCreateFile({ rootPath: requestRoot, parentPath, name })) as {
        entry?: FileEntry;
      };
      if (rootPath.value !== requestRoot) return true;
      const relativePath = parentPath ? `${parentPath}/${name}` : name;
      const returnedEntry = result?.entry;
      const createdEntry: FileEntry =
        returnedEntry?.relativePath && returnedEntry.kind === "file"
          ? returnedEntry
          : {
              name,
              relativePath,
              kind: "file",
              extension: name.includes(".") ? `.${name.split(".").pop()}` : "",
            };

      if (parentPath === currentPath.value) await refresh();
      else await navigate(parentPath);
      if (rootPath.value !== requestRoot) return true;
      await expandTreeNode(parentPath);
      if (rootPath.value !== requestRoot) return true;
      focusNextEditor.value = true;
      await selectEntry(createdEntry);
      if (rootPath.value !== requestRoot) {
        focusNextEditor.value = false;
        return true;
      }
      if (
        selectedEntry.value?.relativePath === createdEntry.relativePath &&
        activeTabPath.value === createdEntry.relativePath
      ) {
        await startEdit();
      }
      if (rootPath.value !== requestRoot) {
        focusNextEditor.value = false;
        return true;
      }
      if (!editMode.value) {
        focusNextEditor.value = false;
        const openError =
          error.value || (preview.value?.kind === "error" ? preview.value.content : "Unable to open the new file");
        error.value = null;
        await notifyOpError("File created but could not be opened", openError, requestRoot);
      }
      return true;
    } catch (err) {
      focusNextEditor.value = false;
      if (rootPath.value !== requestRoot) return true;
      const msg = (err as Error).message || "Failed to create file";
      error.value = msg;
      await notifyOpError("Create file failed", msg);
      return false;
    }
  }

  async function createDirectory(name: string, parentPath = currentPath.value): Promise<void> {
    if (!_api) return;
    try {
      await _api.fileCreateDir({ rootPath: rootPath.value, parentPath, name });
      if (parentPath === currentPath.value) await refresh();
      else await expandTreeNode(parentPath);
    } catch (err) {
      const msg = (err as Error).message || "Failed to create directory";
      error.value = msg;
      await notifyOpError("Create folder failed", msg);
    }
  }

  async function renameEntry(entry: FileEntry, newName: string): Promise<void> {
    if (!_api) return;
    const requestRoot = rootPath.value;
    const parent = entry.relativePath.split("/").slice(0, -1).join("/");
    const destPath = parent ? `${parent}/${newName}` : newName;
    try {
      await _api.fileRename({ rootPath: requestRoot, relativePath: entry.relativePath, newName });
      closeDiffForPath(entry.relativePath, requestRoot);
      remapOpenTabs(entry.relativePath, destPath, requestRoot);
      if (rootPath.value === requestRoot) await refresh();
    } catch (err) {
      if (rootPath.value !== requestRoot) return;
      const msg = (err as Error).message || "Failed to rename";
      error.value = msg;
      await notifyOpError("Rename failed", msg);
    }
  }

  async function deleteEntry(entry: FileEntry): Promise<void> {
    if (!_api) return;
    const requestRoot = rootPath.value;
    try {
      await _api.fileDelete({ rootPath: requestRoot, relativePath: entry.relativePath });
      closeDiffForPath(entry.relativePath, requestRoot);
      removeOpenTabs(entry.relativePath, requestRoot);
      if (rootPath.value === requestRoot && selectedEntry.value?.relativePath === entry.relativePath) {
        selectedEntry.value = null;
        preview.value = null;
      }
      if (rootPath.value === requestRoot) await refresh();
    } catch (err) {
      if (rootPath.value !== requestRoot) return;
      const msg = (err as Error).message || "Failed to delete";
      error.value = msg;
      await notifyOpError("Delete failed", msg);
    }
  }

  async function startEdit(): Promise<void> {
    if (!_api || !selectedEntry.value || editMode.value) return;
    const entry = selectedEntry.value;
    const requestRoot = rootPath.value;
    const requestTab = editorTabs.value.find(
      (item) => item.entry.relativePath === entry.relativePath && item.rootPath === requestRoot,
    );
    if (requestTab?.editLoading) return;
    if (requestTab) requestTab.editLoading = true;
    try {
      const result = (await _api.fileRead({
        rootPath: requestRoot,
        relativePath: entry.relativePath,
      })) as { content: string };
      if (!requestTab || !hasOpenTab(requestTab) || requestTab.rootPath !== requestRoot) return;
      requestTab.editLoading = false;
      if (!requestTab.editMode && !requestTab.editDirty) {
        requestTab.editContent = result.content;
        requestTab.baselineContent = result.content;
        requestTab.editDirty = false;
        requestTab.editMode = true;
      }
      if (
        rootPath.value === requestRoot &&
        editorTabs.value.includes(requestTab) &&
        activeTabPath.value === entry.relativePath &&
        selectedEntry.value?.relativePath === entry.relativePath
      ) {
        restoringTabState = true;
        preview.value = requestTab.preview;
        editContent.value = requestTab.editContent;
        editDirty.value = requestTab.editDirty;
        editMode.value = requestTab.editMode;
        restoringTabState = false;
      }
    } catch (err) {
      if (requestTab && hasOpenTab(requestTab)) requestTab.editLoading = false;
      if (
        requestRoot === rootPath.value &&
        requestTab &&
        editorTabs.value.includes(requestTab) &&
        selectedEntry.value?.relativePath === entry.relativePath &&
        activeTabPath.value === entry.relativePath
      )
        error.value = (err as Error).message || "Failed to read file for editing";
    }
  }

  async function saveEdit(): Promise<void> {
    if (!_api || !selectedEntry.value) return;
    const entry = selectedEntry.value;
    const requestRoot = rootPath.value;
    const requestTab = editorTabs.value.find(
      (item) => item.entry.relativePath === entry.relativePath && item.rootPath === requestRoot,
    );
    const content = editContent.value;
    try {
      await _api.fileWrite({
        rootPath: requestRoot,
        relativePath: entry.relativePath,
        content,
      });
      if (requestTab && hasOpenTab(requestTab)) {
        requestTab.baselineContent = content;
        requestTab.editDirty = requestTab.editContent !== content;
        if (!requestTab.editDirty) {
          requestTab.editMode = rootPath.value === requestRoot ? layoutMode.value === "editor" : requestTab.editMode;
        }
        if (
          rootPath.value === requestRoot &&
          editorTabs.value.includes(requestTab) &&
          activeTabPath.value === requestTab.entry.relativePath &&
          selectedEntry.value?.relativePath === requestTab.entry.relativePath
        ) {
          editDirty.value = requestTab.editDirty;
          editMode.value = requestTab.editMode;
        }
      }
      let updatedPreview: FilePreview;
      try {
        updatedPreview = (await _api.filePreview({
          rootPath: requestRoot,
          relativePath: entry.relativePath,
        })) as FilePreview;
      } catch (err) {
        updatedPreview = {
          kind: "error",
          content: (err as Error).message || "File was saved, but preview could not be refreshed",
        };
      }
      if (requestTab && hasOpenTab(requestTab)) requestTab.preview = updatedPreview;
      if (
        rootPath.value === requestRoot &&
        requestTab &&
        editorTabs.value.includes(requestTab) &&
        activeTabPath.value === entry.relativePath &&
        selectedEntry.value?.relativePath === entry.relativePath &&
        editContent.value === content
      ) {
        preview.value = updatedPreview;
        editDirty.value = false;
        editMode.value = layoutMode.value === "editor";
      }
      // After saving, the file likely became dirty (or maybe became clean).
      if (rootPath.value === requestRoot) await refreshGitStatus();
    } catch (err) {
      const msg = (err as Error).message || "Failed to save file";
      if (
        rootPath.value === requestRoot &&
        requestTab &&
        editorTabs.value.includes(requestTab) &&
        activeTabPath.value === entry.relativePath &&
        selectedEntry.value?.relativePath === entry.relativePath
      ) {
        error.value = msg;
      }
      await notifyOpError("Save failed", msg, requestRoot);
    }
  }

  async function discardEdit(): Promise<void> {
    const tab = activeEditorTab.value;
    if (!tab || !editDirty.value) return;
    const requestRoot = rootPath.value;
    const requestRootSequence = rootChangeSequence;
    const requestPath = tab.entry.relativePath;
    const requestContent = tab.editContent;
    const confirmed = await confirmInApp({
      title: "Discard changes?",
      message: `Restore the last saved contents of ${tab.entry.relativePath} in the editor?`,
      confirmLabel: "Discard changes",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (
      !confirmed ||
      rootChangeSequence !== requestRootSequence ||
      rootPath.value !== requestRoot ||
      activeTabPath.value !== requestPath ||
      activeEditorTab.value !== tab ||
      !tab.editDirty ||
      tab.editContent !== requestContent
    ) {
      return;
    }
    tab.editContent = tab.baselineContent;
    tab.editDirty = false;
    tab.editMode = true;
    editMode.value = true;
    editContent.value = tab.baselineContent;
    editDirty.value = false;
  }

  async function refresh(): Promise<void> {
    if (!_api) return;
    const requestRoot = rootPath.value;
    const requestPath = currentPath.value;
    loading.value = true;
    try {
      const result = (await _api.fileList({ rootPath: requestRoot, relativePath: requestPath })) as {
        entries: FileEntry[];
        path: string;
      };
      if (rootPath.value !== requestRoot) return;
      entries.value = result.entries;
      const expandedPaths = [...treeNodes.value.entries()].filter(([, node]) => node.expanded).map(([path]) => path);
      for (const path of expandedPaths) {
        if (rootPath.value !== requestRoot) return;
        await expandTreeNode(path);
      }
    } catch (err) {
      if (rootPath.value === requestRoot) error.value = (err as Error).message || "Failed to refresh files";
    } finally {
      loading.value = false;
    }
    if (rootPath.value === requestRoot) await refreshGitStatus();
  }

  async function refreshGitStatus(): Promise<void> {
    if (!_api || !rootPath.value) return;
    const requestRoot = rootPath.value;
    try {
      const result = (await _api.fileGitStatus({ rootPath: requestRoot })) as {
        isRepo: boolean;
        root?: string;
        entries?: Record<string, GitStatusEntry>;
        directories?: Record<string, string>;
      };
      if (rootPath.value !== requestRoot) return;
      if (result?.isRepo) {
        gitIsRepo.value = true;
        gitRoot.value = result.root || "";
        gitStatusFiles.value = result.entries || {};
        gitStatusDirectories.value = result.directories || {};
      } else {
        gitIsRepo.value = false;
        gitRoot.value = "";
        gitStatusFiles.value = {};
        gitStatusDirectories.value = {};
      }
    } catch {
      if (rootPath.value !== requestRoot) return;
      gitIsRepo.value = false;
      gitStatusFiles.value = {};
      gitStatusDirectories.value = {};
    }
  }

  async function openInExplorer(entry: FileEntry | null): Promise<void> {
    if (!_api) return;
    try {
      await _api.fileOpenInExplorer({
        rootPath: rootPath.value,
        relativePath: entry?.relativePath || currentPath.value,
      });
    } catch {
      // silently fail
    }
  }

  function copyToClipboard(entry: FileEntry): void {
    clipboard.value = { entry, op: "copy" };
    // Best-effort: also push the file onto the OS clipboard so the user can
    // paste it into Finder / Explorer / Files. Remote (web) transport is a
    // no-op for this; the in-app `clipboard` above still drives Paste here.
    void _api?.fileClipboardCopy?.({ rootPath: rootPath.value, relativePath: entry.relativePath })?.catch?.(() => {
      // swallow — text path was put on the OS clipboard regardless
    });
  }

  function cutToClipboard(entry: FileEntry): void {
    clipboard.value = { entry, op: "cut" };
  }

  function clearClipboard(): void {
    clipboard.value = null;
  }

  async function pasteEntry(targetDir: string): Promise<void> {
    if (!_api || !clipboard.value) return;
    const requestRoot = rootPath.value;
    const { entry, op } = clipboard.value;
    const destDir = targetDir;
    const destPath = destDir ? `${destDir}/${entry.name}` : entry.name;
    try {
      if (op === "copy") {
        // Backend auto-renames on conflict (foo.txt → "foo (copy).txt"),
        // so this resolves to a new file even when pasting into the same
        // directory. refresh() below brings the new entry into view.
        await _api.fileCopy({ rootPath: requestRoot, fromPath: entry.relativePath, toPath: destPath });
      } else {
        // Move refuses to overwrite — the backend throws "Destination already
        // exists" / "Source and destination are the same" so the cut+paste
        // doesn't silently obliterate the target file.
        await _api.fileMove({ rootPath: requestRoot, fromPath: entry.relativePath, toPath: destPath });
        closeDiffForPath(entry.relativePath, requestRoot);
        remapOpenTabs(entry.relativePath, destPath, requestRoot);
        clipboard.value = null;
      }
      if (rootPath.value === requestRoot) await refresh();
    } catch (err) {
      if (rootPath.value !== requestRoot) return;
      const msg = (err as Error).message || "Failed to paste";
      error.value = msg;
      await notifyOpError(op === "copy" ? "Copy failed" : "Move failed", msg);
    }
  }

  /**
   * Surface a failed mutation as a toast, not just the write-only `error`
   * ref — a destructive op (create/rename/delete/move/save) that silently
   * sets `error` with no consumer reads back as a successful no-op to the
   * user (locked file, permissions — common on Windows).
   */
  async function notifyOpError(title: string, msg: string, ownerRoot = rootPath.value): Promise<void> {
    try {
      const { useNotificationStore } = await import("./notifications.js");
      useNotificationStore().showError(title, msg, {
        profileId: await resolveOwningProfileId(ownerRoot),
      });
    } catch {
      // notifications store optional during isolated unit tests
    }
  }

  /**
   * Profile for error/notification scoping. The file operation belongs to
   * the WORKSPACE whose root this pane is showing — not to "whatever profile
   * this window happens to display" — so resolve the owner by rootPath. The
   * same cwd may legitimately exist in several profiles; prefer a workspace
   * in the caller viewer's profile, then any owner, then the viewer profile.
   */
  async function resolveOwningProfileId(ownerRoot = rootPath.value): Promise<string> {
    const { useAppStore } = await import("./app.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appStore = useAppStore() as any;
    const viewerProfileId = (appStore.activeProfile?.id as string) || "default";
    const normalize = (p: string) =>
      String(p || "")
        .replace(/\\/g, "/")
        .replace(/\/+$/, "");
    const root = normalize(ownerRoot);
    if (root) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const workspaces: any[] = appStore.payload?.appState?.workspaces || [];
      const owners = workspaces.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ws: any) =>
          normalize(ws.cwd) === root ||
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (Array.isArray(ws.gitRoots) && ws.gitRoots.some((r: any) => normalize(String(r)) === root)),
      );
      const preferred = owners.find((ws) => (ws.profileId || "default") === viewerProfileId) || owners[0];
      if (preferred) return preferred.profileId || "default";
    }
    return viewerProfileId;
  }

  /**
   * HTML5 drag-drop handler — moves an entry into a target directory.
   * targetDir = "" means the workspace root.
   */
  async function moveEntryTo(entry: FileEntry, targetDir: string): Promise<void> {
    if (!_api || !entry) return;
    const cleanTarget = (targetDir || "").replace(/^\/+|\/+$/g, "");
    // Don't move into self or own subtree
    if (entry.relativePath === cleanTarget) return;
    if (cleanTarget && cleanTarget.startsWith(entry.relativePath + "/")) return;
    const destPath = cleanTarget ? `${cleanTarget}/${entry.name}` : entry.name;
    if (destPath === entry.relativePath) return;
    const requestRoot = rootPath.value;
    try {
      await _api.fileMove({ rootPath: requestRoot, fromPath: entry.relativePath, toPath: destPath });
      closeDiffForPath(entry.relativePath, requestRoot);
      remapOpenTabs(entry.relativePath, destPath, requestRoot);
      if (rootPath.value === requestRoot) await refresh();
    } catch (err) {
      if (rootPath.value !== requestRoot) return;
      const msg = (err as Error).message || "Failed to move";
      error.value = msg;
      await notifyOpError("Move failed", msg);
    }
  }

  function toggleSort(column: string): void {
    if (sortBy.value === column) {
      sortAsc.value = !sortAsc.value;
    } else {
      sortBy.value = column;
      sortAsc.value = true;
    }
  }

  function setFilter(text: string): void {
    filterText.value = text || "";
  }

  // -------------------- Tab-scoped diff viewer --------------------

  async function openDiff(
    entry: FileEntry | null,
    source?: "head" | "staged" | "commit" | "branch" | "tag",
    revisionRef?: string,
  ): Promise<void> {
    if (!_api || !entry || entry.kind !== "file") return;
    const requestRoot = rootPath.value;
    const selection = selectEntry(entry);
    // selectEntry registers/activates the tab synchronously before awaiting its preview.
    // Keep that identity so a workspace switch cannot redirect this request to a
    // same-named file in another root.
    const tab = editorTabs.value.find(
      (item) => item.rootPath === requestRoot && item.entry.relativePath === entry.relativePath,
    );
    if (!tab || !(await selection) || !hasOpenTab(tab)) return;

    const session = ++tab.diffSession;
    const defaultRun = ++tab.diffRun;
    tab.diffOpen = true;
    if (source !== undefined) tab.diffSource = source;
    if (revisionRef !== undefined) tab.diffRevisionRef = revisionRef;
    tab.diffPayload = null;
    tab.diffRefs = { branches: [], tags: [], commits: [], currentBranch: "" };
    tab.diffRefsLoading = true;
    tab.diffLoading = true;
    await loadDiffRefs(tab, session);
    if (!isCurrentDiffTab(tab, session, entry.relativePath) || tab.diffRun !== defaultRun) return;
    await runDiff(tab);
  }

  function isCurrentDiffTab(tab: EditorTab, session: number, relativePath: string): boolean {
    return hasOpenTab(tab) && tab.diffSession === session && tab.diffOpen && tab.entry.relativePath === relativePath;
  }

  async function loadDiffRefs(tab: EditorTab, session: number): Promise<void> {
    if (!_api) return;
    const relativePath = tab.entry.relativePath;
    tab.diffRefsLoading = true;
    try {
      const result = (await _api.fileGitRefs({
        rootPath: tab.rootPath,
        relativePath,
      })) as DiffRefs & { isRepo?: boolean };
      if (!isCurrentDiffTab(tab, session, relativePath)) return;
      tab.diffRefs = {
        branches: result.branches || [],
        tags: result.tags || [],
        commits: result.commits || [],
        currentBranch: result.currentBranch || "",
      };
    } catch {
      if (isCurrentDiffTab(tab, session, relativePath)) {
        tab.diffRefs = { branches: [], tags: [], commits: [], currentBranch: "" };
      }
    } finally {
      if (hasOpenTab(tab) && tab.diffSession === session) tab.diffRefsLoading = false;
    }
  }

  async function setDiffSource(
    source: "head" | "staged" | "commit" | "branch" | "tag",
    revisionRef = "",
  ): Promise<void> {
    const tab = activeEditorTab.value;
    if (!tab?.diffOpen) return;
    diffSource.value = source;
    diffRevisionRef.value = revisionRef;
    await runDiff(tab);
  }

  // Switch diff mode without fetching — used when the user opens a picker
  // (branch / tag / commit) but hasn't selected a specific ref yet.
  function selectDiffMode(source: "head" | "staged" | "commit" | "branch" | "tag"): void {
    const tab = activeEditorTab.value;
    if (!tab?.diffOpen) return;
    tab.diffRun += 1;
    diffSource.value = source;
    diffRevisionRef.value = "";
    diffPayload.value = null;
    diffLoading.value = false;
  }

  async function runDiff(tab = activeEditorTab.value): Promise<void> {
    if (!_api || !tab?.diffOpen) return;
    const session = tab.diffSession;
    const run = ++tab.diffRun;
    const relativePath = tab.entry.relativePath;
    const source = tab.diffSource;
    const revisionRef = tab.diffRevisionRef;
    tab.diffLoading = true;
    try {
      const payload = (await _api.fileGitDiff({
        rootPath: tab.rootPath,
        relativePath,
        source,
        revisionRef,
      })) as DiffPayload;
      if (isCurrentDiffTab(tab, session, relativePath) && run === tab.diffRun) tab.diffPayload = payload;
    } catch (err) {
      if (isCurrentDiffTab(tab, session, relativePath) && run === tab.diffRun) {
        tab.diffPayload = {
          ok: false,
          leftError: (err as Error)?.message || "Failed to compute diff",
          leftContent: "",
          rightContent: "",
          leftLabel: "",
          rightLabel: "",
          leftMissing: true,
          rightMissing: true,
          language: "plaintext",
          revision: revisionRef,
          source,
        };
      }
    } finally {
      if (hasOpenTab(tab) && session === tab.diffSession && run === tab.diffRun) tab.diffLoading = false;
    }
  }

  function closeDiff(): void {
    const tab = activeEditorTab.value;
    if (!tab) return;
    tab.diffSession += 1;
    tab.diffRun += 1;
    tab.diffOpen = false;
    tab.diffPayload = null;
    tab.diffLoading = false;
    tab.diffRefsLoading = false;
  }

  function closeDiffForPath(path: string, root = rootPath.value): void {
    for (const tab of tabsForRoot(root)) {
      if (tab.diffOpen && (tab.entry.relativePath === path || tab.entry.relativePath.startsWith(`${path}/`))) {
        tab.diffSession += 1;
        tab.diffRun += 1;
        tab.diffOpen = false;
        tab.diffPayload = null;
        tab.diffLoading = false;
        tab.diffRefsLoading = false;
      }
    }
  }

  return {
    rootPath,
    currentPath,
    entries,
    treeNodes,
    selectedEntry,
    preview,
    loading,
    error,
    editMode,
    editContent,
    editDirty,
    columnSelection,
    focusNextEditor,
    editorTabs,
    activeTabPath,
    viewMode,
    layoutMode,
    showHidden,
    sortBy,
    sortAsc,
    filterText,
    breadcrumbs,
    sortedEntries,
    gitStatusFiles,
    gitStatusDirectories,
    gitIsRepo,
    gitRoot,
    dirtyCount,
    diffOpen,
    diffEntry,
    diffSource,
    diffRevisionRef,
    diffPayload,
    diffLoading,
    diffRefs,
    diffRefsLoading,
    setApi,
    init,
    navigate,
    expandTreeNode,
    collapseTreeNode,
    selectEntry,
    activateTab,
    closeTab,
    closeUnmodifiedTabs,
    closeAllTabs,
    loadPreview,
    openFileAbsPath,
    createFile,
    createDirectory,
    renameEntry,
    deleteEntry,
    startEdit,
    saveEdit,
    discardEdit,
    clipboard,
    copyToClipboard,
    cutToClipboard,
    clearClipboard,
    pasteEntry,
    moveEntryTo,
    refresh,
    refreshGitStatus,
    openInExplorer,
    toggleSort,
    setFilter,
    getStatusFor,
    getDirectoryStatusFor,
    openDiff,
    setDiffSource,
    selectDiffMode,
    runDiff,
    closeDiff,
  };
});
