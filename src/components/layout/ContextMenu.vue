<template>
  <Teleport to="body">
    <div v-if="store.contextMenu" ref="menuRef" class="context-menu" :style="menuStyle" @click.stop>
      <button type="button" class="context-menu__item" @click="onFocus">
        <span class="context-menu__icon">&#x25C9;</span><span>Focus tab</span>
      </button>

      <template v-if="isTerminal">
        <button v-if="hasPersistentPanel" type="button" class="context-menu__item" @click="onEdit">
          <span class="context-menu__icon">&#x270E;</span><span>Edit tab</span>
        </button>
        <button type="button" class="context-menu__item" @click="onSaveTranscript">
          <span class="context-menu__icon">&#x21E9;</span><span>Save last 500 lines</span>
        </button>
        <button type="button" class="context-menu__item" @click="onClear">
          <span class="context-menu__icon">&#x232B;</span><span>Clear output</span>
        </button>
        <button type="button" class="context-menu__item" @click="onRestart">
          <span class="context-menu__icon">&#x21BB;</span><span>Restart</span>
        </button>
      </template>

      <button v-if="refreshKind" type="button" class="context-menu__item" @click="onRefresh">
        <span class="context-menu__icon">&#x21BB;</span><span>Refresh {{ refreshLabel }}</span>
      </button>

      <template v-if="canClose">
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item context-menu__item--danger" @click="onClose">
          <span class="context-menu__icon">&#x2715;</span><span>Close tab</span>
        </button>
      </template>

      <template v-if="inGroup">
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item" @click="onRemoveFromGroup">
          <span class="context-menu__icon">&#x2715;</span><span>Remove from split</span>
        </button>
        <button type="button" class="context-menu__item context-menu__item--danger" @click="onDisbandGroup">
          <span class="context-menu__icon">&#x2573;</span><span>Disband split</span>
        </button>
      </template>
      <template v-else-if="canAddToSplit">
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item" @click="onAddToGroup">
          <span class="context-menu__icon">+</span><span>Add to split</span>
        </button>
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

// Every handler MUST snapshot viewId.value before hideContextMenu() — the
// computed resolves against store.contextMenu, which hideContextMenu() sets
// to null, so any later read of viewId.value returns "".
function onFocus() {
  const id = viewId.value;
  store.hideContextMenu();
  store.activateView(id);
}

function onRestart() {
  const id = viewId.value;
  store.hideContextMenu();
  termStore.restartSession(id);
}

function onEdit() {
  const id = viewId.value;
  store.hideContextMenu();
  store.editTabWithDialog(id);
}

function onSaveTranscript() {
  const id = viewId.value;
  const title = currentTab.value?.title || "";
  store.hideContextMenu();
  termStore.exportTerminalTranscript(id, { title });
}

function onClear() {
  const id = viewId.value;
  store.hideContextMenu();
  termStore.clearTerminalViewport(id);
}

function onClose() {
  const id = viewId.value;
  store.hideContextMenu();
  store.closeTab(id);
}

function onRefresh() {
  const kind = refreshKind.value;
  store.hideContextMenu();
  if (kind === "docker") store.refreshDocker();
  else if (kind === "azure") store.refreshAzure();
  else if (kind === "github") store.refreshGitHub();
}

function onRemoveFromGroup() {
  const id = viewId.value;
  store.hideContextMenu();
  store.ctxRemoveFromGroup(id);
}

function onDisbandGroup() {
  store.hideContextMenu();
  store.disbandSplit();
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
