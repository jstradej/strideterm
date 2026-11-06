<template>
  <div class="pane-loading">
    <Spinner size="md" label="Loading pane…" />
  </div>
</template>

<script setup lang="ts">
import Spinner from "../common/Spinner.vue";
</script>

<style scoped>
.pane-loading {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 120px;
  color: var(--muted);
}
</style>
