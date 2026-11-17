<template>
  <section class="automation-dashboard" data-testid="automation-dashboard">
    <div class="automation-dashboard__content">
      <header class="dashboard-header">
        <div class="dashboard-header__identity">
          <p class="eyebrow">
            Automation
            <HelpTooltip
              label="Automation controls help"
              :text="
                runNowHelp +
                ' Stop ends the current run; Disable prevents future starts. Global pause blocks new starts in all profiles while active runs continue.'
              "
            />
          </p>
          <div class="dashboard-title">
            <h2>{{ workspace?.name || "Automation" }}</h2>
            <AutomationStatusBadge class="status-badge" :state="statusLabel" dot />
          </div>
          <p v-if="parent" class="dashboard-parent">{{ parent.name }}</p>
        </div>
        <div class="controls">
          <button
            v-if="agentPanel || latestAgentRun?.taskWorkspaceId || latestAgentRun?.reviewWorkspaceId"
            class="button button--ghost"
            type="button"
            :disabled="busy"
            title="Open the current or most recent agent to answer a prompt or inspect its terminal."
            @click="openTerminal()"
          >
            Open agent
          </button>
          <button
            class="button button--ghost"
            type="button"
            :disabled="busy || !parent"
            title="Edit the trigger, prompt, executor and limits for future runs."
            @click="edit"
          >
            Edit</button
          ><button
            class="button button--ghost"
            type="button"
            :disabled="busy || !definition"
            :title="
              definition?.enabled
                ? 'Prevent future starts for this automation. Use Stop to end its current run.'
                : 'Allow this automation to start again and reset its consecutive failure count.'
            "
            @click="toggle"
          >
            {{ definition?.enabled ? "Disable" : "Enable" }}</button
          ><button
            v-if="currentRun"
            class="button button--ghost"
            type="button"
            :disabled="busy"
            title="Stop this run. The automation stays enabled for future triggers."
            @click="stop"
          >
            Stop</button
          ><button
            v-else
            class="button"
            type="button"
            :disabled="busy || !definition?.enabled || paused || definition?.location === 'pr-review'"
            :title="runNowHelp"
            @click="run"
          >
            Run now
          </button>
        </div>
      </header>
      <p v-if="error" class="dashboard-error" role="alert">{{ error }}</p>
      <p v-if="paused" class="hint">All automations are paused.</p>
      <p v-if="definition?.disabledReason" class="hint">Disabled: {{ disabledReason }}</p>
      <section
        v-if="currentRun?.state === 'awaiting-user' && !hasSandboxRequests"
        class="dashboard-section dashboard-section--attention"
        role="status"
      >
        <p class="attention-label">Action required</p>
        <h3>The agent is waiting for your answer</h3>
        <p class="hint">Open its terminal to confirm folder trust, sign in, or answer its question.</p>
        <button
          type="button"
          class="button"
          title="Open the agent terminal to answer its pending request."
          @click="openTerminal()"
        >
          Open agent
        </button>
      </section>
      <section v-if="hasSandboxRequests" class="pending dashboard-section dashboard-section--attention" role="status">
        <p class="attention-label">Action required · Network access</p>
        <h3>Network access requests</h3>
        <SandboxRequestList v-for="id in sandboxWorkspaceIds" :key="id" :workspace-id="id" fallback="" />
      </section>
      <dl class="details">
        <div>
          <dt>Trigger</dt>
          <dd>{{ triggerLabel }}</dd>
        </div>
        <div>
          <dt>Executor</dt>
          <dd>{{ executorLabel }}</dd>
        </div>
        <div>
          <dt>
            Next run
            <HelpTooltip
              label="Next run help"
              text="The next scheduled time, shown in your device's local time zone. Event automations wait for a matching event. The automation must be enabled, global pause off and strIDEterm running to start a run."
            />
          </dt>
          <dd>
            <template v-if="paused">Paused</template>
            <template v-else-if="!definition?.enabled">Disabled</template>
            <NextRunTime v-else-if="summary?.nextRunAt" :at="summary.nextRunAt" />
            <template v-else>—</template>
          </dd>
        </div>
        <div>
          <dt>
            Pending events
            <HelpTooltip
              label="Pending events help"
              text="The number of PRs or Jira issues waiting for a run. Events for the same subject can be grouped. Up to 20 subjects can wait; they remain queued during global pause."
            />
          </dt>
          <dd>{{ pendingEvents.length }}</dd>
        </div>
      </dl>
      <div v-if="currentRun" class="current dashboard-section">
        <div class="run-heading">
          <strong>Current run</strong><AutomationStatusBadge :state="currentRun.state" dot />
        </div>
        <p v-if="currentRun.state === 'running'">Open the agent terminal if it needs attention.</p>
        <button
          type="button"
          class="button button--ghost button--sm"
          title="Open the current agent to inspect progress or answer a prompt."
          @click="openTerminal()"
        >
          Open terminal
        </button>
      </div>
      <div v-if="pendingEvents.length" class="pending dashboard-section">
        <h3>Pending events</h3>
        <ul>
          <li v-for="item in pendingEvents" :key="item.subject">{{ item.subject }} · {{ item.eventCount }}</li>
        </ul>
      </div>
      <section class="dashboard-section">
        <h3>Prompt</h3>
        <p class="prompt" tabindex="0" aria-label="Automation prompt">{{ definition?.prompt }}</p>
      </section>
      <section class="dashboard-section">
        <div class="history-heading">
          <h3>
            Run history
            <HelpTooltip
              label="Run history help"
              text="Search and filters cover all 100 retained records, with 20 matches per page. Today and Yesterday use your device's local calendar. Delete finished removes all finished matches across every page; run files remain in the workspace."
            />
          </h3>
          <button
            type="button"
            class="button button--ghost button--sm"
            :disabled="loading"
            title="Reload saved run history and results."
            @click="loadRuns"
          >
            Refresh
          </button>
        </div>
        <div class="history-filters">
          <input
            v-model="historySearch"
            type="search"
            placeholder="Search history…"
            aria-label="Search run history"
            title="Search stored run states, dates, IDs, reasons and result excerpts."
          />
          <select
            v-model="historyState"
            aria-label="Filter run history by state"
            title="Show stored runs with the selected state."
          >
            <option value="">All states</option>
            <option v-for="state in historyStates" :key="state.value" :value="state.value">{{ state.label }}</option>
          </select>
        </div>
        <div class="history-periods" role="group" aria-label="Run history period">
          <button
            v-for="period in historyPeriods"
            :key="period.value"
            type="button"
            class="button button--ghost button--sm"
            :aria-pressed="historyPeriod === period.value"
            :title="
              period.value === 'all'
                ? 'Show runs from all stored dates.'
                : ['today', 'yesterday'].includes(period.value)
                  ? `Show runs started ${period.label.toLowerCase()}, using this device's local calendar.`
                  : `Show runs started within the ${period.label.toLowerCase()}.`
            "
            @click="historyPeriod = period.value"
          >
            {{ period.label }}
          </button>
        </div>
        <p class="history-retention">Up to 100 run records are kept.</p>
        <div v-if="runs.length" class="history-summary">
          <span>{{ filteredRuns.length }} matching · {{ runs.length }} stored</span>
          <button
            v-if="hasHistoryFilters"
            type="button"
            class="button button--ghost button--sm"
            title="Reset the history search, state and period filters."
            @click="clearHistoryFilters"
          >
            Clear filters
          </button>
          <button
            type="button"
            class="button button--ghost button--sm history-delete"
            :disabled="busy || historyConfirming || !deletableRuns.length"
            title="Delete all finished records matching these filters, across all pages. Run files remain; active runs are protected."
            @click="deleteRuns(deletableRuns)"
          >
            Delete finished ({{ deletableRuns.length }})
          </button>
        </div>
        <p v-if="loading" class="hint">Loading…</p>
        <div v-else-if="!filteredRuns.length" class="history-empty">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <p>{{ runs.length ? "No runs match these filters." : "No runs yet." }}</p>
          <span v-if="!runs.length">Run history and results will appear here.</span>
        </div>
        <ol v-else class="runs">
          <li
            v-for="entry in pagedRuns"
            :key="entry.runId"
            :class="{ 'run--expanded': selectedRun?.runId === entry.runId }"
          >
            <div class="run-heading">
              <AutomationStatusBadge class="run-state" :state="entry.state" />
              <span class="run-time">{{ format(entry.startedAt) }}</span>
            </div>
            <p v-if="runReason(entry)" class="run-reason">{{ runReason(entry) }}</p>
            <p v-if="entry.resultExcerpt">{{ entry.resultExcerpt }}</p>
            <div class="controls">
              <button
                v-if="entry.state === 'succeeded'"
                type="button"
                class="button button--ghost button--sm"
                :aria-expanded="selectedRun?.runId === entry.runId"
                :title="
                  selectedRun?.runId === entry.runId
                    ? 'Collapse the saved result and agent output.'
                    : 'Show this run’s saved summary and agent output.'
                "
                @click="showResult(entry)"
              >
                <svg
                  class="run-details-toggle__chevron"
                  :class="{ 'run-details-toggle__chevron--expanded': selectedRun?.runId === entry.runId }"
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  aria-hidden="true"
                >
                  <path d="m3 6 5 5 5-5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                {{ selectedRun?.runId === entry.runId ? "Hide result" : "Result" }}</button
              ><button
                v-else
                type="button"
                class="button button--ghost button--sm"
                :aria-expanded="selectedRun?.runId === entry.runId"
                :title="
                  selectedRun?.runId === entry.runId
                    ? 'Collapse run details.'
                    : 'Show the reason, exit code when available, and saved output for this run.'
                "
                @click="showResult(entry)"
              >
                <svg
                  class="run-details-toggle__chevron"
                  :class="{ 'run-details-toggle__chevron--expanded': selectedRun?.runId === entry.runId }"
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  aria-hidden="true"
                >
                  <path d="m3 6 5 5 5-5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                {{ selectedRun?.runId === entry.runId ? "Hide details" : "Details" }}</button
              ><button
                v-if="
                  entry.sessionId && entry.canOpenAgent !== false && entry.runId === latestAgentRun?.runId && agentPanel
                "
                type="button"
                class="button button--ghost button--sm"
                title="Open this automation's latest agent session. Earlier runs have saved output in Details."
                @click="openTerminal(entry)"
              >
                Open agent</button
              ><button
                v-if="entry.taskWorkspaceId || entry.reviewWorkspaceId"
                type="button"
                class="button button--ghost button--sm"
                title="Open the Worker + Judge task or PR review workspace associated with this run."
                @click="openRunWorkspace(entry)"
              >
                Open workspace
              </button>
              <button
                v-if="!activeRunStates.has(entry.state)"
                type="button"
                class="button button--ghost button--sm history-delete"
                :disabled="busy || historyConfirming"
                title="Delete this finished history record. Its run files remain in the workspace."
                @click="deleteRuns([entry])"
              >
                Delete
              </button>
            </div>
            <div v-if="selectedRun?.runId === entry.runId" class="result run-details">
              <div class="history-heading">
                <h3>
                  {{ entry.state === "succeeded" ? "Result" : "Run details" }}
                  <span class="run-time">· {{ format(entry.startedAt) }}</span>
                </h3>
                <button
                  type="button"
                  class="button button--ghost button--sm"
                  title="Collapse this run's details."
                  @click="closeResult"
                >
                  Close
                </button>
              </div>
              <p v-if="runReason(selectedRun!)" class="run-reason">{{ runReason(selectedRun!) }}</p>
              <p v-if="detailLoading" class="hint">Loading run details…</p>
              <template v-else>
                <pre v-if="result">{{ result }}</pre>
                <p v-else class="hint">No result was written.</p>
                <h4>Agent output</h4>
                <pre v-if="runOutput" class="run-output">{{ runOutput }}</pre>
                <p v-else class="hint">
                  No output was saved for this run. Open agent is available only for the latest agent session.
                </p>
              </template>
            </div>
          </li>
        </ol>
        <nav v-if="filteredRuns.length > historyPageSize" class="history-pagination" aria-label="Run history pages">
          <button
            type="button"
            class="button button--ghost button--sm"
            :disabled="historyPage === 0"
            title="Show the previous page of matching runs."
            @click="historyPage--"
          >
            Previous
          </button>
          <span>{{ historyPage + 1 }} / {{ historyPageCount }}</span>
          <button
            type="button"
            class="button button--ghost button--sm"
            :disabled="historyPage + 1 >= historyPageCount"
            title="Show the next page of matching runs."
            @click="historyPage++"
          >
            Next
          </button>
        </nav>
      </section>
    </div>
  </section>
</template>
<script setup lang="ts">
import cronstrue from "cronstrue";
import HelpTooltip from "../common/HelpTooltip.vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useAutomationsStore } from "../../stores/automations.js";
import { useSandboxRequestsStore } from "../../stores/sandbox-requests.js";
import SandboxRequestList from "../layout/SandboxRequestList.vue";
import AutomationStatusBadge from "../common/AutomationStatusBadge.vue";
import NextRunTime from "../common/NextRunTime.vue";
import { userFacingMessage } from "../../lib/error-message.js";
import { rlog } from "../../lib/renderer-log.js";
import type { AutomationState } from "../../../electron/shared/automation.js";

interface Run {
  canOpenAgent?: boolean;
  runId: string;
  state: string;
  startedAt: string;
  reason?: string;
  resultExcerpt?: string;
  taskWorkspaceId?: string;
  reviewWorkspaceId?: string;
  sessionId?: string;
  exitCode?: number;
}
interface Summary {
  state: string;
  nextRunAt?: string | null;
  currentRun?: Run | null;
  pending?: Array<{ subject: string; eventCount: number }> | number;
  lastRun?: Run | null;
}
const props = defineProps<{ workspaceId: string }>();
const app = useAppStore();
const automations = useAutomationsStore();
const sandboxRequests = useSandboxRequestsStore();
const sandboxWorkspaceIds = computed(() => {
  const children =
    app.payload?.appState?.workspaces
      .filter((item) => item.kind === "task" && item.task?.parentWorkspaceId === props.workspaceId)
      .map((item) => item.id) || [];
  const allowed = new Set([props.workspaceId, ...children]);
  return [
    ...new Set(
      sandboxRequests.records
        .filter(
          (record) => allowed.has(record.workspaceId) && ["pending", "expired", "refused"].includes(record.outcome),
        )
        .map((record) => record.workspaceId),
    ),
  ];
});
const hasSandboxRequests = computed(() => sandboxWorkspaceIds.value.length > 0);
const workspace = computed(() => app.payload?.appState?.workspaces.find((item) => item.id === props.workspaceId));
const definition = computed(() => workspace.value?.automation as AutomationState | undefined);
const parent = computed(() =>
  app.payload?.appState?.workspaces.find((item) => item.id === definition.value?.parentWorkspaceId),
);
const snapshot = computed(() => app.payload?.automations);
const summary = computed(() => snapshot.value?.byWorkspaceId[props.workspaceId] as Summary | undefined);
const currentRun = computed(() => summary.value?.currentRun);
const agentPanel = computed(() => workspace.value?.panels.find((item) => item.command !== "__automation-dashboard__"));
const latestAgentRun = computed(
  () =>
    currentRun.value ||
    runs.value.find((entry) => entry.sessionId || entry.taskWorkspaceId || entry.reviewWorkspaceId) ||
    summary.value?.lastRun,
);
const paused = computed(() => snapshot.value?.paused === true);
const runNowHelp = computed(() => {
  if (definition.value?.location === "pr-review")
    return "PR reviews start from integration events; Run now is unavailable.";
  if (!definition.value?.enabled) return "Enable this automation before starting a run.";
  if (paused.value) return "Resume automations from Notification Center or Settings before starting a run.";
  return "Run the saved prompt immediately with fresh agent context. No incoming event data is supplied.";
});
const disabledReason = computed(() => {
  const reasons: Record<string, string> = {
    user: "turned off by a user or agent",
    failures: "five consecutive failed or timed-out runs; check the history before enabling again",
    "once-fired": "the one-time schedule has been handled; choose a future date before enabling again",
    "parent-removed": "the parent workspace was removed",
    "profile-removed": "the profile was removed",
    "cwd-missing": "the workspace directory is missing",
    "invalid-definition": "the saved settings are invalid; edit the automation before enabling again",
  };
  return reasons[definition.value?.disabledReason || ""] || definition.value?.disabledReason;
});
const pendingEvents = computed(() => (Array.isArray(summary.value?.pending) ? summary.value.pending : []));
const statusLabel = computed(
  () =>
    currentRun.value?.state ||
    (!definition.value?.enabled ? "disabled" : paused.value ? "paused" : summary.value?.state || "idle"),
);
const triggerLabel = computed(() => {
  const trigger = definition.value?.trigger;
  if (!trigger) return "—";
  if (trigger.type === "event") return `${trigger.source}: ${trigger.kinds.join(", ")}`;
  if (trigger.kind === "once") return `Once: ${format(trigger.at)}`;
  if (trigger.kind === "interval") return `Every ${trigger.everyMinutes} minutes`;
  return `${cronstrue.toString(trigger.expression)}${trigger.timezone ? ` (${trigger.timezone})` : ""}`;
});
const executorLabel = computed(() => {
  const executor = definition.value?.executor;
  return !executor
    ? "—"
    : executor.type === "task"
      ? `Worker ${executor.worker.providerId} + Judge ${executor.judge.providerId}`
      : `${executor.agent.providerId}${executor.agent.model ? ` · ${executor.agent.model}` : ""}`;
});
const runs = ref<Run[]>([]);
const historySearch = ref("");
const historyState = ref("");
const historyPeriod = ref("all");
const historyPage = ref(0);
const historyConfirming = ref(false);
const historyPageSize = 20;
const historyNow = ref(Date.now());
const historyClock = setInterval(() => {
  historyNow.value = Date.now();
}, 60_000);
onBeforeUnmount(() => clearInterval(historyClock));
const activeRunStates = new Set(["starting", "running", "awaiting-user"]);
const historyStates = [
  { value: "running", label: "Running" },
  { value: "starting", label: "Starting" },
  { value: "awaiting-user", label: "Waiting for you" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "timed-out", label: "Timed out" },
  { value: "interrupted", label: "Interrupted" },
  { value: "stopped", label: "Stopped" },
  { value: "skipped", label: "Skipped" },
];
const historyPeriods = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 30 days" },
];
const filteredRuns = computed(() => {
  const today = new Date(historyNow.value);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const from =
    historyPeriod.value === "today"
      ? today.getTime()
      : historyPeriod.value === "yesterday"
        ? yesterday.getTime()
        : historyPeriod.value === "week"
          ? historyNow.value - 7 * 86400_000
          : historyPeriod.value === "month"
            ? historyNow.value - 30 * 86400_000
            : -Infinity;
  const until = historyPeriod.value === "yesterday" ? today.getTime() : Infinity;
  const query = historySearch.value.trim().toLocaleLowerCase();
  return runs.value.filter((run) => {
    const timestamp = new Date(run.startedAt).getTime();
    return (
      (!historyState.value || run.state === historyState.value) &&
      (historyPeriod.value === "all" || (timestamp >= from && timestamp < until)) &&
      (!query ||
        `${run.state} ${run.runId} ${run.resultExcerpt || ""} ${runReason(run)} ${format(run.startedAt)}`
          .toLocaleLowerCase()
          .includes(query))
    );
  });
});
const hasHistoryFilters = computed(() =>
  Boolean(historySearch.value.trim() || historyState.value || historyPeriod.value !== "all"),
);
const deletableRuns = computed(() => filteredRuns.value.filter((run) => !activeRunStates.has(run.state)));
const historyPageCount = computed(() => Math.max(1, Math.ceil(filteredRuns.value.length / historyPageSize)));
const pagedRuns = computed(() =>
  filteredRuns.value.slice(historyPage.value * historyPageSize, (historyPage.value + 1) * historyPageSize),
);
watch([historySearch, historyState, historyPeriod], () => {
  historyPage.value = 0;
  closeResult();
});
watch(historyPageCount, (count) => {
  historyPage.value = Math.min(historyPage.value, count - 1);
});
function clearHistoryFilters(): void {
  historySearch.value = "";
  historyState.value = "";
  historyPeriod.value = "all";
}
async function deleteRuns(entries: Run[]): Promise<void> {
  const workspaceId = props.workspaceId;
  const runIds = entries.filter((run) => !activeRunStates.has(run.state)).map((run) => run.runId);
  if (!runIds.length || historyConfirming.value) return;
  historyConfirming.value = true;
  try {
    const confirmed = await app.confirmInApp({
      title: `Delete ${runIds.length === 1 ? "run record" : `${runIds.length} run records`}?`,
      message:
        "This removes the selected finished runs from history. Result files in the workspace remain. Active runs are kept. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed || props.workspaceId !== workspaceId) return;
    await action(async () => {
      const api = app.getApi();
      if (!api.deleteAutomationRuns) throw new Error("Deleting run history is unavailable.");
      await api.deleteAutomationRuns({ workspaceId, runIds });
      if (selectedRun.value && runIds.includes(selectedRun.value.runId)) closeResult();
    });
  } finally {
    historyConfirming.value = false;
  }
}
const busy = ref(false);
const loading = ref(false);
const error = ref("");
const result = ref<string | null>(null);
const selectedRun = ref<Run | null>(null);
const runOutput = ref<string | null>(null);
const detailLoading = ref(false);
let historyRequest = 0;
let resultRequest = 0;
const format = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};
async function loadRuns() {
  const request = ++historyRequest;
  const workspaceId = props.workspaceId;
  const api = app.getApi();
  if (!api.listAutomationRuns) return;
  loading.value = true;
  try {
    const data = (await api.listAutomationRuns({ workspaceId, limit: 100 })) as { runs: Run[] };
    if (request === historyRequest && workspaceId === props.workspaceId) runs.value = data.runs || [];
  } catch (cause) {
    if (request === historyRequest && workspaceId === props.workspaceId) error.value = userFacingMessage(cause);
  } finally {
    if (request === historyRequest && workspaceId === props.workspaceId) loading.value = false;
  }
}
watch(
  () => props.workspaceId,
  () => {
    runs.value = [];
    result.value = null;
    selectedRun.value = null;
    runOutput.value = null;
    detailLoading.value = false;
    error.value = "";
    clearHistoryFilters();
    historyPage.value = 0;
    resultRequest++;
  },
);
watch(
  () => [
    props.workspaceId,
    summary.value?.lastRun?.runId,
    summary.value?.lastRun?.state,
    summary.value?.currentRun?.runId,
    summary.value?.currentRun?.state,
  ],
  () => {
    void loadRuns();
  },
  { immediate: true },
);
async function action(fn: () => Promise<unknown>, refresh = true) {
  busy.value = true;
  error.value = "";
  try {
    const payload = await fn();
    if (payload && typeof payload === "object" && "appState" in payload) app.handleBroadcastPayload(payload as never);
    if (refresh) await loadRuns();
  } catch (cause) {
    error.value = userFacingMessage(cause, "Action failed.");
    rlog("error", "Automation action failed", { workspaceId: props.workspaceId, error: error.value });
  } finally {
    busy.value = false;
  }
}
function edit() {
  if (parent.value && workspace.value) automations.openEditor(parent.value, workspace.value);
}
function toggle() {
  if (!definition.value) return;
  void action(() => automations.setEnabled(props.workspaceId, definition.value!.updatedAt, !definition.value!.enabled));
}
function run() {
  void action(async () => {
    const { completion } = await automations.runNow(props.workspaceId);
    void completion.then(() => loadRuns()).catch(() => {});
  });
}
function stop() {
  if (currentRun.value) void action(() => automations.stopRun(props.workspaceId, currentRun.value!.runId));
}
async function openTerminal(entry: Run | null | undefined = latestAgentRun.value) {
  if (entry?.reviewWorkspaceId || entry?.taskWorkspaceId) {
    const id = entry.reviewWorkspaceId || entry.taskWorkspaceId!;
    await action(() => app.activateWorkspace(id), false);
    return;
  }
  const panel = agentPanel.value;
  if (panel) await action(() => app.activateView(`${props.workspaceId}:${panel.id}`), false);
}
async function openRunWorkspace(entry: Run) {
  const id = entry.taskWorkspaceId || entry.reviewWorkspaceId;
  if (id) await action(() => app.activateWorkspace(id), false);
}
function runReason(entry: Run): string {
  if (entry.reason === "terminal-exit")
    return `The agent exited${entry.exitCode !== undefined ? ` with code ${entry.exitCode}` : ""} before reporting completion.`;
  if (entry.reason === "task-failed")
    return "The Worker + Judge task failed. Open its workspace to inspect the agents.";
  if (entry.reason === "missed") return "This scheduled run was missed while the application was unavailable.";
  if (entry.reason === "overlap") return "Skipped because another run was already active.";
  if (entry.reason) return entry.reason;
  if (entry.state === "timed-out") return "The run exceeded its maximum run time.";
  if (entry.state === "interrupted") return "The application stopped before this run completed.";
  return "";
}
function closeResult(): void {
  resultRequest++;
  selectedRun.value = null;
  result.value = null;
  runOutput.value = null;
  detailLoading.value = false;
}
async function showResult(entry: Run) {
  if (selectedRun.value?.runId === entry.runId) {
    closeResult();
    return;
  }
  const request = ++resultRequest;
  const workspaceId = props.workspaceId;
  const api = app.getApi();
  if (!api.getAutomationRunResult) return;
  selectedRun.value = entry;
  result.value = null;
  runOutput.value = null;
  detailLoading.value = true;
  try {
    const value = (await api.getAutomationRunResult({ workspaceId, runId: entry.runId })) as {
      result: string | null;
      output?: string | null;
      exitCode?: number | null;
    };
    if (request === resultRequest && workspaceId === props.workspaceId) {
      result.value = value.result || "";
      runOutput.value = value.output || null;
      selectedRun.value = { ...entry, ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}) };
    }
  } catch (cause) {
    if (request === resultRequest && workspaceId === props.workspaceId) error.value = userFacingMessage(cause);
  } finally {
    if (request === resultRequest && workspaceId === props.workspaceId) detailLoading.value = false;
  }
}
</script>
<style scoped>
.automation-dashboard {
  height: 100%;
  overflow: auto;
  min-width: 0;
  container-type: inline-size;
  container-name: automation-dashboard;
}
.automation-dashboard__content {
  display: grid;
  gap: 20px;
  max-width: 1120px;
  margin: 0 auto;
  padding: 24px;
}
.dashboard-header,
.history-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.history-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(130px, auto);
  gap: 8px;
  margin-top: 14px;
}
.history-filters input,
.history-filters select {
  min-width: 0;
  width: 100%;
  height: 32px;
  padding: 5px 8px;
  font-size: 12px;
}
.history-periods,
.history-summary,
.history-pagination {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.runs .history-retention,
.history-retention {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 11px;
}
.history-periods .button,
.history-summary .button {
  padding: 5px 8px;
  font-size: 11px;
}
.history-periods [aria-pressed="true"] {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 9%, transparent);
}
.history-summary,
.history-pagination {
  color: var(--muted);
  font-size: 11px;
}
.history-summary > span {
  flex: 1 1 auto;
}
.history-pagination {
  justify-content: flex-end;
}
.history-delete {
  color: var(--danger);
}
.dashboard-header__identity {
  min-width: 0;
  flex: 1 1 240px;
}
.dashboard-header .eyebrow {
  margin: 0 0 6px;
  font-size: 10px;
}
.dashboard-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.dashboard-header h2,
.dashboard-section h3 {
  margin: 0;
}
.dashboard-section.dashboard-section--attention {
  border-color: var(--accent);
  border-left: 4px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-card));
}
.attention-label {
  margin: 0 0 8px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.dashboard-section--attention > .hint {
  margin: 8px 0 12px;
  font-size: 12px;
}
.dashboard-section--attention :deep(.sandbox-request) {
  background: transparent;
}
.dashboard-header h2 {
  font-size: 22px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.dashboard-parent {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.controls {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dashboard-header .button,
.history-heading .button,
.runs .button {
  padding: 6px 10px;
  font-size: 12px;
}
.details {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}
.details div {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-card);
}
dt,
.hint {
  color: var(--muted);
}
dt {
  font-size: 11px;
}
dd {
  margin: 8px 0 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dashboard-section {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-card);
}
.dashboard-section h3 {
  font-size: 13px;
  font-weight: 600;
}
.prompt {
  margin: 12px 0 0;
  max-height: min(220px, 35dvh);
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.history-heading {
  align-items: center;
}
.history-empty {
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 28px 12px;
  color: var(--muted);
  text-align: center;
  font-size: 12px;
}
.history-empty svg {
  opacity: 0.55;
}
.history-empty p {
  margin: 0;
  color: var(--text);
  font-weight: 500;
}
.history-empty span {
  font-size: 11px;
}
.runs {
  display: grid;
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 12px 0 0;
}
.runs li,
.current {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  overflow-wrap: anywhere;
}
.run-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.run-time {
  color: var(--muted);
  font-size: 11px;
}
.run-reason {
  margin: 8px 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.runs .run--expanded {
  border-color: var(--accent);
}
.run-details {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.runs button[aria-expanded] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.run-details-toggle__chevron {
  flex: none;
}
.run-details-toggle__chevron--expanded {
  transform: rotate(180deg);
}
.result h4 {
  margin: 16px 0 8px;
  font-size: 12px;
}
.result .hint {
  margin-top: 10px;
  font-size: 12px;
}
.result .run-output {
  max-height: 360px;
  overflow: auto;
}
.runs p {
  font-size: 12px;
  line-height: 1.5;
}
.pending ul {
  display: grid;
  gap: 6px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.current strong {
  font-size: 13px;
}
.current p {
  color: var(--muted);
  font-size: 12px;
}
.runs .controls:not(:empty) {
  margin-top: 10px;
}
.result pre {
  margin: 12px 0 0;
  padding: 12px;
  border-radius: 4px;
  background: var(--surface);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
}
.dashboard-error {
  color: var(--danger, #d33);
}
.automation-dashboard__content > .hint,
.dashboard-error {
  margin: 0;
}
@container automation-dashboard (max-width: 600px) {
  .history-filters {
    grid-template-columns: minmax(0, 1fr);
  }
  .automation-dashboard__content {
    padding: 12px;
    gap: 12px;
  }
  .details {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .details div,
  .dashboard-section {
    padding: 12px;
  }
  .dashboard-header > div,
  .dashboard-header .controls {
    width: 100%;
  }
  .dashboard-header button {
    flex: 1 1 auto;
  }
}
</style>
