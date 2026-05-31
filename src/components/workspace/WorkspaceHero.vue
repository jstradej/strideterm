<template>
  <section data-role="workspace-hero">
    <div v-if="isRemote && store.remoteConnectionIssue" class="workspace-remote-alert">
      <strong>Remote connection issue.</strong> {{ store.remoteConnectionIssue }}
    </div>

    <template v-if="!workspace">
      <p class="workspace-empty-copy">Select or create a workspace to open it.</p>
    </template>

    <template v-else-if="activeWorkspace?.kind === 'azure' || activeWorkspace?.kind === 'github'">
      <div class="workspace-meta" :style="`--accent:${safeColor(activeWorkspace.color)}`">
        <div class="workspace-meta__main">
          <span
            class="workspace-meta__path workspace-meta__path--copyable"
            :title="
              activeWorkspace.cwd ? 'Click to copy this workspace’s working-directory path to the clipboard.' : ''
            "
            @click="copyPath"
            >{{
              pathCopied
                ? "Copied!"
                : activeWorkspace.cwd || (activeWorkspace.kind === "github" ? "GitHub inbox" : "Azure DevOps inbox")
            }}</span
          >
        </div>
        <div class="workspace-meta__stats">
          <span class="workspace-chip"
            ><strong>{{ activeWorkspace.kind === "github" ? "GitHub" : "Azure" }}</strong> inbox</span
          >
          <span class="workspace-chip"
            ><strong>{{ reviewTabCount }}</strong> review tabs</span
          >
          <span
            v-if="attention?.count"
            class="workspace-chip workspace-chip--alert"
            :class="{ 'workspace-chip--alert-fresh': isFreshAttention(attention) }"
            :title="attentionTitle(attention)"
          >
            <strong>{{ attention.count }}</strong> attention
          </span>
          <WorkspaceLayoutChip />
        </div>
        <NotificationBell />
      </div>
    </template>

    <template v-else>
      <div class="workspace-meta" :style="`--accent:${safeColor(activeWorkspace.color)}`">
        <div class="workspace-meta__main">
          <span
            class="workspace-meta__path workspace-meta__path--copyable"
            :title="
              activeWorkspace.cwd ? 'Click to copy this workspace’s working-directory path to the clipboard.' : ''
            "
            @click="copyPath"
            >{{ pathCopied ? "Copied!" : activeWorkspace.cwd || "Not set" }}</span
          >
        </div>
        <div class="workspace-meta__stats">
          <span class="workspace-chip"
            ><strong>{{ sessionCount }}</strong> tabs</span
          >
          <span class="workspace-chip"
            ><strong>{{ runningCount }}</strong> running</span
          >
          <span
            v-if="gitSnapshot?.available"
            class="workspace-chip"
            :style="gitSnapshot.dirty ? 'border-color:rgba(255,111,141,0.4)' : 'border-color:rgba(110,223,182,0.4)'"
          >
            <strong :style="gitSnapshot.dirty ? 'color:#ff6f8d' : 'color:#6edfb6'">{{ gitSnapshot.branch }}</strong>
            <span v-if="gitSnapshot.dirty" style="color: #ff6f8d; margin-left: 4px"
              >{{ gitSnapshot.dirtyCount }} uncommitted</span
            >
            <span v-else style="color: #6edfb6; margin-left: 4px">clean</span>
          </span>
          <span v-if="activeWorkspace.kind === 'docker' && dockerAvailable" class="workspace-chip"
            ><strong>{{ dockerRunning }}</strong
            >/{{ dockerTotal }} containers up</span
          >
          <span
            v-if="attention?.count"
            class="workspace-chip workspace-chip--alert"
            :class="{ 'workspace-chip--alert-fresh': isFreshAttention(attention) }"
            :title="attentionTitle(attention)"
          >
            <strong>{{ attention.count }}</strong> attention
          </span>
          <WorkspaceLayoutChip />
        </div>
        <NotificationBell />
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import { safeColor, attentionTitle, isFreshAttention, isContainerRunning } from "../../app/helpers.js";
import WorkspaceLayoutChip from "./WorkspaceLayoutChip.vue";
import NotificationBell from "../layout/NotificationBell.vue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>("api");
const store = useAppStore();

const pathCopied = ref(false);
let pathCopiedTimer: ReturnType<typeof setTimeout> | null = null;
function copyPath() {
  const cwd = activeWorkspace.value?.cwd;
  if (!cwd) return;
  navigator.clipboard.writeText(cwd).then(() => {
    pathCopied.value = true;
    if (pathCopiedTimer != null) clearTimeout(pathCopiedTimer);
    pathCopiedTimer = setTimeout(() => {
      pathCopied.value = false;
    }, 1200);
  });
}

const isRemote = computed(() => api?.isRemote || false);
const workspace = computed<Record<string, any> | null>(() => (store.payload as any)?.workspace || null); // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
const activeWorkspace = computed(() => store.activeWorkspace);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: git snapshot is open-ended server JSON
const gitSnapshot = computed<Record<string, any> | null>(
  () => (activeWorkspace.value ? (store.getGitSnapshot(activeWorkspace.value.id) as Record<string, any> | null) : null), // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: attention blob is open-ended server JSON
const attention = computed<Record<string, any> | null>(() =>
  activeWorkspace.value
    ? (store.getWorkspaceAttentionForId(activeWorkspace.value.id) as Record<string, any> | null) // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
    : null,
);
const reviewTabCount = computed(() => activeWorkspace.value?.panels?.length || 0);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: sessions sub-array from server JSON
const sessionCount = computed(() => (workspace.value?.sessions as any[] | undefined)?.length || 0);
const runningCount = computed(
  () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: sessions sub-array from server JSON
    ((workspace.value?.sessions as any[] | undefined) || []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: session item from server JSON
      (s: any) => s.status === "running",
    ).length,
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: docker state is open-ended server JSON blob
const dockerState = computed<Record<string, any>>(
  () => (activeWorkspace.value?.kind === "docker" ? (store.payload as any)?.docker || {} : {}), // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
);
const dockerAvailable = computed(() => dockerState.value?.available);
const dockerRunning = computed(
  () => ((dockerState.value?.containers as any[]) || []).filter(isContainerRunning).length, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: docker containers array is open-ended server JSON
);
const dockerTotal = computed(() => ((dockerState.value?.containers as any[]) || []).length); // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: docker containers array is open-ended server JSON
</script>
