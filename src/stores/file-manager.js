import { defineStore } from "pinia";
import { ref, computed, shallowRef } from "vue";

export const useFileManagerStore = defineStore("fileManager", () => {
  let _api = null;
  function setApi(api) { _api = api; }

  // State
  const rootPath = ref("");
  const currentPath = ref("");
  const entries = shallowRef([]);
  const treeNodes = ref(new Map());
  const selectedEntry = ref(null);
  const preview = ref(null);
  const loading = ref(false);
  const error = ref(null);
  const clipboard = ref(null); // { entry, op: 'copy' } | null

  // Edit state
  const editMode = ref(false);
  const editContent = ref("");
  const editDirty = ref(false);

  // View preferences
  const viewMode = ref("list");
  const showHidden = ref(false);
  const sortBy = ref("name");
  const sortAsc = ref(true);

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
    items.sort((a, b) => {
      if (a.kind !== b.kind) {
        if (a.kind === "directory" && b.kind !== "directory") return -1;
        if (a.kind !== "directory" && b.kind === "directory") return 1;
      }
      let cmp = 0;
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

  // Actions
  async function init(root) {
    rootPath.value = root;
    currentPath.value = "";
    treeNodes.value = new Map();
    await navigate("");
    await expandTreeNode("");
  }

  async function navigate(relativePath) {
    if (!_api) return;
    loading.value = true;
    error.value = null;
    try {
      const result = await _api.fileList({ rootPath: rootPath.value, relativePath: relativePath || "" });
      entries.value = result.entries;
      currentPath.value = result.path || relativePath || "";
      selectedEntry.value = null;
      preview.value = null;
      editMode.value = false;
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
      next.set(relativePath, {
        entry: existing?.entry || { name: rootPath.value.split(/[/\\]/).pop() || "Root", relativePath: "", kind: "directory" },
        children: dirs.map((e) => {
          const prev = next.get(e.relativePath);
          return prev || { entry: e, children: null, expanded: false };
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
      await _api.fileWrite({ rootPath: rootPath.value, relativePath: selectedEntry.value.relativePath, content: editContent.value });
      editDirty.value = false;
      // Reload preview with new content
      await loadPreview(selectedEntry.value);
      editMode.value = false;
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
    // Re-expand current tree path
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

  function toggleSort(column) {
    if (sortBy.value === column) {
      sortAsc.value = !sortAsc.value;
    } else {
      sortBy.value = column;
      sortAsc.value = true;
    }
  }

  return {
    rootPath, currentPath, entries, treeNodes,
    selectedEntry, preview, loading, error,
    editMode, editContent, editDirty,
    viewMode, showHidden, sortBy, sortAsc,
    breadcrumbs, sortedEntries,
    setApi, init, navigate, expandTreeNode, collapseTreeNode,
    selectEntry, loadPreview,
    createFile, createDirectory, renameEntry, deleteEntry,
    startEdit, saveEdit, cancelEdit,
    clipboard, copyToClipboard, clearClipboard, pasteEntry,
    refresh, openInExplorer, toggleSort,
  };
});
