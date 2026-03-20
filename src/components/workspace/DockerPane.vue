<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      :title="'Docker'"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!dockerState.available" class="empty-card">
      <p>Docker runtime is unavailable.</p>
      <small>{{ dockerState.error || 'Install Docker CLI on Windows or expose it via WSL.' }}</small>
    </div>
    <section v-else class="docker-manager" aria-label="Docker manager">
      <header class="docker-manager__header">
        <div class="docker-manager__summary">
          <article class="docker-stat">
            <span class="eyebrow">Context</span>
            <strong>{{ activeContext?.Name || 'n/a' }}</strong>
            <small>{{ activeContext?.DockerEndpoint || 'No context' }}</small>
          </article>
          <article class="docker-stat">
            <span class="eyebrow">Containers</span>
            <strong>{{ containers.length }}</strong>
            <small>{{ runningCount }} running</small>
          </article>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button v-if="lazydockerAvailable" type="button" class="button" style="white-space:nowrap" @click="appStore.openLazydocker(workspaceId)">Open Lazydocker</button>
          <button v-else type="button" class="button button--ghost" disabled style="white-space:nowrap;border:1px dashed var(--accent);color:var(--accent);opacity:0.9" title="Install lazydocker: winget install JesseDuffield.lazygit or brew install lazydocker">Install Lazydocker</button>
        </div>
      </header>
      <ul class="docker-list" role="list">
        <template v-if="containers.length">
          <li v-for="container in containers" :key="container.ID">
            <article :class="['docker-card', isRunning(container) && 'docker-card--running']">
              <div class="docker-card__head">
                <div>
                  <h4>{{ container.Names || container.ID }}</h4>
                  <p class="docker-card__meta">{{ container.Image || 'Unknown image' }}</p>
                </div>
                <span :class="['docker-state', `docker-state--${isRunning(container) ? 'running' : 'stopped'}`]">{{ container.State || (isRunning(container) ? 'running' : 'stopped') }}</span>
              </div>
              <div class="docker-card__meta">
                <span>{{ container.Status || 'Unknown status' }}</span>
                <span>{{ container.Ports || 'No ports' }}</span>
              </div>
              <div class="docker-card__actions" aria-label="Container actions">
                <button type="button" :class="['button', 'button--ghost', busyAction === `shell-${container.ID}` && 'button--busy']" :disabled="!isRunning(container) || !!busyAction" @click="handleDockerShell(container.ID)">Shell</button>
                <button type="button" :class="['button', 'button--ghost', busyAction === `logs-${container.ID}` && 'button--busy']" :disabled="!!busyAction" @click="handleDockerLogs(container.ID)">Logs</button>
                <button type="button" :class="['button', 'button--ghost', busyAction === `docker-start-${container.ID}` && 'button--busy']" :disabled="isRunning(container) || !!busyAction" @click="handleDockerAction('docker-start', container.ID)">{{ busyAction === `docker-start-${container.ID}` ? 'Starting…' : 'Start' }}</button>
                <button type="button" :class="['button', 'button--ghost', busyAction === `docker-stop-${container.ID}` && 'button--busy']" :disabled="!isRunning(container) || !!busyAction" @click="handleDockerAction('docker-stop', container.ID)">{{ busyAction === `docker-stop-${container.ID}` ? 'Stopping…' : 'Stop' }}</button>
                <button type="button" :class="['button', 'button--ghost', busyAction === `docker-restart-${container.ID}` && 'button--busy']" :disabled="!isRunning(container) || !!busyAction" @click="handleDockerAction('docker-restart', container.ID)">{{ busyAction === `docker-restart-${container.ID}` ? 'Restarting…' : 'Restart' }}</button>
                <button type="button" :class="['button', 'button--ghost', 'danger', busyAction === `docker-remove-${container.ID}` && 'button--busy']" :disabled="!!busyAction" @click="handleDockerAction('docker-remove', container.ID)">{{ busyAction === `docker-remove-${container.ID}` ? 'Removing…' : 'Remove' }}</button>
              </div>
            </article>
          </li>
        </template>
        <li v-else>
          <div class="empty-card">
            <p>No containers found.</p>
            <small>When Docker services appear, you can open logs or attach a shell here.</small>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import { isContainerRunning, currentDockerContext } from "../../app/helpers.js";
import PaneShell from "../layout/PaneShell.vue";

const props = defineProps({
  workspaceId: { type: String, required: true },
  showHeader: { type: Boolean, default: false },
});

const appStore = useAppStore();

const dockerState = computed(() => appStore.payload?.docker || {});
const containers = computed(() => dockerState.value.containers || []);
const runningCount = computed(() => containers.value.filter(isContainerRunning).length);
const activeContext = computed(() => currentDockerContext(dockerState.value.contexts || []));
const lazydockerAvailable = computed(() => dockerState.value.lazydocker?.available || false);

const busyAction = ref("");

async function handleDockerAction(action, containerId) {
  busyAction.value = `${action}-${containerId}`;
  try { await appStore.dockerAction(action, props.workspaceId, containerId); }
  finally { busyAction.value = ""; }
}

async function handleDockerShell(containerId) {
  busyAction.value = `shell-${containerId}`;
  try { await appStore.dockerShell(props.workspaceId, containerId); }
  finally { busyAction.value = ""; }
}

async function handleDockerLogs(containerId) {
  busyAction.value = `logs-${containerId}`;
  try { await appStore.dockerLogs(props.workspaceId, containerId); }
  finally { busyAction.value = ""; }
}

async function handleRefresh() {
  busyAction.value = "refresh";
  try { await appStore.refreshDocker(); }
  finally { busyAction.value = ""; }
}

const headerStatus = computed(() => `${runningCount.value}/${containers.value.length} running`);
const headerActions = computed(() => [
  { className: "workspace-pane__icon-btn", action: "refresh-docker", title: "Refresh Docker", label: "↻" },
  { className: "workspace-pane__icon-btn", action: "select-tab", viewId: `docker:${props.workspaceId}`, title: "Focus tab", label: "◉" },
  { className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger", action: "close-tab", viewId: `docker:${props.workspaceId}`, title: "Close tab", label: "×" },
]);

function isRunning(container) { return isContainerRunning(container); }

function onHeaderAction(action) {
  if (action.action === "refresh-docker") handleRefresh();
  else if (action.action === "select-tab") appStore.activateView(action.viewId);
  else if (action.action === "close-tab") appStore.closeTab(action.viewId);
}
</script>
