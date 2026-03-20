<template>
  <section data-role="workspace-hero">
    <div v-if="isRemote && store.remoteConnectionIssue" class="workspace-remote-alert">
      <strong>Remote connection issue.</strong> {{ store.remoteConnectionIssue }}
    </div>

    <template v-if="!workspace">
      <p class="workspace-empty-copy">Select or create a workspace to open it.</p>
    </template>

    <template v-else-if="activeWorkspace?.kind === 'azure'">
      <div class="workspace-meta" :style="`--accent:${safeColor(activeWorkspace.color)}`">
        <div class="workspace-meta__main">
          <span class="workspace-meta__path" :title="activeWorkspace.cwd || ''">{{ activeWorkspace.cwd || 'Azure DevOps inbox' }}</span>
        </div>
        <div class="workspace-meta__stats">
          <span class="workspace-chip"><strong>Azure</strong> inbox</span>
          <span class="workspace-chip"><strong>{{ reviewTabCount }}</strong> review tabs</span>
          <span
            v-if="attention?.count"
            class="workspace-chip workspace-chip--alert"
            :class="{ 'workspace-chip--alert-fresh': isFreshAttention(attention) }"
            :title="attentionTitle(attention)"
          >
            <strong>{{ attention.count }}</strong> attention
          </span>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="workspace-meta" :style="`--accent:${safeColor(activeWorkspace.color)}`">
        <div class="workspace-meta__main">
          <span class="workspace-meta__path" :title="activeWorkspace.cwd || ''">{{ activeWorkspace.cwd || 'Not set' }}</span>
        </div>
        <div class="workspace-meta__stats">
          <span class="workspace-chip"><strong>{{ sessionCount }}</strong> tabs</span>
          <span class="workspace-chip"><strong>{{ runningCount }}</strong> running</span>
          <span
            v-if="gitSnapshot?.available"
            class="workspace-chip"
            :style="gitSnapshot.dirty ? 'border-color:rgba(255,111,141,0.4)' : 'border-color:rgba(110,223,182,0.4)'"
          >
            <strong :style="gitSnapshot.dirty ? 'color:#ff6f8d' : 'color:#6edfb6'">{{ gitSnapshot.branch }}</strong>
            <span v-if="gitSnapshot.dirty" style="color:#ff6f8d;margin-left:4px;">{{ gitSnapshot.dirtyCount }} uncommitted</span>
            <span v-else style="color:#6edfb6;margin-left:4px;">clean</span>
          </span>
          <span
            v-if="activeWorkspace.kind === 'docker' && dockerAvailable"
            class="workspace-chip"
          ><strong>{{ dockerRunning }}</strong>/{{ dockerTotal }} containers up</span>
          <span
            v-if="attention?.count"
            class="workspace-chip workspace-chip--alert"
            :class="{ 'workspace-chip--alert-fresh': isFreshAttention(attention) }"
            :title="attentionTitle(attention)"
          >
            <strong>{{ attention.count }}</strong> attention
          </span>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, inject } from "vue";
import { useAppStore } from "../../stores/app.js";
import { safeColor, attentionTitle, isFreshAttention, isContainerRunning } from "../../app/helpers.js";

const api = inject("api");
const store = useAppStore();

const isRemote = computed(() => api?.isRemote || false);
const workspace = computed(() => store.payload?.workspace || null);
const activeWorkspace = computed(() => store.activeWorkspace);
const gitSnapshot = computed(() => activeWorkspace.value ? store.getGitSnapshot(activeWorkspace.value.id) : null);
const attention = computed(() => activeWorkspace.value ? store.getWorkspaceAttentionForId(activeWorkspace.value.id) : null);
const reviewTabCount = computed(() => activeWorkspace.value?.panels?.length || 0);
const sessionCount = computed(() => workspace.value?.sessions?.length || 0);
const runningCount = computed(() => (workspace.value?.sessions || []).filter((s) => s.status === "running").length);
const dockerState = computed(() => activeWorkspace.value?.kind === "docker" ? (store.payload?.docker || {}) : {});
const dockerAvailable = computed(() => dockerState.value?.available);
const dockerRunning = computed(() => (dockerState.value?.containers || []).filter(isContainerRunning).length);
const dockerTotal = computed(() => (dockerState.value?.containers || []).length);
</script>
