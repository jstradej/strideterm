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
            <span v-if="sortKey === col.key" class="git-log-table__sort-arrow">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="entry in sortedCommits"
          :key="entry.shortHash"
          :class="{ 'git-log-table--active': selectedCommit === entry.shortHash }"
          :title="entry.subject"
          @click="$emit('select', entry.shortHash)"
        >
          <td class="git-log-table__hash">{{ entry.shortHash }}</td>
          <td class="git-log-table__msg">{{ entry.subject }}</td>
          <td class="git-log-table__date">{{ entry.relativeDate }}</td>
          <td class="git-log-table__author">{{ entry.author || '' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="!sortedCommits.length" class="git-card__hint">No commit history available yet.</p>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";

const props = defineProps({
  commits: { type: Array, default: () => [] },
  selectedCommit: { type: String, default: "" },
});

defineEmits(["select"]);

const columns = [
  { key: "hash", label: "Hash", field: "shortHash" },
  { key: "msg", label: "Message", field: "subject" },
  { key: "date", label: "Date", field: "relativeDate" },
  { key: "author", label: "Author", field: "author" },
];

// --- Sorting ---
const sortKey = ref("");
const sortDir = ref("asc");

function toggleSort(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDir.value = key === "date" ? "desc" : "asc";
  }
}

const sortedCommits = computed(() => {
  if (!sortKey.value) return props.commits;

  const col = columns.find((c) => c.key === sortKey.value);
  if (!col) return props.commits;

  const field = col.field;
  const dir = sortDir.value === "asc" ? 1 : -1;

  return [...props.commits].sort((a, b) => {
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
.git-log-col--hash { width: 72px; }
.git-log-col--msg { width: auto; }
.git-log-col--date { width: 110px; }
.git-log-col--author { width: 120px; }

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
</style>
