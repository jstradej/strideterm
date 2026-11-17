<template>
  <section class="automations-panel" aria-label="Automations">
    <header class="automations-panel__toolbar">
      <div class="automations-panel__summary">
        <strong class="automations-panel__status" :class="{ 'automations-panel__status--paused': paused }">
          <span aria-hidden="true" class="automations-panel__dot"></span>
          {{ paused ? "Automations paused" : "Automations active" }}
        </strong>
        <span class="automations-panel__hint"
          >Pause applies to all profiles.
          <HelpTooltip
            label="Global automation pause help"
            text="Pause blocks new scheduled, event and manual starts across all profiles. Active runs continue. Pending events remain queued, and schedules follow Missed runs after resume."
        /></span>
      </div>
      <button
        type="button"
        class="automations-panel__pause"
        :disabled="busy || !canPause"
        :aria-pressed="paused"
        :title="
          paused
            ? 'Resume starts in all profiles. Queued events can run and schedules follow their missed-run policy.'
            : 'Pause new starts in all profiles. Active runs continue and pending events remain queued.'
        "
        @click="togglePause"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path v-if="paused" d="M4 2.5v11L13 8Z" />
          <path v-else d="M3 2h3v12H3zm7 0h3v12h-3z" />
        </svg>
        {{ paused ? "Resume all" : "Pause all" }}
      </button>
    </header>
    <p v-if="!rows.length" class="notification-center__empty">
      No automations in this profile. Create one from a workspace’s menu.
    </p>
    <template v-else>
      <div class="automations-panel__filters">
        <input
          v-model="search"
          type="search"
          placeholder="Search automations or projects…"
          aria-label="Search automations"
          title="Search automation names and parent project names in this profile."
        />
        <select
          v-model="triggerFilter"
          aria-label="Filter automations by trigger"
          title="Show scheduled automations, event automations or both in this profile."
        >
          <option value="all">All triggers</option>
          <option value="schedule">Scheduled</option>
          <option value="event">Events</option>
        </select>
        <select
          v-model="statusFilter"
          aria-label="Filter automations by state"
          title="Filter current automation state. Last run failed includes failed, timed-out and interrupted runs."
        >
          <option value="all">All states</option>
          <option value="running">Running</option>
          <option value="awaiting-user">Needs attention</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="failed">Last run failed</option>
        </select>
      </div>
      <p class="automations-panel__count" aria-live="polite">
        {{ filteredRows.length }} of {{ rows.length }} in this profile
      </p>
      <div v-if="!filteredRows.length" class="automations-panel__no-results">
        <p>No automations match these filters.</p>
        <button
          type="button"
          class="automations-panel__pause"
          title="Reset search and filters to show all automations in this profile."
          @click="clearFilters"
        >
          Clear filters
        </button>
      </div>
      <div class="automations-panel__list">
        <button
          v-for="row in filteredRows"
          :key="row.workspace.id"
          type="button"
          class="automation-overview"
          :data-workspace-id="row.workspace.id"
          :title="`Open ${row.workspace.name} automation dashboard`"
          @click="$emit('open', row.workspace.id)"
        >
          <span class="automation-overview__heading">
            <strong><AutomationIcon class="automation-overview__icon" /> {{ row.workspace.name }}</strong>
            <AutomationStatusBadge class="automation-overview__state" :state="row.state">{{
              stateLabel(row.state)
            }}</AutomationStatusBadge>
          </span>
          <span v-if="row.parentName" class="automation-overview__muted">{{ row.parentName }}</span>
          <span class="automation-overview__types">
            <span>{{ row.workspace.automation?.trigger.type === "event" ? "Event" : "Schedule" }}</span>
            <span>{{ row.workspace.automation?.executor?.type === "task" ? "Worker + Judge" : "Agent" }}</span>
          </span>
          <span class="automation-overview__trigger">{{ row.trigger }}</span>
          <span v-if="row.nextRunAt" class="automation-overview__muted">Next: <NextRunTime :at="row.nextRunAt" /></span>
          <span
            v-if="row.lastRun"
            class="automation-overview__muted"
            :class="{ 'automation-overview__failure': row.lastRunFailed }"
          >
            Last: {{ stateLabel(row.lastRun.state) }} ·
            {{ formatTime(row.lastRun.finishedAt || row.lastRun.startedAt) }}
          </span>
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import NextRunTime from "../common/NextRunTime.vue";
import HelpTooltip from "../common/HelpTooltip.vue";
import cronstrue from "cronstrue";
import AutomationIcon from "../common/AutomationIcon.vue";
import AutomationStatusBadge from "../common/AutomationStatusBadge.vue";
import { computed, inject, ref, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import type { WorkspaceState } from "../../../electron/shared/types/state.js";
import type { AutomationState } from "../../../electron/shared/automation.js";

interface Summary {
  state?: string;
  nextRunAt?: string | null;
  currentRun?: { state: string } | null;
  lastRun?: { state: string; startedAt: string; finishedAt?: string } | null;
}

defineEmits<{ open: [workspaceId: string] }>();
const app = useAppStore();
const notifications = useNotificationStore();
const api = inject<Transport>(apiKey) ?? app.getApi();
const canPause = computed(() => !!api?.setAutomationsPaused);
const paused = computed(() => app.payload?.automations?.paused === true);
const busy = ref(false);
const search = ref("");
const triggerFilter = ref("all");
const statusFilter = ref("all");
function clearFilters(): void {
  search.value = "";
  triggerFilter.value = "all";
  statusFilter.value = "all";
}
watch(() => app.myActiveProfileId, clearFilters);
const rows = computed(() => {
  if (app.isRemoteTransport && !app.myActiveProfileId) return [];
  const profileId = app.myActiveProfileId ?? app.activeProfile.id;
  const workspaces = (app.payload?.appState?.workspaces || []).filter(
    (workspace) => (workspace.profileId || "default") === profileId,
  ) as WorkspaceState[];
  return workspaces
    .filter((workspace) => workspace.kind === "automation" && workspace.automation)
    .map((workspace) => {
      const definition = workspace.automation!;
      const summary = app.payload?.automations?.byWorkspaceId[workspace.id] as Summary | undefined;
      const currentState = summary?.currentRun?.state || summary?.state;
      const state =
        currentState && ["starting", "running", "awaiting-user"].includes(currentState)
          ? currentState
          : !definition.enabled
            ? "disabled"
            : paused.value
              ? "paused"
              : currentState || "idle";
      return {
        workspace,
        state,
        parentName: workspaces.find((parent) => parent.id === definition.parentWorkspaceId)?.name,
        trigger: triggerLabel(definition.trigger),
        nextRunAt: definition.enabled && !paused.value ? summary?.nextRunAt : null,
        lastRun: summary?.lastRun,
        lastRunFailed: !!summary?.lastRun && ["failed", "timed-out", "interrupted"].includes(summary.lastRun.state),
      };
    });
});

const filteredRows = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return rows.value.filter((row) => {
    const definition = row.workspace.automation!;
    if (query && !`${row.workspace.name} ${row.parentName || ""}`.toLocaleLowerCase().includes(query)) return false;
    if (triggerFilter.value !== "all" && definition.trigger.type !== triggerFilter.value) return false;
    if (statusFilter.value === "running") return ["starting", "running"].includes(row.state);
    if (statusFilter.value === "enabled") return definition.enabled;
    if (statusFilter.value === "disabled") return !definition.enabled;
    if (statusFilter.value === "failed") return row.lastRunFailed;
    return statusFilter.value === "all" || row.state === statusFilter.value;
  });
});
const stateLabels = new Map([
  ["idle", "Idle"],
  ["starting", "Starting"],
  ["running", "Running"],
  ["awaiting-user", "Needs attention"],
  ["paused", "Paused"],
  ["disabled", "Disabled"],
  ["succeeded", "Succeeded"],
  ["failed", "Failed"],
  ["skipped", "Skipped"],
  ["stopped", "Stopped"],
  ["interrupted", "Interrupted"],
  ["timed-out", "Timed out"],
]);
function stateLabel(state: string): string {
  return stateLabels.get(state) || state;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function triggerLabel(trigger: AutomationState["trigger"]): string {
  if (trigger.type === "event") return `${trigger.source} · ${trigger.kinds.join(", ")}`;
  if (trigger.kind === "once") return `Once · ${formatTime(trigger.at)}`;
  if (trigger.kind === "interval") return `Every ${trigger.everyMinutes} minutes`;
  try {
    return `${cronstrue.toString(trigger.expression)}${trigger.timezone ? ` (${trigger.timezone})` : ""}`;
  } catch {
    return trigger.expression;
  }
}

async function togglePause(): Promise<void> {
  if (!api?.setAutomationsPaused || busy.value) return;
  busy.value = true;
  try {
    await notifications.runWithToast("Could not change automation pause", async () => {
      const payload = await api.setAutomationsPaused!({ paused: !paused.value });
      if (payload && typeof payload === "object" && "appState" in payload) app.handleBroadcastPayload(payload as never);
    });
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.automations-panel {
  padding: 12px;
}
.automations-panel__toolbar,
.automation-overview__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.automations-panel__summary {
  display: grid;
  gap: 4px;
}
.automations-panel__status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 12px;
}
.automations-panel__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success, #5eaf74);
}
.automations-panel__status--paused .automations-panel__dot {
  background: var(--accent);
}
.automations-panel__hint,
.automations-panel__count,
.automation-overview__muted {
  color: var(--muted);
  font-size: 11px;
}
.automations-panel__pause {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.04);
  color: var(--text);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.automations-panel__pause:hover {
  background: rgba(var(--tint), 0.08);
}
.automations-panel__pause:disabled {
  opacity: 0.5;
  cursor: default;
}
.automations-panel__count {
  margin: 10px 0 8px;
}
.automations-panel__filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-top: 16px;
}
.automations-panel__filters input {
  grid-column: 1 / -1;
}
.automations-panel__filters input,
.automations-panel__filters select {
  min-width: 0;
  padding: 5px 7px;
  font: inherit;
  font-size: 11px;
}
.automations-panel__no-results {
  display: grid;
  justify-items: start;
  gap: 8px;
  padding: 16px 0;
  color: var(--muted);
  font-size: 12px;
}
.automation-overview__types {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.automation-overview__failure {
  color: var(--danger);
}
.automation-overview__types > span {
  padding: 2px 5px;
  border-radius: 3px;
  background: rgba(var(--tint), 0.05);
  color: var(--muted);
  font-size: 10px;
}
.automations-panel__list {
  display: grid;
  gap: 6px;
}
.automation-overview {
  display: grid;
  gap: 5px;
  width: 100%;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--base-fill);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.automation-overview:hover {
  border-color: var(--accent);
}
.automation-overview__heading strong {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.automation-overview__icon {
  flex: none;
  width: 14px;
  height: 14px;
}
.automation-overview__state {
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 10px;
}
</style>
