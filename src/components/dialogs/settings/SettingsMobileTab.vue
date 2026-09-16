<template>
  <MobileConnectionPanel :profiles="profiles" />
</template>

<script setup lang="ts">
import MobileConnectionPanel from "./MobileConnectionPanel.vue";
withDefaults(defineProps<{ profiles?: { id: string; name: string; color?: string }[] }>(), { profiles: () => [] });
</script>
