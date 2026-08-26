<template>
  <div class="workspace-context-row" :style="`margin-left:${depth * 16}px`" :title="name">
    <span class="workspace-context-row__icon" aria-hidden="true">{{ icon }}</span>
    <span class="workspace-context-row__name">{{ name }}</span>
  </div>
</template>

<script setup lang="ts">
// Non-interactive ancestor label for the sidebar's "recent" view — shows
// where a real workspace card sits in the tree without duplicating the
// full WorkspaceCard (no index, star, status, attention, menu, or drag).
defineProps<{
  name: string;
  icon: string;
  depth: number;
}>();
</script>
