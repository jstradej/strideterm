<template>
  <WorkspaceGridStage v-if="store.isGridVisible" />
  <PaneStage v-else />
</template>

<script setup lang="ts">
import { useAppStore } from "../../stores/app.js";
import PaneStage from "./PaneStage.vue";
import WorkspaceGridStage from "./WorkspaceGridStage.vue";

const store = useAppStore();
</script>
