<template>
  <div class="git-log-wrap">
    <table class="git-log-table">
      <colgroup>
        <col class="git-log-col--hash" />
        <col class="git-log-col--msg" />
        <col class="git-log-col--date" />
        <col class="git-log-col--author" />
      </colgroup>
      <thead>
        <tr>
          <th
            v-for="col in columns"
            :key="col.key"
            :class="['git-log-table__head', sortKey === col.key && 'git-log-table__head--sorted']"
            @click="toggleSort(col.key)"
          >
            {{ col.label }}
            <span v-if="sortKey === col.key" class="git-log-table__sort-arrow">{{
              sortDir === "asc" ? "▲" : "▼"
            }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="entry in sortedCommits"
          :key="entry.shortHash"
          :class="{
            'git-log-table--active': selectedCommit === entry.shortHash,
            'git-log-table--unpushed': aheadCount > 0 && entry._originalIndex < aheadCount,
          }"
          :title="entry.subject"
          @click="$emit('select', entry.shortHash)"
        >
          <td class="git-log-table__hash">{{ entry.shortHash }}</td>
          <td class="git-log-table__msg">
            <span v-if="aheadCount > 0 && entry._originalIndex < aheadCount" class="git-log-unpushed-badge"
              >unpushed</span
            >
            {{ entry.subject }}
          </td>
          <td class="git-log-table__date">{{ entry.relativeDate }}</td>
          <td class="git-log-table__author">{{ entry.author || "" }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="!sortedCommits.length" class="git-card__hint">No commit history available yet.</p>
    <div v-if="hasMore" class="git-log-loadmore">
      <button
        type="button"
        class="git-btn"
        :disabled="loadingMore"
        :title="`Load the next ${pageSize} commits from git log.`"
        @click="$emit('load-more')"
      >
        {{ loadingMore ? "Loading…" : `Load ${pageSize} more` }}
      </button>
      <span class="git-log-loadmore__hint">{{ sortedCommits.length }} commits shown</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commits?: any[];
    selectedCommit?: string;
    aheadCount?: number;
    hasMore?: boolean;
    loadingMore?: boolean;
    pageSize?: number;
  }>(),
  { commits: () => [], selectedCommit: "", aheadCount: 0, hasMore: false, loadingMore: false, pageSize: 100 },
);

defineEmits<{
  (e: "select", hash: string): void;
  (e: "load-more"): void;
}>();

const columns = [
  { key: "hash", label: "Hash", field: "shortHash" },
  { key: "msg", label: "Message", field: "subject" },
  { key: "date", label: "Date", field: "relativeDate" },
  { key: "author", label: "Author", field: "author" },
];

// --- Sorting ---
const sortKey = ref<string>("");
const sortDir = ref<string>("asc");

function toggleSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDir.value = key === "date" ? "desc" : "asc";
  }
}

// Tag each commit with its original index so we can identify unpushed commits after sorting
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const indexedCommits = computed(() => props.commits.map((entry: any, i: number) => ({ ...entry, _originalIndex: i })));

const sortedCommits = computed(() => {
  if (!sortKey.value) return indexedCommits.value;

  const col = columns.find((c) => c.key === sortKey.value);
  if (!col) return indexedCommits.value;

  const field = col.field;
  const dir = sortDir.value === "asc" ? 1 : -1;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [...indexedCommits.value].sort((a: any, b: any) => {
    const va = String(a[field] || "").toLowerCase();
    const vb = String(b[field] || "").toLowerCase();
    return va < vb ? -dir : va > vb ? dir : 0;
  });
});
</script>

<style scoped>
.git-log-wrap {
  overflow: auto;
  flex: 1;
  min-height: 0;
}

/* Column widths via <col> — user can resize via native th resize handle */
.git-log-col--hash {
  width: 72px;
}
.git-log-col--msg {
  width: auto;
}
.git-log-col--date {
  width: 110px;
}
.git-log-col--author {
  width: 120px;
}

.git-log-table__head {
  cursor: pointer;
  user-select: none;
  overflow: hidden;
  resize: horizontal;
}

.git-log-table__head:hover {
  background: rgba(255, 255, 255, 0.04);
}

.git-log-table__head--sorted {
  color: var(--accent);
}

.git-log-table__sort-arrow {
  font-size: 9px;
  margin-left: 4px;
  opacity: 0.7;
}

.git-log-table--unpushed {
  background: rgba(255, 164, 36, 0.06);
  border-left: 2px solid var(--accent);
}

.git-log-loadmore {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  position: sticky;
  bottom: 0;
  background: rgba(var(--tint), 0.05);
  flex: 0 0 auto;
}

.git-log-loadmore__hint {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.git-log-unpushed-badge {
  display: inline-block;
  font-size: 9px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(255, 164, 36, 0.15);
  color: var(--accent);
  margin-right: 6px;
  vertical-align: middle;
  line-height: 16px;
}
</style>
