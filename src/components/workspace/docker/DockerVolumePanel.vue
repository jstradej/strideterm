<template>
  <div class="vol-panel">
    <div class="vol-panel__toolbar">
      <button
        type="button"
        class="button button--ghost button--danger"
        :disabled="removing"
        @click="confirmRemove = true"
      >
        {{ removing ? "Removing…" : "Remove" }}
      </button>
      <div v-if="volume" class="vol-panel__meta">
        <span class="vol-panel__chip">{{ volume.Driver }}</span>
        <span v-if="usedByCount > 0" class="vol-panel__chip vol-panel__chip--info">
          used by {{ usedByCount }} container{{ usedByCount === 1 ? "" : "s" }}
        </span>
      </div>
    </div>
    <div class="vol-panel__view-switch" role="tablist">
      <button
        type="button"
        role="tab"
        :aria-selected="view === 'inspect'"
        :class="['vol-panel__view', view === 'inspect' && 'vol-panel__view--active']"
        @click="view = 'inspect'"
      >
        Inspect
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="view === 'browse'"
        :class="['vol-panel__view', view === 'browse' && 'vol-panel__view--active']"
        @click="view = 'browse'"
      >
        Browse
      </button>
    </div>
    <div class="vol-panel__body">
      <DockerResourceInspect
        v-if="view === 'inspect'"
        kind="volume"
        :resource-key="`${tab.backendId}:${tab.contextName}:${tab.volumeName}`"
        :fetcher="fetcher"
      />
      <DockerVolumeBrowse
        v-else
        :volume-name="tab.volumeName!"
        :backend-id="tab.backendId"
        :context-name="tab.contextName"
      />
    </div>

    <teleport to="body">
      <div v-if="confirmRemove" class="dialog-overlay" @click.self="confirmRemove = false">
        <ConfirmDialog
          title="Remove volume?"
          :message="`Remove volume ${tab.label}? Volume contents will be permanently deleted. ${usedByCount > 0 ? `Currently in use by ${usedByCount} container(s) — will be force-removed.` : ''}`"
          confirm-label="Remove"
          :danger="true"
          @confirm="doRemove(usedByCount > 0)"
          @cancel="confirmRemove = false"
        />
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import DockerResourceInspect from "./DockerResourceInspect.vue";
import DockerVolumeBrowse from "./DockerVolumeBrowse.vue";
import ConfirmDialog from "../../dialogs/ConfirmDialog.vue";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { useDockerDetail, type OpenTab } from "../../../stores/docker-detail.js";

type VolumeView = "inspect" | "browse";

const props = defineProps<{
  workspaceId: string;
  tab: OpenTab;
}>();

const appStore = useAppStore();
const detailStore = useDockerDetail();
const notifications = useNotificationStore();
const removing = ref(false);
const confirmRemove = ref(false);
const view = ref<VolumeView>("inspect");

const volume = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = appStore.dockerState();
  return docker?.volumes?.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v: any) =>
      v.Name === props.tab.volumeName && v.backendId === props.tab.backendId && v.contextName === props.tab.contextName,
  );
});

const usedByCount = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = appStore.dockerState();
  if (!docker?.containers || !props.tab.volumeName) return 0;
  let count = 0;
  for (const c of docker.containers as Array<{
    backendId: string;
    contextName: string;
    Mounts?: string;
  }>) {
    if (c.backendId !== props.tab.backendId || c.contextName !== props.tab.contextName) continue;
    if (typeof c.Mounts === "string" && c.Mounts.split(",").some((m) => m === props.tab.volumeName)) {
      count++;
    }
  }
  return count;
});

const fetcher = () =>
  appStore.dockerVolumeInspect(props.tab.volumeName || "", props.tab.backendId, props.tab.contextName);

async function doRemove(force: boolean): Promise<void> {
  confirmRemove.value = false;
  if (!props.tab.volumeName) return;
  removing.value = true;
  try {
    await appStore.dockerVolumeRemove(props.tab.volumeName, props.tab.backendId, props.tab.contextName, force);
    detailStore.closeTab(props.workspaceId, props.tab.tabId);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    notifications.showError("Failed to remove volume", `${props.tab.volumeName}: ${msg}`);
  } finally {
    removing.value = false;
  }
}
</script>

<style scoped>
.vol-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.vol-panel__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  min-height: 40px;
}

.vol-panel__meta {
  display: flex;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
}

.vol-panel__chip {
  font-size: 11px;
  padding: 2px 7px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  color: var(--text-dim, #aaa);
}
.vol-panel__chip--info {
  border-color: rgba(99, 179, 237, 0.4);
  color: var(--accent, #63b3ed);
}

.vol-panel__view-switch {
  display: flex;
  gap: 2px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  flex-shrink: 0;
}

.vol-panel__view {
  position: relative;
  padding: 6px 12px;
  background: transparent;
  border: 0;
  color: var(--text-dim, #888);
  font-size: 11px;
  letter-spacing: 0.2px;
  cursor: pointer;
  text-transform: uppercase;
  min-height: 32px;
}
.vol-panel__view:hover {
  color: var(--text-primary, #e2e8f0);
}
.vol-panel__view--active {
  color: var(--text-primary, #e2e8f0);
  font-weight: 600;
}
.vol-panel__view--active::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--accent, #63b3ed);
  border-radius: 1px;
}

.vol-panel__body {
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
  .vol-panel__toolbar {
    gap: 4px;
    padding: 6px;
  }
  .vol-panel__meta {
    margin-left: 0;
    width: 100%;
    order: 2;
  }
}
</style>
