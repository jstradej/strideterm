<template>
  <div
    class="workspace-card"
    :class="{
      'workspace-card--active': workspace.active,
      'workspace-card--attention': workspace.attentionCount > 0,
      'workspace-card--attention-fresh': workspace.attentionFresh,
      'workspace-card--sub': workspace.depth > 0,
      'workspace-card--pr-completed': workspace.prStatus === 'completed',
      'workspace-card--pr-abandoned': workspace.prStatus === 'abandoned',
      'workspace-card--in-grid': workspace.inGrid,
    }"
    :style="`--accent:${workspace.color}${workspace.depth > 0 ? `;margin-left:${workspace.depth * 16}px` : ''}`"
    :title="workspace.title"
    draggable="true"
    @click="$emit('activate')"
    @dragstart="$emit('dragstart', $event)"
    @dragover.prevent="$emit('dragover', $event)"
    @drop="$emit('drop', $event)"
  >
    <span class="workspace-card__badge">
      <span class="workspace-card__index">{{ workspace.index }}</span
      >{{ workspace.icon }}
      <span
        v-if="statusDot"
        :class="['workspace-card__status-dot', `workspace-card__status-dot--${statusDot.state}`]"
        :title="statusDot.label"
      ></span>
      <span v-if="workspace.slotIndex" class="workspace-card__slot" :title="`Grid slot ${workspace.slotIndex}`">{{
        workspace.slotIndex
      }}</span>
    </span>
    <button
      type="button"
      draggable="false"
      class="workspace-card__star"
      :class="{ 'workspace-card__star--active': workspace.starred }"
      :title="
        workspace.starred
          ? 'Remove the star — this workspace will no longer be pinned to the top of the list and is no longer prioritised in the Telegram /task picker.'
          : 'Star this workspace — pins it to the top of the sidebar list and surfaces it first in the Telegram /task workspace picker.'
      "
      @mousedown.stop
      @click.stop="$emit('toggle-star')"
    >
      {{ workspace.starred ? "★" : "☆" }}
    </button>
    <span class="workspace-card__meta">
      <span class="workspace-card__title-row">
        <strong>{{ workspace.name }}</strong>
        <span
          v-if="workspace.checksState"
          :class="['workspace-card__checks-dot', `workspace-card__checks-dot--${workspace.checksState}`]"
          :title="
            workspace.checksState === 'failed'
              ? 'CI / pipeline checks for this workspace’s pull request are failing — open the Review pane to see which.'
              : workspace.checksState === 'pending'
                ? 'CI / pipeline checks for this workspace’s pull request are still running.'
                : 'All required CI / pipeline checks for this workspace’s pull request passed.'
          "
        ></span>
        <span v-if="workspace.attentionCount" class="workspace-card__attention" :title="workspace.attentionTooltip">
          🔔<span class="workspace-card__attention-count">{{ workspace.attentionCount }}</span>
        </span>
      </span>
      <small>{{ workspace.summary }}</small>
    </span>
    <span class="workspace-card__actions">
      <button
        v-if="
          workspace.active &&
          workspace.kind === 'task' &&
          (workspace.taskState === 'running' ||
            workspace.taskState === 'evaluating' ||
            workspace.taskState === 'judge-evaluating' ||
            workspace.taskState === 'refreshing')
        "
        class="workspace-card__action"
        type="button"
        title="Pause the agent task immediately — the Worker / Judge processes keep running but the runner stops sending new prompts. Click Continue (or Reset) afterwards from the Dashboard."
        @click.stop="$emit('task-stop')"
      >
        ⏸
      </button>
      <button
        v-if="
          workspace.active &&
          workspace.kind === 'task' &&
          workspace.taskState !== 'running' &&
          workspace.taskState !== 'evaluating' &&
          workspace.taskState !== 'judge-evaluating' &&
          workspace.taskState !== 'refreshing' &&
          workspace.taskState !== 'idle'
        "
        class="workspace-card__action"
        type="button"
        title="Resume the agent task from where it left off — the runner re-prompts the Worker (or Judge) with the orientation prompt and continues the round."
        @click.stop="$emit('task-toggle')"
      >
        ▶
      </button>
      <!-- Kebab menu is always present so the user can edit / delete / star
           an inactive workspace without having to activate it first. CSS
           keeps it hidden until hover (or when the card is active). -->
      <button
        class="workspace-card__action workspace-card__action--menu"
        type="button"
        title="Open the workspace actions menu — Edit, Delete, Star/Unstar, and (for Azure / GitHub workspaces) New branch / New worktree / Create task agent shortcuts."
        @mousedown.stop
        @click.stop="$emit('open-menu', $event)"
      >
        &#x2026;
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

interface WorkspaceCardData {
  active: boolean;
  attentionCount: number;
  attentionFresh: boolean;
  attentionTooltip?: string;
  depth: number;
  prStatus?: string;
  color?: string;
  index?: number | string;
  icon?: string;
  kind?: string;
  taskState?: string;
  starred?: boolean;
  checksState?: string;
  name: string;
  summary?: string;
  title?: string;
  id: string;
  inGrid?: boolean;
  slotIndex?: number;
}

const props = defineProps<{
  workspace: WorkspaceCardData;
}>();

const RUNNING_STATES = new Set(["running", "evaluating", "judge-evaluating", "refreshing", "showering"]);

const statusDot = computed((): { state: string; label: string } | null => {
  const { taskState, prStatus, kind } = props.workspace;

  if (kind === "task" && taskState) {
    if (RUNNING_STATES.has(taskState)) return { state: "running", label: "Running…" };
    if (taskState === "failed") return { state: "failed", label: "Failed" };
    if (taskState === "stopped") return { state: "stopped", label: "Stopped" };
    if (taskState === "paused") return { state: "paused", label: "Paused" };
    if (taskState === "completed" || taskState === "done") {
      if (prStatus === "completed") return { state: "merged", label: "Done · PR merged" };
      return { state: "completed", label: "Completed" };
    }
  }

  if (prStatus === "active") return { state: "pr-active", label: "PR open" };
  if (prStatus === "completed") return { state: "merged", label: "PR merged" };
  if (prStatus === "abandoned") return { state: "abandoned", label: "PR abandoned" };

  return null;
});

defineEmits<{
  (e: "activate"): void;
  (e: "open-menu", event: MouseEvent): void;
  (e: "dragstart", event: DragEvent): void;
  (e: "dragover", event: DragEvent): void;
  (e: "drop", event: DragEvent): void;
  (e: "toggle-star"): void;
  (e: "task-toggle"): void;
  (e: "task-stop"): void;
}>();
</script>
