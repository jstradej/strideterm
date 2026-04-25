<template>
  <Teleport to="body">
    <div v-if="store.diffOpen" class="fm-diff-backdrop" @mousedown.self="store.closeDiff()">
      <div class="fm-diff-modal" role="dialog" aria-modal="true">
        <header class="fm-diff__header">
          <div class="fm-diff__title">
            <span class="fm-diff__filename">{{ store.diffEntry?.name || "" }}</span>
            <span class="fm-diff__path">{{ store.diffEntry?.relativePath || "" }}</span>
          </div>
          <button type="button" class="fm-diff__close" title="Close (Esc)" @click="store.closeDiff()">×</button>
        </header>

        <div class="fm-diff__controls">
          <div class="fm-diff__source">
            <label class="fm-diff__label">Compare against:</label>
            <div class="fm-diff__select-wrap">
              <CustomSelect
                :model-value="store.diffSource"
                :options="sourceOptions"
                placeholder="Source…"
                @update:model-value="onSourceChange"
              />
            </div>
          </div>

          <div v-if="store.diffSource === 'branch'" class="fm-diff__source">
            <label class="fm-diff__label">Branch:</label>
            <div class="fm-diff__select-wrap">
              <CustomSelect
                :model-value="store.diffRevisionRef"
                :options="branchOptions"
                placeholder="— select —"
                @update:model-value="(v) => store.setDiffSource('branch', v)"
              />
            </div>
          </div>

          <div v-if="store.diffSource === 'tag'" class="fm-diff__source">
            <label class="fm-diff__label">Tag:</label>
            <div class="fm-diff__select-wrap">
              <CustomSelect
                :model-value="store.diffRevisionRef"
                :options="tagOptions"
                placeholder="— select —"
                @update:model-value="(v) => store.setDiffSource('tag', v)"
              />
            </div>
          </div>

          <div v-if="store.diffSource === 'commit'" class="fm-diff__source fm-diff__source--commit">
            <label class="fm-diff__label">Commit:</label>
            <div class="fm-diff__select-wrap fm-diff__select-wrap--wide">
              <CustomSelect
                :model-value="store.diffRevisionRef"
                :options="commitOptions"
                placeholder="— pick from log —"
                @update:model-value="(v) => store.setDiffSource('commit', v)"
              />
            </div>
            <input
              type="text"
              class="fm-diff__input"
              placeholder="…or paste commit hash"
              :value="manualCommit"
              @input="manualCommit = $event.target.value"
              @keydown.enter="applyManualCommit"
            />
          </div>

          <div class="fm-diff__spacer"></div>

          <div class="fm-diff__nav">
            <button
              type="button"
              class="fm-diff__btn"
              :disabled="!changeCount"
              title="Previous change (Shift+F7)"
              @click="goToChange(-1)"
            >
              ◀
            </button>
            <span class="fm-diff__nav-counter" :class="{ 'fm-diff__nav-counter--empty': !changeCount }">
              <template v-if="changeCount">{{ currentChangeIndex + 1 }} / {{ changeCount }}</template>
              <template v-else>no changes</template>
            </span>
            <button
              type="button"
              class="fm-diff__btn"
              :disabled="!changeCount"
              title="Next change (F7)"
              @click="goToChange(1)"
            >
              ▶
            </button>
          </div>

          <div class="fm-diff__layout-toggle">
            <label class="fm-diff__label">Layout:</label>
            <button
              type="button"
              :class="['fm-diff__btn', sideBySide && 'fm-diff__btn--active']"
              @click="sideBySide = true"
            >
              Side-by-side
            </button>
            <button
              type="button"
              :class="['fm-diff__btn', !sideBySide && 'fm-diff__btn--active']"
              @click="sideBySide = false"
            >
              Inline
            </button>
          </div>

          <button type="button" class="fm-diff__btn" title="Refresh" @click="store.runDiff()">↻</button>
        </div>

        <div class="fm-diff__labels">
          <div class="fm-diff__label-pane fm-diff__label-pane--left">
            <span class="fm-diff__label-tag">old</span>
            {{ store.diffPayload?.leftLabel || labelForSource() }}
            <span v-if="store.diffPayload?.leftMissing" class="fm-diff__label-missing">(does not exist)</span>
          </div>
          <div class="fm-diff__label-pane fm-diff__label-pane--right">
            <span class="fm-diff__label-tag">new</span>
            {{ store.diffPayload?.rightLabel || (store.diffSource === "staged" ? "staged" : "working tree") }}
            <span v-if="store.diffPayload?.rightMissing" class="fm-diff__label-missing">(does not exist)</span>
          </div>
        </div>

        <div ref="bodyRef" class="fm-diff__body">
          <div v-if="store.diffLoading" class="fm-diff__loading">Loading diff…</div>
          <div
            v-else-if="store.diffPayload && !store.diffPayload.ok && store.diffPayload.leftError"
            class="fm-diff__error"
          >
            {{ store.diffPayload.leftError }}
          </div>
          <div
            ref="containerRef"
            class="fm-diff__monaco"
            :class="{ 'fm-diff__monaco--hidden': store.diffLoading }"
          ></div>
        </div>

        <footer class="fm-diff__footer">
          <span class="fm-diff__hint">
            <kbd>Esc</kbd> close · synced scroll · <kbd>F7</kbd> next change · <kbd>Shift+F7</kbd> previous change
          </span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import "../../../app/monaco-setup.js";
import * as monaco from "monaco-editor";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import CustomSelect from "../../common/CustomSelect.vue";

const store = useFileManagerStore();

const sourceOptions = [
  { value: "head", label: "HEAD (current commit)" },
  { value: "staged", label: "Staged (index)" },
  { value: "branch", label: "Branch…" },
  { value: "commit", label: "Commit…" },
  { value: "tag", label: "Tag…" },
];

const branchOptions = computed(() => (store.diffRefs.branches || []).map((b) => ({ value: b, label: b })));
const tagOptions = computed(() => (store.diffRefs.tags || []).map((t) => ({ value: t, label: t })));
const commitOptions = computed(() =>
  (store.diffRefs.commits || []).map((c) => ({
    value: c.hash,
    label: `${c.shortHash} · ${c.subject} (${formatDate(c.date)})`,
  })),
);
const containerRef = ref(null);
const bodyRef = ref(null);
const sideBySide = ref(true);
const manualCommit = ref("");

const changes = ref([]);
const currentChangeIndex = ref(-1);
const changeCount = computed(() => changes.value.length);

let diffEditor = null;
let resizeObserver = null;
let escListener = null;
let updateDiffDisposable = null;

function labelForSource() {
  switch (store.diffSource) {
    case "head":
      return "HEAD";
    case "staged":
      return "HEAD";
    case "branch":
      return store.diffRevisionRef || "branch";
    case "commit":
      return store.diffRevisionRef ? `commit ${store.diffRevisionRef.slice(0, 8)}` : "commit";
    case "tag":
      return store.diffRevisionRef || "tag";
    default:
      return "";
  }
}

function onSourceChange(value) {
  manualCommit.value = "";
  if (value === "head" || value === "staged") {
    store.setDiffSource(value);
    return;
  }
  // Branch / commit / tag — wait for user to pick a ref
  store.diffSource = value;
  store.diffRevisionRef = "";
  store.diffPayload = null;
}

function applyManualCommit() {
  const value = manualCommit.value.trim();
  if (!value) return;
  store.setDiffSource("commit", value);
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function ensureEditor() {
  if (!containerRef.value || diffEditor) return;
  diffEditor = monaco.editor.createDiffEditor(containerRef.value, {
    theme: "vs-dark",
    readOnly: true,
    renderSideBySide: sideBySide.value,
    enableSplitViewResizing: true,
    automaticLayout: false,
    minimap: { enabled: false },
    lineNumbers: "on",
    fontSize: 12,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
    scrollBeyondLastLine: false,
    renderOverviewRuler: true,
    diffWordWrap: "off",
    wordWrap: "off",
    renderWhitespace: "boundary",
    ignoreTrimWhitespace: false,
    diffAlgorithm: "advanced",
    // The synced scroll is the default for Monaco's diff editor — both panes
    // scroll together when scrolling either side. enableSplitViewResizing
    // lets the user drag the divider between the two panes.
  });

  resizeObserver = new ResizeObserver(() => layoutEditor());
  if (bodyRef.value) resizeObserver.observe(bodyRef.value);
  layoutEditor();

  // Whenever Monaco recomputes the diff, refresh our change list. This fires
  // after model swaps and after live edits (here it's read-only, so really
  // just after model swaps).
  updateDiffDisposable = diffEditor.onDidUpdateDiff(() => refreshChangeList());
}

function refreshChangeList() {
  if (!diffEditor) {
    changes.value = [];
    currentChangeIndex.value = -1;
    return;
  }
  const list = diffEditor.getLineChanges() || [];
  changes.value = list;
  currentChangeIndex.value = list.length ? 0 : -1;
}

function goToChange(direction) {
  if (!diffEditor || !changes.value.length) return;
  const total = changes.value.length;
  const next = (currentChangeIndex.value + direction + total) % total;
  currentChangeIndex.value = next;
  const change = changes.value[next];
  // Prefer the modified line; fall back to original if a pure deletion.
  const targetLine =
    change.modifiedStartLineNumber > 0 ? change.modifiedStartLineNumber : change.originalStartLineNumber;
  const modifiedEditor = diffEditor.getModifiedEditor();
  modifiedEditor.revealLineInCenter(targetLine);
  modifiedEditor.setPosition({ lineNumber: targetLine, column: 1 });
}

function layoutEditor() {
  if (!diffEditor || !bodyRef.value || !containerRef.value) return;
  const rect = bodyRef.value.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w <= 0 || h <= 0) return;
  containerRef.value.style.width = `${w}px`;
  containerRef.value.style.height = `${h}px`;
  diffEditor.layout({ width: w, height: h });
}

function applyDiffModels() {
  if (!diffEditor) return;
  const payload = store.diffPayload;
  if (!payload) {
    diffEditor.setModel(null);
    return;
  }
  const oldModel = monaco.editor.createModel(payload.leftContent || "", payload.language || "plaintext");
  const newModel = monaco.editor.createModel(payload.rightContent || "", payload.language || "plaintext");
  // Dispose previous models to avoid leaks
  const previous = diffEditor.getModel();
  diffEditor.setModel({ original: oldModel, modified: newModel });
  if (previous?.original) previous.original.dispose();
  if (previous?.modified) previous.modified.dispose();
}

watch(
  () => store.diffOpen,
  async (open) => {
    if (open) {
      await nextTick();
      ensureEditor();
      applyDiffModels();
      layoutEditor();
    } else {
      // Tear down on close. Detach models from the editor BEFORE disposing
      // them — Monaco asserts that a TextModel attached to a DiffEditorWidget
      // must not be disposed while still attached.
      if (diffEditor) {
        const model = diffEditor.getModel();
        diffEditor.setModel(null);
        if (model?.original) model.original.dispose();
        if (model?.modified) model.modified.dispose();
      }
    }
  },
);

watch(
  () => store.diffPayload,
  () => {
    if (store.diffOpen) applyDiffModels();
  },
);

watch(sideBySide, (value) => {
  if (diffEditor) diffEditor.updateOptions({ renderSideBySide: value });
  layoutEditor();
});

onMounted(() => {
  escListener = (event) => {
    if (!store.diffOpen) return;
    if (event.key === "Escape") {
      store.closeDiff();
    } else if (event.key === "F7") {
      event.preventDefault();
      goToChange(event.shiftKey ? -1 : 1);
    }
  };
  document.addEventListener("keydown", escListener);
});

onBeforeUnmount(() => {
  if (escListener) document.removeEventListener("keydown", escListener);
  escListener = null;
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (updateDiffDisposable) {
    updateDiffDisposable.dispose();
    updateDiffDisposable = null;
  }
  if (diffEditor) {
    const model = diffEditor.getModel();
    diffEditor.setModel(null);
    if (model?.original) model.original.dispose();
    if (model?.modified) model.modified.dispose();
    diffEditor.dispose();
    diffEditor = null;
  }
});
</script>

<style scoped>
.fm-diff-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 9000;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  padding: 24px;
}

.fm-diff-modal {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--panel, #1e1e1e);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow, 0 12px 36px rgba(0, 0, 0, 0.5));
  overflow: hidden;
  min-height: 0;
  min-width: 0;
}

.fm-diff__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}

.fm-diff__title {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.fm-diff__filename {
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fm-diff__path {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fm-diff__close {
  background: none;
  border: 1px solid transparent;
  color: var(--muted);
  font-size: 22px;
  width: 28px;
  height: 28px;
  cursor: pointer;
  border-radius: 4px;
  line-height: 1;
}

.fm-diff__close:hover {
  background: var(--border);
  color: var(--text);
}

.fm-diff__controls {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.fm-diff__source {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.fm-diff__source--commit {
  flex-wrap: wrap;
}

.fm-diff__label {
  color: var(--muted);
  font-size: 11px;
}

.fm-diff__select-wrap {
  width: 200px;
}

.fm-diff__select-wrap--wide {
  width: 320px;
  max-width: 50vw;
}

.fm-diff__input {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 12px;
  padding: 3px 6px;
  outline: none;
  width: 200px;
}

.fm-diff__input:focus {
  border-color: var(--accent);
}

.fm-diff__layout-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.fm-diff__nav {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
}

.fm-diff__nav-counter {
  font-size: 11px;
  color: var(--text);
  min-width: 56px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.fm-diff__nav-counter--empty {
  color: var(--muted);
  font-style: italic;
}

.fm-diff__btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.fm-diff__btn:hover:not(:disabled) {
  background: var(--border);
  color: var(--text);
}

.fm-diff__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.fm-diff__btn--active {
  background: rgba(255, 164, 36, 0.15);
  color: var(--accent);
  border-color: var(--accent);
}

.fm-diff__spacer {
  flex: 1;
}

.fm-diff__labels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  font-size: 11px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.fm-diff__label-pane {
  padding: 4px 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}

.fm-diff__label-pane--left {
  border-right: 1px solid var(--border);
}

.fm-diff__label-tag {
  background: var(--border);
  color: var(--text);
  padding: 0 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.fm-diff__label-missing {
  color: var(--fm-status-conflict, #e26b6b);
  font-weight: 600;
}

.fm-diff__body {
  flex: 1;
  position: relative;
  min-height: 0;
  overflow: hidden;
}

.fm-diff__monaco {
  width: 100%;
  height: 100%;
}

.fm-diff__monaco--hidden {
  visibility: hidden;
}

.fm-diff__loading,
.fm-diff__error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
}

.fm-diff__error {
  color: var(--fm-status-conflict, #e26b6b);
}

.fm-diff__footer {
  padding: 4px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.fm-diff__hint kbd {
  background: var(--border);
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
  font-family: inherit;
}
</style>
