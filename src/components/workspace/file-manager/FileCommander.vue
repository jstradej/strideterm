<template>
  <div ref="root" class="fc" tabindex="-1" @keydown="onKeydown" @mousedown="onRootMouseDown">
    <nav v-if="narrow" class="fc__switch" aria-label="Commander panels">
      <button
        type="button"
        :aria-pressed="!narrowShowsView && activeIndex === 0"
        :class="{ 'fc__switch--active': !narrowShowsView && activeIndex === 0 }"
        @click="showPanel(0)"
      >
        Left
      </button>
      <button
        type="button"
        :aria-pressed="!narrowShowsView && activeIndex === 1"
        :class="{ 'fc__switch--active': !narrowShowsView && activeIndex === 1 }"
        @click="showPanel(1)"
      >
        Right
      </button>
      <button
        v-if="quickViewOpen || editorOpen || compareOpen || terminalShown"
        type="button"
        :aria-pressed="narrowShowsView"
        :class="{ 'fc__switch--active': narrowShowsView }"
        @click="narrowShowsView = true"
      >
        {{ editorOpen ? "Edit" : compareOpen ? "Compare" : quickViewOpen ? "View" : "Terminal" }}
      </button>
    </nav>
    <div class="fc__main">
      <Splitpanes v-if="!narrow" class="default-theme fm-splitpanes">
        <Pane v-for="index in sides" :key="index" :size="50" :min-size="15">
          <FileCommanderEditor
            v-if="editorOpen && activeIndex !== index"
            :can-pop-out="canPopOut"
            @close="closeEditorAndFocus"
            @pop-out="popOutEditor"
          />
          <FileCommanderQuickView
            v-else-if="quickViewOpen && activeIndex !== index"
            :view="quickView"
            @close="closeQuickView"
          />
          <FileCommanderCompare
            v-else-if="compareOpen && activeIndex !== index"
            :view="compareView"
            @close="closeCompare"
          />
          <FileCommanderTerminal
            v-else-if="terminalShown && activeIndex !== index"
            v-bind="terminalProps"
            @select="selectHosted"
            @close="closeHostedTerminal"
            @move-to-tab="moveHostedToTab"
            @focusin="onTerminalFocusIn"
          />
          <FileCommanderPanel
            v-else
            :ref="(el) => setPanelRef(index, el)"
            v-bind="panelProps(index)"
            v-on="panelListeners(index)"
          />
        </Pane>
      </Splitpanes>
      <div v-else class="fc__single">
        <FileCommanderEditor
          v-if="editorOpen && narrowShowsView"
          :can-pop-out="canPopOut"
          @close="closeEditorAndFocus"
          @pop-out="popOutEditor"
        />
        <FileCommanderQuickView
          v-else-if="quickViewOpen && narrowShowsView"
          :view="quickView"
          @close="closeQuickView"
        />
        <FileCommanderCompare v-else-if="compareOpen && narrowShowsView" :view="compareView" @close="closeCompare" />
        <FileCommanderTerminal
          v-else-if="terminalShown && narrowShowsView"
          v-bind="terminalProps"
          @select="selectHosted"
          @close="closeHostedTerminal"
          @move-to-tab="moveHostedToTab"
          @focusin="onTerminalFocusIn"
        />
        <FileCommanderPanel
          v-else
          :ref="(el) => setPanelRef(activeIndex, el)"
          v-bind="panelProps(activeIndex)"
          v-on="panelListeners(activeIndex)"
        />
      </div>
    </div>
    <div v-if="!narrowTerminalOnly" class="fc__fkeys">
      <button type="button" class="fc__fkey" :disabled="!cursorEntry" @click="renameCursor">
        <span class="fc__fkey-num">F2</span><span class="fc__fkey-label">Rename</span>
      </button>
      <button type="button" class="fc__fkey" :aria-pressed="quickViewOpen" @click="toggleQuickView">
        <span class="fc__fkey-num">F3</span><span class="fc__fkey-label">View</span>
      </button>
      <button
        type="button"
        class="fc__fkey"
        :aria-pressed="editorOpen"
        :disabled="!editorOpen && cursorEntry?.kind !== 'file'"
        @click="toggleEditor"
      >
        <span class="fc__fkey-num">F4</span><span class="fc__fkey-label">Edit</span>
      </button>
      <button type="button" class="fc__fkey" :disabled="!transferable" @click="transferSelected('copy')">
        <span class="fc__fkey-num">F5</span><span class="fc__fkey-label">Copy</span>
      </button>
      <button type="button" class="fc__fkey" :disabled="!transferable" @click="transferSelected('move')">
        <span class="fc__fkey-num">F6</span><span class="fc__fkey-label">Move</span>
      </button>
      <button type="button" class="fc__fkey" @click="createFolder">
        <span class="fc__fkey-num">F7</span>
        <span class="fc__fkey-label fc__fkey-label--long">New folder</span>
        <span class="fc__fkey-label fc__fkey-label--short">MkDir</span>
      </button>
      <button type="button" class="fc__fkey" :disabled="!cursorEntry" @click="deleteCursor">
        <span class="fc__fkey-num">F8</span><span class="fc__fkey-label">Delete</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import { useAppStore } from "../../../stores/app.js";
import { useTerminalStore } from "../../../stores/terminal.js";
import { findHostedPanels } from "../../../app/selectors.js";
import { filesOwnerWorkspaceIdKey } from "../../../types/keys.js";
import { agentTemplatesForPlatform, shellTemplatesForPlatform, type TabTemplate } from "../../../app/tab-templates.js";
import type { WorkspaceState } from "../../../../electron/shared/types/state.js";
import { rlog } from "../../../lib/renderer-log.js";
import FileCommanderPanel from "./FileCommanderPanel.vue";
import FileCommanderQuickView from "./FileCommanderQuickView.vue";
import FileCommanderEditor from "./FileCommanderEditor.vue";
import FileCommanderCompare from "./FileCommanderCompare.vue";
import FileCommanderTerminal from "./FileCommanderTerminal.vue";
import { guessLanguageFromPath } from "./language-map.js";
import {
  buildRows,
  commanderMarksFor,
  commanderRootMemory as rootMemory,
  HISTORY_LIMIT,
  parentPath,
  recallHostedSelection,
  rememberCommanderRoot,
  rememberHostedSelection,
  searchRowIndex,
  type CommanderEntry,
  type CommanderRow,
  type CommanderSortKey,
  type CompareViewState,
  type QuickViewState,
} from "./commander-helpers.js";

interface PanelState {
  path: string;
  entries: CommanderEntry[];
  cursor: number;
  marked: Set<string>;
  sortBy: CommanderSortKey;
  sortAsc: boolean;
  loading: boolean;
  error: string;
  loadToken: number;
  history: string[];
  historyIndex: number;
}

const QUICK_VIEW_MAX_CHARS = 200_000;
const QUICK_VIEW_DELAY_MS = 150;
const SEARCH_TIMEOUT_MS = 1500;
const sides = [0, 1];

const AGENT_STORAGE_KEY = "strideterm-commander-agent";
const SHELL_STORAGE_KEY = "strideterm-commander-shell";

const props = defineProps<{ narrow?: boolean; hostViewId?: string }>();

const store = useFileManagerStore();
const appStore = useAppStore();
const termStore = useTerminalStore();
const fmContextMenu = inject<((event: MouseEvent, entry: CommanderEntry) => void) | null>("fm-context-menu", null);
const fmRename = inject<((entry: CommanderEntry) => void) | null>("fm-rename", null);
const fmDelete = inject<((entry: CommanderEntry) => void) | null>("fm-delete", null);
const fmCreateDir = inject<(() => void) | null>("fm-create-dir", null);

const root = ref<HTMLElement | null>(null);

function newPanel(path = ""): PanelState {
  return {
    path,
    entries: [],
    cursor: 0,
    marked: new Set(),
    sortBy: "name",
    sortAsc: true,
    loading: false,
    error: "",
    loadToken: 0,
    history: [path],
    historyIndex: 0,
  };
}

const panels = ref<PanelState[]>([newPanel(), newPanel()]);
const activeIndex = ref<0 | 1>(0);
const narrowShowsView = ref(false);
const quickViewOpen = ref(false);
const quickView = ref<QuickViewState>({ status: "none", name: "" });
const compareOpen = ref(false);
const compareView = ref<CompareViewState>({ status: "loading", title: "" });
let compareToken = 0;
const searchText = ref("");
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const editorOpen = ref(false);
let editorCreatedTab: string | null = null;
const panelRefs: ({ pageSize: () => number } | null)[] = [null, null];
const terminalOpen = ref(true);
const terminalWantsFocus = ref(false);
const lastAgentKey = ref(readStored(AGENT_STORAGE_KEY));
const lastShellKey = ref(readStored(SHELL_STORAGE_KEY));

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // remembering the choice is a convenience
  }
}

const injectedOwnerId = inject(filesOwnerWorkspaceIdKey, null);
const ownerWorkspace = computed<WorkspaceState | null>(() => {
  const ownerId = injectedOwnerId?.value;
  if (ownerId) {
    const workspaces = (appStore.payload?.appState?.workspaces ?? []) as WorkspaceState[];
    return workspaces.find((candidate) => candidate.id === ownerId) ?? null;
  }
  const container = appStore.payload?.workspace as unknown as {
    workspace?: WorkspaceState;
    project?: WorkspaceState;
  } | null;
  return container?.workspace ?? container?.project ?? null;
});
const ownerIsActive = computed(() => !injectedOwnerId?.value || injectedOwnerId.value === appStore.myActiveWorkspaceId);
const hostedPanels = computed(() => {
  const workspace = ownerWorkspace.value;
  return workspace && props.hostViewId ? findHostedPanels(workspace.panels, props.hostViewId) : [];
});
const selectedHostedId = ref(props.hostViewId ? recallHostedSelection(props.hostViewId) : "");
const hostedPanel = computed(() => {
  const workspace = ownerWorkspace.value;
  const list = hostedPanels.value;
  const panel = list.find((p) => p.id === selectedHostedId.value) ?? list[list.length - 1];
  return workspace && panel ? { workspaceId: workspace.id, panel } : null;
});

function selectHostedPanel(panelId: string) {
  selectedHostedId.value = panelId;
  if (props.hostViewId) rememberHostedSelection(props.hostViewId, panelId);
}

watch(hostedPanels, (list, previous) => {
  if (!list.length || list.some((p) => p.id === selectedHostedId.value)) return;
  const index = previous.findIndex((p) => p.id === selectedHostedId.value);
  selectHostedPanel(list[Math.min(Math.max(index, 0), list.length - 1)].id);
});
const terminalShown = computed(() => !!hostedPanel.value && terminalOpen.value);
const narrowTerminalOnly = computed(
  () =>
    props.narrow &&
    narrowShowsView.value &&
    terminalShown.value &&
    !editorOpen.value &&
    !quickViewOpen.value &&
    !compareOpen.value,
);
const terminalSessionId = computed(() =>
  hostedPanel.value ? `${hostedPanel.value.workspaceId}:${hostedPanel.value.panel.id}` : "",
);
const terminalProps = computed(() => ({
  sessionId: terminalSessionId.value,
  selectedId: hostedPanel.value?.panel.id ?? "",
  tabs: hostedPanels.value.map((p) => ({ id: p.id, title: p.title || "Terminal", cwd: p.cwd || "" })),
}));

function launchItems(templates: TabTemplate[]) {
  return templates.map((tmpl) => {
    const name = tmpl.title || tmpl.command || "Shell";
    return { key: name, icon: tmpl.icon || "", label: name, command: tmpl.command || "" };
  });
}

const platform = computed(() => appStore.payload?.meta?.platform || "");
const agents = computed(() =>
  launchItems(agentTemplatesForPlatform(appStore.payload?.appState?.tabTemplates, platform.value)),
);
const shells = computed(() =>
  launchItems(shellTemplatesForPlatform(appStore.payload?.appState?.tabTemplates, platform.value)),
);

const rootName = computed(() => store.rootPath.split(/[\\/]/).filter(Boolean).pop() || "root");

function rowsOf(panel: PanelState, isActive: boolean): CommanderRow[] {
  return buildRows(panel.entries, {
    path: panel.path,
    showHidden: store.showHidden,
    filter: isActive ? store.filterText : "",
    sortBy: panel.sortBy,
    sortAsc: panel.sortAsc,
  });
}

const rowsByPanel = computed(() => panels.value.map((panel, index) => rowsOf(panel, index === activeIndex.value)));

function cursorOf(index: number): number {
  const rows = rowsByPanel.value[index] || [];
  return Math.min(Math.max(panels.value[index]?.cursor ?? 0, 0), Math.max(rows.length - 1, 0));
}

const cursorRow = computed<CommanderRow | null>(
  () => rowsByPanel.value[activeIndex.value]?.[cursorOf(activeIndex.value)] ?? null,
);
const cursorEntry = computed(() => cursorRow.value?.entry ?? null);

function remember(rootPath = store.rootPath) {
  if (!rootPath) return;
  const cursorKey = (index: number) => rowsByPanel.value[index]?.[cursorOf(index)]?.key ?? null;
  rememberCommanderRoot(rootPath, {
    paths: [panels.value[0].path, panels.value[1].path],
    cursors: [cursorKey(0), cursorKey(1)],
    active: activeIndex.value,
  });
}

async function load(panel: PanelState, focus?: string | null, fallbackToRoot = false) {
  const token = ++panel.loadToken;
  const requestRoot = store.rootPath;
  const isActive = panels.value[activeIndex.value] === panel;
  const keepKey = focus === undefined ? rowsOf(panel, isActive)[panel.cursor]?.key : null;
  panel.loading = true;
  panel.error = "";
  try {
    const result = await store.listDirectory(panel.path);
    if (token !== panel.loadToken || requestRoot !== store.rootPath) return;
    panel.entries = result.entries as CommanderEntry[];
    const rows = rowsOf(panel, panels.value[activeIndex.value] === panel);
    const wanted = focus ?? keepKey;
    const found = wanted ? rows.findIndex((row) => row.key === wanted) : -1;
    if (found >= 0) panel.cursor = found;
    else if (focus !== undefined) panel.cursor = 0;
    const keys = new Set(rows.map((row) => row.key));
    for (const key of [...panel.marked]) if (!keys.has(key)) panel.marked.delete(key);
  } catch (err) {
    if (token !== panel.loadToken || requestRoot !== store.rootPath) return;
    if (fallbackToRoot && panel.path) {
      rlog("info", "file-commander: restored folder is gone, using the root", { path: panel.path });
      panel.path = "";
      panel.history = [""];
      panel.historyIndex = 0;
      panel.marked = commanderMarksFor(requestRoot, panels.value.indexOf(panel), "", true);
      panel.loading = false;
      remember();
      return load(panel, null);
    }
    panel.entries = [];
    panel.error = (err as Error)?.message || "Failed to list directory";
    rlog("warn", "file-commander: listing failed", { path: panel.path, err: panel.error });
  } finally {
    if (token === panel.loadToken) panel.loading = false;
  }
}

function go(index: number, path: string, focus: string | null = null, record = true) {
  const panel = panels.value[index];
  endSearch();
  if (record && path !== panel.path) {
    panel.history = [...panel.history.slice(0, panel.historyIndex + 1), path].slice(-HISTORY_LIMIT);
    panel.historyIndex = panel.history.length - 1;
  }
  panel.path = path;
  // Keys pressed before the new listing arrives must not act on the previous folder's entries (F8 would delete one).
  panel.entries = [];
  panel.marked = commanderMarksFor(store.rootPath, index, path, true);
  panel.cursor = 0;
  remember();
  return load(panel, focus);
}

function goUp(index: number) {
  const panel = panels.value[index];
  if (!panel.path) return;
  void go(index, parentPath(panel.path), panel.path);
}

function stepHistory(index: number, delta: -1 | 1) {
  const panel = panels.value[index];
  const next = panel.historyIndex + delta;
  if (next < 0 || next >= panel.history.length) return;
  const from = panel.path;
  panel.historyIndex = next;
  const target = panel.history[next];
  void go(index, target, delta < 0 && parentPath(from) === target ? from : null, false);
}

function endSearch() {
  searchText.value = "";
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
}

function armSearchTimer() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(endSearch, SEARCH_TIMEOUT_MS);
}

function searchTo(prefix: string) {
  const found = searchRowIndex(rowsByPanel.value[activeIndex.value], prefix);
  if (found < 0) return;
  searchText.value = prefix;
  moveCursor(found);
}

function setActive(index: 0 | 1) {
  narrowShowsView.value = false;
  if (activeIndex.value === index) return;
  endSearch();
  activeIndex.value = index;
  remember();
}

function showPanel(index: 0 | 1) {
  setActive(index);
  narrowShowsView.value = false;
}

watch(
  () => store.rootPath,
  (path, previous) => {
    if (previous) remember(previous);
    if (!path) return;
    const saved = rootMemory.get(path);
    panels.value = [newPanel(saved?.paths[0] ?? ""), newPanel(saved?.paths[1] ?? "")];
    panels.value.forEach((panel, index) => (panel.marked = commanderMarksFor(path, index, panel.path)));
    activeIndex.value = saved?.active ?? 0;
    panels.value.forEach((panel, index) => void load(panel, saved?.cursors[index] ?? null, true));
  },
  { immediate: true },
);

watch(
  () => store.listingRevision,
  () => {
    for (const panel of panels.value) void load(panel);
  },
);

function whenStoreIdle(): Promise<void> {
  if (!store.loading) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(
      () => store.loading,
      (busy) => {
        if (busy) return;
        stop();
        resolve();
      },
    );
  });
}

watch(
  () => [store.rootPath, activeIndex.value, panels.value[activeIndex.value]?.path] as const,
  async ([rootPath, , path]) => {
    if (!rootPath || store.currentPath === path) return;
    await whenStoreIdle();
    const current = panels.value[activeIndex.value]?.path;
    if (store.rootPath !== rootPath || current !== path || store.currentPath === path) return;
    await store.navigate(path).catch((err: unknown) => {
      rlog("warn", "file-commander: syncing the folder failed", { path, err: (err as Error)?.message || String(err) });
    });
  },
);

function moveCursor(to: number) {
  const rows = rowsByPanel.value[activeIndex.value];
  if (!rows.length) return;
  panels.value[activeIndex.value].cursor = Math.min(Math.max(to, 0), rows.length - 1);
}

function pageSize() {
  return panelRefs[activeIndex.value]?.pageSize() ?? 10;
}

function toggleMark(panel: PanelState, row: CommanderRow | undefined) {
  if (!row || row.parent) return;
  if (panel.marked.has(row.key)) panel.marked.delete(row.key);
  else panel.marked.add(row.key);
}

function openRow(index: number, row: CommanderRow | undefined) {
  if (!row) return;
  if (row.parent) goUp(index);
  else if (row.entry?.kind === "directory") void go(index, row.entry.relativePath);
  else void openQuickView();
}

async function openQuickView() {
  if (editorOpen.value && !(await closeEditor())) return;
  closeCompare();
  hideTerminal();
  quickViewOpen.value = true;
  narrowShowsView.value = true;
}

function closeQuickView() {
  quickViewOpen.value = false;
  narrowShowsView.value = false;
}

function toggleQuickView() {
  if (quickViewOpen.value) closeQuickView();
  else void openQuickView();
}

let quickViewTimer: ReturnType<typeof setTimeout> | null = null;
let quickViewToken = 0;

async function runQuickView() {
  const token = ++quickViewToken;
  const requestRoot = store.rootPath;
  const entry = cursorEntry.value;
  if (!entry) {
    quickView.value = { status: "none", name: cursorRow.value?.parent ? ".." : "" };
    return;
  }
  if (entry.kind === "directory") {
    quickView.value = { status: "directory", name: entry.name };
    return;
  }
  quickView.value = { status: "loading", name: entry.name };
  try {
    const result = await store.fetchPreview(entry.relativePath);
    if (token !== quickViewToken || requestRoot !== store.rootPath) return;
    if (result.kind === "text") {
      quickView.value = { status: "text", name: entry.name, content: result.content.slice(0, QUICK_VIEW_MAX_CHARS) };
    } else if (result.kind === "image") {
      quickView.value = { status: "image", name: entry.name, src: result.imageSrc || "" };
    } else if (result.kind === "empty") {
      quickView.value = { status: "empty", name: entry.name };
    } else if (result.kind === "error") {
      quickView.value = { status: "error", name: entry.name, message: result.content };
    } else {
      quickView.value = { status: "binary", name: entry.name };
    }
  } catch (err) {
    if (token !== quickViewToken || requestRoot !== store.rootPath) return;
    const message = (err as Error)?.message || "Failed to load preview";
    quickView.value = { status: "error", name: entry.name, message };
    rlog("warn", "file-commander: quick view failed", { path: entry.relativePath, err: message });
  }
}

watch(
  () => [quickViewOpen.value, cursorRow.value?.key ?? null, store.rootPath, store.listingRevision] as const,
  (next, previous) => {
    if (quickViewTimer) clearTimeout(quickViewTimer);
    quickViewTimer = null;
    if (!next[0]) {
      quickViewToken += 1;
      return;
    }
    if (!previous?.[0]) {
      void runQuickView();
      return;
    }
    quickViewTimer = setTimeout(() => void runQuickView(), QUICK_VIEW_DELAY_MS);
  },
);

function renameCursor() {
  if (cursorEntry.value) fmRename?.(cursorEntry.value);
}

function deleteCursor() {
  if (cursorEntry.value) fmDelete?.(cursorEntry.value);
}

function createFolder() {
  fmCreateDir?.();
}

async function openInEditor(entry: CommanderEntry) {
  if (editorOpen.value && store.selectedEntry?.relativePath !== entry.relativePath && !(await closeEditor())) return;
  quickViewOpen.value = false;
  closeCompare();
  hideTerminal();
  const alreadyOpen = store.editorTabs.some((tab) => tab.entry.relativePath === entry.relativePath);
  editorOpen.value = true;
  narrowShowsView.value = true;
  try {
    await store.selectEntry(entry);
    if (!alreadyOpen) editorCreatedTab = entry.relativePath;
    if (!store.editMode && (store.preview?.kind === "text" || store.preview?.kind === "empty")) await store.startEdit();
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    rlog("warn", "file-commander: opening the editor failed", { path: entry.relativePath, err: message });
    void store.notifyOpError("Could not open the file", message);
  }
}

// A tab the commander opened closes with its editor (asking first when it has unsaved changes); a tab the user already had open stays.
async function closeEditor(): Promise<boolean> {
  const path = editorCreatedTab;
  if (path && store.editorTabs.some((tab) => tab.entry.relativePath === path)) {
    if (!(await store.closeTab(path))) return false;
  }
  editorCreatedTab = null;
  editorOpen.value = false;
  narrowShowsView.value = false;
  return true;
}

async function closeEditorAndFocus() {
  if (await closeEditor()) focus();
}

function toggleEditor() {
  const entry = cursorEntry.value;
  if (editorOpen.value && (entry?.kind !== "file" || store.selectedEntry?.relativePath === entry.relativePath)) {
    void closeEditorAndFocus();
  } else if (entry?.kind === "file") {
    void openInEditor(entry);
  }
}

interface FilePopoutBridge {
  openFilePopout?: (payload: {
    rootPath: string;
    relativePath: string;
    name: string;
  }) => Promise<{ ok?: boolean; error?: string } | undefined>;
}

function popoutBridge(): FilePopoutBridge | null {
  return (window as unknown as { strideterm?: FilePopoutBridge }).strideterm ?? null;
}

const canPopOut = typeof popoutBridge()?.openFilePopout === "function";

async function popOutEditor() {
  const entry = store.selectedEntry;
  const bridge = popoutBridge();
  if (!entry || entry.kind !== "file" || !bridge?.openFilePopout) return;
  if (store.editDirty) return;
  let error: string;
  try {
    const result = await bridge.openFilePopout({
      rootPath: store.rootPath,
      relativePath: entry.relativePath,
      name: entry.name,
    });
    error = result?.error || "";
  } catch (err) {
    error = (err as Error)?.message || String(err);
  }
  if (error) {
    rlog("warn", "file-commander: pop-out failed", { path: entry.relativePath, err: error });
    void store.notifyOpError("Could not open a separate window", error);
    return;
  }
  await closeEditorAndFocus();
}

const transferable = computed(() => !!cursorEntry.value || panels.value[activeIndex.value].marked.size > 0);

async function transferSelected(op: "copy" | "move") {
  const index = activeIndex.value;
  const panel = panels.value[index];
  const marked = rowsByPanel.value[index].filter((row) => row.entry && panel.marked.has(row.key));
  const entries = marked.length ? marked.map((row) => row.entry!) : cursorEntry.value ? [cursorEntry.value] : [];
  if (!entries.length) return;
  const targetDir = panels.value[index === 0 ? 1 : 0].path;
  const verb = op === "copy" ? "Copy" : "Move";
  const problem = store.transferProblem(entries, targetDir);
  if (problem) {
    rlog("warn", "file-commander: transfer refused", { op, targetDir, problem });
    void store.notifyOpError(`${verb} not possible`, problem);
    return;
  }
  try {
    const { useAppStore } = await import("../../../stores/app.js");
    const what = entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`;
    const confirmed = await useAppStore().confirmInApp({
      title: `${verb} ${what}`,
      message: `${verb} ${what} to "${rootName.value}${targetDir ? `/${targetDir}` : ""}"?`,
      confirmLabel: verb,
      cancelLabel: "Cancel",
      danger: false,
    });
    if (!confirmed) return;
    const result = await store.transferEntries(op, entries, targetDir);
    for (const key of result.done) panel.marked.delete(key);
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    rlog("warn", "file-commander: transfer failed", { op, err: message });
    void store.notifyOpError(`${verb} failed`, message);
  }
}

function activeFolder(): string {
  const root = store.rootPath.replace(/\\/g, "/");
  const path = panels.value[activeIndex.value].path;
  return path ? `${root}/${path}` : root;
}

function releaseTerminalSession() {
  if (terminalSessionId.value && appStore.activeSessionId === terminalSessionId.value) appStore.activeSessionId = null;
}

function hideTerminal() {
  terminalOpen.value = false;
  terminalWantsFocus.value = false;
  releaseTerminalSession();
}

async function focusTerminal() {
  const sessionId = terminalSessionId.value;
  if (!sessionId) return;
  terminalWantsFocus.value = true;
  appStore.activeSessionId = sessionId;
  await nextTick();
  await nextTick();
  termStore.focusActiveTerminal();
}

async function showTerminal(): Promise<boolean> {
  if (!hostedPanel.value) return false;
  if (editorOpen.value && !(await closeEditor())) return false;
  quickViewOpen.value = false;
  closeCompare();
  terminalOpen.value = true;
  narrowShowsView.value = true;
  await focusTerminal();
  return true;
}

function toggleTerminal(): boolean {
  if (!hostedPanel.value) return false;
  if (terminalShown.value) {
    hideTerminal();
    narrowShowsView.value = false;
    focus();
  } else void showTerminal();
  return true;
}

function onTerminalFocusIn() {
  terminalWantsFocus.value = true;
  if (terminalSessionId.value) appStore.activeSessionId = terminalSessionId.value;
}

async function launchHostedTerminal(command: string, title: string, folder = activeFolder()) {
  try {
    if (!props.hostViewId) throw new Error("This Files tab cannot host a terminal.");
    if (!ownerWorkspace.value) throw new Error("This Files tab has no workspace.");
    const ownerId = ownerWorkspace.value.id;
    const viewId = await appStore.openHostedTerminal(ownerId, props.hostViewId, { cwd: folder, command, title });
    selectHostedPanel(viewId.slice(ownerId.length + 1));
    await showTerminal();
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    rlog("warn", "file-commander: opening a terminal failed", { path: folder, command, err: message });
    void store.notifyOpError("Could not open a terminal", message);
  }
}

function openTerminal(key = lastShellKey.value, folder = activeFolder()) {
  const shell = shells.value.find((item) => item.key === key) ?? shells.value[0];
  if (!shell) return launchHostedTerminal("", "", folder);
  writeStored(SHELL_STORAGE_KEY, shell.key);
  lastShellKey.value = shell.key;
  return launchHostedTerminal(shell.command, `${shell.icon} ${shell.label}`.trim(), folder);
}

function openTerminalAt(folder: string) {
  return openTerminal(lastShellKey.value, folder);
}

function openAgent(key: string) {
  const agent = agents.value.find((item) => item.key === key) ?? agents.value[0];
  if (!agent) return;
  writeStored(AGENT_STORAGE_KEY, agent.key);
  lastAgentKey.value = agent.key;
  return launchHostedTerminal(agent.command, `${agent.icon} ${agent.label}`.trim());
}

function selectHosted(panelId: string) {
  selectHostedPanel(panelId);
  void focusTerminal();
}

function closeHostedTerminal(panelId: string) {
  const workspace = ownerWorkspace.value;
  if (!workspace) return;
  const closingSelected = panelId === hostedPanel.value?.panel.id;
  if (closingSelected) {
    terminalWantsFocus.value = false;
    releaseTerminalSession();
  }
  if (hostedPanels.value.length <= 1) narrowShowsView.value = false;
  appStore.closeTab(`${workspace.id}:${panelId}`);
  focus();
}

async function moveHostedToTab() {
  const hosted = hostedPanel.value;
  if (!hosted) return;
  const panelId = hosted.panel.id;
  try {
    await appStore.moveHostedTerminalToTab(hosted.workspaceId, panelId);
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    rlog("warn", "file-commander: moving the terminal to a tab failed", { panelId, err: message });
    void store.notifyOpError("Could not move the terminal to a tab", message);
  }
}

watch(
  () => appStore.hostedTerminalReveal,
  (request) => {
    if (!request || !hostedPanels.value.some((p) => p.id === request.panelId)) return;
    appStore.hostedTerminalReveal = null;
    selectHostedPanel(request.panelId);
    void showTerminal();
  },
  { immediate: true },
);

watch(
  [terminalShown, () => !props.narrow || narrowShowsView.value, terminalSessionId, ownerIsActive] as const,
  ([shown, onScreen, sessionId, isActive]) => {
    if (shown && onScreen && sessionId && props.hostViewId && isActive) {
      appStore.hostedTerminal = { hostViewId: props.hostViewId, sessionId };
    } else if (isActive || appStore.hostedTerminal?.sessionId === sessionId) {
      appStore.hostedTerminal = null;
    }
  },
  { immediate: true },
);

function closeCompare() {
  compareToken += 1;
  if (!compareOpen.value) return;
  compareOpen.value = false;
  narrowShowsView.value = false;
}

function refuseCompare(message: string) {
  void store.notifyOpError("Cannot compare", message);
}

async function compareFiles() {
  const index = activeIndex.value;
  const panel = panels.value[index];
  const marked = rowsByPanel.value[index].filter((row) => row.entry && panel.marked.has(row.key));
  let pair: [CommanderEntry, CommanderEntry];
  if (marked.length) {
    if (marked.length !== 2 || marked.some((row) => row.entry!.kind !== "file")) {
      refuseCompare("Mark exactly two files, or none to compare the cursor file with its namesake in the other panel.");
      return;
    }
    pair = [marked[0].entry!, marked[1].entry!];
  } else {
    const entry = cursorEntry.value;
    if (!entry || entry.kind !== "file") {
      refuseCompare("Put the cursor on a file to compare.");
      return;
    }
    const other = panels.value[index === 0 ? 1 : 0].entries.find(
      (item) => item.kind === "file" && item.name === entry.name,
    );
    if (!other) {
      refuseCompare(`The other panel's folder has no file named "${entry.name}".`);
      return;
    }
    pair = index === 0 ? [entry, other] : [other, entry];
  }
  if (editorOpen.value && !(await closeEditor())) return;
  quickViewOpen.value = false;
  hideTerminal();
  const token = ++compareToken;
  const requestRoot = store.rootPath;
  const title = `Compare: ${pair[0].relativePath} ↔ ${pair[1].relativePath}`;
  compareView.value = { status: "loading", title };
  compareOpen.value = true;
  narrowShowsView.value = true;
  try {
    const [leftContent, rightContent] = await Promise.all(pair.map((item) => store.readFileText(item.relativePath)));
    if (token !== compareToken || requestRoot !== store.rootPath) return;
    compareView.value = {
      status: "ready",
      title,
      payload: {
        leftLabel: pair[0].relativePath,
        rightLabel: pair[1].relativePath,
        leftContent,
        rightContent,
        language: guessLanguageFromPath(pair[1].name),
        ok: true,
      },
    };
  } catch (err) {
    if (token !== compareToken) return;
    const message = (err as Error)?.message || String(err);
    rlog("warn", "file-commander: compare failed", { files: pair.map((item) => item.relativePath), err: message });
    closeCompare();
    void store.notifyOpError("Could not compare the files", message);
  }
}

function swapPanels() {
  panels.value = [panels.value[1], panels.value[0]];
  remember();
}

function handleKey(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (target?.closest?.("input, textarea, [contenteditable='true'], .monaco-editor, .fce__body, .fct")) return false;
  if (event.altKey) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return false;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      stepHistory(activeIndex.value, event.key === "ArrowLeft" ? -1 : 1);
      return true;
    }
    return false;
  }
  const index = activeIndex.value;
  const panel = panels.value[index];
  const rows = rowsByPanel.value[index];
  const row = rows[cursorOf(index)];
  const cursor = cursorOf(index);
  const key = event.key;
  const onButton = !!target?.closest?.("button");

  const plain = !event.ctrlKey && !event.metaKey;
  if (plain && key.length === 1 && key !== " ") {
    searchTo(searchText.value + key);
    armSearchTimer();
    return true;
  }
  if (plain && key === "Backspace" && searchText.value) {
    const prefix = searchText.value.slice(0, -1);
    if (prefix) {
      searchTo(prefix);
      armSearchTimer();
    } else endSearch();
    return true;
  }
  if (searchText.value && !["Shift", "Control", "Alt", "Meta"].includes(key)) {
    const wasEscape = key === "Escape";
    endSearch();
    if (wasEscape) return true;
  }

  if (event.ctrlKey || event.metaKey) {
    if (event.shiftKey) {
      switch (key.toLowerCase()) {
        case "t":
          void openTerminal();
          return true;
        case "d":
          void compareFiles();
          return true;
      }
      return false;
    }
    switch (key.toLowerCase()) {
      case "r":
        void store.refresh();
        return true;
      case "u":
        swapPanels();
        return true;
      case "\\":
        void go(index, "");
        return true;
      case "q":
        toggleQuickView();
        return true;
      case "o":
        return toggleTerminal();
      case "pageup":
        goUp(index);
        return true;
    }
    return false;
  }

  switch (key) {
    case "ArrowDown":
      moveCursor(cursor + 1);
      return true;
    case "ArrowUp":
      moveCursor(cursor - 1);
      return true;
    case "Home":
      moveCursor(0);
      return true;
    case "End":
      moveCursor(rows.length - 1);
      return true;
    case "PageDown":
      moveCursor(cursor + pageSize());
      return true;
    case "PageUp":
      moveCursor(cursor - pageSize());
      return true;
    case "Enter":
      if (onButton) return false;
      openRow(index, row);
      return true;
    case "Backspace":
      goUp(index);
      return true;
    case "Tab":
      setActive(index === 0 ? 1 : 0);
      return true;
    case "Insert":
      toggleMark(panel, row);
      moveCursor(cursor + 1);
      return true;
    case " ":
      if (onButton) return false;
      toggleMark(panel, row);
      moveCursor(cursor + 1);
      return true;
    case "F2":
      renameCursor();
      return true;
    case "F3":
      toggleQuickView();
      return true;
    case "F4":
      toggleEditor();
      return true;
    case "F5":
      void transferSelected("copy");
      return true;
    case "F6":
      void transferSelected("move");
      return true;
    case "F7":
      createFolder();
      return true;
    case "F8":
    case "Delete":
      deleteCursor();
      return true;
    case "Escape":
      if (editorOpen.value) void closeEditorAndFocus();
      else if (quickViewOpen.value) closeQuickView();
      else if (compareOpen.value) closeCompare();
      else return false;
      return true;
  }
  return false;
}

function onKeydown(event: KeyboardEvent) {
  if (!handleKey(event)) return;
  event.preventDefault();
  event.stopPropagation();
}

function onRootMouseDown(event: MouseEvent) {
  if (!(event.target as HTMLElement | null)?.closest?.(".fct")) {
    terminalWantsFocus.value = false;
    releaseTerminalSession();
  }
  if ((event.target as HTMLElement | null)?.closest?.("button")) {
    event.preventDefault();
    root.value?.focus({ preventScroll: true });
  }
}

function onRowClick(index: number, rowIndex: number, event: MouseEvent) {
  endSearch();
  setActive(index as 0 | 1);
  const panel = panels.value[index];
  const row = rowsByPanel.value[index][rowIndex];
  if (!row) return;
  panel.cursor = rowIndex;
  if (event.ctrlKey || event.metaKey) {
    toggleMark(panel, row);
    return;
  }
  if (props.narrow && (row.parent || row.entry?.kind === "directory")) openRow(index, row);
}

function onRowDblClick(index: number, rowIndex: number) {
  if (props.narrow) return;
  openRow(index, rowsByPanel.value[index][rowIndex]);
}

function onRowContextMenu(index: number, rowIndex: number, event: MouseEvent) {
  setActive(index as 0 | 1);
  panels.value[index].cursor = rowIndex;
  const entry = rowsByPanel.value[index][rowIndex]?.entry;
  if (entry) fmContextMenu?.(event, entry);
}

function onSort(index: number, column: CommanderSortKey) {
  const panel = panels.value[index];
  if (panel.sortBy === column) panel.sortAsc = !panel.sortAsc;
  else {
    panel.sortBy = column;
    panel.sortAsc = true;
  }
}

function setPanelRef(index: number, el: unknown) {
  panelRefs[index] = (el as { pageSize: () => number } | null) ?? null;
}

function panelProps(index: number) {
  const panel = panels.value[index];
  return {
    rows: rowsByPanel.value[index],
    cursor: cursorOf(index),
    marked: panel.marked,
    active: activeIndex.value === index,
    side: index === 0 ? "left" : "right",
    path: panel.path,
    rootName: rootName.value,
    sortBy: panel.sortBy,
    sortAsc: panel.sortAsc,
    loading: panel.loading,
    error: panel.error,
    search: activeIndex.value === index ? searchText.value : "",
    shells: shells.value,
    shellKey: lastShellKey.value,
    agents: agents.value,
    agentKey: lastAgentKey.value,
  } as const;
}

function panelListeners(index: number) {
  return {
    activate: () => setActive(index as 0 | 1),
    "row-click": (rowIndex: number, event: MouseEvent) => onRowClick(index, rowIndex, event),
    "row-dblclick": (rowIndex: number) => onRowDblClick(index, rowIndex),
    "row-contextmenu": (rowIndex: number, event: MouseEvent) => onRowContextMenu(index, rowIndex, event),
    sort: (column: CommanderSortKey) => onSort(index, column),
    "go-root": () => void go(index, ""),
    "go-up": () => goUp(index),
    "open-terminal": (key: string) => void openTerminal(key),
    compare: () => void compareFiles(),
    "open-agent": (key: string) => void openAgent(key),
  };
}

function focus() {
  nextTick(() => {
    if (terminalWantsFocus.value && terminalShown.value) void focusTerminal();
    else root.value?.focus({ preventScroll: true });
  });
}

onBeforeUnmount(() => {
  releaseTerminalSession();
  if (terminalSessionId.value && appStore.hostedTerminal?.sessionId === terminalSessionId.value) {
    appStore.hostedTerminal = null;
  }
  remember();
  if (quickViewTimer) clearTimeout(quickViewTimer);
  endSearch();
  quickViewToken += 1;
});

defineExpose({ focus, onKeydown, openInEditor, openTerminalAt });
</script>

<style scoped>
.fc {
  container: file-commander / inline-size;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  outline: none;
}

.fc__main {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.fc__main > :deep(.fm-splitpanes) {
  height: 100%;
}

.fc__single {
  height: 100%;
  min-width: 0;
}

.fc__switch {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  padding: 5px 8px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.fc__switch button {
  flex: 1 0 auto;
  min-height: 36px;
  padding: 5px 12px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  touch-action: manipulation;
}

.fc__switch .fc__switch--active {
  border-color: color-mix(in srgb, var(--accent), transparent 60%);
  background: color-mix(in srgb, var(--accent), transparent 88%);
  color: var(--text);
}

.fc__fkeys {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.fc__fkey {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  padding: 3px 4px;
  border: 0;
  border-left: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  touch-action: manipulation;
}

.fc__fkey:first-child {
  border-left: 0;
}

.fc__fkey:hover:not(:disabled) {
  background: var(--border);
}

.fc__fkey:disabled {
  opacity: 0.4;
  cursor: default;
}

.fc__fkey[aria-pressed="true"] {
  background: color-mix(in srgb, var(--accent), transparent 82%);
}

.fc__fkey-num {
  flex: 0 0 auto;
  padding: 0 3px;
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--muted);
  font-size: 10px;
  line-height: 14px;
}

.fc__fkey-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fc__fkey-label--short {
  display: none;
}

@container file-commander (max-width: 759px) {
  .fc__fkey-label--long {
    display: none;
  }

  .fc__fkey-label--short {
    display: inline;
  }
}

@container file-commander (max-width: 559px) {
  .fc__fkeys {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .fc__fkey:nth-child(5) {
    border-left: 0;
  }

  .fc__fkey:nth-child(n + 5) {
    border-top: 1px solid var(--border);
  }
}

@media (pointer: coarse) {
  .fc__fkey {
    min-height: 40px;
  }
}
</style>
