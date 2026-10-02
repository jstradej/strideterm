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
    <p v-if="targetStale" class="git-card__hint review-diff-stale-hint">
      This comment points to an older version. The current diff may have shifted; use the snippet in Comments to confirm
      context.
    </p>
    <MonacoDiffPanel
      v-if="monacoPayload || monacoLoading"
      :payload="monacoPayload"
      :loading="monacoLoading"
      :target-line="targetLine"
      :target-side="targetSide"
      :target-stale="targetStale"
      :line-annotations="lineAnnotations"
      :file-annotations="fileAnnotations"
      :selected-annotation-id="selectedAnnotationId"
      :annotation-actions-enabled="annotationActionsEnabled"
      :allow-inline-comments="allowInlineComments"
      class="review-diff-monaco"
      @request-comment="emit('request-comment', $event)"
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
const emit = defineEmits<{ "request-comment": [location: { line: number; side: "old" | "new" }] }>();

interface ReviewInlineAnnotation {
  id: string;
  line: number | null;
  side: "old" | "new";
  title: string;
  stale?: boolean;
  fallbackLabel?: string;
  actions?: Array<{ label: string; title: string; disabled?: boolean; run: () => void | Promise<void> }>;
  entries: Array<{
    author: string;
    body: string;
    draft?: boolean;
    status?: string;
    actions?: Array<{ label: string; title: string; disabled?: boolean; run: () => void | Promise<void> }>;
  }>;
}

defineProps<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  diffPreview?: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monacoPayload?: Record<string, any> | null;
  monacoLoading?: boolean;
  targetLine?: number;
  targetSide?: "old" | "new";
  targetStale?: boolean;
  lineAnnotations?: ReviewInlineAnnotation[];
  fileAnnotations?: ReviewInlineAnnotation[];
  selectedAnnotationId?: string;
  annotationActionsEnabled?: boolean;
  allowInlineComments?: boolean;
  emptyHint: string;
}>();
</script>
