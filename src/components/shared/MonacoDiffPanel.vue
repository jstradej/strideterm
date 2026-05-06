<template>
  <div class="mdp">
    <div v-if="!hideLabels" class="mdp__labels">
      <div class="mdp__label-pane mdp__label-pane--left">
        <span class="mdp__label-tag">old</span>
        {{ payload?.leftLabel || "" }}
        <span v-if="payload?.leftMissing" class="mdp__label-missing">(does not exist)</span>
      </div>
      <div class="mdp__label-pane mdp__label-pane--right">
        <span class="mdp__label-tag">new</span>
        {{ payload?.rightLabel || "" }}
        <span v-if="payload?.rightMissing" class="mdp__label-missing">(does not exist)</span>
      </div>
    </div>

    <div v-if="!hideToolbar" class="mdp__toolbar">
      <div class="mdp__nav">
        <button
          type="button"
          class="mdp__btn"
          :disabled="!changeCount"
          title="Jump the diff cursor to the previous changed hunk and scroll it into view. Keyboard shortcut: Shift+F7."
          @click="goToChange(-1)"
        >
          ◀
        </button>
        <span class="mdp__nav-counter" :class="{ 'mdp__nav-counter--empty': !changeCount }">
          <template v-if="changeCount">{{ currentChangeIndex + 1 }} / {{ changeCount }}</template>
          <template v-else>no changes</template>
        </span>
        <button
          type="button"
          class="mdp__btn"
          :disabled="!changeCount"
          title="Jump the diff cursor to the next changed hunk and scroll it into view. Keyboard shortcut: F7."
          @click="goToChange(1)"
        >
          ▶
        </button>
      </div>
      <div class="mdp__layout-toggle">
        <button
          type="button"
          :class="['mdp__btn', sideBySide && 'mdp__btn--active']"
          title="Show the diff in two side-by-side panes — old on the left, new on the right. Best for wide screens."
          @click="sideBySide = true"
        >
          Side-by-side
        </button>
        <button
          type="button"
          :class="['mdp__btn', !sideBySide && 'mdp__btn--active']"
          title="Show the diff inline in a single column with red / green markers — better for narrow viewports and easier to read line-by-line."
          @click="sideBySide = false"
        >
          Inline
        </button>
      </div>
    </div>

    <div ref="bodyRef" class="mdp__body">
      <div v-if="loading" class="mdp__overlay">Loading diff…</div>
      <div v-else-if="errorMessage" class="mdp__overlay mdp__overlay--error">{{ errorMessage }}</div>
      <div v-else-if="!payload" class="mdp__overlay mdp__overlay--muted">No diff selected</div>
      <div ref="containerRef" class="mdp__monaco" :class="{ 'mdp__monaco--hidden': loading }"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import "../../app/monaco-setup.js";
import * as monaco from "monaco-editor";

interface DiffPayload {
  leftLabel?: string;
  rightLabel?: string;
  leftMissing?: boolean;
  rightMissing?: boolean;
  leftContent?: string;
  rightContent?: string;
  language?: string;
  ok?: boolean;
  leftError?: string;
}

interface Props {
  payload?: DiffPayload | null;
  loading?: boolean;
  hideLabels?: boolean;
  hideToolbar?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  payload: null,
  loading: false,
  hideLabels: false,
  hideToolbar: false,
});

const containerRef = ref<HTMLDivElement | null>(null);
const bodyRef = ref<HTMLDivElement | null>(null);
const sideBySide = ref(true);
const changes = ref<monaco.editor.ILineChange[]>([]);
const currentChangeIndex = ref(-1);
const changeCount = computed(() => changes.value.length);
const errorMessage = computed(() => {
  const p = props.payload;
  if (!p) return "";
  if (p.ok === false && p.leftError) return p.leftError;
  return "";
});

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
let resizeObserver: ResizeObserver | null = null;
let updateDiffDisposable: monaco.IDisposable | null = null;
let keyListener: ((event: KeyboardEvent) => void) | null = null;

function ensureEditor() {
  if (!containerRef.value || diffEditor) return;
  diffEditor = monaco.editor.createDiffEditor(containerRef.value, {
    theme: "vs-dark",
    readOnly: true,
    renderSideBySide: sideBySide.value,
    enableSplitViewResizing: true,
    automaticLayout: true,
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
  });
  resizeObserver = new ResizeObserver(() => layoutEditor());
  if (bodyRef.value) resizeObserver.observe(bodyRef.value);
  layoutEditor();
  updateDiffDisposable = diffEditor.onDidUpdateDiff(() => refreshChangeList());
}

function layoutEditor() {
  if (!diffEditor || !bodyRef.value) return;
  const rect = bodyRef.value.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w <= 0 || h <= 0) return;
  diffEditor.layout({ width: w, height: h });
}

function applyDiffModels() {
  if (!diffEditor) return;
  const payload = props.payload;
  if (!payload || (payload.ok === false && !payload.leftContent && !payload.rightContent)) {
    const previous = diffEditor.getModel();
    diffEditor.setModel(null);
    if (previous?.original) previous.original.dispose();
    if (previous?.modified) previous.modified.dispose();
    changes.value = [];
    currentChangeIndex.value = -1;
    return;
  }
  const oldModel = monaco.editor.createModel(payload.leftContent || "", payload.language || "plaintext");
  const newModel = monaco.editor.createModel(payload.rightContent || "", payload.language || "plaintext");
  const previous = diffEditor.getModel();
  diffEditor.setModel({ original: oldModel, modified: newModel });
  if (previous?.original) previous.original.dispose();
  if (previous?.modified) previous.modified.dispose();
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

function goToChange(direction: number) {
  if (!diffEditor || !changes.value.length) return;
  const total = changes.value.length;
  const next = (currentChangeIndex.value + direction + total) % total;
  currentChangeIndex.value = next;
  const change = changes.value[next];
  const targetLine =
    change.modifiedStartLineNumber > 0 ? change.modifiedStartLineNumber : change.originalStartLineNumber;
  const modifiedEditor = diffEditor.getModifiedEditor();
  modifiedEditor.revealLineInCenter(targetLine);
  modifiedEditor.setPosition({ lineNumber: targetLine, column: 1 });
}

watch(sideBySide, (value) => {
  if (diffEditor) diffEditor.updateOptions({ renderSideBySide: value });
  layoutEditor();
});

watch(
  () => props.payload,
  () => {
    nextTick(() => {
      ensureEditor();
      applyDiffModels();
      layoutEditor();
    });
  },
);

onMounted(() => {
  nextTick(() => {
    ensureEditor();
    applyDiffModels();
    layoutEditor();
  });
  keyListener = (event) => {
    if (event.key !== "F7") return;
    // Only react if our editor element is in the focused subtree.
    const active = document.activeElement;
    if (!active || !bodyRef.value || !bodyRef.value.contains(active)) return;
    event.preventDefault();
    goToChange(event.shiftKey ? -1 : 1);
  };
  document.addEventListener("keydown", keyListener);
});

onBeforeUnmount(() => {
  if (keyListener) document.removeEventListener("keydown", keyListener);
  keyListener = null;
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

defineExpose({ goToChange });
</script>

<style scoped>
.mdp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.mdp__labels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  font-size: 11px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.mdp__label-pane {
  padding: 4px 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}

.mdp__label-pane--left {
  border-right: 1px solid var(--border);
}

.mdp__label-tag {
  background: var(--border);
  color: var(--text);
  padding: 0 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.mdp__label-missing {
  color: var(--fm-status-conflict, #e26b6b);
  font-weight: 600;
}

.mdp__toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  flex-shrink: 0;
}

.mdp__nav,
.mdp__layout-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mdp__layout-toggle {
  margin-left: auto;
}

.mdp__nav-counter {
  font-size: 11px;
  color: var(--text);
  min-width: 56px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.mdp__nav-counter--empty {
  color: var(--muted);
  font-style: italic;
}

.mdp__btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.mdp__btn:hover:not(:disabled) {
  background: var(--border);
  color: var(--text);
}

.mdp__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mdp__btn--active {
  background: rgba(255, 164, 36, 0.15);
  color: var(--accent);
  border-color: var(--accent);
}

.mdp__body {
  flex: 1;
  position: relative;
  min-height: 0;
  overflow: hidden;
}

.mdp__monaco {
  width: 100%;
  height: 100%;
}

.mdp__monaco--hidden {
  visibility: hidden;
}

.mdp__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
  z-index: 1;
  pointer-events: none;
  background: var(--panel);
}

.mdp__overlay--error {
  color: var(--fm-status-conflict, #e26b6b);
}

.mdp__overlay--muted {
  background: transparent;
  font-style: italic;
}
</style>
