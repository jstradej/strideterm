<template>
  <header class="workspace-pane__header">
    <div class="workspace-pane__meta">
      <strong>{{ title }}</strong>
      <small>{{ status }}</small>
    </div>
    <div class="workspace-pane__actions">
      <button
        v-for="action in actions"
        :key="action.action + (action.viewId || action.sessionId || '')"
        type="button"
        :class="action.className"
        :disabled="!!action.disabled"
        :title="action.title"
        @click="$emit('action', action)"
      >
        {{ action.label }}
      </button>
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
