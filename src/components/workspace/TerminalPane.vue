<template>
  <div ref="paneBodyRef" class="workspace-pane__body">
    <TerminalSearchOverlay :session-id="sessionId" />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useTerminal } from "../../composables/useTerminal.js";
import TerminalSearchOverlay from "./TerminalSearchOverlay.vue";

const props = defineProps<{ sessionId: string }>();

const paneBodyRef = ref<HTMLDivElement | null>(null);
useTerminal(() => props.sessionId, paneBodyRef);
</script>
