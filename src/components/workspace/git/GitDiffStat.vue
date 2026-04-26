<template>
  <div v-if="stat" class="git-stat-row">
    <span class="workspace-chip"
      ><strong>{{ stat.files || 0 }}</strong> files</span
    >
    <span class="workspace-chip"
      ><strong>{{ stat.insertions || 0 }}</strong> +</span
    >
    <span class="workspace-chip"
      ><strong>{{ stat.deletions || 0 }}</strong> -</span
    >
    <span v-if="stat.renames" class="workspace-chip"
      ><strong>{{ stat.renames }}</strong> renames</span
    >
    <span v-if="stat.deletes" class="workspace-chip"
      ><strong>{{ stat.deletes }}</strong> deletes</span
    >
  </div>
</template>

<script setup lang="ts">
withDefaults(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineProps<{ stat?: Record<string, any> | null }>(),
  { stat: null },
);
</script>
