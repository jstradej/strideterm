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
        <div ref="branchEl" class="apr-branch">
          <input
            v-model="branch"
            class="apr-branch__input"
            placeholder="refs/heads/main"
            title="Full ref the run uses, e.g. refs/heads/main. Pick a branch/tag or type any ref."
            @keydown.escape="branchOpen = false"
          />
          <button
            type="button"
            class="apr-branch__toggle"
            :title="refsLoading ? 'Loading branches…' : 'Pick a branch or tag'"
            @click="toggleBranch"
          >
            <span v-if="refsLoading" class="apr-branch__spinner" />
            <span v-else aria-hidden="true">▾</span>
          </button>
          <div v-if="branchOpen" class="apr-branch__menu">
            <div class="apr-branch__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                :class="['apr-branch__tab', { 'apr-branch__tab--active': branchTab === 'branches' }]"
                :aria-selected="branchTab === 'branches'"
                @click="branchTab = 'branches'"
              >
                Branches <span class="apr-branch__tabcount">{{ branchCount }}</span>
              </button>
              <button
                type="button"
                role="tab"
                :class="['apr-branch__tab', { 'apr-branch__tab--active': branchTab === 'tags' }]"
                :aria-selected="branchTab === 'tags'"
                @click="branchTab = 'tags'"
              >
                Tags <span class="apr-branch__tabcount">{{ tagCount }}</span>
              </button>
              <button
                type="button"
                role="tab"
                :class="['apr-branch__tab', { 'apr-branch__tab--active': branchTab === 'commits' }]"
                :aria-selected="branchTab === 'commits'"
                @click="branchTab = 'commits'"
              >
                Commits <span v-if="commitsLoaded" class="apr-branch__tabcount">{{ commits.length }}</span>
              </button>
            </div>
            <input
              v-model="branchQuery"
              class="apr-branch__search"
              type="search"
              :placeholder="`Filter ${branchTab}…`"
              @keydown.escape="branchOpen = false"
            />
            <!-- Commits tab: list recent commits; picking one runs against that commit. -->
            <template v-if="branchTab === 'commits'">
              <div v-if="commitsLoading" class="apr-branch__empty">Loading commits…</div>
              <div v-else-if="!commits.length" class="apr-branch__empty">No commits available.</div>
              <div v-else-if="!filteredCommits.length" class="apr-branch__empty">No matching commits.</div>
              <ul v-else class="apr-branch__list">
                <li
                  v-for="c in filteredCommits"
                  :key="c.id"
                  :class="['apr-branch__item', { 'apr-branch__item--active': c.id === branch }]"
                  :title="`${c.comment}\n${c.author}`"
                  @mousedown.prevent="pickCommit(c)"
                >
                  <span class="apr-branch__sha">{{ c.shortId }}</span>
                  <span class="apr-branch__msg">{{ c.comment }}</span>
                </li>
              </ul>
            </template>
            <!-- Branches / Tags tabs. -->
            <template v-else>
              <div v-if="refsLoading" class="apr-branch__empty">Loading…</div>
              <div v-else-if="!activeRefs.length" class="apr-branch__empty">No matching {{ branchTab }}.</div>
              <ul v-else class="apr-branch__list">
                <li
                  v-for="o in activeRefs"
                  :key="o.value"
                  :class="['apr-branch__item', { 'apr-branch__item--active': o.value === branch }]"
                  @mousedown.prevent="pickBranch(o.value)"
                >
                  <span class="apr-branch__name">{{ stripRef(o.value) }}</span>
                </li>
              </ul>
            </template>
          </div>
        </div>
      </label>

      <fieldset class="apr-group">
        <legend>Parameters</legend>
        <div v-if="!params.length" class="apr-empty">No template parameters on the chosen run.</div>
        <template v-for="(row, i) in params" :key="`p-${i}`">
          <!-- Decorative separator the pipeline declares as a section header. -->
          <div v-if="row.def && isSeparator(row.def)" class="apr-separator">{{ row.def.displayName }}</div>
          <div v-else class="apr-row">
            <!-- Declared parameter: fixed label + control typed from the pipeline schema. -->
            <template v-if="row.def">
              <span class="apr-row__label" :title="row.def.name">{{ row.def.displayName }}</span>
              <select v-if="row.def.values" v-model="row.value" class="apr-row__value">
                <option v-for="opt in selectOptions(row)" :key="opt" :value="opt">{{ opt }}</option>
              </select>
              <label v-else-if="row.def.type === 'boolean'" class="apr-row__bool">
                <input type="checkbox" :checked="isTrue(row.value)" @change="setBool(row, $event)" />
                <span>{{ isTrue(row.value) ? "true" : "false" }}</span>
              </label>
              <input v-else-if="row.def.type === 'number'" v-model="row.value" class="apr-row__value" type="number" />
              <input v-else v-model="row.value" class="apr-row__value" placeholder="value" />
            </template>
            <!-- Ad-hoc parameter not in the schema: editable name + value, removable. -->
            <template v-else>
              <input v-model="row.key" class="apr-row__key" placeholder="name" />
              <input v-model="row.value" class="apr-row__value" placeholder="value" />
              <button type="button" class="button button--ghost button--xs" title="Remove" @click="params.splice(i, 1)">
                ✕
              </button>
            </template>
          </div>
        </template>
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
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useAzurePipelinesStore } from "../../stores/azure-pipelines.js";
import type { AzurePipelineParameterDef, AzurePipelineCommit } from "../../../electron/shared/types/azure-pipelines.js";
import { useDismissable } from "../../composables/useDismissable.js";

/** A parameter row: free-form (editable name) unless `def` ties it to the schema. */
interface ParamRow {
  key: string;
  value: string;
  def?: AzurePipelineParameterDef;
}

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
const params = reactive<ParamRow[]>([]);
const vars = reactive<Array<{ name: string; value: string; isSecret: boolean }>>([]);

// --- Branch picker (custom combobox over the repo's branches + tags) ---
const branchOptions = ref<Array<{ value: string; kind: string }>>([]);
const refsLoading = ref(false);
const branchOpen = ref(false);
const branchQuery = ref("");
const branchTab = ref<"branches" | "tags" | "commits">("branches");
const branchEl = ref<HTMLElement | null>(null);
// Commits load lazily (only when the Commits tab is first opened).
const repoId = ref("");
const commits = ref<AzurePipelineCommit[]>([]);
const commitsLoading = ref(false);
const commitsLoaded = ref(false);

onMounted(async () => {
  try {
    const seed = await store.getRunSeed(props.connectionId, props.projectName, props.pipelineId, props.runId);
    branch.value = seed.branch || "";
    for (const v of seed.variables || []) {
      vars.push({ name: v.name, value: v.value, isSecret: v.isSecret });
    }

    // Parameter schema → typed controls. Best-effort: on failure every parameter
    // falls back to a free-text row.
    let schema: AzurePipelineParameterDef[] = [];
    try {
      schema = await store.getRunParameters(
        props.connectionId,
        props.projectName,
        props.pipelineId,
        seed.branch || undefined,
      );
    } catch {
      // Schema is optional — leave it empty and render free-text rows.
    }

    const seedParams = seed.parameters || {};
    const declared = new Set<string>();
    // Declared parameters first, in schema order, pre-filled from the run (or default).
    for (const def of schema) {
      declared.add(def.name);
      const value = def.name in seedParams ? seedParams[def.name] : (def.default ?? "");
      params.push({ key: def.name, value, def });
    }
    // Anything the run set that the schema doesn't declare stays editable free-text.
    for (const [key, value] of Object.entries(seedParams)) {
      if (!declared.has(key)) params.push({ key, value });
    }
  } catch (err) {
    // Seed fetch can fail (e.g. PAT lacks read) — still allow a manual run.
    error.value = `Couldn't load the run's parameters: ${(err as Error)?.message || "unknown error"}`;
  } finally {
    loading.value = false;
  }

  // Refs load in the background so the form appears immediately; the branch
  // field shows a spinner until they arrive (and stays free-text on failure).
  void loadRefs();
});

useDismissable(branchOpen, branchEl, {
  onDismiss: () => {
    branchOpen.value = false;
  },
  eventName: "mousedown",
});

async function loadRefs(): Promise<void> {
  refsLoading.value = true;
  try {
    const refs = await store.getRefs(props.connectionId, props.projectName, props.pipelineId);
    branchOptions.value = [
      ...refs.branches.map((value) => ({ value, kind: "branch" })),
      ...refs.tags.map((value) => ({ value, kind: "tag" })),
    ];
    repoId.value = refs.repositoryId || "";
  } catch {
    // Picker is optional — the field stays free-text.
  } finally {
    refsLoading.value = false;
  }
}

async function loadCommits(): Promise<void> {
  if (commitsLoaded.value || commitsLoading.value || !repoId.value) return;
  commitsLoading.value = true;
  try {
    commits.value = await store.getCommits(props.connectionId, props.projectName, repoId.value);
    commitsLoaded.value = true;
  } catch {
    // Best-effort — Commits tab just shows nothing.
  } finally {
    commitsLoading.value = false;
  }
}

// Fetch commits only when the Commits tab is first activated.
watch(branchTab, (tab) => {
  if (tab === "commits") void loadCommits();
});

/** Strip the refs/heads/ or refs/tags/ prefix for display. */
function stripRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

const branchCount = computed(() => branchOptions.value.filter((o) => o.kind === "branch").length);
const tagCount = computed(() => branchOptions.value.filter((o) => o.kind === "tag").length);

/** Refs for the active tab, filtered by the search box. */
const activeRefs = computed(() => {
  const wantKind = branchTab.value === "tags" ? "tag" : "branch";
  const q = branchQuery.value.trim().toLowerCase();
  return branchOptions.value.filter(
    (o) =>
      o.kind === wantKind && (!q || o.value.toLowerCase().includes(q) || stripRef(o.value).toLowerCase().includes(q)),
  );
});

const filteredCommits = computed(() => {
  const q = branchQuery.value.trim().toLowerCase();
  if (!q) return commits.value;
  return commits.value.filter(
    (c) => c.shortId.includes(q) || c.comment.toLowerCase().includes(q) || c.author.toLowerCase().includes(q),
  );
});

function toggleBranch(): void {
  branchOpen.value = !branchOpen.value;
  if (branchOpen.value) {
    branchQuery.value = "";
    // Open on the tab matching the current selection so it's visible right away.
    branchTab.value = branch.value.startsWith("refs/tags/")
      ? "tags"
      : /^[0-9a-f]{40}$/i.test(branch.value)
        ? "commits"
        : "branches";
  }
}

function pickBranch(value: string): void {
  branch.value = value;
  branchOpen.value = false;
}

/** A commit picks its full id as the ref — the backend turns a 40-char hex into a `version`. */
function pickCommit(commit: AzurePipelineCommit): void {
  branch.value = commit.id;
  branchOpen.value = false;
}

/** Options for a choice parameter, keeping the run's current value visible if it dropped out of the list. */
function selectOptions(row: ParamRow): string[] {
  const values = row.def?.values ?? [];
  if (row.value && !values.includes(row.value)) return [row.value, ...values];
  return values;
}

/** Azure sends booleans as "True"/"False" (capitalised) — compare loosely. */
function isTrue(value: string): boolean {
  return /^true$/i.test(value.trim());
}

function setBool(row: ParamRow, e: Event): void {
  row.value = (e.target as HTMLInputElement).checked ? "true" : "false";
}

/**
 * Pipelines often declare blank-valued choice params (a single " " option, or a
 * `_separator*` name) purely as visual section headers. Render those as a label,
 * not an empty dropdown.
 */
function isSeparator(def: AzurePipelineParameterDef): boolean {
  if (def.name.startsWith("_separator")) return true;
  return def.values?.length === 1 && def.values[0].trim() === "";
}

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

/* --- Branch combobox --- */
.apr-branch {
  position: relative;
}
.apr-branch__input {
  width: 100%;
  box-sizing: border-box;
  padding-right: 28px;
}
.apr-branch__toggle {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-muted, #888);
  cursor: pointer;
  font-size: 11px;
}
.apr-branch__toggle:hover {
  color: var(--text-primary, #e2e8f0);
}
.apr-branch__menu {
  position: absolute;
  z-index: 10;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  padding: 4px;
  background: var(--bg-elevated, #1c1c20);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
/* Tabs to switch Branches / Tags, mirroring Azure DevOps' picker. */
.apr-branch__tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.apr-branch__tab {
  flex: 0 0 auto;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-muted, #888);
  cursor: pointer;
}
.apr-branch__tab:hover {
  color: var(--text-primary, #e2e8f0);
}
.apr-branch__tab--active {
  color: var(--text-primary, #e2e8f0);
  border-bottom-color: var(--accent, #3b82f6);
}
.apr-branch__tabcount {
  font-size: 10px;
  color: var(--text-muted, #888);
  font-variant-numeric: tabular-nums;
}
.apr-branch__search {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 4px;
}
.apr-branch__list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 220px;
  overflow: auto;
}
.apr-branch__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.apr-branch__item:hover {
  background: rgba(255, 255, 255, 0.06);
}
.apr-branch__item--active {
  background: var(--accent-subtle, rgba(99, 179, 237, 0.15));
}
.apr-branch__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary, #e2e8f0);
}
.apr-branch__sha {
  flex: 0 0 auto;
  font-family: var(--mono, monospace);
  font-size: 11px;
  color: var(--accent, #3b82f6);
}
.apr-branch__msg {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary, #e2e8f0);
}
.apr-branch__empty {
  padding: 8px;
  font-size: 12px;
  font-style: italic;
  color: var(--text-muted, #888);
}
.apr-branch__spinner {
  display: inline-block;
  width: 11px;
  height: 11px;
  border: 2px solid color-mix(in srgb, var(--accent, #3b82f6), transparent 65%);
  border-top-color: var(--accent, #3b82f6);
  border-radius: 50%;
  animation: apr-spin 0.7s linear infinite;
}
@keyframes apr-spin {
  to {
    transform: rotate(360deg);
  }
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
.apr-separator {
  margin: 8px 0 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
  text-align: center;
}
.apr-row__key {
  flex: 0 0 40%;
}
.apr-row__label {
  flex: 0 0 40%;
  font-size: 12px;
  color: var(--text, #d8e4f5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.apr-row__value {
  flex: 1;
}
.apr-row__bool {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted, #888);
}
.apr-row__bool input {
  width: 15px;
  height: 15px;
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
