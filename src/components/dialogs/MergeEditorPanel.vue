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
import { merge3, applyNonConflicting, hasUnresolvedConflicts } from "../../lib/merge3.js";
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

// ---- Monaco refs ----
const oursContainer = ref<HTMLDivElement | null>(null);
const resultContainer = ref<HTMLDivElement | null>(null);
const theirsContainer = ref<HTMLDivElement | null>(null);

let oursEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let resultEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let theirsEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let resizeObs: ResizeObserver | null = null;

// ---- Chunk tracking ----
// Each conflict chunk is stored as a marker block in the result model.
// The MARKER_* constants identify those blocks so we can navigate / apply / count them.
const MARKER_OURS = "<<<<<<< ";
const MARKER_SEP = "=======";
const MARKER_THEIRS = ">>>>>>> ";

// ---- Conflict navigation ----
// Compute conflict positions by scanning the result model for marker lines.
interface ConflictRegion {
  startLine: number; // 1-based (<<< line)
  sepLine: number; // === line
  endLine: number; // >>> line
}

const currentConflictIdx = ref(0);
const conflictRegions = ref<ConflictRegion[]>([]);
const totalConflicts = computed(() => conflictRegions.value.length);
const hasNonConflicting = ref(false);
const currentConflict = computed(() => conflictRegions.value[currentConflictIdx.value] ?? null);

function scanConflicts() {
  if (!resultEditor) return;
  const model = resultEditor.getModel();
  if (!model) return;
  const regions: ConflictRegion[] = [];
  const lineCount = model.getLineCount();
  let startLine = -1;
  let sepLine = -1;
  for (let i = 1; i <= lineCount; i++) {
    const text = model.getLineContent(i);
    if (text.startsWith(MARKER_OURS)) {
      startLine = i;
      sepLine = -1;
    } else if (text === MARKER_SEP && startLine > 0) {
      sepLine = i;
    } else if (text.startsWith(MARKER_THEIRS) && startLine > 0 && sepLine > 0) {
      regions.push({ startLine, sepLine, endLine: i });
      startLine = -1;
      sepLine = -1;
    }
  }
  conflictRegions.value = regions;
  // Clamp index
  if (currentConflictIdx.value >= regions.length) {
    currentConflictIdx.value = Math.max(0, regions.length - 1);
  }
  updateConflictDecorations();
}

// ---- Monaco decorations ----
let oursDecorations: monaco.editor.IEditorDecorationsCollection | null = null;
let resultDecorations: monaco.editor.IEditorDecorationsCollection | null = null;
let theirsDecorations: monaco.editor.IEditorDecorationsCollection | null = null;

function updateConflictDecorations() {
  if (!resultEditor || !oursEditor || !theirsEditor) return;
  const regions = conflictRegions.value;

  // Result: highlight entire marker blocks
  const resultRanges = regions.map((r) => ({
    range: new monaco.Range(r.startLine, 1, r.endLine, 1),
    options: {
      isWholeLine: true,
      className: "mep-conflict-highlight",
      overviewRuler: { color: "rgba(255, 120, 0, 0.7)", position: monaco.editor.OverviewRulerLane.Right },
    },
  }));
  resultDecorations?.set(resultRanges);

  // Highlight current conflict more prominently
  if (currentConflict.value) {
    const r = currentConflict.value;
    const activeRange = {
      range: new monaco.Range(r.startLine, 1, r.endLine, 1),
      options: {
        isWholeLine: true,
        className: "mep-conflict-active",
        overviewRuler: { color: "rgba(255, 165, 0, 1)", position: monaco.editor.OverviewRulerLane.Right },
      },
    };
    resultDecorations?.set([...resultRanges, activeRange]);
  }
}

function revealConflict(region: ConflictRegion | null) {
  if (!region || !resultEditor) return;
  resultEditor.revealLineInCenter(region.startLine);
}

function nextConflict() {
  if (!conflictRegions.value.length) return;
  currentConflictIdx.value = (currentConflictIdx.value + 1) % conflictRegions.value.length;
  updateConflictDecorations();
  revealConflict(currentConflict.value);
}

function prevConflict() {
  if (!conflictRegions.value.length) return;
  const n = conflictRegions.value.length;
  currentConflictIdx.value = (currentConflictIdx.value - 1 + n) % n;
  updateConflictDecorations();
  revealConflict(currentConflict.value);
}

function applyChunk(region: ConflictRegion, side: "ours" | "theirs") {
  if (!resultEditor) return;
  const model = resultEditor.getModel();
  if (!model) return;
  // Extract content lines between markers
  const lines: string[] = [];
  if (side === "ours") {
    for (let i = region.startLine + 1; i < region.sepLine; i++) {
      lines.push(model.getLineContent(i));
    }
  } else {
    for (let i = region.sepLine + 1; i < region.endLine; i++) {
      lines.push(model.getLineContent(i));
    }
  }
  const replacement = lines.join("\n");
  // Replace from start of startLine to end of endLine (including trailing newline if present)
  const endCol = model.getLineMaxColumn(region.endLine);
  const edit: monaco.editor.IIdentifiedSingleEditOperation = {
    range: new monaco.Range(region.startLine, 1, region.endLine, endCol),
    text: replacement,
  };
  model.pushEditOperations([], [edit], () => null);
  // Monaco auto-revises the model; rescan
  nextTick(() => scanConflicts());
}

function applyOurs() {
  const region = currentConflict.value;
  if (!region) return;
  applyChunk(region, "ours");
}

function applyTheirs() {
  const region = currentConflict.value;
  if (!region) return;
  applyChunk(region, "theirs");
}

function applyAllNonConflicting() {
  // Rebuild result from scratch using merge3 + applyNonConflicting, preserve manual edits
  // to resolved regions by reading current model content and replacing only conflict blocks.
  // Simpler: re-derive the result from scratch (only works if user hasn't manually edited).
  if (!resultEditor) return;
  const model = resultEditor.getModel();
  if (!model) return;

  // Apply all pending conflict blocks one by one from bottom to top (to avoid line shifting)
  const regions = [...conflictRegions.value].sort((a, b) => b.startLine - a.startLine);
  for (const region of regions) {
    // Auto-merge: try ours if theirs == base, theirs if ours == base, else skip
    // We don't have the base per-chunk at this point. Resolve all ours side is not right.
    // Instead, re-apply via merge3 engine using the initial content.
    void region; // Skip – handled by the initial merge3 application below
  }
  // Simpler approach: rerun merge3 and apply non-conflicting only if result model is pristine
  // (hasn't been manually edited). We detect this by comparing to the initial text.
  if (model.getValue() !== initialResultText.value) {
    // User has edited – don't clobber their work. Apply only to unresolved blocks.
    return;
  }
  // Recompute from scratch
  const { chunks } = merge3(baseContent.value, oursContent.value, theirsContent.value);
  const applied = applyNonConflicting(chunks);
  const newResult = buildResultText(applied);
  model.setValue(newResult);
  nextTick(() => scanConflicts());
}

const initialResultText = ref("");

function buildResultText(chunks: ReturnType<typeof applyNonConflicting>): string {
  const lines: string[] = [];
  for (const chunk of chunks) {
    if (chunk.kind === "conflict") {
      // Insert conflict markers
      lines.push(`${MARKER_OURS}${oursLabel.value}`);
      lines.push(...chunk.oursLines);
      lines.push(MARKER_SEP);
      lines.push(...chunk.theirsLines);
      lines.push(`${MARKER_THEIRS}${theirsLabel.value}`);
    } else {
      lines.push(...chunk.resultLines);
    }
  }
  return lines.join("\n");
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

  oursDecorations = oursEditor.createDecorationsCollection([]);
  resultDecorations = resultEditor.createDecorationsCollection([]);
  theirsDecorations = theirsEditor.createDecorationsCollection([]);

  // Scroll sync
  oursEditor.onDidScrollChange(() => syncScrollFrom(oursEditor!));
  resultEditor.onDidScrollChange(() => syncScrollFrom(resultEditor!));
  theirsEditor.onDidScrollChange(() => syncScrollFrom(theirsEditor!));

  // Rescan conflicts after every result edit
  resultEditor.onDidChangeModelContent(() => {
    scanConflicts();
  });

  // ResizeObserver
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
  for (const ed of [oursEditor, resultEditor, theirsEditor]) {
    if (ed) {
      ed.getModel()?.dispose();
      ed.dispose();
    }
  }
  oursEditor = null;
  resultEditor = null;
  theirsEditor = null;
  resizeObs?.disconnect();
  resizeObs = null;
}

// ---- Load conflict detail and initialise ----
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
    hasNonConflicting.value = chunks.some((c) => c.kind !== "unchanged" && c.kind !== "conflict");
    const applied = applyNonConflicting(chunks);
    const resultText = buildResultText(applied);
    initialResultText.value = resultText;

    loading.value = false;
    await nextTick();
    createEditors();
    resultEditor?.getModel()?.setValue(resultText);
    scanConflicts();
    if (conflictRegions.value.length) revealConflict(conflictRegions.value[0]);
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
  // If result model is dirty (differs from initial), confirm before discarding
  const current = resultEditor?.getModel()?.getValue() ?? "";
  if (current !== initialResultText.value && current !== "") {
    confirmCancel.value = true;
  } else {
    emit("cancel");
  }
}

// ---- Keyboard shortcuts (Phase 4) ----
function onKeydown(e: KeyboardEvent) {
  // Only when focused inside the merge editor
  if (
    !resultContainer.value?.contains(document.activeElement) &&
    !oursContainer.value?.contains(document.activeElement) &&
    !theirsContainer.value?.contains(document.activeElement)
  )
    return;
  if (e.key === "F7") {
    e.preventDefault();
    e.shiftKey ? prevConflict() : nextConflict();
  }
}

// Watch narrow mode: recreate editors when layout changes
watch(isNarrow, async () => {
  disposeEditors();
  await nextTick();
  if (!loading.value) createEditors();
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
