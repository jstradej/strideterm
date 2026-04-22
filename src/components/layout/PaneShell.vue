<template>
  <header class="workspace-pane__header">
    <div class="workspace-pane__meta">
      <strong>{{ title }}</strong>
      <small>{{ status }}</small>
    </div>
    <div class="workspace-pane__actions">
      <template v-for="(action, index) in actions" :key="action.action + (action.viewId || action.sessionId || index)">
        <span v-if="action.action === 'divider'" class="workspace-pane__action-divider" aria-hidden="true">|</span>
        <button
          v-else
          type="button"
          :class="action.className"
          :disabled="!!action.disabled"
          :title="action.title"
          @click="$emit('action', action, $event)"
        >
          {{ action.label }}
        </button>
      </template>
    </div>
  </header>
</template>

<script setup>
defineProps({
  title: { type: String, default: "" },
  status: { type: String, default: "" },
  actions: { type: Array, default: () => [] },
});
defineEmits(["action"]);
</script>
