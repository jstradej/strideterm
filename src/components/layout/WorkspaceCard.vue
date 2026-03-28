<template>
  <div
    class="workspace-card"
    :class="{
      'workspace-card--active': workspace.active,
      'workspace-card--attention': workspace.attentionCount > 0,
      'workspace-card--attention-fresh': workspace.attentionFresh,
      'workspace-card--worktree': workspace.isWorktree,
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
    </span>
    <span class="workspace-card__meta">
      <span class="workspace-card__title-row">
        <strong>{{ workspace.name }}</strong>
        <span v-if="workspace.attentionCount" class="workspace-card__attention" :title="workspace.attentionTooltip">
          🔔<span class="workspace-card__attention-count">{{ workspace.attentionCount }}</span>
        </span>
      </span>
      <small>{{ workspace.summary }}</small>
    </span>
    <span v-if="workspace.active" class="workspace-card__actions">
      <button
        v-if="workspace.kind === 'azure' || workspace.kind === 'github'"
        class="workspace-card__action"
        type="button"
        title="New Branch"
        @click.stop="$emit('quick-fix')"
      >
        🪄
      </button>
      <button
        v-if="workspace.gitAvailable"
        class="workspace-card__action"
        type="button"
        title="New worktree"
        @click.stop="$emit('create-worktree')"
      >
        🌿
      </button>
      <button class="workspace-card__action" type="button" title="Edit" @click.stop="$emit('edit')">✎</button>
      <button
        class="workspace-card__action workspace-card__action--danger"
        type="button"
        title="Delete"
        @click.stop="$emit('delete')"
      >
        ✕
      </button>
    </span>
  </div>
</template>

<script setup>
defineProps({
  workspace: { type: Object, required: true },
});
defineEmits(["activate", "quick-fix", "create-worktree", "edit", "delete", "dragstart", "dragover", "drop"]);
</script>
