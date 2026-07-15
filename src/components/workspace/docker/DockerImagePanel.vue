<template>
  <div class="image-panel">
    <div class="image-panel__toolbar">
      <button
        type="button"
        class="button button--ghost"
        :disabled="!image || pulling"
        :title="image ? `Pull ${pullRef}` : ''"
        @click="doPull"
      >
        {{ pulling ? "Pulling…" : "Pull" }}
      </button>
      <button
        type="button"
        class="button button--ghost button--danger"
        :disabled="!tab || removing"
        @click="confirmRemove = true"
      >
        {{ removing ? "Removing…" : "Remove" }}
      </button>
      <div v-if="image" class="image-panel__meta">
        <span class="image-panel__chip">{{ image.Size }}</span>
        <span class="image-panel__chip">{{ image.CreatedSince }}</span>
        <span class="image-panel__chip image-panel__chip--mono">{{ shortId }}</span>
      </div>
    </div>
    <div class="image-panel__body">
      <DockerResourceInspect
        kind="image"
        :resource-key="`${tab.backendId}:${tab.contextName}:${tab.imageId}`"
        :fetcher="fetcher"
      />
    </div>

    <teleport to="body">
      <div v-if="confirmRemove" class="dialog-overlay" @click.self="confirmRemove = false">
        <ConfirmDialog
          title="Remove image?"
          :message="`Remove image ${tab.label}? This cannot be undone. Use 'Force' if other containers still reference it.`"
          confirm-label="Remove"
          :danger="true"
          @confirm="doRemove(false)"
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
const pulling = ref(false);
const confirmRemove = ref(false);

const image = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = appStore.dockerState();
  return docker?.images?.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (i: any) =>
      i.ID === props.tab.imageId && i.backendId === props.tab.backendId && i.contextName === props.tab.contextName,
  ) as { Repository: string; Tag: string; Size: string; CreatedSince: string; ID: string } | undefined;
});

const shortId = computed(() => (props.tab.imageId || "").replace(/^sha256:/, "").slice(0, 12));
const pullRef = computed(() => (image.value ? `${image.value.Repository}:${image.value.Tag}` : ""));

const fetcher = () => appStore.dockerImageInspect(props.tab.imageId || "", props.tab.backendId, props.tab.contextName);

async function doRemove(force: boolean): Promise<void> {
  confirmRemove.value = false;
  if (!props.tab.imageId) return;
  removing.value = true;
  try {
    await appStore.dockerImageRemove(props.tab.imageId, props.tab.backendId, props.tab.contextName, force);
    detailStore.closeTab(props.workspaceId, props.tab.tabId);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    // Common case: image is referenced by a container. Suggest force in the toast.
    const hint = /image is .* being used|image is in use|conflict/i.test(msg)
      ? " (try removing the containers that use it first, or use force-remove)"
      : "";
    notifications.showError("Failed to remove image", `${props.tab.label}: ${msg}${hint}`);
  } finally {
    removing.value = false;
  }
}

async function doPull(): Promise<void> {
  if (!pullRef.value) return;
  pulling.value = true;
  try {
    await appStore.dockerImagePull(pullRef.value, props.tab.backendId, props.tab.contextName);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    notifications.showError("Failed to pull image", `${pullRef.value}: ${msg}`);
  } finally {
    pulling.value = false;
  }
}
</script>

<style scoped>
.image-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.image-panel__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  min-height: 40px;
}

.image-panel__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
}

.image-panel__chip {
  font-size: 11px;
  padding: 2px 7px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  color: var(--text-dim, #aaa);
}
.image-panel__chip--mono {
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  color: #79c0ff;
}

.image-panel__body {
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
  .image-panel__toolbar {
    gap: 4px;
    padding: 6px;
  }
  .image-panel__meta {
    margin-left: 0;
    width: 100%;
    order: 2;
  }
}
</style>
