<template>
  <div
    class="workspace-card"
    :class="{
      'workspace-card--active': workspace.active,
      'workspace-card--attention': workspace.attentionCount > 0,
      'workspace-card--attention-fresh': workspace.attentionFresh,
      'workspace-card--worktree': workspace.isWorktree,
      'workspace-card--pr-completed': workspace.prStatus === 'completed',
      'workspace-card--pr-abandoned': workspace.prStatus === 'abandoned',
    }"
    :style="`--accent:${workspace.color}`"
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
        v-if="workspace.prStatus"
        :class="['workspace-card__pr-corner', `workspace-card__pr-corner--${workspace.prStatus}`]"
      ></span>
      <span
        v-if="workspace.kind === 'task' && workspace.taskState"
        :class="[
          'workspace-card__task-corner',
          workspace.taskState === 'completed'
            ? 'workspace-card__task-corner--completed'
            : workspace.taskState === 'failed'
              ? 'workspace-card__task-corner--failed'
              : workspace.taskState === 'running' ||
                  workspace.taskState === 'evaluating' ||
                  workspace.taskState === 'judge-evaluating' ||
                  workspace.taskState === 'refreshing'
                ? 'workspace-card__task-corner--running'
                : 'workspace-card__task-corner--idle',
        ]"
      ></span>
    </span>
    <span class="workspace-card__meta">
      <span class="workspace-card__title-row">
        <strong>{{ workspace.name }}</strong>
        <span
          v-if="workspace.checksState"
          :class="['workspace-card__checks-dot', `workspace-card__checks-dot--${workspace.checksState}`]"
          :title="
            workspace.checksState === 'failed'
              ? 'Checks failed'
              : workspace.checksState === 'pending'
                ? 'Checks pending'
                : 'Checks passed'
          "
        ></span>
        <span v-if="workspace.attentionCount" class="workspace-card__attention" :title="workspace.attentionTooltip">
          🔔<span class="workspace-card__attention-count">{{ workspace.attentionCount }}</span>
        </span>
      </span>
      <small>{{ workspace.summary }}</small>
    </span>
    <span v-if="workspace.active" class="workspace-card__actions">
      <button
        v-if="
          workspace.kind === 'task' &&
          (workspace.taskState === 'running' ||
            workspace.taskState === 'evaluating' ||
            workspace.taskState === 'judge-evaluating' ||
            workspace.taskState === 'refreshing')
        "
        class="workspace-card__action"
        type="button"
        title="Pause the task — Continue or Reset afterwards"
        @click.stop="$emit('task-stop')"
      >
        ⏸
      </button>
      <button
        v-if="
          workspace.kind === 'task' &&
          workspace.taskState !== 'running' &&
          workspace.taskState !== 'evaluating' &&
          workspace.taskState !== 'judge-evaluating' &&
          workspace.taskState !== 'refreshing' &&
          workspace.taskState !== 'idle'
        "
        class="workspace-card__action"
        type="button"
        title="Resume the task from where it left off"
        @click.stop="$emit('task-toggle')"
      >
        ▶
      </button>
      <button
        class="workspace-card__action workspace-card__action--menu"
        type="button"
        title="Workspace actions"
        @click.stop="$emit('open-menu', $event)"
      >
        &#x2026;
      </button>
    </span>
  </div>
</template>

<script setup>
defineProps({
  workspace: { type: Object, required: true },
});
defineEmits(["activate", "open-menu", "dragstart", "dragover", "drop", "task-toggle", "task-stop"]);
</script>
