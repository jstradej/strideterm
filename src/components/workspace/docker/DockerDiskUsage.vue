<template>
  <div class="disk-usage" :title="title">
    <span class="disk-usage__icon" aria-hidden="true">▮</span>
    <div class="disk-usage__grid">
      <template v-if="loading && rows.length === 0">
        <span v-for="i in 4" :key="`skel-${i}`" class="disk-usage__row disk-usage__row--skeleton">
          <span class="disk-usage__label"><span class="disk-usage__skel disk-usage__skel--sm" /></span>
          <span class="disk-usage__value"><span class="disk-usage__skel disk-usage__skel--md" /></span>
          <span class="disk-usage__reclaim"><span class="disk-usage__skel disk-usage__skel--lg" /></span>
        </span>
      </template>
      <span v-else-if="error" class="disk-usage__status disk-usage__error" :title="error">df unavailable</span>
      <span v-else-if="rows.length === 0" class="disk-usage__status disk-usage__empty">df: —</span>
      <template v-else>
        <button
          v-for="r in rows"
          :key="r.Type"
          type="button"
          :class="['disk-usage__row', 'disk-usage__row--btn', kindFor(r.Type) && 'disk-usage__row--clickable']"
          :title="kindFor(r.Type) ? `Open ${shortLabel(r.Type)} list` : 'No detail view'"
          :disabled="!kindFor(r.Type)"
          @click="onRowClick(r)"
        >
          <span class="disk-usage__label">{{ shortLabel(r.Type) }}</span>
          <span class="disk-usage__value">{{ r.Size || "—" }}</span>
          <span v-if="r.Reclaimable" class="disk-usage__reclaim">({{ r.Reclaimable }} reclaimable)</span>
          <span v-else class="disk-usage__reclaim" />
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useAppStore } from "../../../stores/app.js";

interface DfRow {
  Type: string;
  TotalCount?: string;
  Active?: string;
  Size?: string;
  Reclaimable?: string;
}

const props = defineProps<{
  /** When provided, bypasses the IPC and renders these rows directly (tests). */
  mockRaw?: string;
}>();

const emit = defineEmits<{
  /** User clicked an actionable row. "cache" has no list view — caller may
   * choose to run builder prune directly, or ignore it. */
  open: [kind: "images" | "volumes" | "networks" | "cache"];
}>();

const appStore = useAppStore();
const loading = ref(false);
const error = ref("");
const rows = ref<DfRow[]>([]);

const title = computed(() =>
  rows.value.length === 0 ? "Disk usage unavailable" : "Disk usage (docker system df) — click to refresh",
);

function shortLabel(t: string): string {
  // docker emits "Images", "Containers", "Local Volumes", "Build Cache"
  if (t === "Local Volumes") return "Vols";
  if (t === "Build Cache") return "Cache";
  if (t === "Containers") return "Cnt";
  return t;
}

/** Map a df row Type to the kind expected by the `open` event, or null when
 * there is no list view (Containers — covered by the tree itself). */
function kindFor(t: string): "images" | "volumes" | "networks" | "cache" | null {
  if (t === "Images") return "images";
  if (t === "Local Volumes") return "volumes";
  if (t === "Build Cache") return "cache";
  return null;
}

function onRowClick(r: DfRow): void {
  const k = kindFor(r.Type);
  if (k) emit("open", k);
}

async function load(): Promise<void> {
  if (props.mockRaw !== undefined) {
    rows.value = parseDf(props.mockRaw);
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const raw = await appStore.dockerSystemDf();
    rows.value = parseDf(raw);
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function parseDf(raw: string): DfRow[] {
  if (!raw) return [];
  // One JSON object per line, four lines: Images / Containers / Local Volumes / Build Cache.
  const out: DfRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as DfRow;
      if (obj && obj.Type) out.push(obj);
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

onMounted(() => load());
watch(
  () => props.mockRaw,
  () => load(),
);
</script>

<style scoped>
/* Container sits in the docker header beside the title and actions. The grid
 * inside reserves the full 4-row height up front so the panel below doesn't
 * jump once the async `docker system df` reply lands. */
.disk-usage {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim, #888);
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  min-height: 64px;
  padding-top: 2px;
}

.disk-usage__icon {
  color: var(--accent, #63b3ed);
  font-size: 9px;
  line-height: 14px;
  flex-shrink: 0;
}

/* The grid takes one column per data cell (label / value / reclaim). Children
 * use `display: contents` so each `.disk-usage__row` flattens into the parent
 * grid — that's what aligns the values across rows even though labels have
 * different lengths ("Images" vs "Cnt"). */
.disk-usage__grid {
  display: grid;
  grid-template-columns: minmax(40px, auto) minmax(60px, auto) 1fr;
  column-gap: 8px;
  row-gap: 1px;
  align-items: baseline;
  flex: 1 1 auto;
  min-width: 0;
}

.disk-usage__row {
  display: contents;
}

/* Native button reset so a row-button looks identical to the old <span> rows,
 * but still gets the click affordance + a visible hover on the clickable ones. */
.disk-usage__row--btn {
  background: transparent;
  border: 0;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  cursor: default;
  text-align: left;
}
.disk-usage__row--clickable {
  cursor: pointer;
}
.disk-usage__row--clickable:hover .disk-usage__label,
.disk-usage__row--clickable:hover .disk-usage__value {
  color: var(--accent, #63b3ed);
}
.disk-usage__row--btn:focus-visible {
  outline: 1px solid var(--accent, #63b3ed);
  outline-offset: 2px;
  border-radius: 2px;
}
.disk-usage__row--btn:disabled {
  cursor: default;
}

.disk-usage__label {
  color: var(--text-dim, #888);
  white-space: nowrap;
}

.disk-usage__value {
  color: var(--text-primary, #d8e4f5);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: left;
}

.disk-usage__reclaim {
  color: rgba(246, 173, 85, 0.7);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* Status fills the whole grid (empty/error/loading-without-rows). */
.disk-usage__status {
  grid-column: 1 / -1;
  font-style: italic;
}

.disk-usage__skel {
  display: inline-block;
  height: 9px;
  border-radius: 3px;
  vertical-align: middle;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.13), rgba(255, 255, 255, 0.05));
  background-size: 200% 100%;
  animation: disk-usage-skeleton 1.4s ease-in-out infinite;
}
.disk-usage__skel--sm {
  width: 36px;
}
.disk-usage__skel--md {
  width: 56px;
}
.disk-usage__skel--lg {
  width: 130px;
  max-width: 100%;
}

@keyframes disk-usage-skeleton {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

@media (max-width: 600px) {
  .disk-usage__reclaim {
    display: none;
  }
  .disk-usage__grid {
    grid-template-columns: minmax(40px, auto) 1fr;
  }
  .disk-usage {
    min-height: 56px;
  }
}
</style>
