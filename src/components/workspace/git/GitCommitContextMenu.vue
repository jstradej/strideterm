<template>
  <Teleport to="body">
    <div
      ref="menuRef"
      class="commit-ctx"
      role="menu"
      tabindex="-1"
      :style="positionStyle"
      @keydown="onKeydown"
      @click.stop
    >
      <div class="commit-ctx__header">
        <span class="commit-ctx__hash">{{ shortHash }}</span>
        <span class="commit-ctx__subject">{{ subject || "—" }}</span>
      </div>
      <button v-for="item in items" :key="item.id" type="button" class="commit-ctx__item" role="menuitem" @click="run(item.id)">
        <span class="commit-ctx__label">{{ item.label }}</span>
        <span v-if="item.shortcut" class="commit-ctx__shortcut">{{ item.shortcut }}</span>
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, nextTick } from "vue";

interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
}

const props = defineProps<{
  x: number;
  y: number;
  shortHash: string;
  subject: string;
  items: MenuItem[];
}>();

const emit = defineEmits<{
  (e: "pick", id: string): void;
  (e: "close"): void;
}>();

const menuRef = ref<HTMLElement | null>(null);
const adjustedX = ref(props.x);
const adjustedY = ref(props.y);

const positionStyle = computed(() => ({
  position: "fixed" as const,
  left: `${adjustedX.value}px`,
  top: `${adjustedY.value}px`,
  zIndex: "10060",
}));

function run(id: string) {
  emit("pick", id);
}

function onDocumentMousedown(e: MouseEvent) {
  if (!menuRef.value) return;
  if (!menuRef.value.contains(e.target as Node)) emit("close");
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    emit("close");
  }
}

function onWindowBlur() {
  emit("close");
}

onMounted(() => {
  // Flip the menu back into view if it would overflow the right/bottom edges.
  // Sized after first paint because the height depends on the items prop.
  nextTick(() => {
    if (!menuRef.value) return;
    const rect = menuRef.value.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw - 4) adjustedX.value = Math.max(4, vw - rect.width - 4);
    if (rect.bottom > vh - 4) adjustedY.value = Math.max(4, vh - rect.height - 4);
    menuRef.value.focus({ preventScroll: true });
  });
  document.addEventListener("mousedown", onDocumentMousedown, true);
  window.addEventListener("blur", onWindowBlur);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocumentMousedown, true);
  window.removeEventListener("blur", onWindowBlur);
});
</script>

<style scoped>
.commit-ctx {
  min-width: 240px;
  max-width: 360px;
  background: var(--panel-elevated, #1e2127);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
  padding: 4px 0;
  outline: none;
  font-size: 12px;
}

.commit-ctx__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
}

.commit-ctx__hash {
  font-family: var(--font-mono, ui-monospace, "SF Mono", monospace);
  color: var(--accent);
  font-weight: 600;
}

.commit-ctx__subject {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 11px;
}

.commit-ctx__item {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 12px;
  padding: 5px 12px;
  background: transparent;
  border: 0;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.commit-ctx__item:hover,
.commit-ctx__item:focus-visible {
  background: rgba(var(--tint), 0.12);
  outline: none;
}

.commit-ctx__label {
  flex: 1;
}

.commit-ctx__shortcut {
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
</style>
