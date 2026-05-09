<template>
  <div ref="paneBodyRef" class="workspace-pane__body"></div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useTerminal } from "../../composables/useTerminal.js";

const props = defineProps<{ sessionId: string }>();

const paneBodyRef = ref<HTMLDivElement | null>(null);
// Pass a getter so useTerminal re-binds xterm when the parent swaps the
// session id without unmounting this component. The previous static-string
// form attached once and silently kept showing the old session's output
// when the cell's tab strip moved on. (Earlier we keyed the parent on
// activeViewId to force a fresh mount, but the unmount/remount cycle
// caused the workspace-stage to lose its 1fr height for a moment and the
// surrounding grid cells visibly shrank.)
useTerminal(() => props.sessionId, paneBodyRef);
</script>
