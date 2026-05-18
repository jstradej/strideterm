<template>
  <div class="r-inspect">
    <div class="r-inspect__toolbar">
      <button type="button" class="button button--ghost button--sm" :disabled="loading" @click="reload">
        {{ loading ? "Loading…" : "Reload" }}
      </button>
      <button v-if="!loading && pretty && !error" type="button" class="button button--ghost button--sm" @click="copy">
        {{ copied ? "Copied" : "Copy" }}
      </button>
      <span v-if="error" class="r-inspect__error">{{ error }}</span>
    </div>
    <div class="r-inspect__body">
      <div v-if="loading && !pretty" class="r-inspect__loading">
        <Spinner size="md" />
        <span>Inspecting {{ kind }}…</span>
      </div>
      <pre v-else-if="pretty" class="r-inspect__pre" v-html="highlighted" />
      <div v-else class="r-inspect__empty">No data.</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import Spinner from "../../common/Spinner.vue";

const props = defineProps<{
  /** Display name used in the loading text. */
  kind: string;
  /** Stable identity — changes trigger reload. */
  resourceKey: string;
  /** Async loader that returns raw JSON (as docker inspect outputs). */
  fetcher: () => Promise<string>;
  /** Optional mock — when set, bypasses fetcher (used by tests). */
  mockJson?: string;
}>();

const loading = ref(false);
const pretty = ref("");
const error = ref("");
const copied = ref(false);

const highlighted = computed(() => highlightJson(pretty.value));

async function reload(): Promise<void> {
  if (props.mockJson !== undefined) {
    pretty.value = formatJson(props.mockJson);
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const raw = await props.fetcher();
    pretty.value = formatJson(raw);
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
    pretty.value = "";
  } finally {
    loading.value = false;
  }
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Character-by-character tokenizer; see DockerDetailInspect.vue for rationale. */
function highlightJson(text: string): string {
  if (!text) return "";
  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  let out = "";
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < len) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === '"') break;
        end++;
      }
      const raw = text.slice(i, end + 1);
      let j = end + 1;
      while (j < len && /\s/.test(text[j])) j++;
      const isKey = text[j] === ":";
      out += `<span class="${isKey ? "json-key" : "json-string"}">${escapeHtml(raw)}</span>`;
      i = end + 1;
      continue;
    }
    if (text.slice(i, i + 4) === "true") {
      out += '<span class="json-bool">true</span>';
      i += 4;
      continue;
    }
    if (text.slice(i, i + 5) === "false") {
      out += '<span class="json-bool">false</span>';
      i += 5;
      continue;
    }
    if (text.slice(i, i + 4) === "null") {
      out += '<span class="json-null">null</span>';
      i += 4;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let end = i;
      if (text[end] === "-") end++;
      while (end < len && /\d/.test(text[end])) end++;
      if (text[end] === ".") {
        end++;
        while (end < len && /\d/.test(text[end])) end++;
      }
      if (text[end] === "e" || text[end] === "E") {
        end++;
        if (text[end] === "+" || text[end] === "-") end++;
        while (end < len && /\d/.test(text[end])) end++;
      }
      out += `<span class="json-number">${text.slice(i, end)}</span>`;
      i = end;
      continue;
    }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(pretty.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // ignore
  }
}

onMounted(() => reload());
watch(
  () => [props.resourceKey, props.mockJson],
  () => reload(),
);
</script>

<style scoped>
.r-inspect {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.r-inspect__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  flex-shrink: 0;
}

.r-inspect__error {
  color: var(--color-error, #fc8181);
  font-size: 12px;
  margin-left: 6px;
}

.r-inspect__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.r-inspect__loading,
.r-inspect__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 30px;
  color: var(--text-dim, #888);
  font-size: 13px;
}

.r-inspect__pre {
  margin: 0;
  padding: 10px 12px;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.55;
  color: #d8e4f5;
  white-space: pre;
}

.button--sm {
  font-size: 11px;
  padding: 2px 8px;
}

:deep(.json-key) {
  color: #79c0ff;
}
:deep(.json-string) {
  color: #a5d6a3;
}
:deep(.json-number) {
  color: #f6ad55;
}
:deep(.json-bool) {
  color: #d2a8ff;
}
:deep(.json-null) {
  color: #ff7b72;
}
</style>
