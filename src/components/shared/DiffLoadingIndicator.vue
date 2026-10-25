<template>
  <div class="diff-loading">
    <Spinner size="md" label="Loading diff…" />
  </div>
</template>

<script setup lang="ts">
import Spinner from "../common/Spinner.vue";

defineOptions({ inheritAttrs: false });
</script>

<style scoped>
.diff-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  width: 100%;
  min-height: 0;
}
</style>
