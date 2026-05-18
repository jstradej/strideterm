<template>
  <div class="inspect">
    <div class="inspect__toolbar">
      <button type="button" class="button button--ghost button--sm" :disabled="loading" @click="reload">
        {{ loading ? "Loading…" : "Reload" }}
      </button>
      <button
        v-if="!loading && !error && pretty"
        type="button"
        class="button button--ghost button--sm"
        @click="copyToClipboard"
      >
        {{ copied ? "Copied" : "Copy" }}
      </button>
      <span v-if="error" class="inspect__error">{{ error }}</span>
    </div>
    <div class="inspect__body">
      <div v-if="loading" class="inspect__loading">
        <Spinner size="md" />
        <span>Inspecting container…</span>
      </div>
      <pre v-else-if="pretty" class="inspect__pre" v-html="highlighted" />
      <div v-else class="inspect__empty">No data.</div>
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
  /** Test hook: when provided, use this instead of calling the IPC. */
  mockJson?: string;
}>();

const appStore = useAppStore();
const loading = ref(false);
const pretty = ref<string>("");
const error = ref<string>("");
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
    const raw = await appStore.dockerInspect(props.containerId, props.backendId, props.contextName);
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

/**
 * Lightweight JSON syntax highlighter. Walks the input character-by-character
 * so that already-emitted span tags can't themselves match later patterns
 * (the previous regex-pass implementation had that exact bug).
 *
 * Operates on JSON.stringify output but defensively escapes &<> in raw values.
 */
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

    // String
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
      // Look ahead for ':' (= object key)
      let j = end + 1;
      while (j < len && /\s/.test(text[j])) j++;
      const isKey = text[j] === ":";
      out += `<span class="${isKey ? "json-key" : "json-string"}">${escapeHtml(raw)}</span>`;
      i = end + 1;
      continue;
    }

    // Booleans / null
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

    // Number
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

    // Everything else (whitespace, punctuation): escape & emit.
    out += escapeHtml(ch);
    i++;
  }

  return out;
}

async function copyToClipboard(): Promise<void> {
  try {
    await navigator.clipboard.writeText(pretty.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // clipboard blocked — silently ignore
  }
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
.inspect {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.inspect__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  flex-shrink: 0;
}

.inspect__error {
  color: var(--color-error, #fc8181);
  font-size: 12px;
  margin-left: 6px;
}

.inspect__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.inspect__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 30px;
  color: var(--text-dim, #888);
  font-size: 13px;
}

.inspect__pre {
  margin: 0;
  padding: 10px 12px;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.55;
  color: #d8e4f5;
  white-space: pre;
}

.inspect__empty {
  padding: 24px;
  color: var(--text-dim, #888);
  font-style: italic;
  font-size: 13px;
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
