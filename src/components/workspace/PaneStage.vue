<template>
  <div class="terminal-stage" :class="stageClasses" data-role="terminal-stage" @mousedown="onStageMousedown">
    <!-- Empty state: no tabs visible. When this workspace's only tab is the
         Primary currently shown inside a companion task workspace, say so and
         offer the way there instead of a bare "no terminal" — a placeholder
         tab would look like a second copy of the conversation. -->
    <div v-if="!visibleTabs.length && hostedPrimary" class="terminal-empty">
      <p>Primary is currently shown in {{ hostedPrimary.taskWorkspaceName }}</p>
      <small
        >{{ hostedPrimary.sourcePanelTitle }} stays owned by this workspace and comes back when the loop ends.</small
      >
      <button type="button" class="button button--sm terminal-empty__action" @click="openCompanionTask">
        Open companion task
      </button>
    </div>
    <div v-else-if="!visibleTabs.length" class="terminal-empty">
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
          @action="(a, meta) => onPaneAction(a, tab, meta)"
        />
        <TerminalPane :session-id="sessionIdOf(tab)" />
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
          @action="(a, meta) => onPaneAction(a, tab, meta)"
        />
        <div class="workspace-pane__body workspace-pane__body--git">
          <!-- Pane content rendered in later phases -->
        </div>
      </template>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, nextTick } from "vue";
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
import { resolvePaneComponent, resolvePaneProps } from "../../app/pane-resolver.js";
import { tabSessionId } from "../../app/selectors.js";
import { SLOT_BOXES, gridAreaStyle as _gridAreaStyle, swapDirection, swapArrow } from "../../app/layout-geometry.js";
interface Tab {
  id: string;
  type: string;
  title: string;
  status?: string;
  persistent?: boolean;
  url?: string;
  /** Real PTY target — differs from `id` only for a borrowed Primary. */
  sessionId?: string;
  borrowed?: boolean;
}

const store = useAppStore();
const termStore = useTerminalStore();

const visibleTabs = computed(() => store.visibleTabs);

/** Never drive a terminal operation off `tab.id` — see selectors.tabSessionId. */
function sessionIdOf(tab: Tab): string {
  return tabSessionId(tab);
}

// This workspace's Primary is presented inside a companion task workspace
// right now (null otherwise) — drives the dedicated empty state above.
const hostedPrimary = computed(() => store.getCompanionPrimaryHost(store.myActiveWorkspaceId));

function openCompanionTask(): void {
  const taskWorkspaceId = hostedPrimary.value?.taskWorkspaceId;
  if (taskWorkspaceId) void store.activateWorkspaceInGrid(taskWorkspaceId);
}

const currentLayout = computed(() => {
  // When only one pane is visible (e.g. mobile forceSoloLayout collapses a
  // 3-pane task agent split to the active tab), force "solo" so the stage
  // grid does not reserve space for the absent split slots — otherwise the
  // single article ends up parked in slot "a" of "top-split" / "left-split"
  // and the rest of the viewport stays blank.
  if (visibleTabs.value.length <= 1) return "solo";
  // renderedSplitGroup, not splitGroup: a dormant member (a Primary hidden on
  // either side of the relocation) must not leave an empty slot behind.
  const sg = store.renderedSplitGroup;
  if (!sg) return "solo";
  return sg.viewIds.includes(store.activeViewId || "") ? sg.layout : "solo";
});

const isSplit = computed(() => visibleTabs.value.length > 1);

const stageClasses = computed(() => ({
  [`terminal-stage--${currentLayout.value}`]: true,
  [`terminal-stage--count-${visibleTabs.value.length}`]: true,
}));

function paneClasses(tab: Tab) {
  return {
    "workspace-pane--active": tab.id === store.activeViewId,
    "workspace-pane--plain": !isSplit.value,
  };
}

function gridAreaStyle(index: number) {
  return _gridAreaStyle(index, currentLayout.value);
}

// Build swap actions for the current pane based on the active split group.
// Returns an empty array for solo / unsplit tabs so headers stay tidy. The
// inline arrows hide on narrow panes via a CSS container query; a hamburger
// sibling then gives access to the same swap targets through the context
// menu's "Move to" section.
function paneSwapActions(tab: Tab) {
  const sg = store.renderedSplitGroup;
  if (!sg || !sg.viewIds.includes(tab.id)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const boxes = (SLOT_BOXES as Record<string, any>)[sg.layout];
  if (!Array.isArray(boxes)) return [];
  const srcIdx = sg.viewIds.indexOf(tab.id);
  if (srcIdx < 0 || !boxes[srcIdx]) return [];
  const srcBox = boxes[srcIdx];
  const tabs = store.workspaceTabs || [];
  const out = [];
  for (let i = 0; i < sg.viewIds.length; i += 1) {
    if (i === srcIdx || !boxes[i]) continue;
    const targetId = sg.viewIds[i];
    const [dr, dc] = swapDirection(srcBox, boxes[i]);
    const targetTab = tabs.find((t) => t.id === targetId);
    out.push({
      className: "workspace-pane__icon-btn workspace-pane__icon-btn--swap",
      action: "swap-with",
      viewId: tab.id,
      targetViewId: targetId,
      title: `Swap with ${targetTab?.title || targetId}`,
      label: swapArrow(dr, dc),
    });
  }
  return out;
}

function paneMenuAction(tab: Tab) {
  return {
    className: "workspace-pane__icon-btn workspace-pane__icon-btn--menu",
    action: "pane-menu",
    viewId: tab.id,
    title: "Pane menu",
    label: "☰",
  };
}

// Wrap a list of existing pane actions with the swap row (+ divider) when
// the tab is part of the split group. Also appends the hamburger menu
// button, which the container query shows on narrow panes as a fallback.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withSwapAndMenu(tab: Tab, baseActions: any[]) {
  const swaps = paneSwapActions(tab);
  const menu = paneMenuAction(tab);
  // Always append the hamburger — it's hidden on wide panes and exposes
  // every action (swap + base icons) when the container query collapses
  // the inline buttons at narrow widths.
  if (!swaps.length) return [...baseActions, menu];
  return [...baseActions, { action: "divider" }, ...swaps, menu];
}

function terminalPaneActions(tab: Tab) {
  const sessionId = sessionIdOf(tab);
  return withSwapAndMenu(tab, [
    {
      className: "workspace-pane__icon-btn",
      action: "select-tab",
      viewId: tab.id,
      title: "Make this pane the active tab — same as left-clicking it in the tab bar.",
      label: "◉",
    },
    {
      className: "workspace-pane__icon-btn",
      action: "find-in-terminal",
      sessionId,
      title:
        "Find text in this terminal's scrollback (Ctrl/Cmd+F). Searches the buffer xterm.js keeps in memory — older output that's scrolled past the limit isn't searchable.",
      label: "🔍",
    },
    // A borrowed Primary is only hosted here — editing the tab would edit a
    // panel this workspace doesn't own.
    ...(tab.persistent && !tab.borrowed
      ? [
          {
            className: "workspace-pane__icon-btn",
            action: "edit-tab",
            viewId: tab.id,
            title: "Edit this tab's title, command, icon, and notification override.",
            label: "✎",
          },
        ]
      : []),
    {
      className: "workspace-pane__icon-btn",
      action: "export-terminal-transcript",
      sessionId,
      title: "Export the last 500 lines of this terminal's scrollback to a text file via the system save dialog.",
      label: "⇩",
    },
    {
      className: "workspace-pane__icon-btn",
      action: "clear-terminal",
      sessionId,
      title: "Clear the terminal viewport (Ctrl+L equivalent). Scrollback is also wiped.",
      label: "⌫",
    },
    {
      className: "workspace-pane__icon-btn",
      action: "restart-session",
      sessionId,
      title:
        "Kill the current process in this tab and re-run the tab's startup command. Useful when an agent gets stuck or you want a fresh session.",
      label: "↻",
    },
    // Closing is the owner's call: a borrowed Primary has no close button.
    ...(tab.borrowed
      ? []
      : [
          {
            className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
            action: "close-tab",
            viewId: tab.id,
            title:
              "Close this tab. Default panels (Git / Docker / Files / Browser) reopen on next workspace activation; closed PTY tabs do not.",
            label: "×",
          },
        ]),
  ]);
}

function nonTerminalPaneActions(tab: Tab) {
  return withSwapAndMenu(tab, nonTerminalPaneBaseActions(tab));
}

function nonTerminalPaneBaseActions(tab: Tab) {
  if (isGitViewId(tab.id)) {
    return [
      {
        className: "workspace-pane__icon-btn",
        action: "select-tab",
        viewId: tab.id,
        title: "Make this pane the active tab — same as left-clicking it in the tab bar.",
        label: "◉",
      },
      {
        className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
        action: "close-tab",
        viewId: tab.id,
        title:
          "Close this tab. Default panels (Git / Docker / Files / Browser) reopen on next workspace activation; closed PTY tabs do not.",
        label: "×",
      },
    ];
  }
  if (isDockerViewId(tab.id)) {
    return [
      {
        className: "workspace-pane__icon-btn",
        action: "refresh-docker",
        title: "Force a fresh poll of Docker (containers, images, contexts) regardless of the configured interval.",
        label: "↻",
      },
      {
        className: "workspace-pane__icon-btn",
        action: "select-tab",
        viewId: tab.id,
        title: "Make this pane the active tab — same as left-clicking it in the tab bar.",
        label: "◉",
      },
      {
        className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
        action: "close-tab",
        viewId: tab.id,
        title:
          "Close this tab. Default panels (Git / Docker / Files / Browser) reopen on next workspace activation; closed PTY tabs do not.",
        label: "×",
      },
    ];
  }
  if (isAzureViewId(tab.id)) {
    return [
      {
        className: "workspace-pane__icon-btn",
        action: "refresh-azure",
        title:
          "Force a fresh poll of every Azure DevOps connection (PRs, threads, votes, checks) and skip the configured poll interval.",
        label: "↻",
      },
    ];
  }
  if (isGitHubViewId(tab.id)) {
    return [
      {
        className: "workspace-pane__icon-btn",
        action: "refresh-github",
        title:
          "Force a fresh poll of every GitHub connection (PRs, reviews, threads, checks) and skip the configured poll interval.",
        label: "↻",
      },
    ];
  }
  if (isReviewViewId(tab.id)) {
    const ws = store.payload?.appState?.workspaces?.find((w) => w.id === tab.id.replace(/^review:/, ""));
    const provider = ws?.review?.provider || "azure-devops";
    return [
      {
        className: "workspace-pane__icon-btn",
        action: provider === "github" ? "refresh-github" : "refresh-azure",
        title: `Force a fresh poll of ${provider === "github" ? "GitHub" : "Azure DevOps"} so this PR's metadata, reviewers, comments, and checks update straight away.`,
        label: "↻",
      },
    ];
  }
  if (isFilesViewId(tab.id)) {
    return [
      {
        className: "workspace-pane__icon-btn",
        action: "select-tab",
        viewId: tab.id,
        title: "Make this pane the active tab — same as left-clicking it in the tab bar.",
        label: "◉",
      },
      {
        className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
        action: "close-tab",
        viewId: tab.id,
        title:
          "Close this tab. Default panels (Git / Docker / Files / Browser) reopen on next workspace activation; closed PTY tabs do not.",
        label: "×",
      },
    ];
  }
  if (tab.type === "headless-judge") {
    return [
      {
        className: "workspace-pane__icon-btn",
        action: "select-tab",
        viewId: tab.id,
        title: "Make this pane the active tab — same as left-clicking it in the tab bar.",
        label: "◉",
      },
      ...(tab.persistent
        ? [
            {
              className: "workspace-pane__icon-btn",
              action: "edit-tab",
              viewId: tab.id,
              title: "Edit this tab's title, command, icon, and notification override.",
              label: "✎",
            },
          ]
        : []),
    ];
  }
  return [];
}

function paneComponent(type: string) {
  return resolvePaneComponent(type);
}

function paneProps(tab: Tab) {
  return resolvePaneProps(tab.type, tab.id) || { tab };
}

function onStageMousedown(event: MouseEvent) {
  const pane = (event.target as HTMLElement | null)?.closest(".workspace-pane");
  if (!pane) {
    termStore.focusActiveTerminal();
    return;
  }
  const viewId = (pane as HTMLElement).dataset.viewId;
  if (!viewId) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tab = visibleTabs.value.find((entry: any) => entry.id === viewId) || null;
  store.activeViewId = viewId;
  store.activeSessionId = tab?.type === "terminal" ? sessionIdOf(tab) : null;
  termStore.focusActiveTerminal();
}

function onPaneAction(
  action: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: pane action payload is open-ended, typed migration pending
  tab: Tab,
  meta: { anchorRect?: DOMRect | null; event?: MouseEvent } | undefined,
) {
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
    case "find-in-terminal":
      termStore.requestSearch(action.sessionId);
      break;
    case "clear-terminal":
      termStore.clearTerminalViewport(action.sessionId);
      break;
    case "swap-with":
      store.swapInSplit(action.viewId, action.targetViewId);
      break;
    case "pane-menu": {
      const rect = meta?.anchorRect;
      const x = rect ? rect.left : 0;
      const y = rect ? rect.bottom + 4 : 0;
      store.showContextMenu(x, y, tab.id);
      break;
    }
    // Other actions (restart-session, close-tab, etc.) handled in Phase 4
  }
}

function liveTerminalSessionIds(): Set<string> {
  const payload = store.payload as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: server state blob
  const ids = new Set<string>();
  const workspaces = (payload?.appState?.workspaces || []) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
  // Desktop: include terminal sessions from ALL workspaces regardless of profile
  // so xterm buffers survive profile switches (the key visual-profile-switch feature).
  // Remote: scope to the remote client's controllable profile only — remote clients
  // bind to a single desktop windowSlot and should not retain views for profiles
  // they cannot control.
  const profileFilter = store.isRemoteTransport ? store.myActiveProfileId || "default" : null;
  for (const workspace of workspaces) {
    if (profileFilter && (workspace.profileId || "default") !== profileFilter) continue;
    for (const panel of workspace.panels || []) {
      const command = String(panel.command || "");
      if (/^https?:\/\//i.test(command) || command === "__files__" || command === "__task-dashboard__") continue;
      ids.add(`${workspace.id}:${panel.id}`);
    }
  }
  return ids;
}

// Desktop: prune only when workspace/panels are deleted (not on profile switch) —
// keeping inactive-profile buffers alive is the key visual-profile-switch feature.
// Remote: also prune on profile change so remote clients don't accumulate views
// for profiles they can't control.
watch(
  () =>
    store.isRemoteTransport
      ? [store.payload?.appState?.workspaces, store.myActiveProfileId]
      : [store.payload?.appState?.workspaces],
  () => {
    termStore.pruneTerminalViews(liveTerminalSessionIds());
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
