<template>
  <div
    ref="stripRef"
    class="tab-strip"
    data-role="tab-strip"
    @dragover.prevent="dragDrop.onDragover"
    @dragleave="dragDrop.onDragleave"
    @drop="dragDrop.onDrop"
    @dragend="dragDrop.onDragend"
  >
    <button
      v-for="tab in tabModels"
      :key="tab.id"
      type="button"
      class="tab"
      :class="{
        'tab--active': tab.active,
        'tab--grouped': tab.grouped,
        'tab--attention': tab.attention,
        'tab--attention-fresh': tab.attentionFresh,
        [`tab--${tab.tone}`]: true,
      }"
      :data-view-id="tab.id"
      :data-persistent="tab.persistent ? 'true' : 'false'"
      :title="tab.titleTooltip"
      :draggable="tab.persistent"
      @click="store.activateView(tab.id).then(() => nextTick(() => termStore.focusActiveTerminal()))"
      @dblclick="tab.persistent && $emit('rename-tab', tab.id)"
      @dragstart="dragDrop.onDragstart"
      @contextmenu.prevent="$emit('contextmenu-tab', { x: $event.clientX, y: $event.clientY, viewId: tab.id })"
    >
      <span>{{ tab.title }}</span>
      <small>{{ tab.status }}</small>
      <span v-if="tab.attention" class="tab__attention" :title="tab.attentionTooltip">🔔</span>
      <span v-if="tab.persistent" class="tab__rename" :title="'Rename tab'" @click.stop="$emit('rename-tab', tab.id)"
        >✎</span
      >
      <span v-if="tab.closable" class="tab__close" :title="'Close tab'" @click.stop="$emit('close-tab', tab.id)"
        >×</span
      >
    </button>
  </div>
</template>

<script setup>
import { computed, ref, nextTick } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { useTabDragDrop } from "../../composables/useDragDrop.js";
import { isFreshAlert, tabAttentionTitle } from "../../app/helpers.js";

const store = useAppStore();
const termStore = useTerminalStore();
const stripRef = ref(null);
const dragDrop = useTabDragDrop(stripRef);

const tabModels = computed(() => {
  const tabs = store.workspaceTabs;
  const activeViewId = store.activeViewId;
  const splitGroup = store.splitGroup;

  return tabs.map((tab) => {
    const tabAttention = store.getTabAttentionForView(store.activeWorkspace?.id || "", tab.id);
    return {
      id: tab.id,
      title: tab.title,
      status: tab.status,
      tone: tab.tone,
      active: tab.id === activeViewId,
      grouped: splitGroup?.viewIds.includes(tab.id) || false,
      persistent: !!tab.persistent,
      closable: tab.closable !== false,
      attention: !!tabAttention,
      attentionFresh: isFreshAlert(tabAttention),
      attentionTooltip: tabAttentionTitle(tabAttention),
      titleTooltip:
        tabAttentionTitle(tabAttention) ||
        (tab.persistent
          ? "Double click to rename. Drag to reorder."
          : `${tab.title}${tab.status ? `\n${tab.status}` : ""}`),
    };
  });
});

defineEmits(["rename-tab", "close-tab", "contextmenu-tab"]);
</script>
