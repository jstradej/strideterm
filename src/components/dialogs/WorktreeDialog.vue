<template>
  <div class="dialog" style="width: min(460px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Git</p>
        <h2>New worktree</h2>
      </div>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label v-if="repoChoices.length > 1">
        <span>Repository</span>
        <CustomSelect v-model="selectedRoot" :options="repoOptions" />
        <small class="form__hint">
          The worktree is created inside the selected repository. Each repo has its own branches.
        </small>
      </label>
      <label>
        <span>Branch name</span>
        <input
          ref="inputRef"
          v-model="branchName"
          name="name"
          placeholder="feature/my-branch"
          required
          data-validation-required="Enter a name for the new branch."
        />
      </label>
      <div v-if="errorMessage" class="dialog__error" role="alert">
        <span class="dialog__error-icon" aria-hidden="true">⚠</span>
        <span class="dialog__error-text">{{ errorMessage }}</span>
      </div>
      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" :disabled="submitting" @click="emit('cancel')">
          Cancel
        </button>
        <button type="submit" class="button" :disabled="!canSubmit || submitting">
          {{ submitting ? "Creating…" : "Create" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, useAttrs } from "vue";
import CustomSelect from "../common/CustomSelect.vue";

interface RepoChoice {
  value: string;
  label: string;
}

interface Props {
  repoChoices?: RepoChoice[];
  preselectedRootPath?: string;
}

const props = withDefaults(defineProps<Props>(), {
  repoChoices: () => [],
  preselectedRootPath: "",
});

// "submit" is deliberately NOT a declared emit: emit is fire-and-forget, so a
// failed create closed nothing, showed nothing and logged nothing. Calling
// attrs.onSubmit lets us await it and show the rejection inline (same as
// WorkspaceDialog / CompanionAgentDialog). inheritAttrs: false stops Vue from
// also binding onSubmit as a native "submit" listener on the root div.
const emit = defineEmits<{
  cancel: [];
}>();
const attrs = useAttrs();
defineOptions({ inheritAttrs: false });

const inputRef = ref<HTMLInputElement | null>(null);
const branchName = ref("");
const selectedRoot = ref(props.preselectedRootPath || props.repoChoices[0]?.value || "");
const submitting = ref(false);
const errorMessage = ref("");

const repoOptions = computed(() => props.repoChoices.map((r) => ({ value: r.value, label: r.label })));

const canSubmit = computed(() => {
  if (!branchName.value.trim()) return false;
  if (props.repoChoices.length > 1 && !selectedRoot.value) return false;
  return true;
});

onMounted(() =>
  requestAnimationFrame(() => {
    inputRef.value?.focus();
  }),
);

async function handleSubmit() {
  const name = branchName.value.trim();
  if (!name || submitting.value) return;
  if (props.repoChoices.length > 1 && !selectedRoot.value) return;
  submitting.value = true;
  errorMessage.value = "";
  try {
    await (attrs.onSubmit as ((payload: { name: string; rootPath: string }) => Promise<void>) | undefined)?.({
      name,
      rootPath: selectedRoot.value || "",
    });
  } catch (err) {
    errorMessage.value = extractErrorMessage(err);
  } finally {
    submitting.value = false;
  }
}

function extractErrorMessage(err: unknown): string {
  const raw = (err as Error)?.message || String(err || "Unknown error");
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
}
</script>

<style scoped>
.form__hint {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-top: 4px;
}
</style>
