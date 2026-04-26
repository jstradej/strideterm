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
    <button type="button" class="profile-bar__menu" title="Profiles" @click="$emit('click')">☰</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";

const store = useAppStore();
const profile = computed(() => store.activeProfile);

defineEmits<{
  (e: "click"): void;
}>();
</script>
