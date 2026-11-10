<template>
  <div ref="root" class="fcl" :class="{ 'fcl--open': open, 'fcl--disabled': !items.length }">
    <button
      type="button"
      class="fcl__main"
      :title="current ? `${title.replace('{name}', current.label)}${shortcut ? ` (${shortcut})` : ''}` : emptyTitle"
      :aria-label="label"
      :disabled="!items.length"
      @click="$emit('pick', current?.key ?? '')"
    >
      <slot />
    </button>
    <button
      type="button"
      class="fcl__caret"
      :title="menuLabel"
      :aria-label="menuLabel"
      aria-haspopup="menu"
      :aria-expanded="open"
      :disabled="!items.length"
      @click="open = !open"
    >
      <span
        class="disclosure-chevron disclosure-chevron--down"
        :class="{ 'disclosure-chevron--open': open }"
        aria-hidden="true"
      />
    </button>
    <div v-if="open" class="fcl__menu" role="menu">
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        class="fcl__item"
        :class="{ 'fcl__item--current': item.key === current?.key }"
        role="menuitem"
        @click="pick(item.key)"
      >
        <span class="fcl__icon" aria-hidden="true">{{ item.icon }}</span
        >{{ item.label }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useDismissable } from "../../../composables/useDismissable.js";

export interface LaunchItem {
  key: string;
  icon: string;
  label: string;
}

const props = defineProps<{
  items: LaunchItem[];
  currentKey?: string;
  label: string;
  menuLabel: string;
  title: string;
  emptyTitle: string;
  shortcut?: string;
}>();

const emit = defineEmits<{ (e: "pick", key: string): void }>();

const root = ref<HTMLElement | null>(null);
const open = ref(false);
useDismissable(open, root, { onDismiss: () => (open.value = false) });

const current = computed(() => props.items.find((item) => item.key === props.currentKey) ?? props.items[0] ?? null);

function pick(key: string) {
  open.value = false;
  emit("pick", key);
}
</script>

<style scoped>
.fcl {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
}

.fcl--open {
  border-color: var(--accent, var(--border));
}

.fcl--disabled {
  opacity: 0.4;
}

.fcl__main,
.fcl__caret {
  display: inline-flex;
  align-items: center;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}

.fcl__main {
  padding: 1px 6px 1px 8px;
}

.fcl__caret {
  padding: 1px 5px;
  color: var(--muted);
  border-left: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}

.fcl__main:hover:not(:disabled),
.fcl__caret:hover:not(:disabled),
.fcl--open .fcl__caret {
  background: var(--border);
  color: var(--text);
}

.fcl__main:disabled,
.fcl__caret:disabled {
  cursor: default;
}

.fcl__menu {
  position: absolute;
  top: calc(100% + 3px);
  right: -1px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 160px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel-elevated, var(--panel));
  box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
}

.fcl__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.fcl__item--current {
  background: color-mix(in srgb, var(--accent, var(--border)) 18%, transparent);
}

.fcl__item:hover {
  background: var(--border);
}

.fcl__icon {
  width: 1.2em;
  text-align: center;
  font-family: "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
}

@media (pointer: coarse) {
  .fcl__main,
  .fcl__caret {
    min-height: 32px;
  }

  .fcl__caret {
    padding: 1px 10px;
  }
}
</style>
