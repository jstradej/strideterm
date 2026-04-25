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

          <button type="button" class="fm-diff__btn" title="Refresh" @click="store.runDiff()">↻</button>
        </div>

        <MonacoDiffPanel :payload="store.diffPayload" :loading="store.diffLoading" class="fm-diff__panel" />

        <footer class="fm-diff__footer">
          <span class="fm-diff__hint">
            <kbd>Esc</kbd> close · <kbd>F7</kbd> next change · <kbd>Shift+F7</kbd> previous change
          </span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import CustomSelect from "../../common/CustomSelect.vue";
import MonacoDiffPanel from "../../shared/MonacoDiffPanel.vue";

const store = useFileManagerStore();
const manualCommit = ref("");

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

function onSourceChange(value) {
  manualCommit.value = "";
  if (value === "head" || value === "staged") {
    store.setDiffSource(value);
    return;
  }
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

let escListener = null;
onMounted(() => {
  escListener = (event) => {
    if (event.key === "Escape" && store.diffOpen) store.closeDiff();
  };
  document.addEventListener("keydown", escListener);
});

onBeforeUnmount(() => {
  if (escListener) document.removeEventListener("keydown", escListener);
  escListener = null;
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

.fm-diff__btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.fm-diff__btn:hover {
  background: var(--border);
  color: var(--text);
}

.fm-diff__spacer {
  flex: 1;
}

.fm-diff__panel {
  flex: 1;
  min-height: 0;
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
