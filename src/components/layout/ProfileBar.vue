<template>
  <div class="profile-bar-row">
    <button
      type="button"
      class="profile-bar"
      :style="`--profile-color:${profile.color || '#ffa424'}`"
      @click="$emit('click')"
    >
      {{ profile.name }}
      <span
        v-if="otherProfileCount > 0"
        class="profile-bar__other-attention"
        :title="`${otherProfileCount} alert${otherProfileCount === 1 ? '' : 's'} in other profile${otherProfileCount === 1 ? '' : 's'}`"
        >{{ otherProfileCount }}</span
      >
    </button>
    <button type="button" class="profile-bar__menu" title="Profiles" @click="$emit('click')">☰</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";

const store = useAppStore();
const profile = computed(() => store.activeProfile);
const otherProfileCount = computed(() => store.otherProfileAttentionCount);

defineEmits<{
  (e: "click"): void;
}>();
</script>

<style scoped>
.profile-bar__other-attention {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-left: 6px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: var(--accent, #ffa424);
  border-radius: 8px;
  vertical-align: middle;
}
</style>
