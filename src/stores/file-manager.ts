import { defineStore } from "pinia";
import { ref, computed, shallowRef } from "vue";
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

  // View preferences
  const viewMode = ref("list");
  const showHidden = ref(false);
  const sortBy = ref("name");
  const sortAsc = ref(true);
  const filterText = ref(""); // search/filter within current folder

  // Git status state
  const gitStatusFiles = shallowRef<Record<string, GitStatusEntry>>({}); // { relativePath: { status, stagedStatus, unstagedStatus } }
  const gitStatusDirectories = shallowRef<Record<string, string>>({}); // { relativePath: status }
  const gitIsRepo = ref(false);
  const gitRoot = ref("");

  // Diff modal state
  const diffOpen = ref(false);
  const diffEntry = ref<FileEntry | null>(null); // FileEntry currently being diffed
  const diffSource = ref<"head" | "staged" | "commit" | "branch" | "tag">("head");
  const diffRevisionRef = ref(""); // branch name / commit hash / tag
  const diffPayload = ref<DiffPayload | null>(null); // backend response
  const diffLoading = ref(false);
  const diffRefs = ref<DiffRefs>({ branches: [], tags: [], commits: [], currentBranch: "" });
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

  async function navigate(relativePath: string): Promise<void> {
    if (!_api) return;
    loading.value = true;
    error.value = null;
    filterText.value = "";
    try {
      const result = (await _api.fileList({ rootPath: rootPath.value, relativePath: relativePath || "" })) as {
        entries: FileEntry[];
        path: string;
      };
      entries.value = result.entries;
      currentPath.value = result.path || relativePath || "";
      selectedEntry.value = null;
      preview.value = null;
      editMode.value = false;
      // Keep dirty markers in sync with what the user just moved into.
      // Run in the background so navigation isn't blocked.
      refreshGitStatus().catch(() => {});
    } catch (err) {
      error.value = (err as Error).message || "Failed to list directory";
    } finally {
      loading.value = false;
    }
  }

  async function expandTreeNode(relativePath: string): Promise<void> {
    if (!_api) return;
    try {
      const result = (await _api.fileTree({ rootPath: rootPath.value, relativePath: relativePath || "" })) as {
        entries: FileEntry[];
      };
      let dirs = result.entries.filter((e) => e.kind === "directory");
      if (!showHidden.value) {
        dirs = dirs.filter((e) => !e.isHidden);
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

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

  async function selectEntry(entry: FileEntry): Promise<void> {
    selectedEntry.value = entry;
    editMode.value = false;
    if (entry.kind === "file") {
      await loadPreview(entry);
    } else {
      preview.value = null;
    }
  }

  async function loadPreview(entry: FileEntry | null): Promise<void> {
    if (!_api || !entry) return;
    try {
      preview.value = (await _api.filePreview({
        rootPath: rootPath.value,
        relativePath: entry.relativePath,
      })) as FilePreview;
    } catch (err) {
      preview.value = { kind: "error", content: (err as Error).message || "Failed to load preview" };
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

  async function createFile(name: string): Promise<void> {
    if (!_api) return;
    try {
      await _api.fileCreateFile({ rootPath: rootPath.value, parentPath: currentPath.value, name });
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || "Failed to create file";
      error.value = msg;
      await notifyOpError("Create file failed", msg);
    }
  }

  async function createDirectory(name: string): Promise<void> {
    if (!_api) return;
    try {
      await _api.fileCreateDir({ rootPath: rootPath.value, parentPath: currentPath.value, name });
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || "Failed to create directory";
      error.value = msg;
      await notifyOpError("Create folder failed", msg);
    }
  }

  async function renameEntry(entry: FileEntry, newName: string): Promise<void> {
    if (!_api) return;
    try {
      await _api.fileRename({ rootPath: rootPath.value, relativePath: entry.relativePath, newName });
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || "Failed to rename";
      error.value = msg;
      await notifyOpError("Rename failed", msg);
    }
  }

  async function deleteEntry(entry: FileEntry): Promise<void> {
    if (!_api) return;
    try {
      await _api.fileDelete({ rootPath: rootPath.value, relativePath: entry.relativePath });
      if (selectedEntry.value?.relativePath === entry.relativePath) {
        selectedEntry.value = null;
        preview.value = null;
      }
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || "Failed to delete";
      error.value = msg;
      await notifyOpError("Delete failed", msg);
    }
  }

  async function startEdit(): Promise<void> {
    if (!_api || !selectedEntry.value) return;
    try {
      const result = (await _api.fileRead({
        rootPath: rootPath.value,
        relativePath: selectedEntry.value.relativePath,
      })) as { content: string };
      editContent.value = result.content;
      editDirty.value = false;
      editMode.value = true;
    } catch (err) {
      error.value = (err as Error).message || "Failed to read file for editing";
    }
  }

  async function saveEdit(): Promise<void> {
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
      const msg = (err as Error).message || "Failed to save file";
      error.value = msg;
      await notifyOpError("Save failed", msg);
    }
  }

  function cancelEdit(): void {
    editMode.value = false;
    editContent.value = "";
    editDirty.value = false;
  }

  async function refresh(): Promise<void> {
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

  async function refreshGitStatus(): Promise<void> {
    if (!_api || !rootPath.value) return;
    try {
      const result = (await _api.fileGitStatus({ rootPath: rootPath.value })) as {
        isRepo: boolean;
        root?: string;
        entries?: Record<string, GitStatusEntry>;
        directories?: Record<string, string>;
      };
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
    const { entry, op } = clipboard.value;
    const destDir = targetDir || currentPath.value;
    const destPath = destDir ? `${destDir}/${entry.name}` : entry.name;
    try {
      if (op === "copy") {
        // Backend auto-renames on conflict (foo.txt → "foo (copy).txt"),
        // so this resolves to a new file even when pasting into the same
        // directory. refresh() below brings the new entry into view.
        await _api.fileCopy({ rootPath: rootPath.value, fromPath: entry.relativePath, toPath: destPath });
      } else {
        // Move refuses to overwrite — the backend throws "Destination already
        // exists" / "Source and destination are the same" so the cut+paste
        // doesn't silently obliterate the target file.
        await _api.fileMove({ rootPath: rootPath.value, fromPath: entry.relativePath, toPath: destPath });
        clipboard.value = null;
      }
      await refresh();
    } catch (err) {
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
  async function notifyOpError(title: string, msg: string): Promise<void> {
    try {
      const { useNotificationStore } = await import("./notifications.js");
      useNotificationStore().showError(title, msg, {
        profileId: await resolveOwningProfileId(),
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
  async function resolveOwningProfileId(): Promise<string> {
    const { useAppStore } = await import("./app.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appStore = useAppStore() as any;
    const viewerProfileId = (appStore.activeProfile?.id as string) || "default";
    const normalize = (p: string) =>
      String(p || "")
        .replace(/\\/g, "/")
        .replace(/\/+$/, "");
    const root = normalize(rootPath.value);
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
    try {
      await _api.fileMove({ rootPath: rootPath.value, fromPath: entry.relativePath, toPath: destPath });
      await refresh();
    } catch (err) {
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

  // -------------------- Diff modal --------------------

  async function openDiff(
    entry: FileEntry | null,
    source: "head" | "staged" | "commit" | "branch" | "tag" = "head",
    revisionRef = "",
  ): Promise<void> {
    if (!entry || entry.kind !== "file") return;
    diffEntry.value = entry;
    diffSource.value = source;
    diffRevisionRef.value = revisionRef;
    diffOpen.value = true;
    diffPayload.value = null;
    await loadDiffRefs(entry);
    await runDiff();
  }

  async function loadDiffRefs(entry: FileEntry | null): Promise<void> {
    if (!_api || !entry) return;
    diffRefsLoading.value = true;
    try {
      const result = (await _api.fileGitRefs({
        rootPath: rootPath.value,
        relativePath: entry.relativePath,
      })) as DiffRefs & { isRepo?: boolean };
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

  async function setDiffSource(
    source: "head" | "staged" | "commit" | "branch" | "tag",
    revisionRef = "",
  ): Promise<void> {
    diffSource.value = source;
    diffRevisionRef.value = revisionRef;
    await runDiff();
  }

  // Switch diff mode without fetching — used when the user opens a picker
  // (branch / tag / commit) but hasn't selected a specific ref yet.
  function selectDiffMode(source: "head" | "staged" | "commit" | "branch" | "tag"): void {
    diffSource.value = source;
    diffRevisionRef.value = "";
    diffPayload.value = null;
  }

  async function runDiff(): Promise<void> {
    if (!_api || !diffEntry.value) return;
    diffLoading.value = true;
    try {
      const payload = (await _api.fileGitDiff({
        rootPath: rootPath.value,
        relativePath: diffEntry.value.relativePath,
        source: diffSource.value,
        revisionRef: diffRevisionRef.value,
      })) as DiffPayload;
      diffPayload.value = payload;
    } catch (err) {
      diffPayload.value = {
        ok: false,
        leftError: (err as Error)?.message || "Failed to compute diff",
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

  function closeDiff(): void {
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
    openFileAbsPath,
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
