<template>
  <section class="activity-cluster" data-role="activity-cluster" :data-cluster-key="clusterKey">
    <button
      v-for="node in nodes"
      :key="node.key"
      type="button"
      class="activity-row"
      :class="{
        'activity-row--context': node.role === 'context',
        'activity-row--activity': node.role === 'activity',
        'activity-row--active': node.active && !node.missing,
        'activity-row--attention': (node.attentionCount || 0) > 0 && !node.missing,
        'activity-row--in-grid': node.inGrid && !node.missing,
        'activity-row--missing': node.missing,
      }"
      :style="`--accent:${node.color || 'var(--border)'};--activity-depth:${visualDepthOf(node.depth)}`"
      :data-role="node.role === 'context' ? 'activity-context-row' : 'activity-node-row'"
      :data-row-key="node.key"
      :data-workspace-id="node.workspaceId"
      :data-depth="node.depth"
      :disabled="node.missing"
      :aria-label="node.ariaLabel"
      :aria-current="node.active && !node.missing ? 'true' : undefined"
      :title="node.title"
      @click="onActivate(node)"
    >
      <span class="activity-row__badge" aria-hidden="true">
        {{ node.icon }}
        <span
          v-if="node.statusCue && !node.missing"
          v-heartbeat="node.statusCue.heartbeat"
          :class="['activity-row__status-dot', `activity-row__status-dot--${node.statusCue.state}`]"
          :title="node.statusCue.label"
        ></span>
        <span v-if="node.slotIndex && !node.missing" class="activity-row__slot">{{ node.slotIndex }}</span>
      </span>
      <span class="activity-row__text">
        <span class="activity-row__title">
          <strong class="activity-row__label">{{ node.label }}</strong>
          <span
            v-if="(node.attentionCount || 0) > 0 && !node.missing"
            class="activity-row__attention"
            aria-hidden="true"
            >🔔<span class="activity-row__attention-count">{{ node.attentionCount }}</span></span
          >
        </span>
        <small v-if="node.role === 'activity'" class="activity-row__summary">{{ node.summary || "" }}</small>
      </span>
      <span v-if="node.meta !== undefined || node.trailing !== undefined" class="activity-row__tail">
        <span v-if="node.meta !== undefined" class="activity-row__state">{{ node.missing ? "" : node.meta }}</span>
        <span v-if="node.trailing !== undefined" class="activity-row__trailing">{{
          node.missing ? "gone" : node.trailing
        }}</span>
      </span>
    </button>
  </section>
</template>

<script setup lang="ts">
import { visualDepthOf, type ActivityRowView } from "../../app/workspace-activity-tree.js";
import { vHeartbeat } from "../../app/heartbeat-directive.js";

/**
 * ONE activity cluster — the shared hierarchy layout behind both dynamic
 * sidebar sections.
 *
 * V4 gave every recent result its own closed box-in-box block. That solved the
 * false-hierarchy problem but repeated a shared branch once per result, and it
 * left RUNNING drawing the very same parent-child relationship in a completely
 * different, flat visual language (V5 review, §"1." and §"3."). Both sections
 * now project through `buildActivityForest` and render through this component,
 * so a nested task and a nested recent workspace look and behave the same.
 *
 * The DOM shape is the contract:
 *
 *   ┌ [AZ] Azure DevOps          ← context, its own button
 *   │   [AZ] mhub PR #30746 1m   ← activity, its own button
 *   │     [bot] pr-30746    now  ← activity, its own button
 *   └
 *
 *   1. one outer box per CLUSTER, and inside it plain indentation — not a
 *      fresh rectangle per level, which would box a deep Azure/GitHub/task
 *      branch into unreadable nesting;
 *   2. every context and activity row is a SIBLING button. Never a button
 *      wrapping other buttons: clicking a parent is a legitimate navigation,
 *      but nesting interactive elements makes "what did I just click" a
 *      guess, and breaks keyboard traversal outright;
 *   3. a click activates exactly the workspace THAT row stands for — for a
 *      compressed breadcrumb, the nearest parent of the activity below it;
 *   4. activation is navigation, never work: nothing here stamps
 *      `lastWorkedAt`;
 *   5. the row is a THREE-COLUMN grid — badge, `minmax(0, 1fr)` text, compact
 *      tail — so the text column is the only thing that can grow, and is
 *      therefore the only thing that gets ellipsised when the sidebar is
 *      narrow. The cluster never overflows to the right (V6 review, §"P1 UX —
 *      activity cluster přetéká už při defaultních 248 px");
 *   6. the values that keep changing (a state, an elapsed, an age) live in
 *      reserved fixed-width slots inside that tail, and the grid-slot number
 *      and the status dot are drawn out of flow, so nothing that arrives while
 *      the list is frozen can resize a row the user is aiming at;
 *   7. the INDENT saturates at `MAX_ACTIVITY_VISUAL_DEPTH` while the data does
 *      not: a sixth level must not spend the whole text budget, and the full
 *      path is still in the rail, the tooltip and the accessible name;
 *   8. the status dot is the canonical card's, resolved once by
 *      `resolveWorkspaceStatusCue` and handed down — same colour, same glyph,
 *      same heartbeat, on context rows too;
 *   9. a hard-deleted workspace keeps its row and its height and goes inert,
 *      rather than vanishing from under the pointer (interaction lock, V3 §2).
 *
 * Every value it draws is handed to it — this component derives no membership,
 * no hierarchy and no identity of its own.
 */
defineProps<{
  /** The cluster's stable key, for tests and for the DOM. */
  clusterKey: string;
  /** Pre-order rows: a parent always precedes its children. */
  nodes: ActivityRowView[];
}>();

const emit = defineEmits<{
  (e: "activate", node: ActivityRowView): void;
}>();

function onActivate(node: ActivityRowView): void {
  // A disabled button cannot fire this, but the guard keeps the contract true
  // for a programmatic click too: a placeholder never navigates.
  if (node.missing) return;
  emit("activate", node);
}
</script>
