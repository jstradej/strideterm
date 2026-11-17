<template>
  <span
    >{{ absolute }}<span v-if="relative" aria-live="off"> ({{ relative }})</span></span
  >
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";

const props = defineProps<{ at: string }>();
const now = ref(Date.now());
const timestamp = computed(() => new Date(props.at).getTime());
const absolute = computed(() =>
  Number.isFinite(timestamp.value) ? new Date(timestamp.value).toLocaleString() : props.at,
);
const relative = computed(() => {
  if (!Number.isFinite(timestamp.value)) return "";
  const seconds = Math.ceil((timestamp.value - now.value) / 1000);
  if (seconds <= 0) return "due now";
  if (seconds >= 86400) return `in ${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600) return `in ${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `in ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `in ${seconds}s`;
});
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
