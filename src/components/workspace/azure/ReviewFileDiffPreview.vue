<!--
  Diff-preview body shared by the Files and Conflicts tabs in
  AzureReviewPane.vue: Monaco diff (preferred) falling back to the unified
  DiffViewer, falling back to a "no diff" hint, or an empty-state hint when
  no file is selected. The two tabs still render their own distinct toolbar
  header above this (per-commit selector for Files, plain path for
  Conflicts) — only this body was duplicated.
-->
<template>
  <template v-if="diffPreview">
    <MonacoDiffPanel
      v-if="monacoPayload"
      :payload="monacoPayload"
      :loading="monacoLoading"
      class="review-diff-monaco"
    />
    <DiffViewer v-else-if="diffPreview.diff" :diff="diffPreview.diff" />
    <p v-else class="git-card__hint" style="padding: 6px">{{ diffPreview.summary || "No diff available." }}</p>
  </template>
  <div v-else class="review-files-empty">
    <p class="eyebrow">Diff preview</p>
    <p class="git-card__hint">{{ emptyHint }}</p>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import DiffViewer from "../DiffViewer.vue";

const MonacoDiffPanel = defineAsyncComponent(() => import("../../shared/MonacoDiffPanel.vue"));

defineProps<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  diffPreview?: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monacoPayload?: Record<string, any> | null;
  monacoLoading?: boolean;
  emptyHint: string;
}>();
</script>
