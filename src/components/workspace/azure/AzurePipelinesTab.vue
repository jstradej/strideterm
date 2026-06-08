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
        <div v-for="group in projectsOf(conn.id)" :key="group.name" class="azure-pipelines__project">
          <div class="azure-pipelines__project-head">{{ group.name }}</div>
          <AzurePipelineRow
            v-for="pipeline in group.pipelines"
            :key="pipeline.id"
            :pipeline="pipeline"
            @rerun="onRerun"
            @cancel="onCancel"
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
  const groups = new Map<string, AzurePipelineSummary[]>();
  for (const pipeline of stateOf(connectionId).pipelines) {
    if (needle && !pipeline.name.toLowerCase().includes(needle)) continue;
    const name = pipeline.project?.name || "(no project)";
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
