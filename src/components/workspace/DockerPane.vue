<template>
  <div class="workspace-pane__body workspace-pane__body--docker">
    <PaneShell
      v-if="showHeader"
      :title="'Docker'"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />

    <!-- Unavailable state -->
    <div v-if="!dockerState.available" class="docker-unavailable">
      <div class="empty-card">
        <p>Docker runtime is unavailable.</p>
        <small>{{ dockerState.error || "Install Docker CLI on Windows or expose it via WSL." }}</small>
        <button type="button" class="button button--ghost" style="margin-top: 10px" @click="appStore.refreshDocker()">
          Retry
        </button>
      </div>
    </div>

    <!-- Loading state -->
    <div v-else-if="isLoading" class="docker-loading">
      <Spinner size="md" />
      <span>Loading containers…</span>
    </div>

    <!-- Mobile portrait: single panel with view-switch nav. -->
    <template v-else-if="usePortraitLayout">
      <div class="docker-mobile-nav">
        <button
          type="button"
          :class="['docker-mobile-nav__btn', mobileView === 'tree' && 'docker-mobile-nav__btn--active']"
          @click="onPickTree"
        >
          <span class="docker-mobile-nav__icon">☰</span>
          Tree
        </button>
        <!-- "Tabs ☰" hamburger: opens a popover listing every open detail tab.
             Replaces the old "Detail" toggle — picking a tab here implicitly
             switches the mobile view to detail, so the separate Tabs strip in
             DockerDetail isn't needed any more on mobile. -->
        <button
          type="button"
          :class="[
            'docker-mobile-nav__btn',
            mobileView === 'detail' && 'docker-mobile-nav__btn--active',
            tabsMenuOpen && 'docker-mobile-nav__btn--menu-open',
          ]"
          :disabled="!hasActiveTab"
          :aria-expanded="tabsMenuOpen"
          :aria-haspopup="true"
          @click="toggleTabsMenu"
        >
          <span class="docker-mobile-nav__icon">☰</span>
          <span class="docker-mobile-nav__label">{{ activeTabLabel || "Tabs" }}</span>
          <span v-if="tabCount > 0" class="docker-mobile-nav__badge">{{ tabCount }}</span>
          <span class="docker-mobile-nav__caret" aria-hidden="true">▼</span>
        </button>
      </div>

      <!-- Tabs popover — anchored under the mobile nav, lists every open
           detail tab with a close × on each. Tap activates the tab and slides
           the mobile view to "detail". -->
      <template v-if="tabsMenuOpen">
        <div class="docker-mobile-tabs__backdrop" aria-hidden="true" @click="tabsMenuOpen = false"></div>
        <div class="docker-mobile-tabs__popover" role="listbox" aria-label="Open detail tabs">
          <button
            v-for="t in detailTabs"
            :key="t.tabId"
            type="button"
            role="option"
            :aria-selected="t.tabId === activeDetailTabId"
            :class="[
              'docker-mobile-tabs__item',
              t.tabId === activeDetailTabId && 'docker-mobile-tabs__item--active',
              t.removed && 'docker-mobile-tabs__item--removed',
            ]"
            @click="onPickTab(t.tabId)"
          >
            <span class="docker-mobile-tabs__icon">{{ tabIconFor(t.kind) }}</span>
            <span class="docker-mobile-tabs__label">{{ t.label }}</span>
            <span
              class="docker-mobile-tabs__close"
              role="button"
              tabindex="0"
              :aria-label="`Close ${t.label}`"
              @click.stop="onCloseTab(t.tabId)"
              @keydown.enter.stop.prevent="onCloseTab(t.tabId)"
              @keydown.space.stop.prevent="onCloseTab(t.tabId)"
              >×</span
            >
          </button>
          <div v-if="detailTabs.length === 0" class="docker-mobile-tabs__empty">No open tabs.</div>
        </div>
      </template>

      <div v-if="mobileView === 'tree'" class="docker-mobile-pane">
        <DockerHeader :summary="headerSummary" @open-list="onDiskUsageOpen" />
        <div class="docker-tree-filter">
          <input
            v-model="filterInput"
            type="text"
            class="docker-tree-filter__input"
            placeholder="Filter containers, images, volumes…"
            spellcheck="false"
            autocomplete="off"
            @input="treeStore.setFilter(filterInput)"
          />
          <button
            v-if="filterInput"
            type="button"
            class="docker-tree-filter__clear"
            title="Clear filter"
            @click="
              filterInput = '';
              treeStore.setFilter('');
            "
          >
            ×
          </button>
        </div>
        <div class="docker-tree-wrapper">
          <DockerTree
            :nodes="filteredNodes"
            :selected-id="selectedNodeId"
            :filter-active="!!treeStore.filter"
            @select="onNodeSelect"
            @context-menu="onContextMenu"
          />
        </div>
      </div>
      <div v-else class="docker-mobile-pane">
        <DockerDetail :workspace-id="workspaceId" />
      </div>
    </template>

    <!-- Desktop / landscape: split view. -->
    <Splitpanes v-else class="docker-splitpanes" @resize="onResize">
      <Pane :size="leftSize" :min-size="18" class="docker-pane-left">
        <DockerHeader :summary="headerSummary" @open-list="onDiskUsageOpen" />
        <div class="docker-tree-filter">
          <input
            v-model="filterInput"
            type="text"
            class="docker-tree-filter__input"
            placeholder="Filter containers, images, volumes…"
            spellcheck="false"
            autocomplete="off"
            @input="treeStore.setFilter(filterInput)"
          />
          <button
            v-if="filterInput"
            type="button"
            class="docker-tree-filter__clear"
            title="Clear filter"
            @click="
              filterInput = '';
              treeStore.setFilter('');
            "
          >
            ×
          </button>
        </div>
        <div class="docker-tree-wrapper">
          <DockerTree
            :nodes="filteredNodes"
            :selected-id="selectedNodeId"
            :filter-active="!!treeStore.filter"
            @select="onNodeSelect"
            @context-menu="onContextMenu"
          />
        </div>
      </Pane>

      <Pane :size="100 - leftSize" class="docker-pane-right">
        <DockerDetail :workspace-id="workspaceId" />
      </Pane>
    </Splitpanes>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useAppStore } from "../../stores/app.js";
import { useDockerTree } from "../../stores/docker-tree.js";
import { useDockerDetail } from "../../stores/docker-detail.js";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import { useResourceInterest } from "../../composables/useResourceInterest.js";
import DockerHeader from "./docker/DockerHeader.vue";
import DockerTree from "./docker/DockerTree.vue";
import DockerDetail from "./docker/DockerDetail.vue";
import Spinner from "../common/Spinner.vue";
import PaneShell from "../layout/PaneShell.vue";
import type { TreeNode } from "../../stores/docker-tree.js";

const props = withDefaults(defineProps<{ workspaceId: string; showHeader?: boolean }>(), { showHeader: false });

const appStore = useAppStore();
const treeStore = useDockerTree();
const detailStore = useDockerDetail();
// Fetch + keep the full Docker snapshot current while this pane is mounted.
useResourceInterest(() => "docker");
const { isMobile, isPortrait } = useIsNarrow();

// Single-pane navigation only kicks in when the device is BOTH mobile AND
// portrait. Mobile-landscape and tablet stay on the split layout — there's
// enough horizontal space to keep the tree and detail visible side-by-side.
const usePortraitLayout = computed(() => isMobile.value && isPortrait.value);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dockerState = computed<Record<string, any>>(() => appStore.dockerState() || {});
const isLoading = computed(() => dockerState.value.available && !dockerState.value.lastUpdatedAt);

const selectedNodeId = computed(() => {
  const activeTab = detailStore.getActiveTab(props.workspaceId);
  if (!activeTab) return null;
  if (activeTab.kind === "container") return `be:${activeTab.backendId}/cnt:${activeTab.containerId}`;
  if (activeTab.kind === "image") {
    return `be:${activeTab.backendId}/ctx:${activeTab.contextName}/img:${activeTab.imageId}`;
  }
  if (activeTab.kind === "volume") {
    return `be:${activeTab.backendId}/ctx:${activeTab.contextName}/vol:${activeTab.volumeName}`;
  }
  if (activeTab.kind === "network") {
    return `be:${activeTab.backendId}/ctx:${activeTab.contextName}/net:${activeTab.networkId}`;
  }
  // List tabs map to the group node id used in docker-tree.ts buildContextTree().
  if (activeTab.kind === "images-list") {
    return `be:${activeTab.backendId}/ctx:${activeTab.contextName}/images`;
  }
  if (activeTab.kind === "volumes-list") {
    return `be:${activeTab.backendId}/ctx:${activeTab.contextName}/volumes`;
  }
  if (activeTab.kind === "networks-list") {
    return `be:${activeTab.backendId}/ctx:${activeTab.contextName}/networks`;
  }
  return null;
});

const filterInput = ref("");
const filteredNodes = computed(() => treeStore.filteredTreeNodes.nodes);

const leftSize = ref(35);
function onResize(sizes: Array<{ size: number }>) {
  if (sizes[0]) leftSize.value = sizes[0].size;
}

// Mobile navigation state: which panel is currently visible in portrait mode.
const mobileView = ref<"tree" | "detail">("tree");
const tabCount = computed(() => detailStore.getTabs(props.workspaceId).length);
const hasActiveTab = computed(() => !!detailStore.getActiveTab(props.workspaceId));

// Mobile tabs popover (replaces the Detail toggle): list of every open detail
// tab; picking one activates it and slides the view to "detail".
const tabsMenuOpen = ref(false);
const detailTabs = computed(() => detailStore.getTabs(props.workspaceId));
const activeDetailTabId = computed(() => detailStore.getActiveTabId(props.workspaceId));
const activeTabLabel = computed(() => detailStore.getActiveTab(props.workspaceId)?.label || "");

function toggleTabsMenu(): void {
  if (!hasActiveTab.value) {
    tabsMenuOpen.value = false;
    return;
  }
  tabsMenuOpen.value = !tabsMenuOpen.value;
}

function onPickTab(tabId: string): void {
  detailStore.setActive(props.workspaceId, tabId);
  mobileView.value = "detail";
  tabsMenuOpen.value = false;
}

function onCloseTab(tabId: string): void {
  const remaining = detailTabs.value.length - 1;
  closeTab(tabId);
  if (remaining <= 0) {
    // No tabs left → land back on the tree pane so the user isn't staring at
    // an empty detail panel.
    mobileView.value = "tree";
    tabsMenuOpen.value = false;
  }
}

// Tab-strip icon mapping mirrors DockerDetailTabs.vue so the hamburger items
// look familiar.
function tabIconFor(kind: string): string {
  if (kind === "project") return "▣";
  if (kind === "images-list") return "▦";
  if (kind === "volumes-list") return "▤";
  if (kind === "networks-list") return "◇";
  return "●";
}

function onPickTree(): void {
  mobileView.value = "tree";
  tabsMenuOpen.value = false;
}

function closeTab(tabId: string): void {
  const tab = detailTabs.value.find((t) => t.tabId === tabId);
  if (tab?.logSessionId) {
    appStore.dockerLogsClose(tab.logSessionId).catch(() => {});
  }
  if (tab?.shellSessionId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).strideterm;
    api?.dockerShellClose?.({ sessionId: tab.shellSessionId }).catch(() => {});
  }
  detailStore.closeTab(props.workspaceId, tabId);
}

// Auto-navigate to detail when the user picks something in the tree on mobile.
watch(
  () => detailStore.getActiveTabId(props.workspaceId),
  (id) => {
    if (id && usePortraitLayout.value) mobileView.value = "detail";
  },
);

// Drop the popover when the viewport widens back to landscape/desktop — the
// trigger button isn't rendered there and a stale popover would hang.
watch(usePortraitLayout, (portrait) => {
  if (!portrait) tabsMenuOpen.value = false;
});

const headerSummary = computed(() => {
  const containers = dockerState.value.containers || [];
  const running = containers.filter((c: { State: string }) => c.State?.toLowerCase() === "running").length;
  return `${containers.length} containers, ${running} up`;
});

const headerStatus = computed(() => headerSummary.value);
const headerActions = computed(() => [
  {
    className: "workspace-pane__icon-btn",
    action: "select-tab",
    viewId: `docker:${props.workspaceId}`,
    title: "Make this Docker pane the active tab.",
    label: "◉",
  },
  {
    className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
    action: "close-tab",
    viewId: `docker:${props.workspaceId}`,
    title: "Close the Docker tab.",
    label: "×",
  },
]);

function onHeaderAction(action: { action: string; viewId?: string }) {
  if (action.action === "select-tab") appStore.activateView(action.viewId || "");
  else if (action.action === "close-tab") appStore.closeTab(action.viewId || "");
}

function onNodeSelect(node: TreeNode): void {
  if (node.kind === "container" && node.containerId) {
    detailStore.openContainer(props.workspaceId, node.containerId, node.backendId!, node.contextName!, node.label);
  } else if (node.kind === "project" && node.projectName) {
    detailStore.openComposeProject(props.workspaceId, node.projectName, node.backendId!, node.contextName!);
  } else if (node.kind === "image" && node.imageId) {
    detailStore.openImage(props.workspaceId, node.imageId, node.backendId!, node.contextName!, node.label);
  } else if (node.kind === "volume" && node.volumeName) {
    detailStore.openVolume(props.workspaceId, node.volumeName, node.backendId!, node.contextName!);
  } else if (node.kind === "network" && node.networkId) {
    detailStore.openNetwork(props.workspaceId, node.networkId, node.backendId!, node.contextName!, node.label);
  } else if (node.kind === "images-group") {
    detailStore.openImagesList(props.workspaceId, node.backendId!, node.contextName!, node.label);
  } else if (node.kind === "volumes-group") {
    detailStore.openVolumesList(props.workspaceId, node.backendId!, node.contextName!, node.label);
  } else if (node.kind === "networks-group") {
    detailStore.openNetworksList(props.workspaceId, node.backendId!, node.contextName!, node.label);
  }
}

function onContextMenu(_node: TreeNode): void {
  // Context menu — noop in MVP (toolbar covers actions)
}

/**
 * Disk-usage row click → open the matching list tab for the primary backend's
 * current context. `docker system df` itself only reports the primary backend,
 * so opening anywhere else would be misleading; if the user wants a different
 * backend/context, they can still click that group node directly in the tree.
 *
 * "cache" has no list view today — we just no-op until a build-cache panel
 * exists, rather than firing a confirmation dialog from this far away.
 */
function onDiskUsageOpen(kind: "images" | "volumes" | "networks" | "cache"): void {
  if (kind === "cache") return;
  const state = dockerState.value;
  const backend = state.backends?.[0];
  if (!backend) return;
  const ctx =
    (state.contexts || []).find(
      (c: { backendId: string; Current: boolean }) => c.backendId === backend.id && c.Current,
    ) || (state.contexts || []).find((c: { backendId: string }) => c.backendId === backend.id);
  if (!ctx) return;
  if (kind === "images") {
    detailStore.openImagesList(props.workspaceId, backend.id, ctx.Name, "Images");
  } else if (kind === "volumes") {
    detailStore.openVolumesList(props.workspaceId, backend.id, ctx.Name, "Volumes");
  } else if (kind === "networks") {
    detailStore.openNetworksList(props.workspaceId, backend.id, ctx.Name, "Networks");
  }
}
</script>

<style scoped>
.workspace-pane__body--docker {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.docker-unavailable,
.docker-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  color: var(--text-dim, #888);
  font-size: 13px;
}

.docker-splitpanes {
  flex: 1;
  min-height: 0;
}

.docker-pane-left,
.docker-pane-right {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.docker-tree-wrapper {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.docker-tree-filter {
  position: relative;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  flex-shrink: 0;
}

.docker-tree-filter__input {
  width: 100%;
  padding: 6px 26px 6px 10px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary, #e2e8f0);
  border-radius: 4px;
  font-size: 12px;
  outline: none;
}

.docker-tree-filter__input:focus {
  border-color: var(--accent, #63b3ed);
}

.docker-tree-filter__input::placeholder {
  color: var(--text-dim, #777);
}

.docker-tree-filter__clear {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-dim, #888);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  padding: 0;
}

.docker-tree-filter__clear:hover {
  color: var(--text-primary, #e2e8f0);
  background: rgba(255, 255, 255, 0.14);
}

@media (max-width: 600px) {
  .docker-tree-filter__input {
    padding: 9px 30px 9px 12px;
    font-size: 14px;
  }
  .docker-tree-filter__clear {
    width: 26px;
    height: 26px;
  }
}

/* Mobile portrait: stacked single-pane layout */
.docker-mobile-nav {
  display: flex;
  flex-shrink: 0;
  background: var(--bg-secondary, #1a1a1d);
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.docker-mobile-nav__btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 6px;
  background: transparent;
  border: 0;
  color: var(--text-dim, #888);
  font-size: 13px;
  cursor: pointer;
  position: relative;
  min-height: 44px; /* touch target */
}

.docker-mobile-nav__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.docker-mobile-nav__btn--active {
  color: var(--text-primary, #e2e8f0);
  font-weight: 600;
}

.docker-mobile-nav__btn--active::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--accent, #63b3ed);
  border-radius: 1px;
}

.docker-mobile-nav__icon {
  font-size: 14px;
  opacity: 0.8;
}

.docker-mobile-nav__badge {
  background: var(--accent, #63b3ed);
  color: #000;
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 700;
  min-width: 16px;
  text-align: center;
  line-height: 14px;
}

.docker-mobile-pane {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* The Tabs hamburger trigger gets an additional row layout (label + caret +
   badge) so the active tab name reads first and the badge counts open tabs. */
.docker-mobile-nav__label {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.docker-mobile-nav__caret {
  font-size: 9px;
  opacity: 0.7;
  margin-left: -2px;
}
.docker-mobile-nav__btn--menu-open .docker-mobile-nav__caret {
  transform: rotate(180deg);
}

/* Tabs popover: anchored just under the mobile-nav row, full-width on mobile.
   Backdrop is fixed so clicking anywhere off the popover dismisses it. */
.docker-mobile-tabs__backdrop {
  position: fixed;
  inset: 0;
  background: transparent;
  z-index: 40;
}

.docker-mobile-tabs__popover {
  position: absolute;
  top: 44px; /* matches .docker-mobile-nav__btn min-height */
  left: 4px;
  right: 4px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated, #1e1e22);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  padding: 4px 0;
  max-height: 60vh;
  overflow-y: auto;
}

.docker-mobile-tabs__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: transparent;
  border: 0;
  border-left: 3px solid transparent;
  color: var(--text-primary, #e2e8f0);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  min-height: 42px;
  width: 100%;
}
.docker-mobile-tabs__item:hover {
  background: rgba(255, 255, 255, 0.04);
}
.docker-mobile-tabs__item--active {
  border-left-color: var(--accent, #63b3ed);
  background: rgba(99, 179, 237, 0.1);
  font-weight: 600;
}
.docker-mobile-tabs__item--removed {
  opacity: 0.55;
  font-style: italic;
}

.docker-mobile-tabs__icon {
  font-size: 10px;
  color: var(--text-dim, #999);
  flex-shrink: 0;
}

.docker-mobile-tabs__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-mobile-tabs__close {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 16px;
  color: var(--text-dim, #888);
  flex-shrink: 0;
  cursor: pointer;
}
.docker-mobile-tabs__close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary, #e2e8f0);
}

.docker-mobile-tabs__empty {
  padding: 14px 12px;
  color: var(--text-dim, #888);
  font-size: 13px;
  font-style: italic;
  text-align: center;
}
</style>
