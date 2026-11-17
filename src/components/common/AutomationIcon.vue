<template>
  <svg viewBox="0 0 330 330" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false">
    <path v-for="d in BADGE_GLYPHS.automation" :key="d" :d="d" />
  </svg>
</template>
<script setup lang="ts">
import { BADGE_GLYPHS } from "../../app/workspace-badge-glyphs.js";
</script>
