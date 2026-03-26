<template>
  <nav class="file-breadcrumb">
    <span
      v-for="(item, i) in items"
      :key="item.path"
      class="file-breadcrumb__item"
    >
      <span v-if="i > 0" class="file-breadcrumb__sep">/</span>
      <button
        type="button"
        class="file-breadcrumb__link"
        :class="{ 'file-breadcrumb__link--active': i === items.length - 1 }"
        @click="$emit('navigate', item.path)"
      >{{ item.name }}</button>
    </span>
  </nav>
</template>

<script setup>
defineProps({
  items: { type: Array, default: () => [] },
});
defineEmits(["navigate"]);
</script>

<style scoped>
.file-breadcrumb {
  display: flex;
  align-items: center;
  padding: 4px 10px;
  font-size: 12px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  white-space: nowrap;
}

.file-breadcrumb__item {
  display: inline-flex;
  align-items: center;
}

.file-breadcrumb__sep {
  color: var(--muted);
  margin: 0 2px;
}

.file-breadcrumb__link {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}

.file-breadcrumb__link:hover {
  background: var(--border);
  color: var(--text);
}

.file-breadcrumb__link--active {
  color: var(--text);
  font-weight: 600;
}
</style>
