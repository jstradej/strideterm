<template>
  <div v-if="activityCount > 0" class="running-agents" data-role="running-agents">
    <p class="eyebrow running-agents__title">
      <span>Running ({{ activityCount }})</span>
    </p>
    <WorkspaceActivityCluster
      v-for="cluster in rowsByCluster"
      :key="cluster.key"
      :cluster-key="cluster.key"
      :nodes="cluster.rows"
      @activate="onActivate"
    />
    <hr class="workspace-list__divider" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { runningAgentElapsedMs, formatRunningAgentElapsed, type RunningAgentRow } from "../../app/selectors.js";
import type { ActivityRowView } from "../../app/workspace-activity-tree.js";
import type { WorkspaceStatusCue } from "../../app/workspace-status.js";
import type { PresentedActivityCluster } from "../../app/sidebar-presented-rows.js";
import WorkspaceActivityCluster from "./WorkspaceActivityCluster.vue";

/**
 * The RUNNING surface: one activity row per SUPERVISED agent (a task agent or
 * an attached/Companion task), drawn through the SAME activity-tree projection
 * and the same cluster layout as "Recently worked".
 *
 * V4 drew this section flat — a single line per agent with its ancestry glued
 * inline as `parent / parent / name` — right above a recent section that drew
 * the very same parent-child relationship as nested boxes. Two neighbouring
 * sections spoke about one hierarchy in two visual languages, and two tasks in
 * the same provider/review branch repeated that branch once per row (V5
 * review, §"3. RUNNING použije stejnou activity-tree projekci"). Now a root
 * task is one plain row, a nested one sits under context rows it SHARES with
 * its siblings, and the context rows are navigable exactly like the recent
 * ones.
 *
 * This component still derives no membership of its own: the clusters arrive
 * already narrowed by `collectSupervisedAgents`, already deduplicated by
 * `buildActivityForest` and already frozen by SidebarPanel's interaction lock,
 * grid membership and slot number included. A `missing` node is the lock's
 * placeholder. `now` is passed in as well (one shared minute clock in
 * SidebarPanel that stops while the document is hidden), so the surface never
 * runs a timer.
 */
const props = defineProps<{
  clusters: PresentedActivityCluster<RunningAgentRow>[];
  now: number;
  /** This viewer's active workspace — an active row is distinguishable here
   *  exactly as it is in the recent list and in the canonical tree. */
  activeWorkspaceId?: string;
  /** Attention counts by workspace id, for the row's reserved badge slot. */
  attentionCounts?: Map<string, number>;
  /**
   * The canonical status dot per workspace, resolved ONCE in SidebarPanel from
   * the same `workspaceCards` mapping the tree draws (V6 review, §"P2 UX").
   * Passed in rather than derived here, so RUNNING and RECENT and the card can
   * never disagree about what a workspace's state is.
   */
  statusCues?: Map<string, WorkspaceStatusCue>;
}>();

/**
 * Short, fixed-width-friendly UI labels for the task states this surface can
 * show.
 *
 * `judge-evaluating` is sixteen characters. In a reserved slot it either
 * squeezed the workspace name to nothing or wrapped and changed the row's
 * HEIGHT — while the list was frozen and the user was aiming at it (V6 review,
 * §"P1 UX", oprava 4). The state is a glance-level cue; the full wording is
 * still in the row's tooltip and accessible name, and the Dashboard is where
 * the phase is spelled out.
 */
const STATE_LABELS: Record<string, string> = {
  running: "running",
  evaluating: "checking",
  "judge-evaluating": "judging",
  refreshing: "refresh",
  "capturing-context": "capturing",
  paused: "paused",
};

function shortState(state: string): string {
  return STATE_LABELS[state] || state;
}

const emit = defineEmits<{
  (e: "activate", target: { hostWorkspaceId: string; viewId: string }): void;
}>();

function elapsedOf(row: RunningAgentRow): string {
  return formatRunningAgentElapsed(runningAgentElapsedMs(row, props.now));
}

/** The count is AGENTS, never the context rows added for orientation. */
const activityCount = computed(() =>
  props.clusters.reduce((total, cluster) => total + cluster.nodes.filter((n) => n.role === "activity").length, 0),
);

const rowsByCluster = computed((): { key: string; rows: ActivityRowView[] }[] =>
  props.clusters.map((cluster) => ({
    key: cluster.key,
    rows: cluster.nodes.map((node): ActivityRowView => {
      // The label may be ellipsised by a narrow sidebar; the accessible name
      // spells out the whole chain, so two workspaces that share a name are
      // still told apart.
      const where = node.fullPath.join(" › ");
      // The dot may be present on a CONTEXT row too: an Azure inbox parent has
      // its own PR/agent state and the user reads it in exactly the same
      // place as on its tree card.
      const statusCue = props.statusCues?.get(node.workspaceId) || null;
      // Named, never colour-only — the dot is a second reading of the state,
      // not the only one (V6 review, §"P2 UX", oprava 6).
      const status = statusCue ? ` — ${statusCue.label}` : "";
      const base = {
        key: node.key,
        workspaceId: node.workspaceId,
        depth: node.depth,
        active: !!props.activeWorkspaceId && node.workspaceId === props.activeWorkspaceId,
        attentionCount: props.attentionCounts?.get(node.workspaceId) || 0,
        statusCue,
        missing: node.missing,
      };
      if (node.role === "context") {
        const label = node.path.join(" › ");
        return {
          ...base,
          role: "context" as const,
          icon: node.icon,
          color: node.color,
          label,
          ariaLabel: node.missing ? `${where} — no longer available` : `Open ${where}${status}`,
          title: node.missing
            ? `${where} — this workspace is no longer available.`
            : `${where} — click to open this workspace.${statusCue ? ` ${statusCue.label}.` : ""}`,
        };
      }
      const row = node.payload as RunningAgentRow;
      const slot = row.gridSlotIndex ? ` · grid slot ${row.gridSlotIndex}` : "";
      const ariaLabel = node.missing
        ? `${row.label} — no longer available, in ${where}`
        : `${row.label} — ${row.state} for ${elapsedOf(row)} in ${where}${slot}`;
      return {
        ...base,
        role: "activity" as const,
        // The task workspace wears its OWN icon and accent, like its tree card.
        icon: row.workspaceIcon,
        color: row.workspaceColor,
        viewId: row.viewId,
        label: row.workspaceName,
        summary: row.label,
        meta: shortState(row.state),
        trailing: elapsedOf(row),
        inGrid: row.inGrid,
        slotIndex: row.gridSlotIndex,
        ariaLabel,
        title: node.missing
          ? `${row.label} — this workspace is no longer available in ${where}.`
          : `${ariaLabel}. Click to open it.`,
      };
    }),
  })),
);

function onActivate(node: ActivityRowView): void {
  // A context row opens the workspace it stands for and nothing else — only a
  // task's own row opens its agent panel.
  emit("activate", { hostWorkspaceId: node.workspaceId, viewId: node.viewId || "" });
}
</script>
