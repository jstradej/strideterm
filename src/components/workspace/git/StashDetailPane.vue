<template>
  <article class="git-card git-card--diff stash-detail">
    <template v-if="entry">
      <div class="section-head">
        <div>
          <p class="eyebrow" :title="stashRefTooltip(entry.ref)">{{ entry.ref }}</p>
          <h3>{{ entry.customMessage || (entry.isWipDefault ? "WIP" : "(no message)") }}</h3>
        </div>
      </div>
      <div class="stash-detail__meta">
        <span>On {{ entry.branch || "(detached)" }}</span>
        <span>·</span>
        <span>{{ formattedDate }}</span>
        <span>·</span>
        <span>{{ entry.fileCount }} file{{ entry.fileCount === 1 ? "" : "s" }}</span>
      </div>
      <div v-if="entry.baseCommit" class="stash-detail__base">
        base: <code>{{ entry.baseCommit }}</code> {{ entry.baseSubject }}
      </div>

      <div class="stash-detail__actions">
        <button
          type="button"
          class="button button--small"
          :disabled="!!busy"
          :title="STASH_TOOLTIPS.apply"
          @click="emit('apply')"
        >
          {{ busy === "apply" ? "Applying…" : "Apply" }}
        </button>
        <button
          type="button"
          class="button button--small button--ghost"
          :disabled="!!busy"
          :title="STASH_TOOLTIPS.pop"
          @click="emit('pop')"
        >
          {{ busy === "pop" ? "Popping…" : "Pop" }}
        </button>
        <button
          type="button"
          class="button button--small button--danger"
          :disabled="!!busy"
          :title="STASH_TOOLTIPS.drop"
          @click="emit('drop')"
        >
          {{ busy === "drop" ? "Dropping…" : "Drop" }}
        </button>
        <span class="stash-detail__actions-spacer" />
        <button
          type="button"
          class="button button--small button--ghost"
          :disabled="!!busy"
          :title="STASH_TOOLTIPS.export"
          @click="emit('export')"
        >
          {{ busy === "export" ? "Exporting…" : "Export .patch" }}
        </button>
        <button
          type="button"
          class="button button--small button--ghost"
          :disabled="!!busy"
          :title="STASH_TOOLTIPS.copy"
          @click="emit('copy')"
        >
          Copy ref
        </button>
      </div>

      <ul class="stash-detail__files">
        <li
          v-for="f in files"
          :key="f.path"
          :class="['stash-detail__file', f.path === selectedFile && 'stash-detail__file--active']"
          :title="(f.oldPath ? f.oldPath + ' → ' + f.path : f.path) + ' — click to preview its changes'"
          @click="emit('select-file', f.path)"
        >
          <span :class="['stash-detail__code', `stash-detail__code--${f.status}`]">{{ f.code }}</span>
          <span class="stash-detail__path">{{ f.oldPath ? `${f.oldPath} → ${f.path}` : f.path }}</span>
          <span v-if="f.isBinary" class="stash-detail__binary">binary</span>
          <span v-else class="stash-detail__stat">
            <span v-if="f.additions" class="stash-detail__add">+{{ f.additions }}</span>
            <span v-if="f.deletions" class="stash-detail__del">-{{ f.deletions }}</span>
          </span>
        </li>
      </ul>

      <div class="git-monaco-host stash-detail__diff">
        <p v-if="!selectedFile" class="git-card__hint">Select a file to preview its diff.</p>
        <p v-else-if="selectedIsBinary" class="git-card__hint">Binary file — no preview.</p>
        <MonacoDiffPanel v-else :payload="diffPayload" :loading="diffLoading" />
      </div>
    </template>
    <p v-else class="git-card__hint stash-detail__placeholder">Select a stash to see its details.</p>
  </article>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { useGitStashStore } from "../../../stores/git-stash.js";
import type { StashEntry, StashFile } from "../../../stores/git-stash.js";
import { STASH_TOOLTIPS, stashRefTooltip } from "./stash-tooltips.js";

const MonacoDiffPanel = defineAsyncComponent(() => import("../../shared/MonacoDiffPanel.vue"));

const props = defineProps<{
  workspaceId: string;
  entry: StashEntry | null;
  files: StashFile[];
  selectedFile: string;
  busy: string;
}>();

const emit = defineEmits<{
  "select-file": [path: string];
  apply: [];
  pop: [];
  drop: [];
  export: [];
  copy: [];
}>();

const stashStore = useGitStashStore();
const diffLoading = ref(false);

const formattedDate = computed(() => {
  if (!props.entry?.date) return "";
  try {
    return new Date(props.entry.date).toLocaleString();
  } catch {
    return props.entry.date;
  }
});

const selectedIsBinary = computed(() => props.files.find((f) => f.path === props.selectedFile)?.isBinary ?? false);

const diffPayload = computed(() => {
  if (!props.entry || !props.selectedFile) return null;
  return stashStore.get(props.workspaceId).diffByRefAndPath[`${props.entry.ref}::${props.selectedFile}`] || null;
});

watch(
  () => [props.entry?.ref, props.selectedFile],
  async ([ref, file]) => {
    if (!ref || !file || selectedIsBinary.value) return;
    if (diffPayload.value) return;
    diffLoading.value = true;
    try {
      await stashStore.loadDiff(props.workspaceId, ref, file);
    } finally {
      diffLoading.value = false;
    }
  },
  { immediate: true },
);
</script>

<style scoped>
.stash-detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  flex: 1;
  overflow: hidden;
}

.stash-detail__meta {
  display: flex;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}

.stash-detail__base {
  font-size: 12px;
  color: var(--muted);
  margin: 4px 0;
}

.stash-detail__base code {
  font-family: var(--mono, monospace);
}

.stash-detail__files {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  max-height: 30%;
  overflow-y: auto;
  font-size: 12px;
}

.stash-detail__file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
}

.stash-detail__file:hover {
  background: var(--hover, rgba(255, 255, 255, 0.06));
}

.stash-detail__file--active {
  background: var(--accent-soft, rgba(80, 140, 255, 0.18));
}

.stash-detail__code {
  font-family: var(--mono, monospace);
  width: 16px;
  text-align: center;
  font-weight: 600;
}

.stash-detail__code--added,
.stash-detail__code--untracked {
  color: var(--success, #6cc24a);
}

.stash-detail__code--deleted {
  color: var(--danger, #d9534f);
}

.stash-detail__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stash-detail__binary {
  color: var(--muted);
  font-style: italic;
}

.stash-detail__add {
  color: var(--success, #6cc24a);
  margin-right: 6px;
}

.stash-detail__del {
  color: var(--danger, #d9534f);
}

.stash-detail__diff {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}

.stash-detail__diff > .git-card__hint {
  margin: auto;
  color: var(--muted);
}

.stash-detail__actions {
  display: flex;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  margin: 8px 0;
  flex-wrap: wrap;
}

.stash-detail__actions-spacer {
  margin-left: auto;
}

.stash-detail__placeholder {
  margin: auto;
}
</style>
