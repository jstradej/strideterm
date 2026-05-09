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
          @action="(a, meta) => onPaneAction(a, tab, meta)"
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

const AREA_NAMES = ["a", "b", "c", "d"];
const AREA_LAYOUTS = new Set(["top-split", "left-split"]);

// Per-layout slot geometry. Each slot has a center (rCenter/cCenter) and an
// extent (rMin..rMax, cMin..cMax). Extents differ from centers for spanning
// panes — e.g. the top pane in "top-split" occupies the full width, so its
// cMin/cMax are 0/1 while its cCenter is 0.5. Without this, the arrow from
// a bottom sub-pane to the top pane resolved to "↗" / "↖" instead of "↑".
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
    { rMin: 0, rMax: 0, cMin: 0, cMax: 1 }, // full-width top
    { rMin: 1, rMax: 1, cMin: 0, cMax: 0 },
    { rMin: 1, rMax: 1, cMin: 1, cMax: 1 },
  ],
  "left-split": [
    { rMin: 0, rMax: 1, cMin: 0, cMax: 0 }, // full-height left
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
interface Tab {
  id: string;
  type: string;
  title: string;
  status?: string;
  persistent?: boolean;
  url?: string;
}

function boxCenter(box: SlotBox) {
  return { r: (box.rMin + box.rMax) / 2, c: (box.cMin + box.cMax) / 2 };
}

// Direction from src → tgt. If the target's extent covers the source's
// center on an axis, that axis contributes 0 (the target spans past me —
// it's neither to my left nor right, or neither above nor below).
function swapDirection(srcBox: SlotBox, tgtBox: SlotBox) {
  const src = boxCenter(srcBox);
  let dr = 0;
  if (tgtBox.rMax < src.r) dr = -1;
  else if (tgtBox.rMin > src.r) dr = 1;
  let dc = 0;
  if (tgtBox.cMax < src.c) dc = -1;
  else if (tgtBox.cMin > src.c) dc = 1;
  return [dr, dc];
}

function swapArrow(dr: number, dc: number) {
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

const store = useAppStore();
const termStore = useTerminalStore();

const visibleTabs = computed(() => store.visibleTabs);

const currentLayout = computed(() => {
  // When only one pane is visible (e.g. mobile forceSoloLayout collapses a
  // 3-pane task agent split to the active tab), force "solo" so the stage
  // grid does not reserve space for the absent split slots — otherwise the
  // single article ends up parked in slot "a" of "top-split" / "left-split"
  // and the rest of the viewport stays blank.
  if (visibleTabs.value.length <= 1) return "solo";
  const sg = store.splitGroup;
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
  if (!AREA_LAYOUTS.has(currentLayout.value)) return {};
  const area = AREA_NAMES[index];
  return area ? { gridArea: area } : {};
}

// Build swap actions for the current pane based on the active split group.
// Returns an empty array for solo / unsplit tabs so headers stay tidy. The
// inline arrows hide on narrow panes via a CSS container query; a hamburger
// sibling then gives access to the same swap targets through the context
// menu's "Move to" section.
function paneSwapActions(tab: Tab) {
  const sg = store.splitGroup;
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
  return withSwapAndMenu(tab, [
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
    {
      className: "workspace-pane__icon-btn",
      action: "export-terminal-transcript",
      sessionId: tab.id,
      title: "Export the last 500 lines of this terminal's scrollback to a text file via the system save dialog.",
      label: "⇩",
    },
    {
      className: "workspace-pane__icon-btn",
      action: "clear-terminal",
      sessionId: tab.id,
      title: "Clear the terminal viewport (Ctrl+L equivalent). Scrollback is also wiped.",
      label: "⌫",
    },
    {
      className: "workspace-pane__icon-btn",
      action: "restart-session",
      sessionId: tab.id,
      title:
        "Kill the current process in this tab and re-run the tab's startup command. Useful when an agent gets stuck or you want a fresh session.",
      label: "↻",
    },
    {
      className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
      action: "close-tab",
      viewId: tab.id,
      title:
        "Close this tab. Default panels (Git / Docker / Files / Browser) reopen on next workspace activation; closed PTY tabs do not.",
      label: "×",
    },
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
  store.activeSessionId = tab?.type === "terminal" ? viewId : null;
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
