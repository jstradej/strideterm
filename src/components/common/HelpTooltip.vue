<template>
  <span ref="root" class="help-tooltip" @mouseenter="open" @mouseleave="scheduleClose">
    <button
      type="button"
      class="help-tooltip__button"
      data-no-dialog-autofocus
      :aria-label="label"
      :aria-describedby="id"
      :aria-expanded="visible"
      @focus="open"
      @blur="scheduleClose"
      @click.stop.prevent="pinOrToggle"
      @keydown.esc.stop.prevent="close"
    >
      ?
    </button>
    <Teleport to="body">
      <div
        v-show="visible"
        :id="id"
        ref="tooltip"
        class="help-tooltip__content"
        :class="{ 'help-tooltip__content--open': visible }"
        role="tooltip"
        :data-open="visible ? 'true' : 'false'"
        :style="position"
        @mouseenter="cancelClose"
        @mouseleave="scheduleClose"
      >
        {{ props.text }}
      </div>
    </Teleport>
  </span>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";

const props = withDefaults(defineProps<{ text: string; label?: string }>(), { label: "Help" });
const id = `ssh-help-${Math.random().toString(36).slice(2)}`;
const root = ref<HTMLElement | null>(null);
const tooltip = ref<HTMLElement | null>(null);
const visible = ref(false);
const pinned = ref(false);
const coords = ref({ top: 0, left: 0 });
let closeTimer: ReturnType<typeof setTimeout> | undefined;

const position = computed(() => ({ top: `${coords.value.top}px`, left: `${coords.value.left}px` }));

function place() {
  const rect = root.value?.getBoundingClientRect();
  if (!rect) return;
  const tipRect = tooltip.value?.getBoundingClientRect();
  const height = tipRect?.height || 80;
  const width = tipRect?.width || Math.min(400, window.innerWidth - 16);
  const top = rect.bottom + 8;
  coords.value = {
    top: top + height > window.innerHeight ? Math.max(8, rect.top - height - 8) : top,
    left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
  };
}

function open() {
  cancelClose();
  visible.value = true;
  nextTick(place);
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
}

function close() {
  visible.value = false;
  pinned.value = false;
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("resize", place);
  window.removeEventListener("scroll", place, true);
}

function pinOrToggle() {
  if (visible.value && pinned.value) close();
  else {
    open();
    pinned.value = true;
  }
}

function onOutside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node) && !tooltip.value?.contains(event.target as Node)) close();
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape" && visible.value) {
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }
}

function closeIfInactive() {
  setTimeout(() => {
    if ((root.value?.closest(".overlay") as HTMLElement | null)?.inert) close();
  }, 0);
}
function closeForPrompt() {
  close();
}

function cancelClose() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = undefined;
}

function scheduleClose() {
  cancelClose();
  closeTimer = setTimeout(() => {
    if (!pinned.value && !root.value?.contains(document.activeElement)) close();
  }, 120);
}

onBeforeUnmount(() => {
  cancelClose();
  close();
});

window.addEventListener("ssh-dialog-layer-change", closeIfInactive);
window.addEventListener("ssh-modal-open", closeForPrompt);
onBeforeUnmount(() => window.removeEventListener("ssh-dialog-layer-change", closeIfInactive));
onBeforeUnmount(() => window.removeEventListener("ssh-modal-open", closeForPrompt));
</script>

<style scoped>
.help-tooltip {
  display: inline-flex;
  vertical-align: middle;
  margin-left: 5px;
}
.help-tooltip__button {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--muted);
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  cursor: help;
}
.help-tooltip__button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.help-tooltip__content {
  position: fixed;
  z-index: 11000;
  width: min(400px, calc(100vw - 16px));
  max-height: min(60vh, 420px);
  overflow-y: auto;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-elevated);
  color: var(--text);
  box-shadow: 0 8px 24px #0008;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
  white-space: pre-line;
}
</style>
