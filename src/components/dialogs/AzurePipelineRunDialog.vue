<template>
  <div class="dialog" style="width: min(640px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Azure DevOps · Re-run</p>
        <h2>{{ pipelineName || "Run pipeline" }}</h2>
      </div>
    </div>

    <div v-if="loading" class="apr-loading">Loading the run's parameters…</div>

    <form v-else class="form" @submit.prevent="handleSubmit">
      <p class="apr-note">
        Pre-filled from the run you chose. Edit anything below, then queue a new run. Secret variables aren't returned
        by Azure — leave them blank to keep the pipeline's value.
      </p>

      <label>
        <span>Branch</span>
        <input
          v-model="branch"
          placeholder="refs/heads/main"
          title="Full ref the run uses, e.g. refs/heads/main. Carried over from the chosen run."
        />
      </label>

      <fieldset class="apr-group">
        <legend>Parameters</legend>
        <div v-if="!params.length" class="apr-empty">No template parameters on the chosen run.</div>
        <div v-for="(row, i) in params" :key="`p-${i}`" class="apr-row">
          <input v-model="row.key" class="apr-row__key" placeholder="name" />
          <input v-model="row.value" class="apr-row__value" placeholder="value" />
          <button type="button" class="button button--ghost button--xs" title="Remove" @click="params.splice(i, 1)">
            ✕
          </button>
        </div>
        <button type="button" class="button button--ghost button--xs" @click="params.push({ key: '', value: '' })">
          + Add parameter
        </button>
      </fieldset>

      <fieldset v-if="vars.length" class="apr-group">
        <legend>Variables</legend>
        <div v-for="(row, i) in vars" :key="`v-${i}`" class="apr-row">
          <input v-model="row.name" class="apr-row__key" placeholder="name" />
          <input
            v-model="row.value"
            class="apr-row__value"
            :placeholder="row.isSecret ? '(secret — blank keeps current)' : 'value'"
          />
          <span v-if="row.isSecret" class="apr-secret" title="Secret variable — value not shown">🔒</span>
        </div>
      </fieldset>

      <p v-if="error" class="apr-error">{{ error }}</p>

      <div class="form__actions">
        <button type="button" class="button button--ghost" :disabled="submitting" @click="cancel">Cancel</button>
        <button type="submit" class="button" :disabled="submitting">
          {{ submitting ? "Queueing…" : "▶ Run" }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useAzurePipelinesStore } from "../../stores/azure-pipelines.js";

const props = defineProps<{
  connectionId: string;
  projectName: string;
  pipelineId: number | string;
  pipelineName?: string;
  runId: number | string;
  onCancel?: () => void;
  onSubmitted?: (run: { id: number; state: string; result?: string; webUrl: string }) => void;
}>();

const store = useAzurePipelinesStore();

const loading = ref(true);
const submitting = ref(false);
const error = ref("");
const branch = ref("");
const params = reactive<Array<{ key: string; value: string }>>([]);
const vars = reactive<Array<{ name: string; value: string; isSecret: boolean }>>([]);

onMounted(async () => {
  try {
    const seed = await store.getRunSeed(props.connectionId, props.projectName, props.pipelineId, props.runId);
    branch.value = seed.branch || "";
    for (const [key, value] of Object.entries(seed.parameters || {})) {
      params.push({ key, value });
    }
    for (const v of seed.variables || []) {
      vars.push({ name: v.name, value: v.value, isSecret: v.isSecret });
    }
  } catch (err) {
    // Seed fetch can fail (e.g. PAT lacks read) — still allow a manual run.
    error.value = `Couldn't load the run's parameters: ${(err as Error)?.message || "unknown error"}`;
  } finally {
    loading.value = false;
  }
});

function cancel() {
  props.onCancel?.();
}

async function handleSubmit() {
  submitting.value = true;
  error.value = "";
  try {
    const parameters: Record<string, string> = {};
    for (const row of params) {
      const key = row.key.trim();
      if (key) parameters[key] = row.value;
    }
    const variables = vars.map((v) => ({ name: v.name.trim(), value: v.value, isSecret: v.isSecret }));
    const run = await store.run({
      connectionId: props.connectionId,
      projectName: props.projectName,
      pipelineId: props.pipelineId,
      branch: branch.value.trim() || undefined,
      parameters,
      variables,
    });
    props.onSubmitted?.(run);
  } catch (err) {
    error.value = (err as Error)?.message || "Failed to queue the run.";
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.apr-loading {
  padding: 24px 4px;
  color: var(--text-muted, #888);
}
.apr-note {
  font-size: 12px;
  color: var(--text-muted, #888);
  margin: 0 0 4px;
}
.apr-group {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  margin: 0;
}
.apr-group legend {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
  padding: 0 4px;
}
.apr-empty {
  font-size: 12px;
  color: var(--text-muted, #888);
  font-style: italic;
  margin-bottom: 6px;
}
.apr-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.apr-row__key {
  flex: 0 0 40%;
}
.apr-row__value {
  flex: 1;
}
.apr-secret {
  flex: 0 0 auto;
}
.apr-error {
  color: var(--danger, #e53935);
  font-size: 12px;
  white-space: pre-wrap;
  margin: 0;
}
.button--xs {
  font-size: 10px;
  padding: 1px 8px;
}
</style>
