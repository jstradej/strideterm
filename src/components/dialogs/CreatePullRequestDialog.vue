<template>
  <div class="dialog" style="width: min(560px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ providerLabel }}</p>
        <h2>Create pull request</h2>
      </div>
    </div>

    <form class="form create-pr" @submit.prevent="onSubmit">
      <div class="create-pr__row">
        <label class="create-pr__label">Source</label>
        <input class="create-pr__input" type="text" :value="sourceBranch" disabled />
      </div>

      <div class="create-pr__row">
        <label class="create-pr__label">Target</label>
        <CustomSelect
          v-model="targetBranch"
          :options="targetOptions"
          placeholder="-- select target --"
          :searchable="targetOptions.length > 8"
          search-placeholder="Filter branches…"
        />
        <button
          v-if="!loadingBranches"
          type="button"
          class="button button--ghost button--small"
          title="Re-fetch remote branches (origin)"
          @click="loadBranches"
        >
          Refresh
        </button>
        <span v-else class="create-pr__hint">Loading…</span>
      </div>

      <div class="create-pr__row">
        <label class="create-pr__label">Title</label>
        <input
          v-model="title"
          class="create-pr__input"
          type="text"
          required
          maxlength="400"
          placeholder="Pull request title"
        />
      </div>

      <div class="create-pr__row create-pr__row--stack">
        <label class="create-pr__label">Description</label>
        <textarea
          v-model="description"
          class="create-pr__input create-pr__textarea"
          rows="5"
          maxlength="4000"
          placeholder="Optional — supports Markdown."
        ></textarea>
      </div>

      <label class="create-pr__checkbox">
        <input v-model="isDraft" type="checkbox" />
        <span>Create as draft</span>
      </label>

      <p v-if="errorMessage" class="create-pr__error">{{ errorMessage }}</p>

      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button type="submit" class="button" :disabled="!canSubmit || busy">
          {{ busy ? "Creating…" : "Create pull request" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useAttrs, watch } from "vue";
import CustomSelect from "../common/CustomSelect.vue";

interface Props {
  workspaceId: string;
  sourceBranch: string;
  defaultTargetBranch?: string;
  remoteBranches?: string[];
  loadingBranches?: boolean;
  provider?: "azure" | "github";
}

const props = withDefaults(defineProps<Props>(), {
  defaultTargetBranch: "",
  remoteBranches: () => [],
  loadingBranches: false,
  provider: "azure",
});

defineOptions({ inheritAttrs: false });

// Intentionally NOT declaring "submit" in defineEmits — Vue strips declared
// events from $attrs, which would make attrs.onSubmit undefined and silently
// swallow any rejection from the parent's async submit handler. Treating
// onSubmit as a regular callback prop via useAttrs lets us await + catch. See
// WorkspaceDialog.vue for the established pattern.
const emit = defineEmits<{
  cancel: [];
  refreshBranches: [];
}>();
const attrs = useAttrs();

const targetBranch = ref(props.defaultTargetBranch.replace(/^origin\//, ""));
const title = ref("");
const description = ref("");
const isDraft = ref(false);
const busy = ref(false);
const errorMessage = ref("");

const providerLabel = computed(() => (props.provider === "github" ? "GitHub" : "Azure DevOps"));

const targetOptions = computed(() => {
  const names = (props.remoteBranches || []).map((b) => b.replace(/^origin\//, ""));
  const unique = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  return unique.map((b) => ({ value: b, label: b }));
});

const canSubmit = computed(
  () => !!title.value.trim() && !!targetBranch.value && targetBranch.value !== props.sourceBranch,
);

function loadBranches() {
  emit("refreshBranches");
}

async function onSubmit() {
  if (!canSubmit.value) return;
  busy.value = true;
  errorMessage.value = "";
  try {
    // Call the parent-provided onSubmit directly (via attrs) rather than
    // emit so we can await the async handler and catch its rejection — emit
    // is fire-and-forget and would swallow backend errors, leaving the
    // dialog open with busy stuck true and no feedback about what went wrong.
    await (
      attrs.onSubmit as
        | ((payload: { title: string; description: string; targetBranch: string; isDraft: boolean }) => Promise<void>)
        | undefined
    )?.({
      title: title.value.trim(),
      description: description.value.trim(),
      targetBranch: targetBranch.value,
      isDraft: isDraft.value,
    });
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to create pull request";
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.defaultTargetBranch,
  (next) => {
    if (!targetBranch.value && next) targetBranch.value = next.replace(/^origin\//, "");
  },
);

onMounted(() => {
  if (!props.remoteBranches?.length) emit("refreshBranches");
});
</script>

<style scoped>
.create-pr {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 8px;
}

.create-pr__row {
  display: grid;
  grid-template-columns: 90px 1fr auto;
  align-items: center;
  gap: 8px;
}

.create-pr__row--stack {
  align-items: start;
}

.create-pr__label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.create-pr__input {
  width: 100%;
  padding: 6px 8px;
  font-size: 13px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
}

.create-pr__input:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.create-pr__textarea {
  resize: vertical;
  min-height: 80px;
  font-family: inherit;
}

.create-pr__checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  padding-left: 98px;
}

.create-pr__hint {
  font-size: 11px;
  color: var(--muted);
}

.create-pr__error {
  margin: 4px 0 0;
  padding: 8px 10px;
  background: rgba(224, 123, 142, 0.15);
  border: 1px solid rgba(224, 123, 142, 0.45);
  border-radius: 4px;
  color: #e07b8e;
  font-size: 12px;
  white-space: pre-wrap;
}
</style>
