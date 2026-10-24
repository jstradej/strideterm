<template>
  <div
    v-if="store.diffOpen"
    ref="diffRoot"
    class="fm-diff-inline"
    tabindex="-1"
    @keydown.esc.stop.prevent="store.closeDiff()"
  >
    <header class="fm-diff__header">
      <div class="fm-diff__title">
        <span class="fm-diff__filename">{{ store.diffEntry?.name || "" }}</span>
        <span class="fm-diff__path">{{ store.diffEntry?.relativePath || "" }}</span>
      </div>
      <button
        type="button"
        class="fm-diff__close"
        title="Return to the file editor. Keyboard shortcut: Esc."
        @click="store.closeDiff()"
      >
        ← Back to file
      </button>
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
            @update:model-value="(v) => store.setDiffSource('branch', String(v))"
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
            @update:model-value="(v) => store.setDiffSource('tag', String(v))"
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
            @update:model-value="(v) => store.setDiffSource('commit', String(v))"
          />
        </div>
        <input
          type="text"
          class="fm-diff__input"
          placeholder="…or paste commit hash"
          :value="manualCommit"
          @input="manualCommit = ($event.target as HTMLInputElement).value"
          @keydown.enter="applyManualCommit"
        />
      </div>

      <div class="fm-diff__spacer"></div>

      <button
        type="button"
        class="fm-diff__btn"
        title="Re-run git diff for this file against the selected source — picks up new commits or working-tree edits made since the diff was opened."
        @click="store.runDiff()"
      >
        ↻
      </button>
    </div>

    <MonacoDiffPanel
      :payload="store.diffPayload"
      :loading="store.diffLoading"
      :popout-title="store.diffEntry?.relativePath || store.diffEntry?.name || ''"
      class="fm-diff__panel"
    />

    <footer class="fm-diff__footer">
      <span class="fm-diff__hint">
        <kbd>Esc</kbd> close · <kbd>F7</kbd> next change · <kbd>Shift+F7</kbd> previous change
      </span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import CustomSelect from "../../common/CustomSelect.vue";
import MonacoDiffPanel from "../../shared/MonacoDiffPanel.vue";

const store = useFileManagerStore();
const diffRoot = ref<HTMLElement | null>(null);
const manualCommit = ref<string>("");

onMounted(() => diffRoot.value?.focus({ preventScroll: true }));

watch(
  () => store.diffEntry?.relativePath,
  () => {
    manualCommit.value = "";
  },
);

const sourceOptions = [
  { value: "head", label: "HEAD (current commit)" },
  { value: "staged", label: "Staged (index)" },
  { value: "branch", label: "Branch…" },
  { value: "commit", label: "Commit…" },
  { value: "tag", label: "Tag…" },
];

const branchOptions = computed(() => (store.diffRefs.branches || []).map((b: string) => ({ value: b, label: b })));
const tagOptions = computed(() => (store.diffRefs.tags || []).map((t: string) => ({ value: t, label: t })));
const commitOptions = computed(() =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store.diffRefs.commits || []).map((c: any) => ({
    value: c.hash,
    label: `${c.shortHash} · ${c.subject} (${formatDate(c.date)})`,
  })),
);

function onSourceChange(value: string | number) {
  const v = String(value) as "head" | "staged" | "commit" | "branch" | "tag";
  manualCommit.value = "";
  if (v === "head" || v === "staged") {
    store.setDiffSource(v);
    return;
  }
  store.selectDiffMode(v);
}

function applyManualCommit() {
  const value = manualCommit.value.trim();
  if (!value) return;
  store.setDiffSource("commit", value);
}

function formatDate(iso: string) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}
</script>

<style scoped>
.fm-diff-inline {
  container: fm-diff / inline-size;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--panel);
}

.fm-diff__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
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
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
  padding: 4px 8px;
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
  padding: 6px 10px;
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
  padding: 4px 10px;
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

@container fm-diff (max-width: 560px) {
  .fm-diff__header {
    align-items: flex-start;
    padding: 7px 8px;
  }

  .fm-diff__title {
    overflow: hidden;
  }

  .fm-diff__path {
    display: none;
  }

  .fm-diff__close {
    flex: 0 0 auto;
    min-height: 36px;
    white-space: nowrap;
  }

  .fm-diff__controls {
    align-items: stretch;
    gap: 8px;
    padding: 8px;
  }

  .fm-diff__source {
    flex: 1 1 100%;
    min-width: 0;
  }

  .fm-diff__source:not(.fm-diff__source--commit) .fm-diff__select-wrap {
    flex: 1 1 120px;
    width: auto;
    min-width: 0;
  }

  .fm-diff__source--commit .fm-diff__select-wrap--wide {
    flex: 1 1 130px;
    width: auto;
    max-width: none;
    min-width: 0;
  }

  .fm-diff__source--commit .fm-diff__input {
    flex: 1 1 150px;
    width: auto;
    min-width: 0;
  }

  .fm-diff__spacer {
    display: none;
  }

  .fm-diff__btn {
    min-width: 36px;
    min-height: 36px;
    margin-left: auto;
  }

  .fm-diff__footer {
    padding: 6px 8px;
    flex-wrap: wrap;
  }
}

@media (max-height: 500px) {
  .fm-diff__path,
  .fm-diff__footer {
    display: none;
  }

  .fm-diff__header {
    padding-top: 4px;
    padding-bottom: 4px;
  }

  .fm-diff__controls {
    gap: 6px;
    padding-top: 4px;
    padding-bottom: 4px;
  }
}
</style>
