<template>
  <Teleport to="body">
    <div v-if="store.contextMenu" ref="menuRef" class="context-menu" :style="menuStyle" @click.stop>
      <template v-if="isTerminal">
        <button type="button" class="context-menu__item" @click="onRestart">&#x21BB; Restart</button>
        <button v-if="hasPersistentPanel" type="button" class="context-menu__item" @click="onRename">
          &#x270E; Rename tab
        </button>
      </template>
      <template v-if="inGroup">
        <div v-if="isTerminal" class="context-menu__divider"></div>
        <button type="button" class="context-menu__item" @click="onRemoveFromGroup">&#x2715; Remove from split</button>
        <button type="button" class="context-menu__item context-menu__item--danger" @click="onDisbandGroup">
          &#x2573; Disband split
        </button>
      </template>
      <template v-else-if="canAddToSplit">
        <div v-if="isTerminal" class="context-menu__divider"></div>
        <button type="button" class="context-menu__item" @click="onAddToGroup">+ Add to split</button>
      </template>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { isGitViewId, isDockerViewId } from "../../app/helpers.js";

const store = useAppStore();
const termStore = useTerminalStore();
const menuRef = ref(null);
const LAYOUTS = {
  solo: { slots: 1 },
  cols: { slots: 2 },
  rows: { slots: 2 },
  "top-split": { slots: 3 },
  "left-split": { slots: 3 },
  grid: { slots: 4 },
};

const viewId = computed(() => store.contextMenu?.viewId || "");
const rawX = computed(() => store.contextMenu?.x || 0);
const rawY = computed(() => store.contextMenu?.y || 0);

const isTerminal = computed(() => viewId.value && !isGitViewId(viewId.value) && !isDockerViewId(viewId.value));

const hasPersistentPanel = computed(() => {
  const target = store.getPanelByViewId(viewId.value);
  return Boolean(target);
});

const inGroup = computed(() => Boolean(store.splitGroup?.viewIds.includes(viewId.value)));

const canAddToSplit = computed(() => {
  if (inGroup.value || !store.splitGroup) return false;
  const slots = LAYOUTS[store.splitGroup.layout]?.slots || 2;
  return store.splitGroup.viewIds.length < slots;
});

// Adjusted position (set after mount to clamp to viewport)
const adjustedX = ref(rawX.value);
const adjustedY = ref(rawY.value);

const menuStyle = computed(() => ({
  position: "fixed",
  left: `${adjustedX.value}px`,
  top: `${adjustedY.value}px`,
  zIndex: 9999,
}));

watch(
  () => store.contextMenu,
  async (menu) => {
    if (!menu) return;
    adjustedX.value = menu.x;
    adjustedY.value = menu.y;
    await nextTick();
    if (!menuRef.value) return;
    const rect = menuRef.value.getBoundingClientRect();
    if (rect.right > window.innerWidth) adjustedX.value = window.innerWidth - rect.width - 4;
    if (rect.bottom > window.innerHeight) adjustedY.value = window.innerHeight - rect.height - 4;
  },
);

function onRestart() {
  termStore.restartSession(viewId.value);
  store.hideContextMenu();
}

function onRename() {
  store.hideContextMenu();
  store.renameTabWithDialog(viewId.value);
}

function onRemoveFromGroup() {
  store.ctxRemoveFromGroup(viewId.value);
  store.hideContextMenu();
}

function onDisbandGroup() {
  store.disbandSplit();
  store.hideContextMenu();
}

function onAddToGroup() {
  store.ctxAddToGroup(viewId.value);
  store.hideContextMenu();
}

function onDocumentClick(e) {
  if (menuRef.value && !menuRef.value.contains(e.target)) {
    store.hideContextMenu();
  }
}

function onKeydown(e) {
  if (e.key === "Escape") store.hideContextMenu();
}

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>
