<template>
  <div class="log-toolbar">
    <!-- Pause / Resume -->
    <button
      type="button"
      :class="['log-toolbar__btn', paused && 'log-toolbar__btn--accent']"
      :title="paused ? 'Resume rendering (live)' : 'Pause rendering (backend keeps streaming)'"
      @click="emit('toggle-pause')"
    >
      <span class="log-toolbar__icon">{{ paused ? "▶" : "⏸" }}</span>
      <span class="log-toolbar__label">{{ paused ? "Resume" : "Pause" }}</span>
    </button>

    <!-- Clear -->
    <button type="button" class="log-toolbar__btn" title="Clear xterm buffer" @click="emit('clear')">
      <span class="log-toolbar__icon">∅</span>
      <span class="log-toolbar__label">Clear</span>
    </button>

    <!-- Copy all -->
    <button
      type="button"
      class="log-toolbar__btn"
      :title="`Copy entire scrollback (${lineCount} lines, ${formatBytes(byteCount)})`"
      @click="emit('copy')"
    >
      <span class="log-toolbar__icon">⧉</span>
      <span class="log-toolbar__label">{{ copied ? "Copied" : "Copy" }}</span>
    </button>

    <!-- Download -->
    <button type="button" class="log-toolbar__btn" title="Download scrollback as .log file" @click="emit('download')">
      <span class="log-toolbar__icon">↓</span>
      <span class="log-toolbar__label">Save</span>
    </button>

    <!-- Search -->
    <div class="log-toolbar__search">
      <input
        ref="searchEl"
        v-model="searchInput"
        type="text"
        class="log-toolbar__search-input"
        placeholder="Search…"
        spellcheck="false"
        @input="emit('search', searchInput)"
        @keydown.enter.prevent="searchNext"
        @keydown.escape.prevent="clearSearch"
      />
      <span v-if="searchInput" class="log-toolbar__search-count">
        {{ searchTotal === 0 ? "no matches" : `${searchIndex + 1}/${searchTotal}` }}
      </span>
      <button
        type="button"
        class="log-toolbar__search-btn"
        :disabled="searchTotal === 0"
        title="Previous match (Shift+Enter)"
        @click="emit('search-prev')"
      >
        ↑
      </button>
      <button
        type="button"
        class="log-toolbar__search-btn"
        :disabled="searchTotal === 0"
        title="Next match (Enter)"
        @click="emit('search-next')"
      >
        ↓
      </button>
    </div>

    <!-- Tail size -->
    <label class="log-toolbar__select" title="Initial scrollback to load when the stream starts">
      <span class="log-toolbar__select-label">Tail</span>
      <select :value="String(tail)" @change="onTailChange">
        <option value="100">100</option>
        <option value="1000">1k</option>
        <option value="10000">10k</option>
        <option value="all">all</option>
      </select>
    </label>

    <!-- Timestamps toggle -->
    <button
      type="button"
      :class="['log-toolbar__toggle', timestamps && 'log-toolbar__toggle--on']"
      :title="timestamps ? 'Hide docker --timestamps prefix' : 'Show docker --timestamps prefix (restarts stream)'"
      @click="emit('toggle-timestamps')"
    >
      <span class="log-toolbar__icon">🕒</span>
      <span class="log-toolbar__label">Time</span>
    </button>

    <!-- Stats / counts -->
    <span class="log-toolbar__stats" :title="`Total received from this stream session`">
      <span class="log-toolbar__stat-num">{{ formatNum(lineCount) }}</span>
      <span class="log-toolbar__stat-unit">lines</span>
      <span class="log-toolbar__stat-sep">·</span>
      <span class="log-toolbar__stat-num">{{ formatBytes(byteCount) }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  paused: boolean;
  timestamps: boolean;
  tail: number | "all";
  lineCount: number;
  byteCount: number;
  searchIndex: number;
  searchTotal: number;
  copied?: boolean;
}>();

const emit = defineEmits<{
  "toggle-pause": [];
  clear: [];
  copy: [];
  download: [];
  search: [q: string];
  "search-next": [];
  "search-prev": [];
  "tail-change": [tail: number | "all"];
  "toggle-timestamps": [];
}>();

const searchInput = ref("");
const searchEl = ref<HTMLInputElement | null>(null);

// Allow parent to focus the search box programmatically (Ctrl+F).
function focusSearch(): void {
  searchEl.value?.focus();
  searchEl.value?.select();
}
defineExpose({ focusSearch });

function searchNext(e: KeyboardEvent): void {
  if (e.shiftKey) emit("search-prev");
  else emit("search-next");
}

function clearSearch(): void {
  searchInput.value = "";
  emit("search", "");
}

function onTailChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  emit("tail-change", v === "all" ? "all" : Number(v));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function formatNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Keep input in sync when parent clears it (e.g. on tab switch).
watch(
  () => props.searchTotal,
  (v) => {
    if (v === 0 && !searchInput.value) {
      // no-op; just defensively clear input when the parent zeros search
    }
  },
);
</script>

<style scoped>
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  background: var(--bg-secondary, #18181b);
  flex-shrink: 0;
  flex-wrap: wrap;
  min-height: 36px;
}

.log-toolbar__btn,
.log-toolbar__toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
  color: var(--text-dim, #aaa);
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  min-height: 28px;
}

.log-toolbar__btn:hover,
.log-toolbar__toggle:hover {
  background: rgba(255, 255, 255, 0.07);
  color: var(--text-primary, #e2e8f0);
}

.log-toolbar__btn--accent {
  background: rgba(99, 179, 237, 0.15);
  border-color: rgba(99, 179, 237, 0.35);
  color: var(--accent, #63b3ed);
}

.log-toolbar__toggle--on {
  background: rgba(99, 179, 237, 0.15);
  border-color: rgba(99, 179, 237, 0.35);
  color: var(--accent, #63b3ed);
}

.log-toolbar__icon {
  font-size: 12px;
  line-height: 1;
}

.log-toolbar__search {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
}

.log-toolbar__search-input {
  width: 140px;
  padding: 3px 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--text-primary, #e2e8f0);
  border-radius: 3px;
  font-size: 11px;
  outline: none;
  min-height: 26px;
}
.log-toolbar__search-input:focus {
  border-color: var(--accent, #63b3ed);
  background: rgba(255, 255, 255, 0.06);
}

.log-toolbar__search-count {
  font-size: 10px;
  color: var(--text-dim, #888);
  padding: 0 4px;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  min-width: 50px;
  text-align: center;
}

.log-toolbar__search-btn {
  width: 22px;
  height: 26px;
  padding: 0;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
  color: var(--text-dim, #aaa);
  border-radius: 3px;
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
}
.log-toolbar__search-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.log-toolbar__search-btn:not(:disabled):hover {
  color: var(--accent, #63b3ed);
}

.log-toolbar__select {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-dim, #aaa);
}
.log-toolbar__select-label {
  text-transform: uppercase;
  letter-spacing: 0.3px;
  font-size: 9px;
}
.log-toolbar__select select {
  background: transparent;
  border: 0;
  color: var(--text-primary, #e2e8f0);
  font-size: 11px;
  outline: none;
  padding: 0;
  cursor: pointer;
  font-family: inherit;
}

.log-toolbar__stats {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim, #888);
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-variant-numeric: tabular-nums;
}
.log-toolbar__stat-num {
  color: var(--text-primary, #d8e4f5);
}
.log-toolbar__stat-unit,
.log-toolbar__stat-sep {
  color: var(--text-dim, #666);
}

/* Labels collapse on mid widths; icons stay legible. */
@media (max-width: 900px) {
  .log-toolbar__label {
    display: none;
  }
  .log-toolbar__search-input {
    width: 110px;
  }
}

@media (max-width: 600px) {
  .log-toolbar {
    gap: 3px;
    padding: 4px 6px;
  }
  .log-toolbar__btn,
  .log-toolbar__toggle {
    padding: 6px 8px;
    min-height: 36px;
  }
  .log-toolbar__search {
    flex: 1 1 100%;
    order: 99;
    margin-left: 0;
  }
  .log-toolbar__search-input {
    flex: 1;
    width: auto;
    min-height: 36px;
  }
  .log-toolbar__stats {
    flex: 1 1 100%;
    order: 100;
    justify-content: flex-end;
  }
}
</style>
