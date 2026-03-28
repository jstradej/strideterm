<template>
  <div ref="paneBodyRef" class="workspace-pane__body"></div>
</template>

<script setup>
import { ref } from "vue";
import { useTerminal } from "../../composables/useTerminal.js";

const props = defineProps({
  sessionId: { type: String, required: true },
});

const paneBodyRef = ref(null);
useTerminal(props.sessionId, paneBodyRef);
</script>
