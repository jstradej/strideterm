<template>
  <div class="azure-audit-log">
    <!-- Filters -->
    <div class="azure-audit-log__filters">
      <select v-model="filterCategory" class="azure-audit-log__select">
        <option value="">All operations</option>
        <option value="read">Read</option>
        <option value="write">Write</option>
      </select>
      <select v-model="filterSuccess" class="azure-audit-log__select">
        <option value="">All status</option>
        <option value="true">Success</option>
        <option value="false">Error</option>
      </select>
      <select v-model="filterSource" class="azure-audit-log__select">
        <option value="">All sources</option>
        <option value="user">User</option>
        <option value="sync">Sync</option>
      </select>
      <select v-model="filterRange" class="azure-audit-log__select">
        <option value="24h">Last 24 hours</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
      </select>
      <input v-model="searchText" type="text" class="azure-audit-log__search" placeholder="Search\u2026" @input="onSearchInput">
      <button type="button" :class="['button', 'button--ghost', loading && 'button--busy']" :disabled="loading" @click="loadData">
        {{ loading ? 'Loading\u2026' : 'Refresh' }}
      </button>
    </div>

    <!-- Stats -->
    <div v-if="stats.total" class="azure-audit-log__stats">
      <span><strong>{{ stats.total }}</strong> calls</span>
      <span class="azure-audit-log__stat-ok">{{ stats.successCount }} ok</span>
      <span v-if="stats.errorCount" class="azure-audit-log__stat-err">{{ stats.errorCount }} errors</span>
      <span>{{ stats.readCount }} read / {{ stats.writeCount }} write</span>
      <span v-if="stats.avgDurationMs">avg {{ stats.avgDurationMs }}ms</span>
    </div>

    <!-- Table -->
    <div v-if="entries.length" class="azure-audit-log__table-wrap">
      <table class="azure-audit-log__table">
        <colgroup>
          <col v-for="col in columns" :key="col.key" :style="{ width: col.width + 'px', minWidth: col.minWidth + 'px' }">
        </colgroup>
        <thead>
          <tr>
            <th v-for="(col, ci) in columns" :key="col.key" @click="toggleSort(col.key)">
              <div class="azure-audit-log__th-inner">
                <span>{{ col.label }}</span>
                <span v-if="sortKey === col.key" class="azure-audit-log__sort-arrow">{{ sortDir === 'asc' ? '\u25B2' : '\u25BC' }}</span>
              </div>
              <div v-if="ci < columns.length - 1" class="azure-audit-log__resize-handle" @mousedown.stop.prevent="startResize($event, ci)"></div>
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="entry in sortedEntries" :key="entry.id">
            <tr :class="['azure-audit-log__row', !entry.success && 'azure-audit-log__row--error', expandedId === entry.id && 'azure-audit-log__row--expanded']" @click="toggleDetail(entry.id)">
              <td class="azure-audit-log__cell-time" :title="entry.timestamp">{{ formatTime(entry.timestamp) }}</td>
              <td>
                <span class="azure-audit-log__op">{{ entry.operation }}</span>
                <span v-if="entry.resourceType" class="azure-audit-log__resource">{{ entry.resourceType }}</span>
              </td>
              <td>
                <span :class="['azure-audit-log__cat', `azure-audit-log__cat--${entry.category}`]">{{ entry.category }}</span>
              </td>
              <td class="azure-audit-log__cell-project">{{ isGitHub ? (entry.owner ? `${entry.owner}/${entry.repository}` : '\u2014') : (entry.project || '\u2014') }}</td>
              <td>
                <span v-if="entry.success" class="azure-audit-log__status-ok">{{ entry.statusCode || 'OK' }}</span>
                <span v-else class="azure-audit-log__status-err" :title="entry.errorMessage || ''">{{ entry.statusCode || 'ERR' }}</span>
              </td>
              <td class="azure-audit-log__cell-dur">{{ entry.durationMs != null ? entry.durationMs + 'ms' : '\u2014' }}</td>
              <td>
                <span v-if="entry.userInitiated" class="workspace-chip" style="font-size:9px;padding:0 4px;">user</span>
                <span v-else style="font-size:11px;color:var(--muted);">sync</span>
              </td>
            </tr>
            <!-- Expanded detail row -->
            <tr v-if="expandedId === entry.id" class="azure-audit-log__detail-row">
              <td colspan="7">
                <div class="azure-audit-log__detail">
                  <div class="azure-audit-log__detail-grid">
                    <span class="azure-audit-log__detail-label">Timestamp</span>
                    <span>{{ entry.timestamp }}</span>
                    <span class="azure-audit-log__detail-label">Method</span>
                    <span><strong>{{ entry.method }}</strong> {{ entry.statusCode || '' }}</span>
                    <span class="azure-audit-log__detail-label">URL</span>
                    <span class="azure-audit-log__detail-url">{{ entry.url }}</span>
                    <span class="azure-audit-log__detail-label">{{ isGitHub ? 'Repository' : 'Organization' }}</span>
                    <span>{{ isGitHub ? (entry.owner ? `${entry.owner}/${entry.repository}` : '\u2014') : (entry.organization || '\u2014') }}</span>
                    <span class="azure-audit-log__detail-label">Connection</span>
                    <span>{{ entry.connectionId || '\u2014' }}</span>
                    <template v-if="entry.errorMessage">
                      <span class="azure-audit-log__detail-label">Error</span>
                      <span class="azure-audit-log__detail-error">{{ entry.errorMessage }}</span>
                    </template>
                  </div>
                  <button type="button" class="button button--ghost azure-audit-log__copy-btn" @click.stop="copyEntry(entry)">
                    {{ copiedId === entry.id ? 'Copied!' : 'Copy to clipboard' }}
                  </button>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <div v-else-if="!loading" class="azure-empty"><p>No audit log entries for the selected period.</p></div>

    <!-- Pagination -->
    <div v-if="total > pageSize" class="azure-audit-log__pagination">
      <button type="button" class="button button--ghost" :disabled="page <= 0" @click="page--; loadEntries();">&laquo; Prev</button>
      <span>{{ page * pageSize + 1 }}&ndash;{{ Math.min((page + 1) * pageSize, total) }} of {{ total }}</span>
      <button type="button" class="button button--ghost" :disabled="(page + 1) * pageSize >= total" @click="page++; loadEntries();">Next &raquo;</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, reactive } from "vue";
import { useAppStore } from "../../../stores/app.js";

const props = defineProps({
  provider: { type: String, default: "azure" },
});

const appStore = useAppStore();
function getApi() {
  return appStore.getApi();
}
const isGitHub = computed(() => props.provider === "github");

const filterCategory = ref("");
const filterSuccess = ref("");
const filterSource = ref("");
const filterRange = ref("24h");
const searchText = ref("");
let searchDebounce = null;
const loading = ref(false);
const entries = ref([]);
const total = ref(0);
const page = ref(0);
const pageSize = 50;
const expandedId = ref(null);
const copiedId = ref(null);
const sortKey = ref("id");
const sortDir = ref("desc");
const stats = ref({ total: 0, successCount: 0, errorCount: 0, readCount: 0, writeCount: 0, avgDurationMs: 0 });

const columns = reactive([
  { key: "timestamp", label: "Time", width: 90, minWidth: 60 },
  { key: "operation", label: "Operation", width: 200, minWidth: 100 },
  { key: "category", label: "Category", width: 80, minWidth: 50 },
  { key: "project", label: "Project", width: 140, minWidth: 60 },
  { key: "statusCode", label: "Status", width: 70, minWidth: 45 },
  { key: "durationMs", label: "Duration", width: 80, minWidth: 50 },
  { key: "userInitiated", label: "Source", width: 60, minWidth: 40 },
]);

// --- Sorting ---
function toggleSort(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDir.value = key === "durationMs" || key === "statusCode" ? "desc" : "asc";
  }
}

const sortedEntries = computed(() => {
  const key = sortKey.value;
  const dir = sortDir.value === "asc" ? 1 : -1;
  return [...entries.value].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "boolean") { av = av ? 1 : 0; bv = bv ? 1 : 0; }
    if (typeof av === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
});

// --- Column resize ---
let resizeCol = -1;
let resizeStartX = 0;
let resizeStartW = 0;

function startResize(event, colIndex) {
  resizeCol = colIndex;
  resizeStartX = event.clientX;
  resizeStartW = columns[colIndex].width;
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeEnd);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function onResizeMove(event) {
  if (resizeCol < 0) return;
  const delta = event.clientX - resizeStartX;
  columns[resizeCol].width = Math.max(columns[resizeCol].minWidth, resizeStartW + delta);
}

function onResizeEnd() {
  resizeCol = -1;
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

// --- Detail expand + copy ---
function toggleDetail(id) {
  expandedId.value = expandedId.value === id ? null : id;
}

async function copyEntry(entry) {
  const text = [
    `Timestamp: ${entry.timestamp}`,
    `Operation: ${entry.operation} (${entry.category})`,
    `Method: ${entry.method} ${entry.statusCode || ""}`,
    `URL: ${entry.url}`,
    `Project: ${entry.project || "-"}`,
    `Organization: ${entry.organization || "-"}`,
    `Connection: ${entry.connectionId || "-"}`,
    `Duration: ${entry.durationMs != null ? entry.durationMs + "ms" : "-"}`,
    `Source: ${entry.userInitiated ? "user" : "sync"}`,
    entry.errorMessage ? `Error: ${entry.errorMessage}` : "",
  ].filter(Boolean).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    copiedId.value = entry.id;
    setTimeout(() => { if (copiedId.value === entry.id) copiedId.value = null; }, 2000);
  } catch {}
}

// --- Search debounce ---
function onSearchInput() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => loadData(), 300);
}

// --- Data loading ---
function rangeToFrom(range) {
  const now = new Date();
  if (range === "24h") return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  if (range === "7d") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
}

function buildFilters() {
  const f = { from: rangeToFrom(filterRange.value) };
  if (filterCategory.value) f.category = filterCategory.value;
  if (filterSuccess.value === "true") f.success = true;
  else if (filterSuccess.value === "false") f.success = false;
  if (filterSource.value === "user") f.userInitiated = true;
  else if (filterSource.value === "sync") f.userInitiated = false;
  if (searchText.value.trim()) f.search = searchText.value.trim();
  return f;
}

async function loadEntries() {
  loading.value = true;
  try {
    const queryFn = isGitHub.value ? getApi().queryGitHubAuditLog : getApi().queryAzureAuditLog;
    const result = await queryFn({
      ...buildFilters(),
      limit: pageSize,
      offset: page.value * pageSize,
    });
    entries.value = result.entries || [];
    total.value = result.total || 0;
  } catch (err) {
    console.warn("Audit log query failed:", err);
  } finally {
    loading.value = false;
  }
}

async function loadStats() {
  try {
    const statsFn = isGitHub.value ? getApi().getGitHubAuditStats : getApi().getAzureAuditStats;
    stats.value = await statsFn(buildFilters());
  } catch {}
}

async function loadData() {
  page.value = 0;
  expandedId.value = null;
  await Promise.all([loadEntries(), loadStats()]);
}

function formatTime(iso) {
  if (!iso) return "\u2014";
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60_000) return "just now";
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

watch([filterCategory, filterSuccess, filterSource, filterRange], () => loadData());

onMounted(() => loadData());
</script>

<style scoped>
.azure-audit-log {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}

.azure-audit-log__filters {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.azure-audit-log__select {
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 11px;
  cursor: pointer;
}

.azure-audit-log__search {
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  width: 140px;
  outline: none;
}

.azure-audit-log__search:focus {
  border-color: var(--accent);
}

.azure-audit-log__search::placeholder {
  color: var(--muted);
}

.azure-audit-log__stats {
  display: flex;
  gap: 12px;
  padding: 6px 8px;
  background: var(--panel);
  border-radius: 4px;
  font-size: 11px;
  color: var(--muted);
}

.azure-audit-log__stat-ok { color: var(--accent); }
.azure-audit-log__stat-err { color: var(--error, #e55); }

.azure-audit-log__table-wrap {
  overflow-x: auto;
}

.azure-audit-log__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  table-layout: fixed;
}

.azure-audit-log__table th {
  position: relative;
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  overflow: hidden;
}

.azure-audit-log__table th:hover {
  color: var(--fg);
}

.azure-audit-log__th-inner {
  display: flex;
  align-items: center;
  gap: 3px;
}

.azure-audit-log__sort-arrow {
  font-size: 8px;
  color: var(--accent);
}

.azure-audit-log__resize-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  background: transparent;
}

.azure-audit-log__resize-handle:hover {
  background: var(--accent);
  opacity: 0.4;
}

.azure-audit-log__table td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.05));
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.azure-audit-log__row {
  cursor: pointer;
  transition: background 0.1s;
}

.azure-audit-log__row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.azure-audit-log__row--error {
  background: rgba(238, 85, 85, 0.06);
}

.azure-audit-log__row--error:hover {
  background: rgba(238, 85, 85, 0.1);
}

.azure-audit-log__row--expanded {
  background: rgba(255, 255, 255, 0.04);
}

.azure-audit-log__detail-row td {
  padding: 0 8px 8px;
  border-bottom: 1px solid var(--border);
  white-space: normal;
  overflow: visible;
}

.azure-audit-log__detail {
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  border-left: 3px solid var(--accent);
}

.azure-audit-log__detail-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 12px;
  font-size: 11px;
  align-items: baseline;
}

.azure-audit-log__detail-label {
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
}

.azure-audit-log__detail-url {
  word-break: break-all;
  font-family: monospace;
  font-size: 10px;
  color: var(--muted);
}

.azure-audit-log__detail-error {
  color: var(--error, #e55);
  word-break: break-word;
}

.azure-audit-log__copy-btn {
  margin-top: 6px;
  font-size: 10px;
  padding: 2px 8px;
}

.azure-audit-log__cell-time {
  color: var(--muted);
}

.azure-audit-log__cell-project {
  overflow: hidden;
  text-overflow: ellipsis;
}

.azure-audit-log__cell-dur {
  text-align: right;
  color: var(--muted);
}

.azure-audit-log__op {
  font-weight: 500;
}

.azure-audit-log__resource {
  margin-left: 4px;
  color: var(--muted);
  font-size: 10px;
}

.azure-audit-log__cat {
  display: inline-block;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
}

.azure-audit-log__cat--read {
  background: rgba(100, 180, 255, 0.15);
  color: #6ab4ff;
}

.azure-audit-log__cat--write {
  background: rgba(255, 180, 60, 0.15);
  color: #ffb43c;
}

.azure-audit-log__status-ok {
  color: var(--accent);
}

.azure-audit-log__status-err {
  color: var(--error, #e55);
  cursor: help;
}

.azure-audit-log__pagination {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: center;
  padding: 4px 0;
  font-size: 11px;
  color: var(--muted);
}
</style>
