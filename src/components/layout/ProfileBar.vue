<template>
  <div class="profile-bar-row">
    <button
      type="button"
      class="profile-bar"
      :style="`--profile-color:${profile.color || '#ffa424'}`"
      @click="$emit('click')"
    >
      {{ profile.name }}
    </button>
    <button
      v-if="hasAnyStarred"
      type="button"
      class="profile-bar__star"
      :class="{ 'profile-bar__star--active': store.starFilterActive }"
      :title="store.starFilterActive ? 'Show all workspaces' : 'Show starred only'"
      @click="store.starFilterActive = !store.starFilterActive"
    >
      {{ store.starFilterActive ? "★" : "☆" }}
    </button>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";

const store = useAppStore();
const profile = computed(() => store.activeProfile);
const hasAnyStarred = computed(() => store.filteredWorkspaces.some((ws) => ws.starred));

defineEmits(["click"]);
</script>
