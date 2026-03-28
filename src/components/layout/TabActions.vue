<template>
  <div class="terminal-toolbar__actions" data-role="tab-actions">
    <button
      v-if="workspaceKind !== 'docker' && workspaceKind !== 'azure' && workspaceKind !== 'github'"
      type="button"
      class="button button--ghost"
      @click="$emit('toggle-tab-picker', $event)"
    >
      + Tab
    </button>
    <button v-if="store.splitGroup" type="button" class="button button--ghost" @click="$emit('disband-split')">
      Unsplit
    </button>
    <button
      type="button"
      class="button button--ghost"
      :class="{ 'button--active': currentLayout !== 'solo' }"
      :title="'Layout'"
      @click="$emit('open-layout-picker', $event)"
    >
      {{ currentLayout !== "solo" ? layouts[currentLayout]?.label || "Split" : "Split" }}
    </button>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";

const LAYOUTS = {
  solo: { slots: 1, label: "Solo" },
  cols: { slots: 2, label: "Side by side" },
  rows: { slots: 2, label: "Stacked" },
  "top-split": { slots: 3, label: "Top + 2 bottom" },
  "left-split": { slots: 3, label: "Left + 2 right" },
  grid: { slots: 4, label: "Grid" },
};

const store = useAppStore();

const workspaceKind = computed(() => store.activeWorkspace?.kind || "terminal");
const layouts = LAYOUTS;

const currentLayout = computed(() => {
  const sg = store.splitGroup;
  if (!sg) return "solo";
  return sg.viewIds.includes(store.activeViewId) ? sg.layout : "solo";
});

defineEmits(["toggle-tab-picker", "disband-split", "open-layout-picker"]);
</script>
