<template>
  <div class="dialog sftp-conflict-dialog" data-testid="sftp-conflict-dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">SFTP</p>
        <h2>{{ conflicts.length === 1 ? "1 item already exists" : `${conflicts.length} items already exist` }}</h2>
      </div>
    </div>
    <p class="sftp-conflict-dialog__message">
      Overwrite replaces them with the new files. Skip existing keeps what is there and transfers only the rest.
    </p>
    <ul class="sftp-conflict-dialog__list">
      <li v-for="path in shown" :key="path">
        <code>{{ path }}</code>
      </li>
      <li v-if="conflicts.length > shown.length" class="sftp-conflict-dialog__more">
        … and {{ conflicts.length - shown.length }} more
      </li>
    </ul>
    <footer class="dialog__footer sftp-conflict-dialog__footer">
      <button type="button" class="button button--ghost" data-testid="sftp-conflict-cancel" @click="emit('cancel')">
        Cancel
      </button>
      <button
        type="button"
        class="button button--ghost"
        data-testid="sftp-conflict-skip"
        @click="emit('choose', 'skip')"
      >
        Skip existing
      </button>
      <button
        type="button"
        class="button button--danger"
        data-testid="sftp-conflict-overwrite"
        @click="emit('choose', 'overwrite')"
      >
        Overwrite
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ conflicts: string[] }>();
const emit = defineEmits<{
  cancel: [];
  choose: [policy: "overwrite" | "skip"];
}>();

const shown = computed(() => props.conflicts.slice(0, 8));
</script>

<style scoped>
.sftp-conflict-dialog {
  width: min(520px, 100%);
}

.sftp-conflict-dialog__message {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--muted);
}

.sftp-conflict-dialog__list {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
}

.sftp-conflict-dialog__list code {
  word-break: break-all;
}

.sftp-conflict-dialog__more {
  color: var(--muted);
}

.sftp-conflict-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
