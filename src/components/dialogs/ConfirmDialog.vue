<template>
  <div class="dialog confirm-dialog">
    <div class="dialog__header">
      <div>
        <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ title }}</h2>
      </div>
    </div>
    <p class="confirm-dialog__message">{{ message }}</p>
    <footer class="dialog__footer confirm-dialog__footer">
      <button type="button" class="button button--ghost" @click="emit('cancel')">
        {{ cancelLabel }}
      </button>
      <button type="button" :class="['button', danger && 'button--danger']" @click="emit('confirm')">
        {{ confirmLabel }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    message: string;
    eyebrow?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }>(),
  {
    eyebrow: "",
    confirmLabel: "OK",
    cancelLabel: "Cancel",
    danger: false,
  },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<style scoped>
.confirm-dialog {
  width: min(460px, 100%);
}

.confirm-dialog__message {
  margin-top: 14px;
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.confirm-dialog__footer {
  margin-top: 18px;
  justify-content: flex-end;
}
</style>
