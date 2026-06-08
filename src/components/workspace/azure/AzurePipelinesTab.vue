<template>
  <div class="azure-pipelines">
    <div class="azure-pipelines__toolbar">
      <input
        v-model="filter"
        class="azure-pipelines__filter"
        type="search"
        placeholder="Filter pipelines…"
        title="Filter the list by pipeline name."
      />
      <select
        v-if="allProjects.length > 1"
        v-model="projectFilter"
        class="azure-pipelines__select"
        title="Show only one project."
      >
        <option value="">All projects</option>
        <option v-for="name in allProjects" :key="name" :value="name">{{ name }}</option>
      </select>
      <select
        v-model="timeFilter"
        class="azure-pipelines__select"
        title="Show only pipelines whose last run is recent."
      >
        <option value="all">Any time</option>
        <option value="1">Last 24h</option>
        <option value="7">Last 7 days</option>
        <option value="30">Last 30 days</option>
      </select>
      <span class="azure-pipelines__spacer"></span>
      <button
        type="button"
        class="button button--ghost button--xs"
        :disabled="anyLoading"
        title="Re-fetch pipelines for all connections."
        @click="refreshAll"
      >
        {{ anyLoading ? "Refreshing…" : "↻ Refresh" }}
      </button>
    </div>

    <div v-for="conn in connections" :key="conn.id" class="azure-pipelines__conn">
      <div class="azure-pipelines__conn-head">{{ conn.label || conn.id }}</div>

      <div v-if="stateOf(conn.id).loading && !stateOf(conn.id).pipelines.length" class="azure-pipelines__msg">
        Loading pipelines…
      </div>
      <div v-else-if="stateOf(conn.id).error" class="azure-pipelines__error">
        {{ stateOf(conn.id).error }}
      </div>
      <div v-else-if="!stateOf(conn.id).pipelines.length" class="azure-pipelines__msg">No pipelines found.</div>

      <template v-else>
        <div v-if="!projectsOf(conn.id).length" class="azure-pipelines__msg">
          No pipelines match the current filters.
        </div>
        <div v-for="group in projectsOf(conn.id)" :key="group.name" class="azure-pipelines__project">
          <div class="azure-pipelines__project-head">{{ group.name }}</div>
          <AzurePipelineRow
            v-for="pipeline in group.pipelines"
            :key="pipeline.id"
            :pipeline="pipeline"
            :downloading-run-id="downloadingRunId"
            @rerun="onRerun"
            @cancel="onCancel"
            @download-log="onDownloadLog"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import AzurePipelineRow from "./AzurePipelineRow.vue";
import { useAppStore } from "../../../stores/app.js";
import { useAzurePipelinesStore } from "../../../stores/azure-pipelines.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import type { AzurePipelineSummary } from "../../../../electron/shared/types/azure-pipelines.js";

const props = defineProps<{ connections: Array<{ id: string; label?: string }>; workspaceId?: string }>();

const appStore = useAppStore();
const store = useAzurePipelinesStore();
const notify = useNotificationStore();
const filter = ref("");
const projectFilter = ref("");
const timeFilter = ref("all");

/** Distinct project names across all connections, for the project dropdown. */
const allProjects = computed(() => {
  const names = new Set<string>();
  for (const conn of props.connections) {
    for (const pipeline of stateOf(conn.id).pipelines) {
      names.add(pipeline.project?.name || "(no project)");
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
});

/** Last-run timestamp of a pipeline, for the time-window filter. */
function lastRunTimeMs(pipeline: AzurePipelineSummary): number {
  const r = pipeline.lastRun;
  const stamp = r?.finishTime || r?.startTime || r?.queueTime;
  const ms = stamp ? new Date(stamp).getTime() : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

const workspaceName = computed(
  () => appStore.payload?.appState?.workspaces?.find((w) => w.id === props.workspaceId)?.name || "Azure DevOps",
);
const profileId = computed(() => appStore.myActiveProfileId || "default");

function connectionLabel(connectionId: string): string {
  return props.connections.find((c) => c.id === connectionId)?.label || connectionId;
}

function stateOf(connectionId: string) {
  return store.byConnection[connectionId] || { loading: false, error: "", pipelines: [], loaded: false };
}

const anyLoading = computed(() => props.connections.some((c) => stateOf(c.id).loading));

function projectsOf(connectionId: string): Array<{ name: string; pipelines: AzurePipelineSummary[] }> {
  const needle = filter.value.trim().toLowerCase();
  const maxAgeMs = timeFilter.value === "all" ? 0 : Number(timeFilter.value) * 86_400_000;
  const cutoff = maxAgeMs ? Date.now() - maxAgeMs : 0;
  const groups = new Map<string, AzurePipelineSummary[]>();
  for (const pipeline of stateOf(connectionId).pipelines) {
    const name = pipeline.project?.name || "(no project)";
    if (needle && !pipeline.name.toLowerCase().includes(needle)) continue;
    if (projectFilter.value && name !== projectFilter.value) continue;
    if (cutoff && lastRunTimeMs(pipeline) < cutoff) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(pipeline);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, pipelines]) => ({ name, pipelines }));
}

function loadAll(force = false) {
  for (const conn of props.connections) {
    void store.load(conn.id, { force });
  }
}

function refreshAll() {
  loadAll(true);
}

watch(
  () => props.connections.map((c) => c.id).join(","),
  () => loadAll(false),
  { immediate: false },
);

onMounted(() => loadAll(false));

function onRerun({ pipeline, run }: { pipeline: AzurePipelineSummary; run: { id: number | string } }) {
  appStore.openDialog("AzurePipelineRunDialog", {
    connectionId: pipeline.connectionId,
    projectName: pipeline.project.name,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    runId: run.id,
    onCancel: () => appStore.closeDialog(),
    onSubmitted: (newRun: { id?: number; webUrl?: string }) => {
      appStore.closeDialog();
      void store.loadRuns(pipeline.connectionId, pipeline.project.name, pipeline.id, { force: true });
      void store.load(pipeline.connectionId, { force: true });
      notify.pushEphemeralToast({
        title: "Pipeline run queued",
        body: `${pipeline.name} — run #${newRun?.id ?? "?"} started. You'll be notified when it finishes.`,
        kind: "success",
        durationMs: 5000,
      });
      // Watch the run so the user gets a notification when it completes.
      if (newRun?.id != null) {
        store.watchRun({
          connectionId: pipeline.connectionId,
          projectName: pipeline.project.name,
          pipelineId: pipeline.id,
          runId: newRun.id,
          pipelineName: pipeline.name,
          connectionLabel: connectionLabel(pipeline.connectionId),
          workspaceId: props.workspaceId || "",
          workspaceName: workspaceName.value,
          profileId: profileId.value,
        });
      }
    },
  });
}

async function onCancel({ pipeline, run }: { pipeline: AzurePipelineSummary; run: { id: number | string } }) {
  try {
    await store.cancel(pipeline.connectionId, pipeline.project.name, run.id);
    notify.pushEphemeralToast({
      title: "Cancel requested",
      body: `${pipeline.name} — run #${run.id}`,
      kind: "info",
      durationMs: 4000,
    });
  } catch (err) {
    notify.pushPersistentToast({
      title: "Couldn't cancel run",
      body: (err as Error)?.message || "Unknown error",
      kind: "error",
      profileId: profileId.value,
    });
  }
}

const downloadingRunId = ref<number | string | null>(null);

async function onDownloadLog({ pipeline, run }: { pipeline: AzurePipelineSummary; run: { id: number | string } }) {
  if (downloadingRunId.value != null) return;
  downloadingRunId.value = run.id;
  const toastId = notify.pushEphemeralToast({
    title: "Preparing log…",
    body: `${pipeline.name} — run #${run.id}`,
    kind: "info",
    durationMs: 0,
  });
  try {
    const text = await store.getBuildLog(pipeline.connectionId, pipeline.project.name, run.id);
    const slug = pipeline.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "pipeline";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}-run-${run.id}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    notify.pushPersistentToast({
      title: "Couldn't download log",
      body: (err as Error)?.message || "Unknown error",
      kind: "error",
      profileId: profileId.value,
    });
  } finally {
    notify.dismissPersistentToast(toastId);
    downloadingRunId.value = null;
  }
}
</script>

<style scoped>
.azure-pipelines {
  padding: 4px 0;
}
.azure-pipelines__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.azure-pipelines__filter {
  flex: 0 1 240px;
  font-size: 12px;
  padding: 3px 8px;
}
.azure-pipelines__select {
  font-size: 12px;
  padding: 3px 6px;
}
.azure-pipelines__spacer {
  flex: 1;
}
.azure-pipelines__conn {
  margin-bottom: 14px;
}
.azure-pipelines__conn-head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
  margin-bottom: 6px;
}
.azure-pipelines__project {
  margin-bottom: 10px;
}
.azure-pipelines__project-head {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
  opacity: 0.85;
}
.azure-pipelines__msg {
  font-size: 12px;
  color: var(--text-muted, #888);
  padding: 4px 0;
}
.azure-pipelines__error {
  font-size: 12px;
  color: var(--danger, #e53935);
  white-space: pre-wrap;
  padding: 4px 0;
}
.button--xs {
  font-size: 10px;
  padding: 1px 8px;
}
</style>
