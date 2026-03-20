<template>
  <div class="workspace-pane__body" ref="paneBodyRef"></div>
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
