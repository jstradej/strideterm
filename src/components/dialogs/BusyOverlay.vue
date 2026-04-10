<template>
  <div class="busy-overlay">
    <div class="busy-overlay__spinner"></div>
    <strong class="busy-overlay__message">{{ message }}</strong>
    <small v-if="detail" class="busy-overlay__detail">{{ detail }}</small>
  </div>
</template>

<script setup>
defineProps({
  message: { type: String, default: "Please wait…" },
  detail: { type: String, default: "" },
});
</script>

<style scoped>
.busy-overlay {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px 40px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.busy-overlay__spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border);
  border-top-color: var(--accent, #e8a838);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.busy-overlay__message {
  font-size: 14px;
  color: var(--fg);
}

.busy-overlay__detail {
  color: var(--muted);
  font-size: 11px;
  max-width: 400px;
  word-break: break-all;
  text-align: center;
}
</style>
