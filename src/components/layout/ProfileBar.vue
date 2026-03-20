<template>
  <button
    type="button"
    class="profile-bar"
    :style="`--profile-color:${profile.color || '#ffa424'}`"
    @click="$emit('click')"
  >{{ profile.name }}</button>
</template>

<script setup>
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";

const store = useAppStore();
const profile = computed(() => store.activeProfile);

defineEmits(["click"]);
</script>
