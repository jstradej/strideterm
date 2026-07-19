<template>
  <div class="docker-detail">
    <!-- Desktop: the tab strip lives here. On mobile the strip is replaced by
         a hamburger up in DockerPane's mobile-nav, so we skip rendering it
         here to free the vertical space. -->
    <DockerDetailTabs
      v-if="!isMobile"
      :tabs="tabs"
      :active-tab-id="activeTabId"
      @activate="detailStore.setActive(workspaceId, $event)"
      @close="closeTab"
    />

    <template v-if="activeTab">
      <!-- Desktop: toolbar gets its own row above the sub-tabs. -->
      <DockerDetailToolbar
        v-if="!isMobile && (activeTab.kind === 'container' || activeTab.kind === 'project')"
        :workspace-id="workspaceId"
        :tab="activeTab"
        :lazydocker-available="lazydockerAvailable"
        @open-shell="openShell"
        @open-lazydocker="openLazydocker"
        @confirm-remove="showRemoveDialog = true"
      />

      <!-- Container view: sub-tabs + section content -->
      <template v-if="activeTab.kind === 'container'">
        <!-- Mobile: sub-tabs trigger and toolbar ⋮ share a single chrome row
             so we don't burn two precious mobile rows on a one-button toolbar
             plus a one-button section selector. Desktop still renders them
             stacked (toolbar above sub-tabs) via the v-if branch above. -->
        <div v-if="isMobile" class="docker-detail__mobile-bar">
          <DockerDetailSubTabs :active-sub-tab="activeTab.activeSubTab || 'logs'" @change="onSubTabChange" />
          <DockerDetailToolbar
            :workspace-id="workspaceId"
            :tab="activeTab"
            :lazydocker-available="lazydockerAvailable"
            @open-shell="openShell"
            @open-lazydocker="openLazydocker"
            @confirm-remove="showRemoveDialog = true"
          />
        </div>
        <DockerDetailSubTabs v-else :active-sub-tab="activeTab.activeSubTab || 'logs'" @change="onSubTabChange" />
        <div class="docker-detail__section">
          <!-- Logs: kept alive so the xterm buffer survives sub-tab switches. -->
          <KeepAlive>
            <DockerDetailLog
              v-if="(activeTab.activeSubTab || 'logs') === 'logs' && activeTab.logSessionId"
              :key="activeTab.tabId"
              :session-id="activeTab.logSessionId"
              :container-id="activeTab.containerId!"
              :container-name="activeTab.label"
              :backend-id="activeTab.backendId"
              :context-name="activeTab.contextName"
              :removed="activeTab.removed"
            />
          </KeepAlive>
          <DockerDetailStats
            v-if="activeTab.activeSubTab === 'stats'"
            :key="`stats-${activeTab.tabId}`"
            :container-id="activeTab.containerId!"
            :backend-id="activeTab.backendId"
            :context-name="activeTab.contextName"
          />
          <KeepAlive>
            <DockerDetailShell
              v-if="activeTab.activeSubTab === 'shell' && activeTab.shellSessionId"
              :key="`shell-${activeTab.tabId}`"
              :session-id="activeTab.shellSessionId"
              :container-id="activeTab.containerId!"
              :container-name="activeTab.label"
              :backend-id="activeTab.backendId"
              :context-name="activeTab.contextName"
            />
          </KeepAlive>
          <DockerResourceInspect
            v-if="activeTab.activeSubTab === 'inspect'"
            :key="`inspect-${activeTab.tabId}`"
            kind="container"
            :resource-key="inspectResourceKey"
            :fetcher="inspectFetcher"
          />
          <DockerDetailEnv
            v-if="activeTab.activeSubTab === 'env'"
            :key="`env-${activeTab.tabId}`"
            :container-id="activeTab.containerId!"
            :backend-id="activeTab.backendId"
            :context-name="activeTab.contextName"
          />
          <DockerDetailTop
            v-if="activeTab.activeSubTab === 'top'"
            :key="`top-${activeTab.tabId}`"
            :container-id="activeTab.containerId!"
            :backend-id="activeTab.backendId"
            :context-name="activeTab.contextName"
          />
        </div>
      </template>

      <!-- Image / Volume / Network panels -->
      <DockerImagePanel
        v-else-if="activeTab.kind === 'image'"
        :key="`img-${activeTab.tabId}`"
        :workspace-id="workspaceId"
        :tab="activeTab"
      />
      <DockerVolumePanel
        v-else-if="activeTab.kind === 'volume'"
        :key="`vol-${activeTab.tabId}`"
        :workspace-id="workspaceId"
        :tab="activeTab"
      />
      <DockerNetworkPanel
        v-else-if="activeTab.kind === 'network'"
        :key="`net-${activeTab.tabId}`"
        :workspace-id="workspaceId"
        :tab="activeTab"
      />

      <!-- Group-level list views (sortable tables with bulk actions) -->
      <DockerImagesTable
        v-else-if="activeTab.kind === 'images-list'"
        :key="`imgs-${activeTab.tabId}`"
        :workspace-id="workspaceId"
        :tab="activeTab"
      />
      <DockerVolumesTable
        v-else-if="activeTab.kind === 'volumes-list'"
        :key="`vols-${activeTab.tabId}`"
        :workspace-id="workspaceId"
        :tab="activeTab"
      />
      <DockerNetworksTable
        v-else-if="activeTab.kind === 'networks-list'"
        :key="`nets-${activeTab.tabId}`"
        :workspace-id="workspaceId"
        :tab="activeTab"
      />

      <!-- Compose project view -->
      <div v-else-if="activeTab.kind === 'project'" class="docker-detail__compose">
        <div class="compose-empty">
          <p>Multi-service log aggregation is not yet available.</p>
          <p class="compose-empty__hint">Click a service in the tree to see its logs.</p>
          <ul class="compose-empty__services">
            <li v-for="svc in projectServices" :key="svc.ID">
              <span :class="['svc-dot', svc.State === 'running' ? 'svc-dot--running' : 'svc-dot--stopped']" />
              {{ svc.Names?.replace(/^\//, "") }}
            </li>
          </ul>
        </div>
      </div>
    </template>

    <div v-else class="docker-detail__empty">
      <p>Select a container in the tree</p>
    </div>

    <!-- Remove confirmation dialog -->
    <teleport to="body">
      <div v-if="showRemoveDialog" class="dialog-overlay" @click.self="showRemoveDialog = false">
        <ConfirmDialog
          title="Remove container?"
          :message="`This will force-remove ${activeTab?.label || 'the container'}. The container's filesystem and any unsaved state will be lost.`"
          confirm-label="Remove"
          :danger="true"
          @confirm="doRemove"
          @cancel="showRemoveDialog = false"
        />
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import DockerDetailTabs from "./DockerDetailTabs.vue";
import DockerDetailToolbar from "./DockerDetailToolbar.vue";
import DockerDetailSubTabs from "./DockerDetailSubTabs.vue";
import DockerDetailLog from "./DockerDetailLog.vue";
import DockerDetailShell from "./DockerDetailShell.vue";
import DockerDetailStats from "./DockerDetailStats.vue";
import DockerImagePanel from "./DockerImagePanel.vue";
import DockerVolumePanel from "./DockerVolumePanel.vue";
import DockerNetworkPanel from "./DockerNetworkPanel.vue";
import DockerImagesTable from "./DockerImagesTable.vue";
import DockerVolumesTable from "./DockerVolumesTable.vue";
import DockerNetworksTable from "./DockerNetworksTable.vue";
import DockerResourceInspect from "./DockerResourceInspect.vue";
import DockerDetailEnv from "./DockerDetailEnv.vue";
import DockerDetailTop from "./DockerDetailTop.vue";
import ConfirmDialog from "../../dialogs/ConfirmDialog.vue";
import { useDockerDetail, type SubTabKind } from "../../../stores/docker-detail.js";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { useIsNarrow } from "../../../composables/useIsNarrow.js";

const { isMobile } = useIsNarrow();

const props = defineProps<{
  workspaceId: string;
}>();

const detailStore = useDockerDetail();
const appStore = useAppStore();
const notifications = useNotificationStore();
const showRemoveDialog = ref(false);

const tabs = computed(() => detailStore.getTabs(props.workspaceId));
const activeTabId = computed(() => detailStore.getActiveTabId(props.workspaceId));
const activeTab = computed(() => detailStore.getActiveTab(props.workspaceId));

const inspectResourceKey = computed(() => {
  const tab = activeTab.value;
  return `${tab?.backendId}:${tab?.contextName}:${tab?.containerId}`;
});

const inspectFetcher = (): Promise<string> => {
  const tab = activeTab.value;
  return appStore.dockerInspect(tab?.containerId || "", tab?.backendId || "", tab?.contextName || "");
};

const lazydockerAvailable = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = appStore.dockerState();
  if (!docker?.lazydocker) return false;
  const backendId = activeTab.value?.backendId;
  if (backendId && docker.lazydocker[backendId]) return docker.lazydocker[backendId].available;
  // fallback: any backend has lazydocker
  return Object.values(docker.lazydocker).some((v: unknown) => (v as { available: boolean }).available);
});

const projectServices = computed(() => {
  if (activeTab.value?.kind !== "project") return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = appStore.dockerState();
  if (!docker?.containers) return [];
  return docker.containers.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) =>
      c.backendId === activeTab.value?.backendId &&
      c.contextName === activeTab.value?.contextName &&
      c.parsedLabels?.composeProject === activeTab.value?.projectName,
  );
});

function closeTab(tabId: string): void {
  const tab = tabs.value.find((t) => t.tabId === tabId);
  if (tab?.logSessionId) {
    appStore.dockerLogsClose(tab.logSessionId).catch(() => {});
  }
  if (tab?.shellSessionId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    api?.dockerShellClose?.({ sessionId: tab.shellSessionId }).catch(() => {});
  }
  detailStore.closeTab(props.workspaceId, tabId);
}

function openShell(): void {
  const tab = activeTab.value;
  if (!tab?.containerId) return;
  // Switch the embedded Shell sub-tab into view instead of spawning a new
  // workspace tab — keeps the user's context on this container.
  detailStore.setActiveSubTab(props.workspaceId, tab.tabId, "shell");
}

async function openLazydocker(): Promise<void> {
  await appStore.openLazydocker(props.workspaceId, activeTab.value?.backendId);
}

async function doRemove(): Promise<void> {
  showRemoveDialog.value = false;
  const tab = activeTab.value;
  if (!tab?.containerId) return;
  try {
    await appStore.dockerAction("remove", props.workspaceId, tab.containerId, tab.backendId, tab.contextName);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    notifications.showError("Failed to remove container", `${tab.label}: ${msg}`);
  }
}

function onSubTabChange(sub: SubTabKind): void {
  const tab = activeTab.value;
  if (!tab) return;
  detailStore.setActiveSubTab(props.workspaceId, tab.tabId, sub);
}
</script>

<style scoped>
.docker-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.docker-detail__section {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Mobile: sub-tabs trigger + toolbar ⋮ live in one chrome row. We push the
   trigger to the left and the overflow ⋮ to the right with margin-left:auto. */
.docker-detail__mobile-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--bg-secondary, #1a1a1d);
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  flex-shrink: 0;
}
.docker-detail__mobile-bar > :deep(.detail-toolbar) {
  margin-left: auto;
}

.docker-detail__section > * {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
}

.docker-detail__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim, #888);
  font-size: 13px;
  font-style: italic;
}

.docker-detail__compose {
  flex: 1;
  overflow: auto;
}

.compose-empty {
  padding: 24px;
  color: var(--text-dim, #888);
  font-size: 13px;
}

.compose-empty p {
  margin: 0 0 8px 0;
}
.compose-empty__hint {
  font-style: italic;
}

.compose-empty__services {
  margin: 12px 0 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.compose-empty__services li {
  display: flex;
  align-items: center;
  gap: 6px;
}

.svc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.svc-dot--running {
  background: var(--color-success, #48bb78);
}
.svc-dot--stopped {
  background: transparent;
  border: 1.5px solid var(--text-dim, #888);
}

.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
</style>
