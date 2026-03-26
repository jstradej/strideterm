<template>
  <div class="dialog" style="width:min(680px,100%);">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">GitHub</p>
        <h2>{{ connection ? 'Edit connection' : 'Add connection' }}</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <div class="grid">
        <label>
          <span>Label</span>
          <input ref="labelRef" v-model="draft.label" required maxlength="60" />
        </label>
        <label>
          <span>Poll seconds</span>
          <input v-model.number="draft.pollSeconds" type="number" min="15" max="3600" />
        </label>
      </div>
      <label>
        <span>Host URL</span>
        <input v-model="draft.hostUrl" placeholder="https://github.com" required maxlength="300" />
        <small style="color:var(--muted);font-size:12px;">Use https://github.com for GitHub.com or your GitHub Enterprise Server URL.</small>
      </label>
      <label>
        <span>PAT {{ connection ? '(leave empty to keep current token)' : '' }}</span>
        <input v-model="draft.pat" type="password" placeholder="Personal Access Token" maxlength="300" />
        <small style="color:var(--muted);font-size:12px;">Fine-grained or classic PAT with repo scope.</small>
      </label>
      <label>
        <span>Review checkout root</span>
        <div class="input-with-action">
          <input v-model="draft.reviewRoot" placeholder="C:/Users/me/.strideterm/github-pr" maxlength="500" />
          <button v-if="api?.browseDirectory" type="button" class="button button--ghost input-with-action__btn" @click="browseReviewRoot">Browse</button>
        </div>
      </label>
      <div class="grid">
        <label>
          <span>Owner filters</span>
          <input v-model="draft.ownerFilters" placeholder="my-org, my-user" maxlength="500" />
          <small style="color:var(--muted);font-size:12px;">Comma-separated GitHub org or user names.</small>
        </label>
        <label>
          <span>Repository filters</span>
          <input v-model="draft.repositoryFilters" placeholder="owner/repo, owner/other-repo" maxlength="500" />
          <small style="color:var(--muted);font-size:12px;">Optional owner/repo names.</small>
        </label>
      </div>
      <label style="display:flex;align-items:center;gap:8px;">
        <input v-model="draft.enabled" type="checkbox" />
        <span>Enable polling for this connection</span>
      </label>
      <p v-if="errorMessage" style="margin:0;color:var(--danger);">{{ errorMessage }}</p>
      <div v-if="verification" style="border:1px solid var(--border);border-radius:6px;padding:12px;background:rgba(255,255,255,0.03);display:grid;gap:6px;">
        <strong>Connection verified</strong>
        <small style="color:var(--muted);">Authenticated as <strong>{{ verification.login }}</strong>{{ verification.name && verification.name !== verification.login ? ` (${verification.name})` : '' }}</small>
      </div>
      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button type="button" :class="['button', 'button--ghost', busy && 'button--busy']" :disabled="busy" @click="testConnection">{{ busy ? 'Testing…' : 'Test connection' }}</button>
        <button type="submit" :class="['button', busy && 'button--busy']" :disabled="busy">{{ busy ? 'Saving…' : 'Save connection' }}</button>
      </footer>
    </form>
  </div>
</template>

<script setup>
import { ref, reactive, inject, onMounted, useAttrs } from "vue";

defineOptions({ inheritAttrs: false });

const props = defineProps({
  connection: { type: Object, default: null },
  defaultReviewRoot: { type: String, default: "" },
});

const emit = defineEmits(["cancel"]);
const attrs = useAttrs();

const api = inject("api");
const labelRef = ref(null);

const draft = reactive({
  id: props.connection?.id || "",
  label: props.connection?.label || "",
  hostUrl: props.connection?.hostUrl || "https://github.com",
  pat: "",
  reviewRoot: props.connection?.reviewRoot || props.defaultReviewRoot || "",
  ownerFilters: (props.connection?.ownerFilters || []).join(", "),
  repositoryFilters: (props.connection?.repositoryFilters || []).join(", "),
  pollSeconds: props.connection?.pollSeconds || 120,
  enabled: props.connection?.enabled !== false,
});

const busy = ref(false);
const errorMessage = ref("");
const verification = ref(null);

onMounted(() => labelRef.value?.focus());

async function browseReviewRoot() {
  if (!api?.browseDirectory) return;
  const selected = await api.browseDirectory(draft.reviewRoot || props.defaultReviewRoot || "");
  if (selected) draft.reviewRoot = selected;
}

function buildDraftPayload() {
  return {
    id: draft.id,
    label: draft.label.trim(),
    hostUrl: draft.hostUrl.trim(),
    pat: draft.pat.trim(),
    reviewRoot: draft.reviewRoot.trim(),
    enabled: draft.enabled,
    pollSeconds: Number(draft.pollSeconds) || 120,
    ownerFilters: draft.ownerFilters.split(",").map((v) => v.trim()).filter(Boolean),
    repositoryFilters: draft.repositoryFilters.split(",").map((v) => v.trim()).filter(Boolean),
  };
}

async function testConnection() {
  busy.value = true;
  errorMessage.value = "";
  verification.value = null;
  try {
    verification.value = await api.verifyGitHubConnection(buildDraftPayload());
  } catch (err) {
    errorMessage.value = err?.message || "GitHub connection test failed.";
  } finally {
    busy.value = false;
  }
}

async function handleSubmit() {
  busy.value = true;
  errorMessage.value = "";
  try {
    await attrs.onSave?.(buildDraftPayload());
  } catch (err) {
    errorMessage.value = err?.message || "Saving GitHub connection failed.";
    busy.value = false;
  }
}
</script>
