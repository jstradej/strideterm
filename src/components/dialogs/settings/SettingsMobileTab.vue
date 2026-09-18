<template>
  <MobileConnectionPanel :profiles="profiles" :initial-view="initialView" />
</template>

<script setup lang="ts">
import MobileConnectionPanel from "./MobileConnectionPanel.vue";
withDefaults(
  defineProps<{
    profiles?: { id: string; name: string; color?: string }[];
    initialView?: "overview" | "phones" | "account";
  }>(),
  { profiles: () => [], initialView: "overview" },
);
</script>
