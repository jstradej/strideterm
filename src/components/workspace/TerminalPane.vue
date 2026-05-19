<template>
  <div ref="paneBodyRef" class="workspace-pane__body"></div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useTerminal } from "../../composables/useTerminal.js";

const props = defineProps<{ sessionId: string }>();

const paneBodyRef = ref<HTMLDivElement | null>(null);
useTerminal(() => props.sessionId, paneBodyRef);
</script>
