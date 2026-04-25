import { defineStore } from "pinia";
import { ref, computed, shallowRef } from "vue";

export const useFileManagerStore = defineStore("fileManager", () => {
  let _api = null;
  function setApi(api) {
    _api = api;
  }

  // State
  const rootPath = ref("");
  const currentPath = ref("");
  const entries = shallowRef([]);
  const treeNodes = ref(new Map());
  const selectedEntry = ref(null);
  const preview = ref(null);
  const loading = ref(false);
  const error = ref(null);
  const clipboard = ref(null); // { entry, op: 'copy' | 'cut' } | null

  // Edit state
  const editMode = ref(false);
  const editContent = ref("");
  const editDirty = ref(false);

  // View preferences
  const viewMode = ref("list");
  const showHidden = ref(false);
  const sortBy = ref("name");
  const sortAsc = ref(true);
  const filterText = ref(""); // search/filter within current folder

  // Git status state
  const gitStatusFiles = shallowRef({}); // { relativePath: { status, stagedStatus, unstagedStatus } }
  const gitStatusDirectories = shallowRef({}); // { relativePath: status }
  const gitIsRepo = ref(false);
  const gitRoot = ref("");

  // Diff modal state
  const diffOpen = ref(false);
  const diffEntry = ref(null); // FileEntry currently being diffed
  const diffSource = ref("head"); // "head" | "staged" | "branch" | "commit" | "tag"
  const diffRevisionRef = ref(""); // branch name / commit hash / tag
  const diffPayload = ref(null); // backend response
  const diffLoading = ref(false);
  const diffRefs = ref({ branches: [], tags: [], commits: [], currentBranch: "" });
  const diffRefsLoading = ref(false);

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
      let cmp;
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
  function getStatusFor(relativePath) {
    if (!relativePath) return null;
    return gitStatusFiles.value[relativePath] || null;
  }

  function getDirectoryStatusFor(relativePath) {
    if (!relativePath) return null;
    return gitStatusDirectories.value[relativePath] || null;
  }

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  async function init(root) {
    if (rootPath.value === root && entries.value.length > 0) return;
    rootPath.value = root;
    currentPath.value = "";
    treeNodes.value = new Map();
    selectedEntry.value = null;
    preview.value = null;
    editMode.value = false;
    filterText.value = "";
    await navigate("");
    await expandTreeNode("");
    await refreshGitStatus();
  }

  async function navigate(relativePath) {
    if (!_api) return;
    loading.value = true;
    error.value = null;
    filterText.value = "";
    try {
      const result = await _api.fileList({ rootPath: rootPath.value, relativePath: relativePath || "" });
      entries.value = result.entries;
      currentPath.value = result.path || relativePath || "";
      selectedEntry.value = null;
      preview.value = null;
      editMode.value = false;
      // Keep dirty markers in sync with what the user just moved into.
      // Run in the background so navigation isn't blocked.
      refreshGitStatus().catch(() => {});
    } catch (err) {
      error.value = err.message || "Failed to list directory";
    } finally {
      loading.value = false;
    }
  }

  async function expandTreeNode(relativePath) {
    if (!_api) return;
    try {
      const result = await _api.fileTree({ rootPath: rootPath.value, relativePath: relativePath || "" });
      const dirs = result.entries.filter((e) => e.kind === "directory");
      if (!showHidden.value) {
        dirs.splice(0, dirs.length, ...dirs.filter((e) => !e.isHidden));
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      const next = new Map(treeNodes.value);
      const existing = next.get(relativePath);
      const fallbackEntry = relativePath
        ? { name: relativePath.split("/").pop(), relativePath, kind: "directory" }
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
    } catch {
      // silently fail tree expansion
    }
  }

  function collapseTreeNode(relativePath) {
    const next = new Map(treeNodes.value);
    const node = next.get(relativePath);
    if (node) {
      next.set(relativePath, { ...node, expanded: false });
      treeNodes.value = next;
    }
  }

  async function selectEntry(entry) {
    selectedEntry.value = entry;
    editMode.value = false;
    if (entry.kind === "file") {
      await loadPreview(entry);
    } else {
      preview.value = null;
    }
  }

  async function loadPreview(entry) {
    if (!_api || !entry) return;
    try {
      preview.value = await _api.filePreview({ rootPath: rootPath.value, relativePath: entry.relativePath });
    } catch (err) {
      preview.value = { kind: "error", content: err.message || "Failed to load preview" };
    }
  }

  async function createFile(name) {
    if (!_api) return;
    try {
      await _api.fileCreateFile({ rootPath: rootPath.value, parentPath: currentPath.value, name });
      await refresh();
    } catch (err) {
      error.value = err.message || "Failed to create file";
    }
  }

  async function createDirectory(name) {
    if (!_api) return;
    try {
      await _api.fileCreateDir({ rootPath: rootPath.value, parentPath: currentPath.value, name });
      await refresh();
    } catch (err) {
      error.value = err.message || "Failed to create directory";
    }
  }

  async function renameEntry(entry, newName) {
    if (!_api) return;
    try {
      await _api.fileRename({ rootPath: rootPath.value, relativePath: entry.relativePath, newName });
      await refresh();
    } catch (err) {
      error.value = err.message || "Failed to rename";
    }
  }

  async function deleteEntry(entry) {
    if (!_api) return;
    try {
      await _api.fileDelete({ rootPath: rootPath.value, relativePath: entry.relativePath });
      if (selectedEntry.value?.relativePath === entry.relativePath) {
        selectedEntry.value = null;
        preview.value = null;
      }
      await refresh();
    } catch (err) {
      error.value = err.message || "Failed to delete";
    }
  }

  async function startEdit() {
    if (!_api || !selectedEntry.value) return;
    try {
      const result = await _api.fileRead({ rootPath: rootPath.value, relativePath: selectedEntry.value.relativePath });
      editContent.value = result.content;
      editDirty.value = false;
      editMode.value = true;
    } catch (err) {
      error.value = err.message || "Failed to read file for editing";
    }
  }

  async function saveEdit() {
    if (!_api || !selectedEntry.value) return;
    try {
      await _api.fileWrite({
        rootPath: rootPath.value,
        relativePath: selectedEntry.value.relativePath,
        content: editContent.value,
      });
      editDirty.value = false;
      await loadPreview(selectedEntry.value);
      editMode.value = false;
      // After saving, the file likely became dirty (or maybe became clean).
      await refreshGitStatus();
    } catch (err) {
      error.value = err.message || "Failed to save file";
    }
  }

  function cancelEdit() {
    editMode.value = false;
    editContent.value = "";
    editDirty.value = false;
  }

  async function refresh() {
    await navigate(currentPath.value);
    const parts = currentPath.value.split("/").filter(Boolean);
    let path = "";
    await expandTreeNode("");
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      const node = treeNodes.value.get(path);
      if (node?.expanded) {
        await expandTreeNode(path);
      }
    }
    await refreshGitStatus();
  }

  async function refreshGitStatus() {
    if (!_api || !rootPath.value) return;
    try {
      const result = await _api.fileGitStatus({ rootPath: rootPath.value });
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
      gitIsRepo.value = false;
      gitStatusFiles.value = {};
      gitStatusDirectories.value = {};
    }
  }

  async function openInExplorer(entry) {
    if (!_api) return;
    const absPath = rootPath.value.replace(/\\/g, "/") + "/" + (entry?.relativePath || currentPath.value);
    try {
      await _api.fileOpenInExplorer(absPath);
    } catch {
      // silently fail
    }
  }

  function copyToClipboard(entry) {
    clipboard.value = { entry, op: "copy" };
  }

  function cutToClipboard(entry) {
    clipboard.value = { entry, op: "cut" };
  }

  function clearClipboard() {
    clipboard.value = null;
  }

  async function pasteEntry(targetDir) {
    if (!_api || !clipboard.value) return;
    const { entry, op } = clipboard.value;
    const destDir = targetDir || currentPath.value;
    const destPath = destDir ? `${destDir}/${entry.name}` : entry.name;
    try {
      if (op === "copy") {
        await _api.fileCopy({ rootPath: rootPath.value, fromPath: entry.relativePath, toPath: destPath });
      } else {
        await _api.fileMove({ rootPath: rootPath.value, fromPath: entry.relativePath, toPath: destPath });
        clipboard.value = null;
      }
      await refresh();
    } catch (err) {
      error.value = err.message || "Failed to paste";
    }
  }

  /**
   * HTML5 drag-drop handler — moves an entry into a target directory.
   * targetDir = "" means the workspace root.
   */
  async function moveEntryTo(entry, targetDir) {
    if (!_api || !entry) return;
    const cleanTarget = (targetDir || "").replace(/^\/+|\/+$/g, "");
    // Don't move into self or own subtree
    if (entry.relativePath === cleanTarget) return;
    if (cleanTarget && cleanTarget.startsWith(entry.relativePath + "/")) return;
    const destPath = cleanTarget ? `${cleanTarget}/${entry.name}` : entry.name;
    if (destPath === entry.relativePath) return;
    try {
      await _api.fileMove({ rootPath: rootPath.value, fromPath: entry.relativePath, toPath: destPath });
      await refresh();
    } catch (err) {
      error.value = err.message || "Failed to move";
    }
  }

  function toggleSort(column) {
    if (sortBy.value === column) {
      sortAsc.value = !sortAsc.value;
    } else {
      sortBy.value = column;
      sortAsc.value = true;
    }
  }

  function setFilter(text) {
    filterText.value = text || "";
  }

  // -------------------- Diff modal --------------------

  async function openDiff(entry, source = "head", revisionRef = "") {
    if (!entry || entry.kind !== "file") return;
    diffEntry.value = entry;
    diffSource.value = source;
    diffRevisionRef.value = revisionRef;
    diffOpen.value = true;
    diffPayload.value = null;
    await loadDiffRefs(entry);
    await runDiff();
  }

  async function loadDiffRefs(entry) {
    if (!_api || !entry) return;
    diffRefsLoading.value = true;
    try {
      const result = await _api.fileGitRefs({
        rootPath: rootPath.value,
        relativePath: entry.relativePath,
      });
      diffRefs.value = {
        branches: result.branches || [],
        tags: result.tags || [],
        commits: result.commits || [],
        currentBranch: result.currentBranch || "",
      };
    } catch {
      diffRefs.value = { branches: [], tags: [], commits: [], currentBranch: "" };
    } finally {
      diffRefsLoading.value = false;
    }
  }

  async function setDiffSource(source, revisionRef = "") {
    diffSource.value = source;
    diffRevisionRef.value = revisionRef;
    await runDiff();
  }

  // Switch diff mode without fetching — used when the user opens a picker
  // (branch / tag / commit) but hasn't selected a specific ref yet.
  function selectDiffMode(source) {
    diffSource.value = source;
    diffRevisionRef.value = "";
    diffPayload.value = null;
  }

  async function runDiff() {
    if (!_api || !diffEntry.value) return;
    diffLoading.value = true;
    try {
      const payload = await _api.fileGitDiff({
        rootPath: rootPath.value,
        relativePath: diffEntry.value.relativePath,
        source: diffSource.value,
        revisionRef: diffRevisionRef.value,
      });
      diffPayload.value = payload;
    } catch (err) {
      diffPayload.value = {
        ok: false,
        leftError: err?.message || "Failed to compute diff",
        leftContent: "",
        rightContent: "",
        leftLabel: "",
        rightLabel: "",
        leftMissing: true,
        rightMissing: true,
        language: "plaintext",
        revision: diffRevisionRef.value,
        source: diffSource.value,
      };
    } finally {
      diffLoading.value = false;
    }
  }

  function closeDiff() {
    diffOpen.value = false;
    diffEntry.value = null;
    diffPayload.value = null;
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
    viewMode,
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
    loadPreview,
    createFile,
    createDirectory,
    renameEntry,
    deleteEntry,
    startEdit,
    saveEdit,
    cancelEdit,
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
