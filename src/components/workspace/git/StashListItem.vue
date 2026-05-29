<template>
  <div :class="['stash-item', selected && 'stash-item--selected']">
    <div class="stash-item__row" tabindex="0" @click="emit('select')" @keydown.enter.prevent="emit('toggle')">
      <button
        type="button"
        class="stash-item__chevron"
        :aria-expanded="expanded"
        :title="expanded ? 'Hide files and quick actions' : 'Show the files in this stash and quick actions'"
        @click.stop="emit('toggle')"
      >
        {{ expanded ? "▾" : "▸" }}
      </button>
      <div class="stash-item__main">
        <div class="stash-item__head">
          <span class="stash-item__ref" :title="refTooltip">{{ entry.ref }}</span>
          <span class="stash-item__age">{{ age }}</span>
          <span v-if="fromOtherBranch" class="workspace-chip workspace-chip--muted" :title="otherBranchHint">
            other branch
          </span>
        </div>
        <div class="stash-item__msg" :title="entry.customMessage || (entry.isWipDefault ? 'WIP (no message)' : '')">
          {{ entry.customMessage || (entry.isWipDefault ? "WIP (no message)" : "(no message)") }}
        </div>
        <div class="stash-item__meta">
          on {{ entry.branch || "(detached)" }} · {{ entry.fileCount }} file{{ entry.fileCount === 1 ? "" : "s" }}
        </div>
      </div>
      <div class="stash-item__kebab">
        <button
          type="button"
          class="workspace-pane__icon-btn"
          title="More actions for this stash"
          @click.stop="menuOpen = !menuOpen"
        >
          ⋮
        </button>
        <div v-if="menuOpen" class="stash-item__menu" @click.stop>
          <button type="button" :title="STASH_TOOLTIPS.apply" @click="run('apply')">Apply</button>
          <button type="button" :title="STASH_TOOLTIPS.pop" @click="run('pop')">Pop</button>
          <button type="button" class="stash-item__menu-danger" :title="STASH_TOOLTIPS.drop" @click="run('drop')">
            Drop
          </button>
          <div class="stash-item__menu-sep"></div>
          <button type="button" :title="STASH_TOOLTIPS.branch" @click="run('branch')">Branch from…</button>
          <button type="button" :title="STASH_TOOLTIPS.export" @click="run('export')">Export .patch</button>
          <button type="button" :title="STASH_TOOLTIPS.copy" @click="run('copy')">Copy ref</button>
        </div>
      </div>
    </div>

    <div v-if="expanded" class="stash-item__expanded">
      <div class="stash-item__actions">
        <button
          type="button"
          class="button button--small"
          :disabled="!!busy"
          :title="STASH_TOOLTIPS.apply"
          @click.stop="emit('apply')"
        >
          {{ busy === "apply" ? "Applying…" : "Apply" }}
        </button>
        <button
          type="button"
          class="button button--small button--ghost"
          :disabled="!!busy"
          :title="STASH_TOOLTIPS.pop"
          @click.stop="emit('pop')"
        >
          {{ busy === "pop" ? "Popping…" : "Pop" }}
        </button>
        <button
          type="button"
          class="button button--small button--danger"
          :disabled="!!busy"
          :title="STASH_TOOLTIPS.drop"
          @click.stop="emit('drop')"
        >
          {{ busy === "drop" ? "Dropping…" : "Drop" }}
        </button>
      </div>
      <ul v-if="files.length" class="stash-item__files">
        <li v-for="f in files" :key="f.path" class="stash-item__file">
          <span :class="['stash-item__code', `stash-item__code--${f.status}`]">{{ f.code }}</span>
          <span class="stash-item__path" :title="f.oldPath ? `${f.oldPath} → ${f.path}` : f.path">{{
            f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
          }}</span>
          <span v-if="f.isBinary" class="stash-item__binary">binary</span>
          <span v-else class="stash-item__stat">
            <span v-if="f.additions" class="stash-item__add">+{{ f.additions }}</span>
            <span v-if="f.deletions" class="stash-item__del">-{{ f.deletions }}</span>
          </span>
        </li>
      </ul>
      <p v-else class="stash-item__empty-files">No file details.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { formatRelativeAge } from "../../../app/relative-age.js";
import type { StashEntry, StashFile } from "../../../stores/git-stash.js";
import { STASH_TOOLTIPS, stashRefTooltip } from "./stash-tooltips.js";

const props = defineProps<{
  entry: StashEntry;
  files: StashFile[];
  selected: boolean;
  expanded: boolean;
  busy: string;
  currentBranch?: string;
}>();

const emit = defineEmits<{
  select: [];
  toggle: [];
  apply: [];
  pop: [];
  drop: [];
  branch: [];
  export: [];
  copy: [];
}>();

const menuOpen = ref(false);
const age = computed(() => formatRelativeAge(props.entry.date));
const refTooltip = computed(() => stashRefTooltip(props.entry.ref));
const fromOtherBranch = computed(
  () => !!props.currentBranch && !!props.entry.branch && props.entry.branch !== props.currentBranch,
);
const otherBranchHint = computed(
  () => `Stashed on '${props.entry.branch}' — applying onto '${props.currentBranch}' may conflict.`,
);

function run(action: "apply" | "pop" | "drop" | "branch" | "export" | "copy") {
  menuOpen.value = false;
  if (action === "apply") emit("apply");
  else if (action === "pop") emit("pop");
  else if (action === "drop") emit("drop");
  else if (action === "branch") emit("branch");
  else if (action === "export") emit("export");
  else emit("copy");
}
</script>

<style scoped>
.stash-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  background: var(--surface, transparent);
}

.stash-item--selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}

.stash-item__row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px;
  cursor: pointer;
}

.stash-item__chevron {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  line-height: 1.4;
}

.stash-item__main {
  flex: 1;
  min-width: 0;
}

.stash-item__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stash-item__ref {
  font-family: var(--mono, monospace);
  font-size: 12px;
  color: var(--muted);
}

.stash-item__age {
  font-size: 11px;
  color: var(--muted);
}

.stash-item__msg {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stash-item__meta {
  font-size: 11px;
  color: var(--muted);
}

.stash-item__kebab {
  position: relative;
}

.stash-item__menu {
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: var(--surface, #1e1e1e);
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 140px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.stash-item__menu button {
  background: none;
  border: none;
  color: var(--text);
  text-align: left;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 12px;
}

.stash-item__menu button:hover {
  background: var(--hover, rgba(255, 255, 255, 0.06));
}

.stash-item__menu button.stash-item__menu-danger {
  color: var(--danger, #d9534f);
}

.stash-item__menu-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.stash-item__expanded {
  padding: 0 8px 8px 26px;
}

.stash-item__actions {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.stash-item__files {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 12px;
}

.stash-item__file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.stash-item__code {
  font-family: var(--mono, monospace);
  width: 16px;
  text-align: center;
  font-weight: 600;
}

.stash-item__code--added,
.stash-item__code--untracked {
  color: var(--success, #6cc24a);
}

.stash-item__code--deleted {
  color: var(--danger, #d9534f);
}

.stash-item__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stash-item__binary {
  color: var(--muted);
  font-style: italic;
}

.stash-item__add {
  color: var(--success, #6cc24a);
  margin-right: 6px;
}

.stash-item__del {
  color: var(--danger, #d9534f);
}

.stash-item__empty-files {
  font-size: 12px;
  color: var(--muted);
  margin: 0;
}
</style>
