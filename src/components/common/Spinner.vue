<template>
  <span :class="['spinner', `spinner--${size}`]" role="status" :aria-label="label">
    <span class="sr-only">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: "sm" | "md" | "lg";
    label?: string;
  }>(),
  {
    size: "sm",
    label: "Loading…",
  },
);
</script>

<style scoped>
@keyframes spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}

.spinner {
  display: inline-block;
  border-radius: 50%;
  border-style: solid;
  border-color: transparent;
  border-top-color: currentColor;
  animation: spinner-rotate 0.7s linear infinite;
  flex-shrink: 0;
}

.spinner--sm {
  width: 12px;
  height: 12px;
  border-width: 2px;
}
.spinner--md {
  width: 24px;
  height: 24px;
  border-width: 3px;
}
.spinner--lg {
  width: 48px;
  height: 48px;
  border-width: 4px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
    border-top-color: transparent;
    border-left-color: currentColor;
  }
}
</style>
