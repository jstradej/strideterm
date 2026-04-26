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
          @click.stop="onActionClick($event, action)"
          @mousedown.stop
        >
          {{ action.label }}
        </button>
      </template>
    </div>
  </header>
</template>

<script setup lang="ts">
interface PaneAction {
  action: string;
  viewId?: string;
  sessionId?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  label?: string;
}

withDefaults(defineProps<{
  title?: string;
  status?: string;
  actions?: PaneAction[];
}>(), {
  title: "",
  status: "",
  actions: () => [],
});

const emit = defineEmits<{
  (e: "action", action: PaneAction, meta: { anchorRect: DOMRect | null; event: MouseEvent }): void;
}>();

// Capture the button element synchronously on click — event.currentTarget
// is only reliable during the dispatched event lifecycle, so we snapshot
// it into the emitted payload for callers that need to position menus
// relative to the clicked button.
function onActionClick(event: MouseEvent, action: PaneAction): void {
  const anchorRect = (event?.currentTarget as Element)?.getBoundingClientRect?.() || null;
  emit("action", action, { anchorRect, event });
}
</script>
