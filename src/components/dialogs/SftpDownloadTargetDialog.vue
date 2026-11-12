<template>
  <div class="dialog sftp-download-dialog" data-testid="sftp-download-dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">SFTP</p>
        <h2>Download to a workspace folder</h2>
        <p class="sftp-download-dialog__hint">
          Files are saved on the desktop, inside one of this profile's workspace folders.
        </p>
      </div>
    </div>
    <form class="form" @submit.prevent="submit">
      <label>
        <span>Workspace folder</span>
        <select v-model="root" name="sftp-download-root" data-testid="sftp-download-root">
          <option v-for="candidate in roots" :key="candidate" :value="candidate">{{ candidate }}</option>
        </select>
      </label>
      <label>
        <span>Sub-folder (optional)</span>
        <input
          v-model="relative"
          name="sftp-download-subfolder"
          data-testid="sftp-download-subfolder"
          placeholder="downloads"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <p v-if="error" class="sftp-download-dialog__error" data-testid="sftp-download-error">{{ error }}</p>
      <footer class="dialog__footer sftp-download-dialog__footer">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button type="submit" class="button" :disabled="!root" data-testid="sftp-download-submit">Download</button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { isSafeRelativeFolder, joinLocal } from "../workspace/sftp/sftp-helpers.js";

const props = defineProps<{ roots: string[] }>();
const emit = defineEmits<{
  cancel: [];
  submit: [localDir: string];
}>();

const root = ref(props.roots[0] || "");
const relative = ref("");
const error = ref("");

function submit(): void {
  if (!root.value) return;
  if (!isSafeRelativeFolder(relative.value)) {
    error.value = "The sub-folder must stay inside the workspace folder.";
    return;
  }
  error.value = "";
  emit("submit", joinLocal(root.value, relative.value));
}
</script>

<style scoped>
.sftp-download-dialog {
  width: min(480px, 100%);
}

.sftp-download-dialog__hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
}

.sftp-download-dialog__error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}

.sftp-download-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
