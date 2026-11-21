<template>
  <section class="tmux-fields" aria-label="tmux session">
    <div v-if="canList" class="tmux-fields__actions">
      <button type="button" class="button button--ghost" :disabled="loading" @click="loadSessions">
        {{ loading ? "Finding sessions…" : sessions !== null ? "Refresh sessions" : "Find sessions" }}
      </button>
    </div>
    <p v-else class="tmux-fields__help">
      {{ manualHint }}
    </p>
    <p v-if="listError" class="tmux-fields__error" role="alert">{{ listError }}</p>
    <p v-else-if="loading" class="tmux-fields__help" role="status">Connecting to the SSH host…</p>
    <p v-else-if="sessions?.length === 0" class="tmux-fields__help" role="status">
      No running tmux sessions were found for this account.
    </p>
    <ul v-if="sessions?.length" class="tmux-fields__sessions" aria-label="Running tmux sessions">
      <li v-for="session in sessions" :key="session.name">
        <button
          type="button"
          class="tmux-fields__session"
          :aria-pressed="name === session.name"
          @click="name = session.name"
        >
          <span class="tmux-fields__session-name">{{ session.name }}</span>
          <span class="tmux-fields__session-meta">
            <small>
              {{ session.windows }} {{ session.windows === 1 ? "window" : "windows" }} ·
              {{ session.attached ? "Attached" : "Detached" }}
            </small>
            <small>Last active {{ formatActivity(session.lastActivityAt) }}</small>
          </span>
        </button>
      </li>
    </ul>
    <label class="tmux-fields__name">
      <span>Exact session name</span>
      <input
        v-model="name"
        required
        data-validation-required="Enter the exact name of a running tmux session."
        autocomplete="off"
        spellcheck="false"
        data-testid="tmux-session-name"
      />
    </label>
    <label class="tmux-fields__access">
      <span>Session access</span>
      <CustomSelect
        :model-value="readOnly ? 'read-only' : 'interactive'"
        :options="ACCESS_OPTIONS"
        @update:model-value="setAccess"
      />
    </label>
    <p v-if="readOnly" class="tmux-fields__help">View the session without sending input to it.</p>
    <div v-if="canPreview && exactName" class="tmux-fields__actions">
      <button type="button" class="button button--ghost" :disabled="previewing || loading" @click="loadPreview">
        {{ previewing ? "Loading output…" : preview !== null ? "Refresh recent output" : "Preview recent output" }}
      </button>
    </div>
    <p v-if="previewError" ref="previewResult" class="tmux-fields__error" role="alert">{{ previewError }}</p>
    <div v-else-if="preview !== null" ref="previewResult" class="tmux-fields__output">
      <span>Recent output · active pane</span>
      <pre v-if="preview" tabindex="0" aria-label="Recent tmux output">{{ preview }}</pre>
      <p v-else class="tmux-fields__help">The active pane has no recent output.</p>
    </div>
    <p class="tmux-fields__help">
      Closing this tab disconnects the client. The tmux session keeps running on the host.
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { normalizeSshTmuxName, type SshTmuxSession } from "../../../electron/shared/ssh-tmux.js";
import CustomSelect from "../common/CustomSelect.vue";
import { userFacingMessage } from "../../lib/error-message.js";
import type { Transport } from "../../transport.js";
import { apiKey } from "../../types/keys.js";

const ACCESS_OPTIONS = [
  { value: "interactive", label: "Interactive" },
  { value: "read-only", label: "Read-only" },
];
const props = defineProps<{ hostId: string; remote: boolean; manualHint: string }>();
const name = defineModel<string>("name", { required: true });
const readOnly = defineModel<boolean>("readOnly", { required: true });
const api = inject<Transport | undefined>(apiKey, undefined);
const canList = computed(() => Boolean(props.hostId && !props.remote && api?.sshTmuxList));
const canPreview = computed(() => Boolean(props.hostId && !props.remote && api?.sshTmuxPreview));
const exactName = computed(() => normalizeSshTmuxName(name.value));
const sessions = ref<SshTmuxSession[] | null>(null);
const loading = ref(false);
const listError = ref("");
const preview = ref<string | null>(null);
const previewError = ref("");
const previewing = ref(false);
const previewResult = ref<HTMLElement | null>(null);
type PendingProbe = { requestId?: string };
let listRequest: PendingProbe | null = null;
let previewRequest: PendingProbe | null = null;

function beginProbe(): PendingProbe {
  return api?.sshTmuxCancel ? { requestId: crypto.randomUUID() } : {};
}

function cancelProbe(probe: PendingProbe | null) {
  if (!probe?.requestId) return;
  // A finished request or an unavailable desktop bridge already needs no cleanup here.
  void api?.sshTmuxCancel?.({ requestId: probe.requestId }).catch(() => undefined);
}

function clearPreview() {
  cancelProbe(previewRequest);
  previewRequest = null;
  preview.value = null;
  previewError.value = "";
  previewing.value = false;
}

function clearSessions() {
  cancelProbe(listRequest);
  listRequest = null;
  sessions.value = null;
  listError.value = "";
  loading.value = false;
  clearPreview();
}

watch(() => [props.hostId, props.remote], clearSessions, { flush: "sync" });
watch(name, clearPreview, { flush: "sync" });
watch(previewResult, (result) => result?.scrollIntoView?.({ block: "nearest" }), { flush: "post" });
onBeforeUnmount(clearSessions);

async function loadSessions() {
  if (!canList.value || loading.value || !api?.sshTmuxList) return;
  const request = beginProbe();
  listRequest = request;
  clearPreview();
  loading.value = true;
  listError.value = "";
  try {
    const result = await api.sshTmuxList({ hostId: props.hostId, ...request });
    if (request !== listRequest) return;
    if (result.ok) sessions.value = result.sessions;
    else {
      sessions.value = null;
      listError.value = result.message;
    }
  } catch (err) {
    if (request !== listRequest) return;
    sessions.value = null;
    listError.value = userFacingMessage(err, "Could not list tmux sessions.");
  } finally {
    if (request === listRequest) {
      listRequest = null;
      loading.value = false;
    }
  }
}

async function loadPreview() {
  if (!canPreview.value || !exactName.value || previewing.value || loading.value || !api?.sshTmuxPreview) return;
  clearPreview();
  const request = beginProbe();
  previewRequest = request;
  previewing.value = true;
  try {
    const result = await api.sshTmuxPreview({ hostId: props.hostId, name: exactName.value, ...request });
    if (request !== previewRequest) return;
    if (result.ok) preview.value = result.output;
    else previewError.value = result.message;
  } catch (err) {
    if (request === previewRequest) previewError.value = userFacingMessage(err, "Could not preview tmux output.");
  } finally {
    if (request === previewRequest) {
      previewRequest = null;
      previewing.value = false;
    }
  }
}

function formatActivity(timestamp: number | null) {
  return timestamp === null ? "unknown" : new Date(timestamp).toLocaleString();
}

function setAccess(value: string | number) {
  readOnly.value = value === "read-only";
}
</script>

<style scoped>
.tmux-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  min-width: 0;
}
.tmux-fields__actions {
  display: flex;
  gap: 8px;
}
.tmux-fields__name,
.tmux-fields__access {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
}
.tmux-fields__help,
.tmux-fields__error {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.tmux-fields__error {
  color: var(--danger);
}
.tmux-fields__sessions {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
  list-style: none;
  max-height: 166px;
  overflow: auto;
  margin: 0;
  padding: 1px;
}
.tmux-fields__session {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 3px;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  text-align: start;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.tmux-fields__session:hover,
.tmux-fields__session[aria-pressed="true"] {
  border-color: var(--accent);
}
.tmux-fields__session[aria-pressed="true"] {
  background: rgba(var(--tint), 0.08);
}
.tmux-fields__session-name {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}
.tmux-fields__session-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 10px;
  color: var(--muted);
}
.tmux-fields__output {
  min-width: 0;
}
.tmux-fields__output pre {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  overflow: auto;
  margin: 6px 0 0;
  max-height: 132px;
  unicode-bidi: plaintext;
}
</style>
