<template>
  <!-- Desktop / wide: classic horizontal row. -->
  <div v-if="!isMobile" class="sub-tabs" role="tablist" aria-label="Container detail sections">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      role="tab"
      :aria-selected="activeSubTab === tab.id"
      :class="['sub-tabs__tab', activeSubTab === tab.id && 'sub-tabs__tab--active']"
      @click="emit('change', tab.id)"
    >
      {{ tab.label }}
    </button>
  </div>

  <!-- Mobile: a single "Logs ▼" trigger that opens a vertical popover. Same
       chrome pattern as the workspace tabs menu in GitPane so users see a
       consistent interaction across the app. -->
  <div v-else class="sub-tabs-mobile">
    <button
      type="button"
      class="sub-tabs-mobile__trigger"
      :aria-expanded="open"
      :aria-label="open ? 'Close section menu' : 'Open section menu'"
      @click="toggle"
    >
      <span class="sub-tabs-mobile__trigger-label">{{ activeLabel }}</span>
      <span class="sub-tabs-mobile__trigger-caret" aria-hidden="true">▼</span>
    </button>
    <template v-if="open">
      <div class="sub-tabs-mobile__backdrop" aria-hidden="true" @click="open = false"></div>
      <div class="sub-tabs-mobile__popover" role="tablist" aria-label="Container detail sections">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="activeSubTab === tab.id"
          :class="['sub-tabs-mobile__item', activeSubTab === tab.id && 'sub-tabs-mobile__item--active']"
          @click="onPick(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { SubTabKind } from "../../../stores/docker-detail.js";
import { useIsNarrow } from "../../../composables/useIsNarrow.js";

const props = defineProps<{
  activeSubTab: SubTabKind;
}>();

const emit = defineEmits<{
  change: [tab: SubTabKind];
}>();

const { isMobile } = useIsNarrow();
const open = ref(false);

// Close the popover automatically when the viewport widens back to desktop
// — the desktop branch is rendered instead and an open popover would dangle.
watch(isMobile, (mobile) => {
  if (!mobile) open.value = false;
});

const ALL_TABS: Array<{ id: SubTabKind; label: string }> = [
  { id: "logs", label: "Logs" },
  { id: "stats", label: "Stats" },
  { id: "shell", label: "Shell" },
  { id: "inspect", label: "Inspect" },
  { id: "env", label: "Env" },
  { id: "top", label: "Top" },
];

// Shell uses a bidirectional PTY stream that's only wired through Electron's
// `window.strideterm` IPC. The remote/web transport doesn't pipe shell I/O
// over the WebSocket today, so we hide the entry on remote clients rather
// than ship a "click to attach…" that stays stuck forever.
// Detecting via `window.strideterm` (preload script) avoids needing Pinia
// in unit tests — same signal that the Transport's `isRemote` boolean uses.
const isRemote = computed(() => typeof window !== "undefined" && !(window as { strideterm?: unknown }).strideterm);

const tabs = computed(() => (isRemote.value ? ALL_TABS.filter((t) => t.id !== "shell") : ALL_TABS));

// If the persisted active sub-tab is "shell" but we're on remote, silently
// downgrade to logs so the section pane has something to render.
watch(
  [isRemote, () => props.activeSubTab],
  ([remote, sub]) => {
    if (remote && sub === "shell") emit("change", "logs");
  },
  { immediate: true },
);

const activeLabel = computed(() => tabs.value.find((t) => t.id === props.activeSubTab)?.label || "Detail");

function toggle(): void {
  open.value = !open.value;
}

function onPick(id: SubTabKind): void {
  open.value = false;
  emit("change", id);
}
</script>

<style scoped>
.sub-tabs {
  display: flex;
  gap: 2px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  background: var(--bg-secondary, #1a1a1d);
  flex-shrink: 0;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}

.sub-tabs::-webkit-scrollbar {
  display: none;
}

.sub-tabs__tab {
  position: relative;
  padding: 7px 14px;
  background: transparent;
  border: 0;
  color: var(--text-dim, #888);
  font-size: 12px;
  cursor: pointer;
  letter-spacing: 0.2px;
  border-radius: 0;
  white-space: nowrap;
  flex-shrink: 0;
  min-height: 36px; /* touch target on mobile */
}

.sub-tabs__tab:hover {
  color: var(--text-primary, #e2e8f0);
}

.sub-tabs__tab--active {
  color: var(--text-primary, #e2e8f0);
  font-weight: 600;
}

.sub-tabs__tab--active::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--accent, #63b3ed);
  border-radius: 1px;
}

.sub-tabs__tab:focus-visible {
  outline: 1px solid var(--accent, #63b3ed);
  outline-offset: -2px;
}

/* Mobile: single trigger element. Chrome (padding, border, background) is
   provided by the parent .docker-detail__mobile-bar wrapper so the trigger
   sits flush in the same row as the toolbar's ⋮ menu. */
.sub-tabs-mobile {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  flex-shrink: 0;
}

.sub-tabs-mobile__trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  border-radius: 4px;
  color: var(--text-primary, #e2e8f0);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  min-height: 36px;
}

.sub-tabs-mobile__trigger:hover {
  background: rgba(255, 255, 255, 0.07);
}

.sub-tabs-mobile__trigger:focus-visible {
  outline: 1px solid var(--accent, #63b3ed);
  outline-offset: 1px;
}

.sub-tabs-mobile__trigger-caret {
  font-size: 9px;
  opacity: 0.7;
}

.sub-tabs-mobile__backdrop {
  position: fixed;
  inset: 0;
  background: transparent;
  z-index: 40;
}

.sub-tabs-mobile__popover {
  position: absolute;
  /* Anchor to the trigger's left edge. The parent .sub-tabs-mobile is now an
     inline-flex container the width of the trigger button, so we can't use
     `right: …` to stretch — instead size the popover with min-width that
     fits the longest sub-tab label without cropping. */
  top: calc(100% + 4px);
  left: 0;
  min-width: 160px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated, #1e1e22);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  padding: 4px 0;
  max-height: 70vh;
  overflow-y: auto;
}

.sub-tabs-mobile__item {
  padding: 10px 16px;
  background: transparent;
  border: 0;
  border-left: 3px solid transparent;
  color: var(--text-dim, #999);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  min-height: 40px;
  white-space: nowrap;
}

.sub-tabs-mobile__item:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary, #e2e8f0);
}

.sub-tabs-mobile__item--active {
  color: var(--text-primary, #e2e8f0);
  font-weight: 600;
  border-left-color: var(--accent, #63b3ed);
  background: rgba(99, 179, 237, 0.1);
}

.sub-tabs-mobile__item:focus-visible {
  outline: 1px solid var(--accent, #63b3ed);
  outline-offset: -2px;
}
</style>
