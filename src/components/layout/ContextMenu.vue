<template>
  <Teleport to="body">
    <div v-if="store.contextMenu" ref="menuRef" class="context-menu" :style="menuStyle" @click.stop>
      <button
        type="button"
        class="context-menu__item"
        title="Make this tab the active view in the workspace — same as left-clicking it in the tab bar."
        @click="onFocus"
      >
        <span class="context-menu__icon">&#x25C9;</span><span>Focus tab</span>
      </button>

      <template v-if="isTerminal">
        <button
          v-if="hasPersistentPanel && !isSshPanel"
          type="button"
          class="context-menu__item"
          title="Edit this tab's title, command, icon, and notification override."
          @click="onEdit"
        >
          <span class="context-menu__icon">&#x270E;</span><span>Edit tab</span>
        </button>
        <button
          v-if="isSshPanel"
          type="button"
          class="context-menu__item"
          title="Open the SSH host editor for the host this tab is connected to — change auth, port, jump hosts, post-login command, etc."
          @click="onEditSshHost"
        >
          <span class="context-menu__icon">&#x1F310;</span><span>Edit SSH host</span>
        </button>
        <button
          type="button"
          class="context-menu__item"
          title="Open the search bar to find text in this terminal's scrollback (Ctrl/Cmd+F)."
          @click="onFind"
        >
          <span class="context-menu__icon">&#x1F50D;</span><span>Find in terminal</span>
        </button>
        <button
          type="button"
          class="context-menu__item"
          title="Export the last 500 lines of this terminal's scrollback to a text file via the system save dialog."
          @click="onSaveTranscript"
        >
          <span class="context-menu__icon">&#x21E9;</span><span>Save last 500 lines</span>
        </button>
        <button
          type="button"
          class="context-menu__item"
          title="Clear the terminal viewport (Ctrl+L equivalent). Scrollback is also wiped."
          @click="onClear"
        >
          <span class="context-menu__icon">&#x232B;</span><span>Clear output</span>
        </button>
        <template v-if="isSshPanel">
          <button
            type="button"
            class="context-menu__item"
            title="Re-establish the SSH connection — kills the current session if alive and starts a fresh one."
            @click="onRestart"
          >
            <span class="context-menu__icon">&#x21BB;</span><span>Reconnect SSH</span>
          </button>
          <button
            type="button"
            class="context-menu__item context-menu__item--danger"
            title="Close the SSH session immediately — the tab stays open, but the remote shell ends."
            @click="onDisconnectSsh"
          >
            <span class="context-menu__icon">&#x274C;</span><span>Disconnect SSH</span>
          </button>
        </template>
        <button
          v-else
          type="button"
          class="context-menu__item"
          title="Kill the current process in this tab and re-run the tab's startup command. Useful when an agent gets stuck or you want a fresh session."
          @click="onRestart"
        >
          <span class="context-menu__icon">&#x21BB;</span><span>Restart</span>
        </button>
      </template>

      <button
        v-if="refreshKind"
        type="button"
        class="context-menu__item"
        :title="`Force a re-poll of ${refreshLabel} now (skip the configured poll interval) — refreshes container/PR data, comments, and statuses.`"
        @click="onRefresh"
      >
        <span class="context-menu__icon">&#x21BB;</span><span>Refresh {{ refreshLabel }}</span>
      </button>

      <template v-if="canClose">
        <div class="context-menu__divider"></div>
        <button
          type="button"
          class="context-menu__item context-menu__item--danger"
          title="Close this tab. Default panels (Git / Docker / Files / Browser) reopen on next workspace activation; closed PTY tabs do not."
          @click="onClose"
        >
          <span class="context-menu__icon">&#x2715;</span><span>Close tab</span>
        </button>
      </template>

      <template v-if="inGroup">
        <template v-if="moveTargets.length">
          <div class="context-menu__divider"></div>
          <div class="context-menu__label">Move to</div>
          <button
            v-for="target in moveTargets"
            :key="target.viewId"
            type="button"
            class="context-menu__item"
            :title="`Swap this tab with '${target.title}' so it occupies the slot in that direction.`"
            @click="onSwapWith(target.viewId)"
          >
            <span class="context-menu__icon">{{ target.arrow }}</span
            ><span>{{ target.title }}</span>
          </button>
        </template>
        <div class="context-menu__divider"></div>
        <button
          type="button"
          class="context-menu__item"
          title="Remove just this tab from the split. Other tabs in the group stay split."
          @click="onRemoveFromGroup"
        >
          <span class="context-menu__icon">&#x2715;</span><span>Remove from split</span>
        </button>
        <button
          type="button"
          class="context-menu__item context-menu__item--danger"
          title="Disband the entire split layout — every tab in the group returns to a single full-width pane."
          @click="onDisbandGroup"
        >
          <span class="context-menu__icon">&#x2573;</span><span>Disband split</span>
        </button>
      </template>
      <template v-else-if="canAddToSplit">
        <div class="context-menu__divider"></div>
        <button
          type="button"
          class="context-menu__item"
          title="Add this tab to the existing split layout — fills the next free slot in the current layout."
          @click="onAddToGroup"
        >
          <span class="context-menu__icon">+</span><span>Add to split</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, type CSSProperties } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { useSshStore } from "../../stores/ssh.js";
import { LAYOUTS } from "../../app/layout-geometry.js";
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
const sshStore = useSshStore();
const menuRef = ref<HTMLElement | null>(null);

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

const isSshPanel = computed(() => {
  const target = store.getPanelByViewId(viewId.value) as { panel?: { launch?: { kind?: string } } } | undefined;
  return target?.panel?.launch?.kind === "ssh";
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

const refreshLabel = computed(() => {
  const labels: Record<string, string> = {
    docker: "Docker",
    azure: "Azure DevOps",
    github: "GitHub",
  };
  return labels[refreshKind.value] || "";
});

const inGroup = computed(() => Boolean(store.splitGroup?.viewIds.includes(viewId.value)));

// Slot extents per layout. Spanning panes (top pane of "top-split", left
// pane of "left-split") cover the full width/height, so their cMin/cMax
// or rMin/rMax reflect that — the arrow logic treats a target that spans
// past the source's center as "directly above/below/beside", not diagonal.
const SLOT_BOXES = {
  solo: [{ rMin: 0, rMax: 0, cMin: 0, cMax: 0 }],
  cols: [
    { rMin: 0, rMax: 0, cMin: 0, cMax: 0 },
    { rMin: 0, rMax: 0, cMin: 1, cMax: 1 },
  ],
  rows: [
    { rMin: 0, rMax: 0, cMin: 0, cMax: 0 },
    { rMin: 1, rMax: 1, cMin: 0, cMax: 0 },
  ],
  grid: [
    { rMin: 0, rMax: 0, cMin: 0, cMax: 0 },
    { rMin: 0, rMax: 0, cMin: 1, cMax: 1 },
    { rMin: 1, rMax: 1, cMin: 0, cMax: 0 },
    { rMin: 1, rMax: 1, cMin: 1, cMax: 1 },
  ],
  "top-split": [
    { rMin: 0, rMax: 0, cMin: 0, cMax: 1 },
    { rMin: 1, rMax: 1, cMin: 0, cMax: 0 },
    { rMin: 1, rMax: 1, cMin: 1, cMax: 1 },
  ],
  "left-split": [
    { rMin: 0, rMax: 1, cMin: 0, cMax: 0 },
    { rMin: 0, rMax: 0, cMin: 1, cMax: 1 },
    { rMin: 1, rMax: 1, cMin: 1, cMax: 1 },
  ],
};

interface SlotBox {
  rMin: number;
  rMax: number;
  cMin: number;
  cMax: number;
}

function boxCenter(box: SlotBox): { r: number; c: number } {
  return { r: (box.rMin + box.rMax) / 2, c: (box.cMin + box.cMax) / 2 };
}

function arrowFor(srcBox: SlotBox, tgtBox: SlotBox): string {
  const src = boxCenter(srcBox);
  let dr = 0;
  if (tgtBox.rMax < src.r) dr = -1;
  else if (tgtBox.rMin > src.r) dr = 1;
  let dc = 0;
  if (tgtBox.cMax < src.c) dc = -1;
  else if (tgtBox.cMin > src.c) dc = 1;
  if (dr < 0 && dc < 0) return "↖";
  if (dr < 0 && dc > 0) return "↗";
  if (dr > 0 && dc < 0) return "↙";
  if (dr > 0 && dc > 0) return "↘";
  if (dr < 0) return "↑";
  if (dr > 0) return "↓";
  if (dc < 0) return "←";
  if (dc > 0) return "→";
  return "⇄";
}

// List of swap targets for the currently right-clicked pane. Each entry
// has the target viewId, the arrow glyph showing which direction the pane
// will move into, and the target pane's title for context.
const moveTargets = computed(() => {
  const sg = store.splitGroup;
  if (!sg || !inGroup.value) return [];
  const boxes = (
    SLOT_BOXES as Record<string, { rMin: number; rMax: number; cMin: number; cMax: number }[] | undefined>
  )[sg.layout];
  if (!Array.isArray(boxes)) return [];
  const srcIdx = sg.viewIds.indexOf(viewId.value);
  if (srcIdx < 0 || !boxes[srcIdx]) return [];
  const srcBox = boxes[srcIdx];
  const tabs = store.workspaceTabs || [];
  const out = [];
  for (let i = 0; i < sg.viewIds.length; i += 1) {
    if (i === srcIdx || !boxes[i]) continue;
    const tab = tabs.find((t) => t.id === sg.viewIds[i]);
    out.push({
      viewId: sg.viewIds[i],
      title: tab?.title || sg.viewIds[i],
      arrow: arrowFor(srcBox, boxes[i]),
    });
  }
  return out;
});

const canAddToSplit = computed(() => {
  if (inGroup.value || !store.splitGroup) return false;
  const slots = (LAYOUTS as Record<string, { slots: number } | undefined>)[store.splitGroup.layout]?.slots || 2;
  return store.splitGroup.viewIds.length < slots;
});

const adjustedX = ref(rawX.value);
const adjustedY = ref(rawY.value);

const menuStyle = computed((): CSSProperties => ({
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
  store.restartSession(id);
}

function onEdit() {
  const id = viewId.value;
  store.hideContextMenu();
  store.editTabWithDialog(id);
}

function onEditSshHost() {
  const id = viewId.value;
  store.hideContextMenu();
  const target = store.getPanelByViewId(id) as { panel?: { launch?: { sshHostId?: string } } } | undefined;
  const hostId = target?.panel?.launch?.sshHostId;
  const host = sshStore.hosts.find((h) => h.id === hostId);
  if (host && store.openSshHostEditor) {
    store.openSshHostEditor(host);
  }
}

function onDisconnectSsh() {
  const id = viewId.value;
  store.hideContextMenu();
  // Guarantee visible feedback even when the backend no-ops (e.g. the session
  // already failed/exited). If the session IS live, session-manager will also
  // emit its own "Disconnected by user" banner — harmless duplicate.
  termStore.writeToTerminal?.(id, "\r\n\x1b[90m── Disconnect requested\x1b[0m\r\n");
  store
    .getApi()
    .closeTerminal?.(id)
    .catch((err) => {
      console.warn("Failed to disconnect SSH:", err);
    });
}

function onSaveTranscript() {
  const id = viewId.value;
  const title = currentTab.value?.title || "";
  store.hideContextMenu();
  termStore.exportTerminalTranscript(id, { title });
}

function onFind() {
  const id = viewId.value;
  store.hideContextMenu();
  termStore.requestSearch(id);
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

function onSwapWith(targetId: string): void {
  const id = viewId.value;
  store.hideContextMenu();
  store.swapInSplit(id, targetId);
}

function onDisbandGroup() {
  store.hideContextMenu();
  store.disbandSplit();
}

function onAddToGroup() {
  store.ctxAddToGroup(viewId.value);
  store.hideContextMenu();
}

function onDocumentClick(e: MouseEvent): void {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    store.hideContextMenu();
  }
}

function onKeydown(e: KeyboardEvent): void {
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
