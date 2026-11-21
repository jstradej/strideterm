<template>
  <!-- An empty title keeps the tab's own native tooltip from showing over the note. -->
  <span
    ref="root"
    class="tab__notes"
    :class="{ 'tab__notes--picker': picker }"
    title=""
    :aria-label="'Tab note: ' + notes"
    @mouseenter="show"
    @mouseleave="hide"
    @click.stop="edit"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 2v4M12 2v4M16 2v4" />
      <rect x="4" y="4" width="16" height="18" rx="2" />
      <path d="M8 10h6M8 14h8M8 18h5" />
    </svg>
    <Teleport to="body">
      <div v-if="visible" ref="note" class="tab-note-postit" role="tooltip" :style="position">{{ notes }}</div>
    </Teleport>
  </span>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";

defineProps<{ notes: string; picker?: boolean }>();
const emit = defineEmits<{ edit: [] }>();

const SHOW_DELAY_MS = 250;
const root = ref<HTMLElement | null>(null);
const note = ref<HTMLElement | null>(null);
const visible = ref(false);
const coords = ref({ top: 0, left: 0 });
let timer: ReturnType<typeof setTimeout> | undefined;

const position = computed(() => ({ top: `${coords.value.top}px`, left: `${coords.value.left}px` }));

function place() {
  const anchor = root.value?.getBoundingClientRect();
  if (!anchor) return;
  const size = note.value?.getBoundingClientRect();
  const width = size?.width || 300;
  const height = size?.height || 120;
  const below = anchor.bottom + 6;
  coords.value = {
    top: below + height > window.innerHeight ? Math.max(8, anchor.top - height - 6) : below,
    left: Math.min(Math.max(8, anchor.left - 16), Math.max(8, window.innerWidth - width - 8)),
  };
}

function show() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    visible.value = true;
    window.addEventListener("scroll", hide, true);
    void nextTick(place);
  }, SHOW_DELAY_MS);
}

function hide() {
  clearTimeout(timer);
  visible.value = false;
  window.removeEventListener("scroll", hide, true);
}

function edit() {
  hide();
  emit("edit");
}

onBeforeUnmount(hide);
</script>

<style scoped>
.tab-note-postit {
  position: fixed;
  z-index: 10000;
  display: -webkit-box;
  max-width: 300px;
  min-width: 120px;
  padding: 10px 12px 12px;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 14;
  border-radius: 2px 2px 2px 12px;
  background: linear-gradient(180deg, #fff7a1 0%, #ffee6e 100%);
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.18),
    0 8px 18px rgba(0, 0, 0, 0.25);
  color: #3a3200;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  transform: rotate(-0.8deg);
  pointer-events: none;
}
</style>
