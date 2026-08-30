<template>
  <button
    v-if="count > 0"
    type="button"
    class="agent-run-chip"
    data-role="agent-run-chip"
    :title="tooltip"
    @click="openAgentsTab"
  >
    <span aria-hidden="true">🤖</span>
    <strong>{{ count }}</strong>
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import {
  collectSupervisedAgents,
  runningAgentElapsedMs,
  formatRunningAgentElapsed,
  type RunningAgentRow,
} from "../../app/selectors.js";
import type { WorkspaceState } from "../../../electron/shared/types/state.js";

// "How many agents are working" — the always-visible entry point. It is a
// direct child of `.workspace-meta`, next to the bell, precisely because
// `.workspace-meta__stats` is display:none below 768px / under 500px of
// height (src/styles/mobile.css) while `.workspace-meta` survives. That
// placement gives the chip remote/mobile visibility with no new CSS exception
// — mobile.css is not touched.
//
// The chip carries no list of its own: clicking it opens the dock on the
// Agents tab, which renders the same rows as the sidebar surface — the SAME
// task-only projection, so the three can never disagree about the count.
const store = useAppStore();
const notifications = useNotificationStore();

const rows = computed((): RunningAgentRow[] => {
  const payload = store.payload;
  if (!payload) return [];
  return collectSupervisedAgents({
    workspaces: store.filteredWorkspaces as WorkspaceState[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskRunnerSnapshot: ((payload as any).taskRunner as Record<string, { state?: string }>) || null,
    workspaceGrid: store.workspaceGrid,
  });
});

const count = computed(() => rows.value.length);

const tooltip = computed(() => {
  const now = Date.now();
  const lines = rows.value.map(
    (row) => `${row.workspaceName} › ${row.label} — ${formatRunningAgentElapsed(runningAgentElapsedMs(row, now))}`,
  );
  return [`${count.value} agent${count.value === 1 ? "" : "s"} running. Click to open the Agents tab.`, ...lines].join(
    "\n",
  );
});

function openAgentsTab(): void {
  notifications.openPanelOnTab("agents");
}
</script>
