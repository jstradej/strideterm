<template>
  <div class="env">
    <div class="env__toolbar">
      <input
        v-model="filter"
        type="text"
        class="env__filter"
        placeholder="Filter by key or value…"
        spellcheck="false"
        autocomplete="off"
      />
      <span class="env__count">{{ filtered.length }} / {{ entries.length }}</span>
      <button type="button" class="button button--ghost button--sm" :disabled="loading" @click="reload">
        {{ loading ? "Loading…" : "Reload" }}
      </button>
    </div>
    <div class="env__body">
      <div v-if="loading" class="env__loading">
        <Spinner size="md" />
        <span>Reading environment…</span>
      </div>
      <div v-else-if="error" class="env__error">{{ error }}</div>
      <table v-else-if="filtered.length > 0" class="env__table">
        <colgroup>
          <col class="env__col-key" />
          <col class="env__col-val" />
        </colgroup>
        <tbody>
          <tr v-for="(row, idx) in filtered" :key="`${row.key}-${idx}`">
            <td class="env__key">{{ row.key }}</td>
            <td class="env__val">{{ row.value }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="env__empty">
        {{ entries.length === 0 ? "No environment variables." : "No matches." }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import Spinner from "../../common/Spinner.vue";
import { useAppStore } from "../../../stores/app.js";

const props = defineProps<{
  containerId: string;
  backendId: string;
  contextName: string;
  /** Test hook — when provided, bypass IPC and use this as the inspect JSON. */
  mockJson?: string;
}>();

const appStore = useAppStore();
const loading = ref(false);
const error = ref<string>("");
const entries = ref<Array<{ key: string; value: string }>>([]);
const filter = ref("");

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return entries.value;
  return entries.value.filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q));
});

async function reload(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const raw = props.mockJson ?? (await appStore.dockerInspect(props.containerId, props.backendId, props.contextName));
    entries.value = parseEnv(raw);
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

function parseEnv(raw: string): Array<{ key: string; value: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // `docker inspect` returns an array of one container object.
  const container = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!container || typeof container !== "object") return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = ((container as any).Config?.Env ?? []) as string[];
  if (!Array.isArray(env)) return [];
  return env
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq < 0) return { key: line, value: "" };
      return { key: line.slice(0, eq), value: line.slice(eq + 1) };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

onMounted(() => {
  reload();
});

watch(
  () => [props.containerId, props.mockJson],
  () => reload(),
);
</script>

<style scoped>
.env {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.env__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  flex-shrink: 0;
}

.env__filter {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary, #e2e8f0);
  border-radius: 3px;
  font-size: 12px;
  outline: none;
}

.env__filter:focus {
  border-color: var(--accent, #63b3ed);
}

.env__count {
  font-size: 11px;
  color: var(--text-dim, #888);
  flex-shrink: 0;
  min-width: 60px;
  text-align: right;
}

.env__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.env__loading,
.env__error,
.env__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 30px;
  color: var(--text-dim, #888);
  font-size: 13px;
}

.env__error {
  color: var(--color-error, #fc8181);
}

.env__table {
  width: 100%;
  border-collapse: collapse;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 12px;
}

.env__col-key {
  width: 30%;
}

.env__table tbody tr:nth-child(odd) {
  background: rgba(255, 255, 255, 0.025);
}

.env__table td {
  padding: 4px 12px;
  vertical-align: top;
  line-height: 1.5;
  word-break: break-all;
}

.env__key {
  color: #79c0ff;
  font-weight: 600;
  white-space: nowrap;
}

.env__val {
  color: #d8e4f5;
}

.button--sm {
  font-size: 11px;
  padding: 2px 8px;
}

@media (max-width: 600px) {
  /* Stack key/value vertically on phones — long URLs and tokens would
     squash the value into a 1-character-wide column otherwise. */
  .env__col-key {
    width: auto;
  }
  .env__table tbody tr {
    display: block;
    padding: 4px 10px;
  }
  .env__table td {
    display: block;
    padding: 2px 0;
  }
  .env__key {
    font-size: 11px;
    color: var(--text-dim, #888);
  }
  .env__val {
    padding-left: 8px;
  }
}
</style>
