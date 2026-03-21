<template>
  <div
    class="terminal-stage"
    :class="stageClasses"
    data-role="terminal-stage"
    @mousedown="onStageMousedown"
  >
    <!-- Empty state: no tabs visible -->
    <div v-if="!visibleTabs.length" class="terminal-empty">
      <p>No active terminal</p>
      <small>Select a tab or open a Docker shell/log stream.</small>
    </div>

    <!-- Terminal panes (v-if — terminal instance lives in store Map, re-attaches on mount) -->
    <article
      v-for="(tab, index) in visibleTerminalTabs"
      :key="tab.id"
      class="workspace-pane"
      :class="paneClasses(tab)"
      :style="gridAreaStyle(index)"
      :data-view-id="tab.id"
    >
      <PaneShell
        v-if="isSplit"
        :title="tab.title"
        :status="tab.status"
        :actions="terminalPaneActions(tab)"
        @action="onPaneAction($event, tab)"
      />
      <TerminalPane :session-id="tab.id" />
    </article>

    <!-- Non-terminal panes (dynamic component — rendered per type) -->
    <article
      v-for="(tab, index) in visibleNonTerminalTabs"
      :key="tab.id"
      class="workspace-pane"
      :class="[paneClasses(tab), `workspace-pane--${tab.type}`]"
      :style="gridAreaStyle(terminalTabCount + index)"
      :data-view-id="tab.id"
    >
      <component
        v-if="paneComponent(tab.type)"
        :is="paneComponent(tab.type)"
        v-bind="paneProps(tab)"
        :show-header="isSplit"
      />
      <!-- Placeholder for pane types not yet implemented -->
      <template v-else>
        <PaneShell
          v-if="isSplit"
          :title="tab.title"
          :status="tab.status"
          :actions="nonTerminalPaneActions(tab)"
          @action="onPaneAction($event, tab)"
        />
        <div class="workspace-pane__body workspace-pane__body--git">
          <!-- Pane content rendered in later phases -->
        </div>
      </template>
    </article>
  </div>
</template>

<script setup>
import { computed, watch, defineAsyncComponent } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { isGitViewId, isDockerViewId, isAzureViewId, isReviewViewId, isBrowserViewId } from "../../app/helpers.js";
import PaneShell from "../layout/PaneShell.vue";
import TerminalPane from "./TerminalPane.vue";
const GitPane = defineAsyncComponent(() => import("./GitPane.vue"));
const DockerPane = defineAsyncComponent(() => import("./DockerPane.vue"));
const AzureInboxPane = defineAsyncComponent(() => import("./AzureInboxPane.vue"));
const AzureReviewPane = defineAsyncComponent(() => import("./AzureReviewPane.vue"));
const BrowserPane = defineAsyncComponent(() => import("./BrowserPane.vue"));

const AREA_NAMES = ["a", "b", "c", "d"];
const AREA_LAYOUTS = new Set(["top-split", "left-split"]);

const store = useAppStore();
const termStore = useTerminalStore();

const visibleTabs = computed(() => store.visibleTabs);

const currentLayout = computed(() => {
  const sg = store.splitGroup;
  if (!sg) return "solo";
  return sg.viewIds.includes(store.activeViewId) ? sg.layout : "solo";
});

const isSplit = computed(() => visibleTabs.value.length > 1);

const visibleTerminalTabs = computed(() =>
  visibleTabs.value.filter((t) => t.type === "terminal"),
);

const visibleNonTerminalTabs = computed(() =>
  visibleTabs.value.filter((t) => t.type !== "terminal"),
);

const terminalTabCount = computed(() => visibleTerminalTabs.value.length);

const stageClasses = computed(() => ({
  [`terminal-stage--${currentLayout.value}`]: true,
  [`terminal-stage--count-${visibleTabs.value.length}`]: true,
}));

function paneClasses(tab) {
  return {
    "workspace-pane--active": tab.id === store.activeViewId,
    "workspace-pane--plain": !isSplit.value,
  };
}

function gridAreaStyle(index) {
  if (!AREA_LAYOUTS.has(currentLayout.value)) return {};
  const area = AREA_NAMES[index];
  return area ? { gridArea: area } : {};
}

function terminalPaneActions(tab) {
  return [
    { className: "workspace-pane__icon-btn", action: "select-tab", viewId: tab.id, title: "Focus tab", label: "◉" },
    ...(tab.persistent ? [{ className: "workspace-pane__icon-btn", action: "rename-tab", viewId: tab.id, title: "Rename tab", label: "✎" }] : []),
    { className: "workspace-pane__icon-btn", action: "export-terminal-transcript", sessionId: tab.id, title: "Save last 500 lines", label: "⇩" },
    { className: "workspace-pane__icon-btn", action: "clear-terminal", sessionId: tab.id, title: "Clear output", label: "⌫" },
    { className: "workspace-pane__icon-btn", action: "restart-session", sessionId: tab.id, title: "Restart", label: "↻" },
    { className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger", action: "close-tab", viewId: tab.id, title: "Close tab", label: "×" },
  ];
}

function nonTerminalPaneActions(tab) {
  if (isGitViewId(tab.id)) {
    return [
      { className: "workspace-pane__icon-btn", action: "select-tab", viewId: tab.id, title: "Focus tab", label: "◉" },
      { className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger", action: "close-tab", viewId: tab.id, title: "Close tab", label: "×" },
    ];
  }
  if (isDockerViewId(tab.id)) {
    return [
      { className: "workspace-pane__icon-btn", action: "refresh-docker", title: "Refresh Docker", label: "↻" },
      { className: "workspace-pane__icon-btn", action: "select-tab", viewId: tab.id, title: "Focus tab", label: "◉" },
      { className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger", action: "close-tab", viewId: tab.id, title: "Close tab", label: "×" },
    ];
  }
  if (isAzureViewId(tab.id) || isReviewViewId(tab.id)) {
    return [
      { className: "workspace-pane__icon-btn", action: "refresh-azure", title: "Refresh Azure DevOps", label: "↻" },
    ];
  }
  return [];
}

const PANE_COMPONENTS = {
  git: GitPane,
  docker: DockerPane,
  azure: AzureInboxPane,
  review: AzureReviewPane,
  browser: BrowserPane,
};

function paneComponent(type) {
  return PANE_COMPONENTS[type] || null;
}

function paneProps(tab) {
  if (tab.type === "git") return { workspaceId: tab.id.replace(/^git:/, "") };
  if (tab.type === "docker") return { workspaceId: tab.id.replace(/^docker:/, "") };
  if (tab.type === "azure") return { workspaceId: tab.id.replace(/^azure:/, "") };
  if (tab.type === "review") return { workspaceId: tab.id.replace(/^review:/, "") };
  return { tab };  // browser and others get the full tab object
}

function onStageMousedown(event) {
  const pane = event.target.closest(".workspace-pane");
  if (!pane) {
    termStore.focusActiveTerminal();
    return;
  }
  const viewId = pane.dataset.viewId;
  if (!viewId) return;
  store.activeViewId = viewId;
  store.activeSessionId = (
    isGitViewId(viewId) || isDockerViewId(viewId) ||
    isAzureViewId(viewId) || isReviewViewId(viewId) || isBrowserViewId(viewId)
  ) ? null : viewId;
  termStore.focusActiveTerminal();
}

function onPaneAction(action, tab) {
  switch (action.action) {
    case "select-tab":
      store.activateView(tab.id);
      break;
    case "export-terminal-transcript":
      termStore.exportTerminalTranscript(action.sessionId, { title: tab.title });
      break;
    case "clear-terminal":
      termStore.clearTerminalViewport(action.sessionId);
      break;
    // Other actions (restart-session, rename-tab, close-tab, etc.) handled in Phase 4
  }
}

// Prune terminal views when tabs change (remove orphaned terminal instances)
watch(
  () => store.workspaceTabs,
  (tabs) => {
    const validSessionIds = new Set(
      tabs.filter((t) => t.type === "terminal").map((t) => t.id),
    );
    termStore.pruneTerminalViews(validSessionIds);
  },
);
</script>
