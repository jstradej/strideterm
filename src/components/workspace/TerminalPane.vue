<template>
  <div ref="paneBodyRef" class="workspace-pane__body">
    <TerminalSearchOverlay :session-id="sessionId" />
    <!-- Touch affordance for "Select text". The long press inside the terminal
         does the same thing, but a gesture nobody has been told about is not a
         feature — and a tablet with an external keyboard and mouse never shows
         the MobileInputBar that carries the menu entry. Gated on the device
         having a coarse pointer at all, NOT on viewport width or on the remote
         transport: a touchscreen laptop running the desktop build has exactly
         the same problem dragging out an xterm selection by finger. -->
    <button
      v-if="hasCoarsePointer"
      type="button"
      class="term-select-btn"
      data-role="terminal-select-text"
      title="Select text — opens a snapshot of this screen you can select and copy with the phone's own handles. Long-pressing the terminal does the same."
      aria-label="Select text from this terminal"
      @mousedown.prevent
      @click="openTextSelection"
    >
      ⿴
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useTerminal } from "../../composables/useTerminal.js";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import { useTerminalStore } from "../../stores/terminal.js";
import TerminalSearchOverlay from "./TerminalSearchOverlay.vue";

const props = defineProps<{ sessionId: string }>();

const paneBodyRef = ref<HTMLDivElement | null>(null);
useTerminal(() => props.sessionId, paneBodyRef);

const { hasCoarsePointer } = useIsNarrow();
const termStore = useTerminalStore();

function openTextSelection(): void {
  termStore.requestTextSelection(props.sessionId);
}
</script>

<style scoped>
.term-select-btn {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 4;
  /* 44 x 44 touch target, but visually quiet so it doesn't sit on top of the
     output it exists to help copy. */
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--panel-elevated), transparent 25%);
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.55;
}

.term-select-btn:hover,
.term-select-btn:active {
  opacity: 1;
  color: var(--text);
  background: var(--panel-elevated);
}
</style>
