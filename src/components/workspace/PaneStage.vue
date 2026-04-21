<template>
  <div class="terminal-stage" :class="stageClasses" data-role="terminal-stage" @mousedown="onStageMousedown">
    <!-- Empty state: no tabs visible -->
    <div v-if="!visibleTabs.length" class="terminal-empty">
      <p>No active terminal</p>
      <small>Select a tab or open a Docker shell/log stream.</small>
    </div>

    <!-- Panes rendered in split-group order (active tab first) -->
    <article
      v-for="(tab, index) in visibleTabs"
      :key="tab.id"
      class="workspace-pane"
      :class="[paneClasses(tab), tab.type !== 'terminal' && `workspace-pane--${tab.type}`]"
      :style="gridAreaStyle(index)"
      :data-view-id="tab.id"
    >
      <!-- Terminal pane -->
      <template v-if="tab.type === 'terminal'">
        <PaneShell
          v-if="isSplit"
          :title="tab.title"
          :status="tab.status"
          :actions="terminalPaneActions(tab)"
          @action="onPaneAction($event, tab)"
        />
        <TerminalPane :session-id="tab.id" />
      </template>

      <!-- Non-terminal pane (dynamic component) -->
      <template v-else-if="paneComponent(tab.type)">
        <component :is="paneComponent(tab.type)" v-bind="paneProps(tab)" :show-header="isSplit" />
      </template>

      <!-- Placeholder for unknown pane types -->
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
import { computed, watch, nextTick, defineAsyncComponent } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import {
  isGitViewId,
  isDockerViewId,
  isAzureViewId,
  isGitHubViewId,
  isReviewViewId,
  isFilesViewId,
} from "../../app/helpers.js";
import PaneShell from "../layout/PaneShell.vue";
import TerminalPane from "./TerminalPane.vue";
const GitPane = defineAsyncComponent(() => import("./GitPane.vue"));
const DockerPane = defineAsyncComponent(() => import("./DockerPane.vue"));
const AzureInboxPane = defineAsyncComponent(() => import("./AzureInboxPane.vue"));
const AzureReviewPane = defineAsyncComponent(() => import("./AzureReviewPane.vue"));
const GitHubInboxPane = defineAsyncComponent(() => import("./GitHubInboxPane.vue"));
// GitHubReviewPane removed — AzureReviewPane is provider-aware and handles both Azure and GitHub reviews
const BrowserPane = defineAsyncComponent(() => import("./BrowserPane.vue"));
const FileManagerPane = defineAsyncComponent(() => import("./FileManagerPane.vue"));
const TaskDashboardPane = defineAsyncComponent(() => import("./TaskDashboardPane.vue"));
const HeadlessJudgePane = defineAsyncComponent(() => import("./HeadlessJudgePane.vue"));

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
    ...(tab.persistent
      ? [
          {
            className: "workspace-pane__icon-btn",
            action: "edit-tab",
            viewId: tab.id,
            title: "Edit tab",
            label: "✎",
          },
        ]
      : []),
    {
      className: "workspace-pane__icon-btn",
      action: "export-terminal-transcript",
      sessionId: tab.id,
      title: "Save last 500 lines",
      label: "⇩",
    },
    {
      className: "workspace-pane__icon-btn",
      action: "clear-terminal",
      sessionId: tab.id,
      title: "Clear output",
      label: "⌫",
    },
    {
      className: "workspace-pane__icon-btn",
      action: "restart-session",
      sessionId: tab.id,
      title: "Restart",
      label: "↻",
    },
    {
      className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
      action: "close-tab",
      viewId: tab.id,
      title: "Close tab",
      label: "×",
    },
  ];
}

function nonTerminalPaneActions(tab) {
  if (isGitViewId(tab.id)) {
    return [
      { className: "workspace-pane__icon-btn", action: "select-tab", viewId: tab.id, title: "Focus tab", label: "◉" },
      {
        className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
        action: "close-tab",
        viewId: tab.id,
        title: "Close tab",
        label: "×",
      },
    ];
  }
  if (isDockerViewId(tab.id)) {
    return [
      { className: "workspace-pane__icon-btn", action: "refresh-docker", title: "Refresh Docker", label: "↻" },
      { className: "workspace-pane__icon-btn", action: "select-tab", viewId: tab.id, title: "Focus tab", label: "◉" },
      {
        className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
        action: "close-tab",
        viewId: tab.id,
        title: "Close tab",
        label: "×",
      },
    ];
  }
  if (isAzureViewId(tab.id)) {
    return [
      { className: "workspace-pane__icon-btn", action: "refresh-azure", title: "Refresh Azure DevOps", label: "↻" },
    ];
  }
  if (isGitHubViewId(tab.id)) {
    return [{ className: "workspace-pane__icon-btn", action: "refresh-github", title: "Refresh GitHub", label: "↻" }];
  }
  if (isReviewViewId(tab.id)) {
    const ws = store.payload?.appState?.workspaces?.find((w) => w.id === tab.id.replace(/^review:/, ""));
    const provider = ws?.review?.provider || "azure-devops";
    return [
      {
        className: "workspace-pane__icon-btn",
        action: provider === "github" ? "refresh-github" : "refresh-azure",
        title: `Refresh ${provider === "github" ? "GitHub" : "Azure DevOps"}`,
        label: "↻",
      },
    ];
  }
  if (isFilesViewId(tab.id)) {
    return [
      { className: "workspace-pane__icon-btn", action: "select-tab", viewId: tab.id, title: "Focus tab", label: "◉" },
      {
        className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
        action: "close-tab",
        viewId: tab.id,
        title: "Close tab",
        label: "×",
      },
    ];
  }
  if (tab.type === "headless-judge") {
    return [
      { className: "workspace-pane__icon-btn", action: "select-tab", viewId: tab.id, title: "Focus tab", label: "◉" },
      ...(tab.persistent
        ? [
            {
              className: "workspace-pane__icon-btn",
              action: "edit-tab",
              viewId: tab.id,
              title: "Edit tab",
              label: "✎",
            },
          ]
        : []),
    ];
  }
  return [];
}

const PANE_COMPONENTS = {
  git: GitPane,
  docker: DockerPane,
  azure: AzureInboxPane,
  review: AzureReviewPane,
  github: GitHubInboxPane,
  browser: BrowserPane,
  files: FileManagerPane,
  "task-dashboard": TaskDashboardPane,
  "headless-judge": HeadlessJudgePane,
};

function paneComponent(type) {
  return PANE_COMPONENTS[type] || null;
}

function paneProps(tab) {
  if (tab.type === "git") return { workspaceId: tab.id.replace(/^git:/, "") };
  if (tab.type === "docker") return { workspaceId: tab.id.replace(/^docker:/, "") };
  if (tab.type === "azure") return { workspaceId: tab.id.replace(/^azure:/, "") };
  if (tab.type === "github") return { workspaceId: tab.id.replace(/^github:/, "") };
  if (tab.type === "review") return { workspaceId: tab.id.replace(/^review:/, "") };
  if (tab.type === "files") return { workspaceId: tab.id.replace(/^files:/, "") };
  if (tab.type === "task-dashboard") return { workspaceId: tab.id.replace(/^task-dashboard:/, "") };
  if (tab.type === "headless-judge") return { sessionId: tab.id };
  return { tab };
}

function onStageMousedown(event) {
  const pane = event.target.closest(".workspace-pane");
  if (!pane) {
    termStore.focusActiveTerminal();
    return;
  }
  const viewId = pane.dataset.viewId;
  if (!viewId) return;
  const tab = visibleTabs.value.find((entry) => entry.id === viewId) || null;
  store.activeViewId = viewId;
  store.activeSessionId = tab?.type === "terminal" ? viewId : null;
  termStore.focusActiveTerminal();
}

function onPaneAction(action, tab) {
  switch (action.action) {
    case "select-tab":
      store.activateView(tab.id);
      break;
    case "edit-tab":
      store.editTabWithDialog(action.viewId);
      break;
    case "export-terminal-transcript":
      termStore.exportTerminalTranscript(action.sessionId, { title: tab.title });
      break;
    case "clear-terminal":
      termStore.clearTerminalViewport(action.sessionId);
      break;
    // Other actions (restart-session, close-tab, etc.) handled in Phase 4
  }
}

// Prune terminal views when tabs change (remove orphaned terminal instances)
watch(
  () => store.workspaceTabs,
  (tabs) => {
    const validSessionIds = new Set(tabs.filter((t) => t.type === "terminal").map((t) => t.id));
    termStore.pruneTerminalViews(validSessionIds);
  },
);

// Auto-focus the active terminal when the active session changes (workspace switch,
// tab change, notification click) so the user can start typing immediately. nextTick
// waits for the pane to mount; focusActiveTerminal already skips when an overlay is open.
watch(
  () => store.activeSessionId,
  async (sessionId) => {
    if (!sessionId) return;
    await nextTick();
    termStore.focusActiveTerminal();
  },
);
</script>
