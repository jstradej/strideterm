import { defineStore } from "pinia";
import { ref } from "vue";

// Frontend mirror of the backend StashEntry / StashFile shapes. Kept local so
// the renderer doesn't import backend runtime modules.
export interface StashEntry {
  index: number;
  ref: string;
  // Full SHA of the stash commit. Optional because older backends / canned
  // fixtures may omit it; the stash-reshuffle preflight is a no-op when absent.
  hash?: string;
  date: string;
  author: string;
  branch: string;
  baseCommit: string;
  baseSubject: string;
  message: string;
  customMessage: string;
  isWipDefault: boolean;
  fileCount: number;
  // Repo-relative paths the stash touches, returned eagerly so the filter can
  // match file paths before the per-stash file list is hydrated.
  filePaths?: string[];
}

export interface StashFile {
  path: string;
  code: string;
  status: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  oldPath?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiffPayload = Record<string, any>;

export type StashBusyAction = "" | "apply" | "pop" | "drop" | "branch" | "create" | "export" | "import";

interface WorkspaceStashState {
  entries: StashEntry[];
  loadedAt: number;
  filesByRef: Record<string, StashFile[]>;
  selectedRef: string;
  selectedFile: string;
  diffByRefAndPath: Record<string, DiffPayload>;
  busyRef: string;
  busyAction: StashBusyAction;
  loading: boolean;
  filter: string;
  includeUntrackedNext: boolean;
}

function emptyState(): WorkspaceStashState {
  return {
    entries: [],
    loadedAt: 0,
    filesByRef: {},
    selectedRef: "",
    selectedFile: "",
    diffByRefAndPath: {},
    busyRef: "",
    busyAction: "",
    loading: false,
    filter: "",
    includeUntrackedNext: true,
  };
}

export const useGitStashStore = defineStore("git-stash", () => {
  const byWorkspace = ref<Record<string, WorkspaceStashState>>({});

  function ensure(workspaceId: string): WorkspaceStashState {
    if (!byWorkspace.value[workspaceId]) {
      // "Include untracked" starts ON every session — a "Stash all" should clear
      // the whole working tree, new files included. Unchecking it applies only
      // to the current session and is not persisted, so an accidental opt-out
      // can't silently leave untracked files behind after a restart.
      byWorkspace.value = { ...byWorkspace.value, [workspaceId]: emptyState() };
    }
    return byWorkspace.value[workspaceId];
  }

  function get(workspaceId: string): WorkspaceStashState {
    return byWorkspace.value[workspaceId] || emptyState();
  }

  function cleanup(workspaceId: string): void {
    const next = { ...byWorkspace.value };
    delete next[workspaceId];
    byWorkspace.value = next;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function api(): Promise<any> {
    const { useAppStore } = await import("./app.js");
    return useAppStore().getApi();
  }

  async function activeRoot(workspaceId: string): Promise<string> {
    const { useGitUiStore } = await import("./git-ui.js");
    return useGitUiStore().getActiveRoot(workspaceId) || "";
  }

  async function toast(title: string, body: string, kind: "info" | "error" = "info"): Promise<void> {
    const { useNotificationStore } = await import("./notifications.js");
    useNotificationStore().pushEphemeralToast({ title, body, kind, durationMs: 4000 });
  }

  async function refreshSnapshot(workspaceId: string): Promise<void> {
    const { useGitUiStore } = await import("./git-ui.js");
    await useGitUiStore().refreshGit(workspaceId);
  }

  // Guard against acting on a stale `stash@{N}`: the stack can be reshuffled out
  // of band (e.g. a `git stash drop` from a terminal), after which the cached
  // ref points at a different commit. Refresh the list and confirm the targeted
  // entry's SHA still matches the cached one before any apply/pop/drop/branch/
  // export; abort with a refresh otherwise. No-op when the ref has no cached
  // SHA (older backend / fixture) — nothing to compare against.
  async function preflightRefUnchanged(workspaceId: string, ref: string): Promise<boolean> {
    if (!ref) return true;
    const st = ensure(workspaceId);
    const cachedHash = st.entries.find((e) => e.ref === ref)?.hash || "";
    if (!cachedHash) return true;
    await loadStashes(workspaceId);
    const current = st.entries.find((e) => e.ref === ref);
    if (!current || current.hash !== cachedHash) {
      await toast("Stashes", "Stash list changed — refreshing.", "error");
      return false;
    }
    return true;
  }

  async function loadStashes(workspaceId: string): Promise<void> {
    const st = ensure(workspaceId);
    st.loading = true;
    try {
      const rootPath = await activeRoot(workspaceId);
      const client = await api();
      if (!client) return;
      const res = (await client.gitListStashes({ workspaceId, rootPath })) as {
        ok?: boolean;
        stashes?: StashEntry[];
      };
      st.entries = Array.isArray(res?.stashes) ? res.stashes : [];
      st.loadedAt = Date.now();
      // Keep selection valid: prefer the same logical ref, else fall back to the
      // first entry. After a drop the indices shift, so an old ref may vanish.
      if (!st.entries.some((e) => e.ref === st.selectedRef)) {
        st.selectedRef = st.entries[0]?.ref || "";
        st.selectedFile = "";
      }
    } catch (error) {
      await toast("Stashes", (error as Error)?.message || "Failed to load stashes.", "error");
    } finally {
      st.loading = false;
    }
  }

  async function loadFiles(workspaceId: string, ref: string): Promise<void> {
    if (!ref) return;
    const st = ensure(workspaceId);
    try {
      const rootPath = await activeRoot(workspaceId);
      const client = await api();
      if (!client) return;
      const res = (await client.gitStashFiles({ workspaceId, rootPath, ref })) as { files?: StashFile[] };
      st.filesByRef = { ...st.filesByRef, [ref]: Array.isArray(res?.files) ? res.files : [] };
    } catch (error) {
      await toast("Stashes", (error as Error)?.message || "Failed to load stash files.", "error");
    }
  }

  async function loadDiff(workspaceId: string, ref: string, path: string): Promise<void> {
    if (!ref || !path) return;
    const st = ensure(workspaceId);
    const key = `${ref}::${path}`;
    if (st.diffByRefAndPath[key]) return; // cached
    try {
      const rootPath = await activeRoot(workspaceId);
      const client = await api();
      if (!client) return;
      const payload = (await client.gitStashFileDiff({
        workspaceId,
        rootPath,
        ref,
        relativePath: path,
      })) as DiffPayload;
      st.diffByRefAndPath = { ...st.diffByRefAndPath, [key]: payload };
    } catch (error) {
      await toast("Stashes", (error as Error)?.message || "Failed to load stash diff.", "error");
    }
  }

  function setFilter(workspaceId: string, text: string): void {
    ensure(workspaceId).filter = text || "";
  }

  function setSelected(workspaceId: string, ref: string, file?: string): void {
    const st = ensure(workspaceId);
    st.selectedRef = ref;
    if (file !== undefined) st.selectedFile = file;
    else st.selectedFile = "";
  }

  function setIncludeUntrackedNext(workspaceId: string, value: boolean): void {
    ensure(workspaceId).includeUntrackedNext = value;
  }

  // Shared mutation wrapper: tracks busy state, surfaces a toast, then refreshes
  // both the stash list and the git snapshot so counts stay in sync.
  async function runStashAction(
    workspaceId: string,
    ref: string,
    action: StashBusyAction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runner: () => Promise<any>,
  ): Promise<boolean> {
    const st = ensure(workspaceId);
    st.busyRef = ref;
    st.busyAction = action;
    try {
      if (!(await preflightRefUnchanged(workspaceId, ref))) return false;
      const response = await runner();
      const result = response?.result ?? response;
      const ok = result?.ok !== false;
      // An unborn-HEAD stash is handled by the caller with an inline "create
      // initial commit" prompt — skip the error toast so the user isn't shown
      // both a red toast and the prompt.
      if (!result?.needsInitialCommit) {
        await toast("Stashes", String(result?.summary || (ok ? "Done." : "Action failed.")), ok ? "info" : "error");
      }
      // Diffs may be stale after a mutation — clear the cache for safety.
      st.diffByRefAndPath = {};
      st.filesByRef = {};
      await loadStashes(workspaceId);
      await refreshSnapshot(workspaceId);
      return ok;
    } catch (error) {
      await toast("Stashes", (error as Error)?.message || "Stash action failed.", "error");
      return false;
    } finally {
      st.busyRef = "";
      st.busyAction = "";
    }
  }

  async function createStash(
    workspaceId: string,
    {
      message,
      includeUntracked,
      paths,
      allowEmptyInitialCommit,
    }: { message: string; includeUntracked: boolean; paths?: string[]; allowEmptyInitialCommit?: boolean },
  ): Promise<{ ok: boolean; needsInitialCommit: boolean }> {
    // Captured from inside the runner so the caller can offer a one-click
    // "create initial commit & stash" prompt when the repo has no commits yet.
    let needsInitialCommit = false;
    const ok = await runStashAction(workspaceId, "", "create", async () => {
      const rootPath = await activeRoot(workspaceId);
      // Omit `paths` entirely for a whole-tree stash so the backend takes its
      // default branch; pass the subset only when the caller picked files.
      const payload: Record<string, unknown> = { workspaceId, rootPath, message: message || "", includeUntracked };
      if (paths && paths.length) payload.paths = paths;
      if (allowEmptyInitialCommit) payload.allowEmptyInitialCommit = true;
      const response = await (await api()).gitStash(payload);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (response as any)?.result ?? response;
      if (result?.needsInitialCommit) needsInitialCommit = true;
      return response;
    });
    return { ok, needsInitialCommit };
  }

  async function apply(workspaceId: string, ref: string): Promise<boolean> {
    return runStashAction(workspaceId, ref, "apply", async () => {
      const rootPath = await activeRoot(workspaceId);
      return (await api()).gitStashApply({ workspaceId, rootPath, ref });
    });
  }

  async function pop(workspaceId: string, ref: string): Promise<boolean> {
    return runStashAction(workspaceId, ref, "pop", async () => {
      const rootPath = await activeRoot(workspaceId);
      return (await api()).gitStashPop({ workspaceId, rootPath, ref });
    });
  }

  async function drop(workspaceId: string, ref: string): Promise<boolean> {
    return runStashAction(workspaceId, ref, "drop", async () => {
      const rootPath = await activeRoot(workspaceId);
      return (await api()).gitStashDrop({ workspaceId, rootPath, ref });
    });
  }

  async function branchFrom(
    workspaceId: string,
    ref: string,
    branchName: string,
    switchImmediately: boolean,
  ): Promise<boolean> {
    return runStashAction(workspaceId, ref, "branch", async () => {
      const rootPath = await activeRoot(workspaceId);
      return (await api()).gitStashBranch({ workspaceId, rootPath, ref, branchName, switchImmediately });
    });
  }

  async function exportPatch(
    workspaceId: string,
    ref: string,
  ): Promise<{ ok: boolean; patch: string; suggestedFilename: string }> {
    const st = ensure(workspaceId);
    st.busyRef = ref;
    st.busyAction = "export";
    try {
      if (!(await preflightRefUnchanged(workspaceId, ref))) {
        return { ok: false, patch: "", suggestedFilename: "" };
      }
      const rootPath = await activeRoot(workspaceId);
      const res = (await (await api()).gitStashExport({ workspaceId, rootPath, ref })) as {
        ok?: boolean;
        patch?: string;
        suggestedFilename?: string;
        summary?: string;
      };
      if (res?.ok === false) await toast("Stashes", String(res?.summary || "Export failed."), "error");
      return { ok: res?.ok !== false, patch: res?.patch || "", suggestedFilename: res?.suggestedFilename || "" };
    } finally {
      st.busyRef = "";
      st.busyAction = "";
    }
  }

  async function importPatch(workspaceId: string, patch: string, message?: string): Promise<boolean> {
    return runStashAction(workspaceId, "", "import", async () => {
      const rootPath = await activeRoot(workspaceId);
      return (await api()).gitStashImport({ workspaceId, rootPath, patch, message });
    });
  }

  return {
    byWorkspace,
    get,
    ensure,
    cleanup,
    loadStashes,
    loadFiles,
    loadDiff,
    setFilter,
    setSelected,
    setIncludeUntrackedNext,
    createStash,
    apply,
    pop,
    drop,
    branchFrom,
    exportPatch,
    importPatch,
  };
});
