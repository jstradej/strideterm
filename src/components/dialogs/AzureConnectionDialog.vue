<template>
  <div class="dialog" style="width: min(680px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Azure DevOps</p>
        <h2>{{ connection ? "Edit connection" : "Add connection" }}</h2>
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
        <span>Organization URL</span>
        <input v-model="draft.orgUrl" placeholder="https://dev.azure.com/your-org" required maxlength="300" />
        <small style="color: var(--muted); font-size: 12px"
          >A project or repository page URL also works. The app will normalize it.</small
        >
      </label>
      <div class="grid">
        <label>
          <span>Login / UPN</span>
          <input v-model="draft.login" placeholder="me@company.com" required maxlength="200" />
        </label>
        <label>
          <span>PAT {{ connection ? "(leave empty to keep current token)" : "" }}</span>
          <input v-model="draft.pat" type="password" placeholder="Personal Access Token" maxlength="300" />
        </label>
      </div>
      <label>
        <span>Review checkout root</span>
        <div class="input-with-action">
          <input v-model="draft.reviewRoot" placeholder="C:/Users/me/.strideterm/azure-pr" maxlength="500" />
          <button
            v-if="api?.browseDirectory"
            type="button"
            class="button button--ghost input-with-action__btn"
            @click="browseReviewRoot"
          >
            Browse
          </button>
        </div>
      </label>
      <div class="grid">
        <label>
          <span>Project filters</span>
          <input v-model="draft.projectFilters" placeholder="Platform, Mobile" maxlength="500" />
          <small style="color: var(--muted); font-size: 12px">Comma-separated project ids or names.</small>
        </label>
        <label>
          <span>Repository filters</span>
          <input v-model="draft.repositoryFilters" placeholder="web-app, api" maxlength="500" />
          <small style="color: var(--muted); font-size: 12px">Optional repo ids or names.</small>
        </label>
      </div>
      <label style="display: flex; align-items: center; gap: 8px">
        <input v-model="draft.enabled" type="checkbox" />
        <span>Enable polling for this connection</span>
      </label>
      <p v-if="errorMessage" style="margin: 0; color: var(--danger)">{{ errorMessage }}</p>
      <div
        v-if="verification"
        style="
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
          display: grid;
          gap: 6px;
        "
      >
        <strong>Connection verified</strong>
        <small style="color: var(--muted)">{{ verification.projectCount }} projects available.</small>
        <div style="display: flex; flex-wrap: wrap; gap: 6px">
          <span v-for="project in verification.projects.slice(0, 8)" :key="project.name" class="workspace-chip">{{
            project.name
          }}</span>
        </div>
      </div>
      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button
          type="button"
          :class="['button', 'button--ghost', busy && 'button--busy']"
          :disabled="busy"
          @click="testConnection"
        >
          {{ busy ? "Testing…" : "Test connection" }}
        </button>
        <button type="submit" :class="['button', busy && 'button--busy']" :disabled="busy">
          {{ busy ? "Saving…" : "Save connection" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, inject, onMounted, useAttrs } from "vue";
import type { Transport } from "../../transport.js";

defineOptions({ inheritAttrs: false });

interface AzureConnection {
  id?: string;
  label?: string;
  orgUrl?: string;
  login?: string;
  reviewRoot?: string;
  projectFilters?: string[];
  repositoryFilters?: string[];
  pollSeconds?: number;
  enabled?: boolean;
}

interface Props {
  connection?: AzureConnection | null;
  defaultReviewRoot?: string;
}

const props = withDefaults(defineProps<Props>(), {
  connection: null,
  defaultReviewRoot: "",
});

const emit = defineEmits<{
  cancel: [];
}>();
const attrs = useAttrs();

const api = inject<Transport>("api");
const labelRef = ref<HTMLInputElement | null>(null);

const draft = reactive({
  id: props.connection?.id || "",
  label: props.connection?.label || "",
  orgUrl: props.connection?.orgUrl || "",
  login: props.connection?.login || "",
  pat: "",
  reviewRoot: props.connection?.reviewRoot || props.defaultReviewRoot || "",
  projectFilters: (props.connection?.projectFilters || []).join(", "),
  repositoryFilters: (props.connection?.repositoryFilters || []).join(", "),
  pollSeconds: props.connection?.pollSeconds || 120,
  enabled: props.connection?.enabled !== false,
});

const busy = ref(false);
const errorMessage = ref("");
const verification = ref<{ projectCount: number; projects: { name: string }[] } | null>(null);

onMounted(() => labelRef.value?.focus());

async function browseReviewRoot() {
  if (!api?.browseDirectory) return;
  const selected = await api.browseDirectory(draft.reviewRoot || props.defaultReviewRoot || "") as string | null;
  if (selected) draft.reviewRoot = selected;
}

function buildDraftPayload() {
  return {
    id: draft.id,
    label: draft.label.trim(),
    orgUrl: draft.orgUrl.trim(),
    login: draft.login.trim(),
    pat: draft.pat.trim(),
    reviewRoot: draft.reviewRoot.trim(),
    enabled: draft.enabled,
    pollSeconds: Number(draft.pollSeconds) || 120,
    projectFilters: draft.projectFilters
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    repositoryFilters: draft.repositoryFilters
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
}

async function testConnection() {
  busy.value = true;
  errorMessage.value = "";
  verification.value = null;
  try {
    verification.value = await api?.verifyAzureConnection?.(buildDraftPayload()) as { projectCount: number; projects: { name: string }[] } | null;
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Azure DevOps connection test failed.";
  } finally {
    busy.value = false;
  }
}

async function handleSubmit() {
  busy.value = true;
  errorMessage.value = "";
  try {
    await (attrs.onSave as ((payload: unknown) => Promise<void>) | undefined)?.(buildDraftPayload());
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Saving Azure DevOps connection failed.";
    busy.value = false;
  }
}
</script>
