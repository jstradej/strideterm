<template>
  <Teleport to="body">
    <div v-if="store.contextMenu" ref="menuRef" class="context-menu" :style="menuStyle" @click.stop>
      <button type="button" class="context-menu__item" @click="onFocus">&#x25C9; Focus tab</button>

      <template v-if="isTerminal">
        <button v-if="hasPersistentPanel" type="button" class="context-menu__item" @click="onEdit">
          &#x270E; Edit tab
        </button>
        <button type="button" class="context-menu__item" @click="onSaveTranscript">&#x21E9; Save last 500 lines</button>
        <button type="button" class="context-menu__item" @click="onClear">&#x232B; Clear output</button>
        <button type="button" class="context-menu__item" @click="onRestart">&#x21BB; Restart</button>
      </template>

      <button v-if="refreshKind" type="button" class="context-menu__item" @click="onRefresh">
        &#x21BB; Refresh {{ refreshLabel }}
      </button>

      <template v-if="canClose">
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item context-menu__item--danger" @click="onClose">
          &#x2715; Close tab
        </button>
      </template>

      <template v-if="inGroup">
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item" @click="onRemoveFromGroup">&#x2715; Remove from split</button>
        <button type="button" class="context-menu__item context-menu__item--danger" @click="onDisbandGroup">
          &#x2573; Disband split
        </button>
      </template>
      <template v-else-if="canAddToSplit">
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item" @click="onAddToGroup">+ Add to split</button>
      </template>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import {
  isGitViewId,
  isDockerViewId,
  isAzureViewId,
  isGitHubViewId,
  isReviewViewId,
  isFilesViewId,
  isBrowserViewId,
  isTaskDashboardViewId,
} from "../../app/helpers.js";

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

const isTerminal = computed(() => {
  const id = viewId.value;
  if (!id) return false;
  return (
    !isGitViewId(id) &&
    !isDockerViewId(id) &&
    !isAzureViewId(id) &&
    !isGitHubViewId(id) &&
    !isReviewViewId(id) &&
    !isFilesViewId(id) &&
    !isBrowserViewId(id) &&
    !isTaskDashboardViewId(id)
  );
});

const currentTab = computed(() => (store.workspaceTabs || []).find((t) => t.id === viewId.value) || null);

const hasPersistentPanel = computed(() => {
  const target = store.getPanelByViewId(viewId.value);
  return Boolean(target);
});

const canClose = computed(() => (currentTab.value ? currentTab.value.closable !== false : false));

const refreshKind = computed(() => {
  const id = viewId.value;
  if (isDockerViewId(id)) return "docker";
  if (isAzureViewId(id)) return "azure";
  if (isGitHubViewId(id)) return "github";
  if (isReviewViewId(id)) {
    const wsId = id.replace(/^review:/, "");
    const ws = store.payload?.appState?.workspaces?.find((w) => w.id === wsId);
    return ws?.review?.provider === "github" ? "github" : "azure";
  }
  return "";
});

const refreshLabel = computed(
  () =>
    ({
      docker: "Docker",
      azure: "Azure DevOps",
      github: "GitHub",
    })[refreshKind.value] || "",
);

const inGroup = computed(() => Boolean(store.splitGroup?.viewIds.includes(viewId.value)));

const canAddToSplit = computed(() => {
  if (inGroup.value || !store.splitGroup) return false;
  const slots = LAYOUTS[store.splitGroup.layout]?.slots || 2;
  return store.splitGroup.viewIds.length < slots;
});

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

function onFocus() {
  store.activateView(viewId.value);
  store.hideContextMenu();
}

function onRestart() {
  termStore.restartSession(viewId.value);
  store.hideContextMenu();
}

function onEdit() {
  store.hideContextMenu();
  store.editTabWithDialog(viewId.value);
}

function onSaveTranscript() {
  termStore.exportTerminalTranscript(viewId.value, { title: currentTab.value?.title || "" });
  store.hideContextMenu();
}

function onClear() {
  termStore.clearTerminalViewport(viewId.value);
  store.hideContextMenu();
}

function onClose() {
  store.hideContextMenu();
  store.closeTab(viewId.value);
}

function onRefresh() {
  const kind = refreshKind.value;
  store.hideContextMenu();
  if (kind === "docker") store.refreshDocker();
  else if (kind === "azure") store.refreshAzure();
  else if (kind === "github") store.refreshGitHub();
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
