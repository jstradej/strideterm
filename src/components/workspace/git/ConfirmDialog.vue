<template>
  <div :class="['git-operation-banner', severityClass]" data-testid="confirm-dialog">
    <template v-if="pending.isDestructive">
      <strong>{{ pending.title }}</strong>
      <p v-if="pending.body" style="white-space: pre-wrap">{{ pending.body }}</p>
    </template>
    <template v-else>
      <strong>{{ messageLines[0] || "" }}</strong>
      <p v-for="(line, i) in messageLines.slice(1)" :key="i">{{ line }}</p>
    </template>
    <div class="git-operation-actions">
      <button
        type="button"
        :class="['button', pending.severity === 'danger' && 'button--danger']"
        @click="$emit('confirm')"
      >
        {{ pending.confirmLabel || "Confirm" }}
      </button>
      <button type="button" class="button button--ghost" @click="$emit('cancel')">
        {{ pending.cancelLabel || "Cancel" }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
  pending: { type: Object, required: true },
});

defineEmits(["confirm", "cancel"]);

const messageLines = computed(() => String(props.pending?.message || "").split("\n"));

const severityClass = computed(() => {
  const sev = props.pending?.severity || "info";
  if (sev === "danger") return "git-operation-banner--danger";
  if (sev === "warn") return "git-operation-banner--warn";
  return "git-operation-banner--confirm";
});
</script>
