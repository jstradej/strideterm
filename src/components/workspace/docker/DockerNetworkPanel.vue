<template>
  <div class="net-panel">
    <div class="net-panel__toolbar">
      <button
        type="button"
        class="button button--ghost button--danger"
        :disabled="removing || isBuiltin"
        :title="isBuiltin ? 'Built-in networks cannot be removed' : ''"
        @click="confirmRemove = true"
      >
        {{ removing ? "Removing…" : "Remove" }}
      </button>
      <div v-if="network" class="net-panel__meta">
        <span class="net-panel__chip">{{ network.Driver }}</span>
        <span v-if="network.Scope" class="net-panel__chip">{{ network.Scope }}</span>
        <span v-if="isBuiltin" class="net-panel__chip net-panel__chip--builtin">built-in</span>
      </div>
    </div>
    <div class="net-panel__body">
      <DockerResourceInspect
        kind="network"
        :resource-key="`${tab.backendId}:${tab.contextName}:${tab.networkId}`"
        :fetcher="fetcher"
      />
    </div>

    <teleport to="body">
      <div v-if="confirmRemove" class="dialog-overlay" @click.self="confirmRemove = false">
        <ConfirmDialog
          title="Remove network?"
          :message="`Remove network ${tab.label}? Containers connected to it will lose this network.`"
          confirm-label="Remove"
          :danger="true"
          @confirm="doRemove"
          @cancel="confirmRemove = false"
        />
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import DockerResourceInspect from "./DockerResourceInspect.vue";
import ConfirmDialog from "../../dialogs/ConfirmDialog.vue";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { useDockerDetail, type OpenTab } from "../../../stores/docker-detail.js";

const props = defineProps<{
  workspaceId: string;
  tab: OpenTab;
}>();

const appStore = useAppStore();
const detailStore = useDockerDetail();
const notifications = useNotificationStore();
const removing = ref(false);
const confirmRemove = ref(false);

const network = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = (appStore.payload as any)?.docker;
  return docker?.networks?.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (n: any) =>
      n.ID === props.tab.networkId && n.backendId === props.tab.backendId && n.contextName === props.tab.contextName,
  ) as { Name: string; Driver: string; Scope?: string } | undefined;
});

/** docker's `bridge`, `host`, `none` defaults can't be removed. */
const isBuiltin = computed(() => {
  const name = network.value?.Name || props.tab.label;
  return name === "bridge" || name === "host" || name === "none";
});

const fetcher = () =>
  appStore.dockerNetworkInspect(props.tab.networkId || "", props.tab.backendId, props.tab.contextName);

async function doRemove(): Promise<void> {
  confirmRemove.value = false;
  if (!props.tab.networkId) return;
  removing.value = true;
  try {
    await appStore.dockerNetworkRemove(props.tab.networkId, props.tab.backendId, props.tab.contextName);
    detailStore.closeTab(props.workspaceId, props.tab.tabId);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    notifications.showError("Failed to remove network", `${props.tab.label}: ${msg}`);
  } finally {
    removing.value = false;
  }
}
</script>

<style scoped>
.net-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.net-panel__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  min-height: 40px;
}

.net-panel__meta {
  display: flex;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
}

.net-panel__chip {
  font-size: 11px;
  padding: 2px 7px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  color: var(--text-dim, #aaa);
}
.net-panel__chip--builtin {
  border-color: rgba(210, 168, 255, 0.4);
  color: #d2a8ff;
}

.net-panel__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
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

@media (max-width: 600px) {
  .net-panel__toolbar {
    gap: 4px;
    padding: 6px;
  }
  .net-panel__meta {
    margin-left: 0;
    width: 100%;
    order: 2;
  }
}
</style>
