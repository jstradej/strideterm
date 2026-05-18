<template>
  <div class="detail-toolbar" :class="isMobile && 'detail-toolbar--mobile'">
    <!-- ============================== Container ============================= -->
    <template v-if="tab.kind === 'container'">
      <!-- Desktop: keep every action on the row. -->
      <template v-if="!isMobile">
        <button
          type="button"
          :class="['button', 'button--ghost', busyAction === `start` && 'button--busy']"
          :disabled="!!tab.removed || isRunning || !!busyAction"
          @click="doAction('start')"
        >
          {{ busyAction === "start" ? "Starting…" : "Start" }}
        </button>

        <button
          type="button"
          :class="['button', 'button--ghost', busyAction === `stop` && 'button--busy']"
          :disabled="!!tab.removed || !isRunning || !!busyAction"
          @click="doAction('stop')"
        >
          {{ busyAction === "stop" ? "Stopping…" : "Stop" }}
        </button>

        <button
          type="button"
          :class="['button', 'button--ghost', busyAction === 'restart' && 'button--busy']"
          :disabled="!!tab.removed || !!busyAction"
          @click="doAction('restart')"
        >
          {{ busyAction === "restart" ? "Restarting…" : "Restart" }}
        </button>

        <button
          v-if="shellAvailable"
          type="button"
          class="button button--ghost"
          :disabled="!!tab.removed || !isRunning || !!busyAction"
          @click="emit('open-shell')"
        >
          Open Shell
        </button>

        <button
          type="button"
          :class="['button', 'button--ghost', 'button--danger', busyAction === 'remove' && 'button--busy']"
          :disabled="!!tab.removed || !!busyAction"
          @click="confirmRemove"
        >
          {{ busyAction === "remove" ? "Removing…" : "Remove" }}
        </button>

        <button
          v-if="lazydockerAvailable"
          type="button"
          class="button button--ghost detail-toolbar__lazydocker"
          :disabled="!!tab.removed"
          @click="emit('open-lazydocker')"
        >
          Lazydocker
        </button>
      </template>

      <!-- Mobile: a single ⋮ trigger holding every action. The parent positions
           this on the same row as the sub-tabs trigger, so the toolbar adds no
           dedicated chrome row of its own. -->
      <template v-else>
        <button
          type="button"
          class="detail-toolbar__more"
          :aria-expanded="moreOpen"
          :aria-label="moreOpen ? 'Close actions menu' : 'Container actions'"
          :disabled="!!tab.removed"
          @click="toggleMore"
        >
          <span class="detail-toolbar__more-dot" aria-hidden="true">⋮</span>
        </button>

        <template v-if="moreOpen">
          <div class="detail-toolbar__backdrop" aria-hidden="true" @click="moreOpen = false"></div>
          <div class="detail-toolbar__popover" role="menu">
            <button
              v-if="!isRunning"
              type="button"
              role="menuitem"
              class="detail-toolbar__menu-item"
              :disabled="!!tab.removed || !!busyAction"
              @click="runFromMenu(() => doAction('start'))"
            >
              {{ busyAction === "start" ? "Starting…" : "Start" }}
            </button>
            <button
              v-else
              type="button"
              role="menuitem"
              class="detail-toolbar__menu-item"
              :disabled="!!tab.removed || !!busyAction"
              @click="runFromMenu(() => doAction('stop'))"
            >
              {{ busyAction === "stop" ? "Stopping…" : "Stop" }}
            </button>
            <button
              type="button"
              role="menuitem"
              class="detail-toolbar__menu-item"
              :disabled="!!tab.removed || !!busyAction"
              @click="runFromMenu(() => doAction('restart'))"
            >
              {{ busyAction === "restart" ? "Restarting…" : "Restart" }}
            </button>
            <button
              v-if="shellAvailable"
              type="button"
              role="menuitem"
              class="detail-toolbar__menu-item"
              :disabled="!!tab.removed || !isRunning || !!busyAction"
              @click="runFromMenu(() => emit('open-shell'))"
            >
              Shell
            </button>
            <button
              v-if="lazydockerAvailable"
              type="button"
              role="menuitem"
              class="detail-toolbar__menu-item"
              :disabled="!!tab.removed"
              @click="runFromMenu(() => emit('open-lazydocker'))"
            >
              Lazydocker
            </button>
            <button
              type="button"
              role="menuitem"
              class="detail-toolbar__menu-item detail-toolbar__menu-item--danger"
              :disabled="!!tab.removed || !!busyAction"
              @click="runFromMenu(confirmRemove)"
            >
              {{ busyAction === "remove" ? "Removing…" : "Remove" }}
            </button>
          </div>
        </template>
      </template>
    </template>

    <!-- =============================== Compose ============================== -->
    <template v-else-if="tab.kind === 'project'">
      <template v-if="!isMobile">
        <button
          type="button"
          :class="['button', 'button--ghost', composeAction === 'start' && 'button--busy']"
          :disabled="!!composeAction"
          @click="doComposeAction('start')"
        >
          {{ composeAction === "start" ? "Starting…" : "Start all" }}
        </button>

        <button
          type="button"
          :class="['button', 'button--ghost', composeAction === 'stop' && 'button--busy']"
          :disabled="!!composeAction"
          @click="doComposeAction('stop')"
        >
          {{ composeAction === "stop" ? "Stopping…" : "Stop all" }}
        </button>

        <button
          type="button"
          :class="['button', 'button--ghost', composeAction === 'restart' && 'button--busy']"
          :disabled="!!composeAction"
          @click="doComposeAction('restart')"
        >
          {{ composeAction === "restart" ? "Restarting…" : "Restart all" }}
        </button>
      </template>

      <!-- Mobile compose: Start all primary + ⋮ for Stop all / Restart all.
           We can't reliably tell from a project-tab whether everything is up
           (no parsedLabels here), so we don't flip primary the way we do for
           single containers — Start all is the most common entry point. -->
      <template v-else>
        <button
          type="button"
          :class="['button', 'button--ghost', composeAction === 'start' && 'button--busy']"
          :disabled="!!composeAction"
          @click="doComposeAction('start')"
        >
          {{ composeAction === "start" ? "Starting…" : "Start all" }}
        </button>
        <button
          type="button"
          class="detail-toolbar__more"
          :aria-expanded="moreOpen"
          :aria-label="moreOpen ? 'Close actions menu' : 'More actions'"
          @click="toggleMore"
        >
          <span class="detail-toolbar__more-dot" aria-hidden="true">⋮</span>
        </button>
        <template v-if="moreOpen">
          <div class="detail-toolbar__backdrop" aria-hidden="true" @click="moreOpen = false"></div>
          <div class="detail-toolbar__popover" role="menu">
            <button
              type="button"
              role="menuitem"
              class="detail-toolbar__menu-item"
              :disabled="!!composeAction"
              @click="runFromMenu(() => doComposeAction('stop'))"
            >
              {{ composeAction === "stop" ? "Stopping…" : "Stop all" }}
            </button>
            <button
              type="button"
              role="menuitem"
              class="detail-toolbar__menu-item"
              :disabled="!!composeAction"
              @click="runFromMenu(() => doComposeAction('restart'))"
            >
              {{ composeAction === "restart" ? "Restarting…" : "Restart all" }}
            </button>
          </div>
        </template>
      </template>
    </template>

    <!-- Removed container banner -->
    <div v-if="tab.removed" class="detail-toolbar__removed-banner">
      ⚠ Container was removed. Logs are read-only. Close this tab to dismiss.
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { useIsNarrow } from "../../../composables/useIsNarrow.js";
import type { OpenTab } from "../../../stores/docker-detail.js";

// Shell PTY I/O isn't wired through the remote/web transport (only Electron
// IPC). Hide the action entirely on remote clients so the user doesn't pick
// it and end up staring at an inert pane.

const props = defineProps<{
  workspaceId: string;
  tab: OpenTab;
  lazydockerAvailable: boolean;
}>();

const emit = defineEmits<{
  "open-shell": [];
  "open-lazydocker": [];
  "confirm-remove": [];
}>();

const appStore = useAppStore();
const notifications = useNotificationStore();
const { isMobile } = useIsNarrow();
// Mirror DockerDetailSubTabs: hide Shell on remote transports (window.strideterm
// only exists in Electron). Same signal, no Pinia dependency for tests.
const shellAvailable = computed(
  () => typeof window !== "undefined" && !!(window as { strideterm?: unknown }).strideterm,
);

const busyAction = ref<string>("");
const composeAction = ref<string>("");
const moreOpen = ref(false);

// If the viewport widens back to desktop while the popover is open, drop it
// — the desktop branch won't render the overflow trigger anyway.
watch(isMobile, (mobile) => {
  if (!mobile) moreOpen.value = false;
});

// Close the popover when the user navigates to a different tab so a stale
// "Remove" target doesn't linger.
watch(
  () => props.tab.tabId,
  () => {
    moreOpen.value = false;
  },
);

const container = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = (appStore.payload as any)?.docker;
  if (!docker?.containers || !props.tab.containerId) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return docker.containers.find((c: any) => c.ID === props.tab.containerId) || null;
});

const isRunning = computed(() => {
  const state = (container.value?.State || "").toLowerCase();
  return state === "running";
});

async function doAction(action: string): Promise<void> {
  if (!props.tab.containerId) return;
  busyAction.value = action;
  try {
    await appStore.dockerAction(
      action,
      props.workspaceId,
      props.tab.containerId,
      props.tab.backendId,
      props.tab.contextName,
    );
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    notifications.showError(`Failed to ${action} container`, `${props.tab.label}: ${msg}`);
  } finally {
    busyAction.value = "";
  }
}

async function doComposeAction(action: string): Promise<void> {
  if (!props.tab.projectName) return;
  composeAction.value = action;
  try {
    await appStore.dockerComposeAction(action, props.tab.backendId, props.tab.contextName, props.tab.projectName);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    notifications.showError(`Compose ${action} failed`, `${props.tab.label}: ${msg}`);
  } finally {
    composeAction.value = "";
  }
}

function confirmRemove(): void {
  emit("confirm-remove");
}

function toggleMore(): void {
  moreOpen.value = !moreOpen.value;
}

/**
 * Wrap any menu-item click so the popover dismisses before the action runs.
 * Avoids the popover lingering while the confirmation dialog animates in or
 * while the docker call is in flight.
 */
function runFromMenu(fn: () => void): void {
  moreOpen.value = false;
  fn();
}
</script>

<style scoped>
.detail-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  min-height: 40px;
  position: relative;
}

.detail-toolbar__lazydocker {
  margin-left: auto;
}

.detail-toolbar__removed-banner {
  flex: 1 1 100%;
  padding: 4px 8px;
  background: rgba(252, 129, 74, 0.12);
  border: 1px solid rgba(252, 129, 74, 0.3);
  border-radius: 4px;
  font-size: 12px;
  color: var(--color-warn, #f6ad55);
}

/* Mobile: the toolbar is just the ⋮ trigger now. It's positioned by the
   parent (DockerDetail mobile bar) alongside the sub-tabs trigger, so we
   strip the "own row" chrome — no padding, no border, no min-height. The
   wrapper still exists in the DOM (carries the popover + backdrop), but
   collapses to fit content only. */
.detail-toolbar--mobile {
  display: inline-flex;
  gap: 0;
  padding: 0;
  flex-wrap: nowrap;
  min-height: 0;
  border-bottom: 0;
  flex-shrink: 0;
}
.detail-toolbar--mobile .detail-toolbar__removed-banner {
  /* Banner sits outside the inline row — anchor it under the mobile bar so
     the warning still shows once for a removed container. */
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 1px;
  flex: none;
}

.detail-toolbar__more {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  min-height: 38px;
  padding: 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  border-radius: 4px;
  color: var(--text-primary, #e2e8f0);
  cursor: pointer;
}
.detail-toolbar__more:hover {
  background: rgba(255, 255, 255, 0.07);
}
.detail-toolbar__more:focus-visible {
  outline: 1px solid var(--accent, #63b3ed);
  outline-offset: 1px;
}
.detail-toolbar__more-dot {
  font-size: 18px;
  line-height: 1;
}

.detail-toolbar__backdrop {
  position: fixed;
  inset: 0;
  background: transparent;
  z-index: 40;
}

.detail-toolbar__popover {
  position: absolute;
  top: calc(100% + 2px);
  right: 8px;
  min-width: 180px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated, #1e1e22);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
}

.detail-toolbar__menu-item {
  padding: 10px 14px;
  background: transparent;
  border: 0;
  color: var(--text-primary, #e2e8f0);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  min-height: 40px;
  white-space: nowrap;
}
.detail-toolbar__menu-item:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.05);
}
.detail-toolbar__menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.detail-toolbar__menu-item--danger {
  color: var(--color-error, #fc8181);
}
.detail-toolbar__menu-item:focus-visible {
  outline: 1px solid var(--accent, #63b3ed);
  outline-offset: -2px;
}
</style>
