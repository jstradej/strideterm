<template>
  <div class="dialog" style="width: min(460px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Git</p>
        <h2>New worktree</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label v-if="repoChoices.length > 1">
        <span>Repository</span>
        <select v-model="selectedRoot" required>
          <option v-for="root in repoChoices" :key="root.value" :value="root.value">{{ root.label }}</option>
        </select>
        <small class="form__hint">
          The worktree is created inside the selected repository. Each repo has its own branches.
        </small>
      </label>
      <label>
        <span>Branch name</span>
        <input ref="inputRef" v-model="branchName" name="name" placeholder="feature/my-branch" required />
      </label>
      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button type="submit" class="button" :disabled="!canSubmit">Create</button>
      </footer>
    </form>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";

const props = defineProps({
  repoChoices: { type: Array, default: () => [] },
  preselectedRootPath: { type: String, default: "" },
});

const emit = defineEmits(["cancel", "submit"]);

const inputRef = ref(null);
const branchName = ref("");
const selectedRoot = ref(props.preselectedRootPath || props.repoChoices[0]?.value || "");

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

function handleSubmit() {
  const name = branchName.value.trim();
  if (!name) return;
  if (props.repoChoices.length > 1 && !selectedRoot.value) return;
  emit("submit", { name, rootPath: selectedRoot.value || "" });
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
