<template>
  <div class="mep" :class="{ 'mep--narrow': isNarrow }">
    <!-- Toolbar -->
    <div class="mep__toolbar">
      <span class="mep__file" :title="filePath">{{ shortName }}</span>
      <div class="mep__toolbar-center">
        <button
          type="button"
          class="button button--ghost button--small"
          :disabled="!hasNonConflicting"
          @click="applyAllNonConflicting"
        >
          ⚡ Apply non-conflicting
        </button>
        <div class="mep__nav">
          <button type="button" class="mep__nav-btn" :disabled="totalConflicts === 0" @click="prevConflict">◀</button>
          <span class="mep__nav-count" :class="{ 'mep__nav-count--done': totalConflicts === 0 }">
            {{ totalConflicts === 0 ? "no conflicts" : `${currentConflictIdx + 1} / ${totalConflicts}` }}
          </span>
          <button type="button" class="mep__nav-btn" :disabled="totalConflicts === 0" @click="nextConflict">▶</button>
        </div>
        <template v-if="currentConflict">
          <button type="button" class="button button--ghost button--small" @click="applyOurs">◀ {{ oursLabel }}</button>
          <button type="button" class="button button--ghost button--small" @click="applyTheirs">
            {{ theirsLabel }} ▶
          </button>
        </template>
      </div>
    </div>

    <!-- Mobile tab selector -->
    <div v-if="isNarrow" class="mep__tabs">
      <button
        v-for="tab in ['ours', 'result', 'theirs'] as const"
        :key="tab"
        type="button"
        :class="['mep__tab', { 'mep__tab--active': activeTab === tab }]"
        @click="activeTab = tab"
      >
        {{ tab === "ours" ? oursLabel : tab === "theirs" ? theirsLabel : "Result" }}
      </button>
    </div>

    <!-- Pane labels (desktop) -->
    <div v-if="!isNarrow" class="mep__pane-labels">
      <div class="mep__pane-label">{{ oursLabel }} <span class="mep__pane-tag">ours</span></div>
      <div class="mep__pane-label mep__pane-label--result">Result</div>
      <div class="mep__pane-label">{{ theirsLabel }} <span class="mep__pane-tag">theirs</span></div>
    </div>

    <!-- Loading / error -->
    <div v-if="loading" class="mep__overlay">Loading conflict detail…</div>
    <div v-else-if="loadError" class="mep__overlay mep__overlay--error">{{ loadError }}</div>

    <!-- Three editors (desktop: side by side, narrow: single tab) -->
    <div v-else class="mep__editors">
      <div v-if="!isNarrow || activeTab === 'ours'" :class="['mep__pane', isNarrow && 'mep__pane--full']">
        <div ref="oursContainer" class="mep__editor-host"></div>
      </div>
      <div
        v-if="!isNarrow || activeTab === 'result'"
        :class="['mep__pane', 'mep__pane--result', isNarrow && 'mep__pane--full']"
      >
        <div ref="resultContainer" class="mep__editor-host"></div>
      </div>
      <div v-if="!isNarrow || activeTab === 'theirs'" :class="['mep__pane', isNarrow && 'mep__pane--full']">
        <div ref="theirsContainer" class="mep__editor-host"></div>
      </div>
    </div>

    <!-- Footer -->
    <div class="mep__footer">
      <span class="mep__conflict-count">
        <template v-if="totalConflicts > 0">⚠ {{ totalConflicts }} remaining</template>
        <template v-else>✓ All resolved</template>
      </span>
      <div class="mep__footer-actions">
        <button type="button" class="button button--ghost" @click="onCancel">Cancel</button>
        <button
          type="button"
          class="button"
          :disabled="totalConflicts > 0 || busy"
          :title="totalConflicts > 0 ? 'Resolve all conflicts before applying' : ''"
          @click="onApply"
        >
          {{ busy ? "Applying…" : "Apply" }}
        </button>
      </div>
    </div>
  </div>

  <!-- Dirty-cancel confirm -->
  <Teleport to="body">
    <div v-if="confirmCancel" class="mep-backdrop" @mousedown.self="confirmCancel = false">
      <div class="mep-confirm">
        <p>Discard unsaved changes to the Result?</p>
        <div class="mep-confirm__actions">
          <button type="button" class="button button--ghost" @click="confirmCancel = false">Keep editing</button>
          <button type="button" class="button" style="background: var(--danger)" @click="emit('cancel')">
            Discard
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import "../../app/monaco-setup.js";
import * as monaco from "monaco-editor";
import { merge3, applyNonConflicting } from "../../lib/merge3.js";
import type { Chunk } from "../../lib/merge3.js";
import { useAppStore } from "../../stores/app.js";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import { guessLanguageFromPath } from "../../../config/language-map.js";

const props = defineProps<{
  filePath: string;
  conflictType: string;
  workspaceId: string;
  rootPath: string;
  sides: { ours: string; theirs: string } | null;
}>();

const emit = defineEmits<{
  (e: "apply"): void;
  (e: "cancel"): void;
}>();

const appStore = useAppStore();
const { isNarrow } = useIsNarrow();

const activeTab = ref<"ours" | "result" | "theirs">("result");
const loading = ref(true);
const loadError = ref("");
const busy = ref(false);
const confirmCancel = ref(false);

const oursLabel = computed(() => props.sides?.ours || "Ours");
const theirsLabel = computed(() => props.sides?.theirs || "Theirs");

const shortName = computed(() => props.filePath.split("/").pop() || props.filePath);
const language = computed(() => guessLanguageFromPath(props.filePath));

// ---- Content from backend ----
const baseContent = ref("");
const oursContent = ref("");
const theirsContent = ref("");
const initialResultText = ref("");

// ---- Monaco refs ----
const oursContainer = ref<HTMLDivElement | null>(null);
const resultContainer = ref<HTMLDivElement | null>(null);
const theirsContainer = ref<HTMLDivElement | null>(null);

let oursEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let resultEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let theirsEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let resizeObs: ResizeObserver | null = null;

// ---- Chunk tracking with sticky Monaco decorations (IntelliJ-style, no git markers) ----
// Conflict chunks are represented as a single placeholder line in the Result editor.
// Their positions are tracked via Monaco model decorations with range stickiness,
// so navigation and apply arrows keep working after the user edits adjacent text.

const CONFLICT_PLACEHOLDER = "⚠ conflict";

interface ConflictTracker {
  chunkIdx: number; // index into allChunksData
  oursLines: string[];
  theirsLines: string[];
  decorationId: string; // Monaco model decoration ID (range stickiness)
  resolved: boolean;
}

// Module-level mutable state — Monaco operations are synchronous
let allChunksData: Chunk[] = [];
let conflictTrackersMut: ConflictTracker[] = [];

// Reactive mirrors for template
const conflictTrackersRef = ref<ConflictTracker[]>([]);
const currentConflictIdx = ref(0); // index into unresolvedTrackers

const unresolvedTrackers = computed(() => conflictTrackersRef.value.filter((t) => !t.resolved));
const totalConflicts = computed(() => unresolvedTrackers.value.length);
const currentConflict = computed(() => unresolvedTrackers.value[currentConflictIdx.value] ?? null);
// Non-conflicting = ours/theirs chunks where only one side changed
const hasNonConflicting = computed(() => allChunksData.some((c) => c.kind === "ours" || c.kind === "theirs"));

// ---- Build initial result text (no git markers) ----
interface ConflictPosition {
  chunkIdx: number;
  line: number; // 1-based
}

function buildInitialResult(appliedChunks: Chunk[]): { text: string; conflictPositions: ConflictPosition[] } {
  const lines: string[] = [];
  const conflictPositions: ConflictPosition[] = [];

  for (let i = 0; i < appliedChunks.length; i++) {
    const chunk = appliedChunks[i];
    if (chunk.kind === "conflict") {
      const line = lines.length + 1; // 1-based
      lines.push(CONFLICT_PLACEHOLDER);
      conflictPositions.push({ chunkIdx: i, line });
    } else {
      lines.push(...chunk.resultLines);
    }
  }

  return { text: lines.join("\n"), conflictPositions };
}

// ---- Install sticky decorations for conflict placeholder lines ----
function installConflictDecorations(conflictPositions: ConflictPosition[]) {
  const model = resultEditor?.getModel();
  if (!model) return;

  // Remove any existing sticky decorations
  if (conflictTrackersMut.length) {
    const oldIds = conflictTrackersMut.map((t) => t.decorationId).filter(Boolean);
    if (oldIds.length) model.deltaDecorations(oldIds, []);
    conflictTrackersMut = [];
  }

  if (!conflictPositions.length) {
    conflictTrackersRef.value = [];
    currentConflictIdx.value = 0;
    return;
  }

  // Create sticky model decorations — NeverGrowsWhenTypingAtEdges keeps the placeholder
  // range exact while still letting Monaco track the range as surrounding text is edited.
  const decorationDefs: monaco.editor.IModelDeltaDecoration[] = conflictPositions.map((pos) => ({
    range: new monaco.Range(pos.line, 1, pos.line, model.getLineMaxColumn(pos.line)),
    options: {
      stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
    },
  }));

  const newIds = model.deltaDecorations([], decorationDefs);

  conflictTrackersMut = conflictPositions.map((pos, i) => {
    const chunk = allChunksData[pos.chunkIdx];
    return {
      chunkIdx: pos.chunkIdx,
      oursLines: chunk.oursLines,
      theirsLines: chunk.theirsLines,
      decorationId: newIds[i],
      resolved: false,
    };
  });

  conflictTrackersRef.value = [...conflictTrackersMut];
  currentConflictIdx.value = 0;
}

// ---- Editor decoration collections (visual only — separate from sticky tracking) ----
let resultDecColl: monaco.editor.IEditorDecorationsCollection | null = null;

function updateConflictDecorations() {
  if (!resultEditor || !resultDecColl) return;
  const model = resultEditor.getModel();
  if (!model) return;

  const unresolved = conflictTrackersMut.filter((t) => !t.resolved);
  const current = unresolved[currentConflictIdx.value];

  const decList: monaco.editor.IModelDeltaDecoration[] = [];
  for (const tracker of unresolved) {
    const range = model.getDecorationRange(tracker.decorationId);
    if (!range) continue;
    const isCurrent = tracker === current;
    decList.push({
      range,
      options: {
        isWholeLine: true,
        className: isCurrent ? "mep-conflict-active" : "mep-conflict-highlight",
        overviewRuler: {
          color: isCurrent ? "rgba(255,165,0,1)" : "rgba(255,120,0,0.7)",
          position: monaco.editor.OverviewRulerLane.Right,
        },
      },
    });
  }
  resultDecColl.set(decList);
}

// ---- Detect when user manually edits a conflict placeholder ----
function checkManualResolution() {
  const model = resultEditor?.getModel();
  if (!model) return;

  let changed = false;
  for (const tracker of conflictTrackersMut) {
    if (tracker.resolved) continue;
    const range = model.getDecorationRange(tracker.decorationId);
    if (!range) {
      // Decoration range is gone — user deleted it entirely
      tracker.resolved = true;
      changed = true;
      continue;
    }
    const content = model.getValueInRange(range);
    if (content !== CONFLICT_PLACEHOLDER) {
      // User typed something in the conflict region — count as resolved
      tracker.resolved = true;
      model.deltaDecorations([tracker.decorationId], []);
      tracker.decorationId = "";
      changed = true;
    }
  }

  if (changed) {
    conflictTrackersRef.value = [...conflictTrackersMut];
    const n = unresolvedTrackers.value.length;
    if (currentConflictIdx.value >= n) currentConflictIdx.value = Math.max(0, n - 1);
    updateConflictDecorations();
  }
}

// ---- Navigation ----
function revealCurrentConflict() {
  const model = resultEditor?.getModel();
  const tracker = currentConflict.value;
  if (!model || !tracker) return;
  const range = model.getDecorationRange(tracker.decorationId);
  if (range) resultEditor?.revealLineInCenter(range.startLineNumber);
}

function nextConflict() {
  const n = unresolvedTrackers.value.length;
  if (!n) return;
  currentConflictIdx.value = (currentConflictIdx.value + 1) % n;
  updateConflictDecorations();
  revealCurrentConflict();
}

function prevConflict() {
  const n = unresolvedTrackers.value.length;
  if (!n) return;
  currentConflictIdx.value = (currentConflictIdx.value - 1 + n) % n;
  updateConflictDecorations();
  revealCurrentConflict();
}

// ---- Apply ours/theirs to a conflict chunk ----
function applyChunk(tracker: ConflictTracker, side: "ours" | "theirs") {
  const model = resultEditor?.getModel();
  if (!model) return;

  const range = model.getDecorationRange(tracker.decorationId);
  if (!range) return;

  const lines = side === "ours" ? tracker.oursLines : tracker.theirsLines;
  const replacement = lines.join("\n");

  // Remove sticky decoration before editing so it doesn't interfere
  model.deltaDecorations([tracker.decorationId], []);
  tracker.decorationId = "";

  // Replace the placeholder range with the chosen content
  model.pushEditOperations([], [{ range, text: replacement }], () => null);

  tracker.resolved = true;
  conflictTrackersRef.value = [...conflictTrackersMut];

  const n = unresolvedTrackers.value.length;
  if (currentConflictIdx.value >= n) currentConflictIdx.value = Math.max(0, n - 1);
  updateConflictDecorations();
}

function applyOurs() {
  const tracker = currentConflict.value;
  if (!tracker) return;
  applyChunk(tracker, "ours");
}

function applyTheirs() {
  const tracker = currentConflict.value;
  if (!tracker) return;
  applyChunk(tracker, "theirs");
}

// ---- Apply all non-conflicting changes ----
// Rebuilds the result from the original merge3 chunks, resetting to the initial
// auto-merged state. Non-conflicting ours/theirs changes are re-applied; conflict
// placeholders are restored. Always works regardless of manual edits.
function applyAllNonConflicting() {
  if (!resultEditor || !allChunksData.length) return;
  const model = resultEditor.getModel();
  if (!model) return;

  // Remove all existing sticky decorations
  const oldIds = conflictTrackersMut.map((t) => t.decorationId).filter(Boolean);
  if (oldIds.length) model.deltaDecorations(oldIds, []);
  conflictTrackersMut = [];

  // Rebuild from original chunks
  const applied = applyNonConflicting(allChunksData);
  const { text, conflictPositions } = buildInitialResult(applied);
  model.setValue(text);
  initialResultText.value = text;

  installConflictDecorations(conflictPositions);
  updateConflictDecorations();
  revealCurrentConflict();
}

// ---- Scroll sync ----
let syncingScroll = false;

function syncScrollFrom(source: monaco.editor.IStandaloneCodeEditor) {
  if (syncingScroll) return;
  syncingScroll = true;
  const top = source.getScrollTop();
  for (const ed of [oursEditor, resultEditor, theirsEditor]) {
    if (ed && ed !== source) ed.setScrollTop(top);
  }
  syncingScroll = false;
}

// ---- Editor lifecycle ----
const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: "vs-dark",
  fontSize: 12,
  fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
  lineNumbers: "on",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "off",
  renderWhitespace: "boundary",
  automaticLayout: false,
};

function createEditors() {
  if (!oursContainer.value || !resultContainer.value || !theirsContainer.value) return;
  const lang = language.value;

  oursEditor = monaco.editor.create(oursContainer.value, {
    ...EDITOR_OPTIONS,
    value: oursContent.value,
    language: lang,
    readOnly: true,
  });
  resultEditor = monaco.editor.create(resultContainer.value, {
    ...EDITOR_OPTIONS,
    value: "",
    language: lang,
    readOnly: false,
  });
  theirsEditor = monaco.editor.create(theirsContainer.value, {
    ...EDITOR_OPTIONS,
    value: theirsContent.value,
    language: lang,
    readOnly: true,
  });

  resultDecColl = resultEditor.createDecorationsCollection([]);

  oursEditor.onDidScrollChange(() => syncScrollFrom(oursEditor!));
  resultEditor.onDidScrollChange(() => syncScrollFrom(resultEditor!));
  theirsEditor.onDidScrollChange(() => syncScrollFrom(theirsEditor!));

  // After each user edit, check if any conflict placeholder was modified
  resultEditor.onDidChangeModelContent(() => {
    checkManualResolution();
  });

  resizeObs = new ResizeObserver(() => layoutEditors());
  if (resultContainer.value.parentElement) {
    resizeObs.observe(resultContainer.value.parentElement);
  }
  layoutEditors();
}

function layoutEditors() {
  for (const ed of [oursEditor, resultEditor, theirsEditor]) {
    if (ed) ed.layout();
  }
}

function disposeEditors() {
  // Remove sticky decorations from the model before disposal
  if (conflictTrackersMut.length) {
    const model = resultEditor?.getModel();
    if (model) {
      const ids = conflictTrackersMut.map((t) => t.decorationId).filter(Boolean);
      if (ids.length) model.deltaDecorations(ids, []);
    }
    conflictTrackersMut = [];
    conflictTrackersRef.value = [];
  }

  for (const ed of [oursEditor, resultEditor, theirsEditor]) {
    if (ed) {
      ed.getModel()?.dispose();
      ed.dispose();
    }
  }
  oursEditor = null;
  resultEditor = null;
  theirsEditor = null;
  resultDecColl = null;
  resizeObs?.disconnect();
  resizeObs = null;
}

// ---- Load conflict detail ----
async function loadDetail() {
  loading.value = true;
  loadError.value = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    const detail = (await api.gitConflictDetail({
      workspaceId: props.workspaceId,
      rootPath: props.rootPath,
      filePath: props.filePath,
    })) as Record<string, unknown>;

    baseContent.value = (detail.base as string) || "";
    oursContent.value = (detail.ours as string) || "";
    theirsContent.value = (detail.theirs as string) || "";

    const { chunks } = merge3(baseContent.value, oursContent.value, theirsContent.value);
    allChunksData = chunks;

    const applied = applyNonConflicting(chunks);
    const { text, conflictPositions } = buildInitialResult(applied);
    initialResultText.value = text;

    loading.value = false;
    await nextTick();
    createEditors();
    resultEditor?.getModel()?.setValue(text);
    installConflictDecorations(conflictPositions);
    updateConflictDecorations();
    revealCurrentConflict();
  } catch (err) {
    loadError.value = (err as Error)?.message || "Failed to load conflict detail.";
    loading.value = false;
  }
}

// ---- Apply & Cancel ----
async function onApply() {
  if (!resultEditor || totalConflicts.value > 0) return;
  busy.value = true;
  try {
    const content = resultEditor.getModel()?.getValue() ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    await api.gitResolveConflict({
      workspaceId: props.workspaceId,
      rootPath: props.rootPath,
      filePath: props.filePath,
      mode: "manual",
      content,
    });
    emit("apply");
  } catch (err) {
    loadError.value = (err as Error)?.message || "Failed to apply resolution.";
  } finally {
    busy.value = false;
  }
}

function onCancel() {
  const current = resultEditor?.getModel()?.getValue() ?? "";
  if (current !== initialResultText.value && current !== "") {
    confirmCancel.value = true;
  } else {
    emit("cancel");
  }
}

// ---- Keyboard shortcuts (Phase 4) ----
// Scoped to focus within one of the editor panes so they never clobber
// global app/browser shortcuts when the merge editor is not in use.
//   F7 / Shift+F7        — next / prev conflict
//   Alt+ArrowLeft        — apply ours (◀) to current conflict
//   Alt+ArrowRight       — apply theirs (▶) to current conflict
//   Alt+A                — apply all non-conflicting changes
function onKeydown(e: KeyboardEvent) {
  if (
    !resultContainer.value?.contains(document.activeElement) &&
    !oursContainer.value?.contains(document.activeElement) &&
    !theirsContainer.value?.contains(document.activeElement)
  )
    return;
  if (e.key === "F7") {
    e.preventDefault();
    e.shiftKey ? prevConflict() : nextConflict();
  } else if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    applyOurs();
  } else if (e.altKey && e.key === "ArrowRight") {
    e.preventDefault();
    applyTheirs();
  } else if (e.altKey && (e.key === "a" || e.key === "A")) {
    if (!hasNonConflicting.value) return;
    e.preventDefault();
    applyAllNonConflicting();
  }
}

// On layout change, reload from scratch (persisting partial edits across layout
// switches is not worth the complexity; user can re-apply their choices)
watch(isNarrow, async () => {
  disposeEditors();
  await nextTick();
  if (!loading.value) void loadDetail();
});

onMounted(() => {
  document.addEventListener("keydown", onKeydown);
  void loadDetail();
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  disposeEditors();
});
</script>

<style scoped>
.mep {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.mep__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.mep__file {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--text);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.mep__toolbar-center {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mep__nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.mep__nav-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
}

.mep__nav-btn:hover:not(:disabled) {
  background: var(--border);
  color: var(--text);
}

.mep__nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mep__nav-count {
  font-size: 11px;
  color: var(--text);
  min-width: 64px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.mep__nav-count--done {
  color: var(--ok, #0b6);
  font-style: italic;
}

/* Narrow (mobile) tabs */
.mep__tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.mep__tab {
  flex: 1;
  padding: 6px 12px;
  font-size: 12px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: var(--muted);
}

.mep__tab--active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* Pane labels row */
.mep__pane-labels {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  font-size: 11px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
}

.mep__pane-label {
  padding: 3px 10px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.mep__pane-label:not(:last-child) {
  border-right: 1px solid var(--border);
}

.mep__pane-label--result {
  font-weight: 600;
  color: var(--text);
}

.mep__pane-tag {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: var(--border);
  padding: 1px 5px;
  border-radius: 3px;
}

/* Overlay (loading / error) */
.mep__overlay {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted);
  padding: 20px;
}

.mep__overlay--error {
  color: var(--danger, #e44);
}

/* Editors area */
.mep__editors {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.mep__pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.mep__pane:not(:last-child) {
  border-right: 1px solid var(--border);
}

.mep__pane--result {
  flex: 1.2; /* result pane slightly wider */
}

.mep__pane--full {
  flex: 1;
}

.mep__editor-host {
  flex: 1;
  min-height: 0;
  width: 100%;
  height: 100%;
}

/* Footer */
.mep__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  gap: 8px;
}

.mep__conflict-count {
  font-size: 12px;
  color: var(--muted);
}

.mep__footer-actions {
  display: flex;
  gap: 8px;
}

/* Dirty-cancel confirm */
.mep-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.mep-confirm {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  min-width: 280px;
  box-shadow: var(--shadow);
}

.mep-confirm p {
  margin: 0 0 12px;
  font-size: 13px;
}

.mep-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

<style>
/* Global styles for Monaco decorations (cannot be scoped) */
.mep-conflict-highlight {
  background: rgba(255, 120, 0, 0.1) !important;
  border-left: 3px solid rgba(255, 120, 0, 0.6) !important;
}

.mep-conflict-active {
  background: rgba(255, 165, 0, 0.18) !important;
  border-left: 3px solid rgba(255, 165, 0, 0.9) !important;
}
</style>
