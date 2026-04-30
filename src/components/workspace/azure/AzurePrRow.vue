<template>
  <article :class="['azure-pr-row', item.hasAttention && 'azure-pr-row--attention']">
    <div class="azure-pr-row__main">
      <div class="azure-pr-row__title">
        <span class="azure-pr-row__id">#{{ pullRequest.id }}</span>
        <strong>{{ pullRequest.title || "Untitled pull request" }}</strong>
        <span v-if="pullRequest.isDraft" class="workspace-chip" style="font-size: 10px">Draft</span>
        <span v-if="item.hasAttention" class="workspace-chip workspace-chip--alert" style="font-size: 10px">{{
          item.attentionReason || "attention"
        }}</span>
      </div>
      <div class="azure-pr-row__meta">
        <span>{{ item.project?.name || "" }} / {{ item.repository?.name || "" }}</span>
        <span>&middot;</span>
        <span>{{ authorName }}</span>
        <span>&middot;</span>
        <span class="workspace-chip" style="font-size: 10px; padding: 0 4px">{{ item.role || "reviewer" }}</span>
      </div>
      <div class="azure-pr-row__branch">
        {{ stripRef(pullRequest.sourceRefName) }} &rarr; {{ stripRef(pullRequest.targetRefName) }}
      </div>
    </div>
    <div class="azure-pr-row__actions">
      <button
        type="button"
        class="button"
        :title="actionTitle"
        @click="$emit('open', { prKey: item.prKey, workspaceId: openWorkspaceId })"
      >
        {{ actionLabel }}
      </button>
      <button
        type="button"
        class="button button--ghost"
        title="Open this pull request in your default browser."
        @click="$emit('browser', pullRequest.webUrl || pullRequest.url)"
      >
        Browser
      </button>
      <button
        v-if="item.hasAttention"
        type="button"
        class="button button--ghost"
        title='Acknowledge: clear the "needs attention" flag for this PR until it changes again.'
        @click="$emit('seen', item.prKey)"
      >
        Seen
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const props = defineProps<{ item: Record<string, any> }>();

defineEmits<{
  (e: "open", payload: { prKey: string; workspaceId: string }): void;
  (e: "browser", url: string): void;
  (e: "seen", prKey: string): void;
}>();

const pullRequest = computed(() => props.item.pullRequest || {});
const authorName = computed(() => {
  const author = props.item.author;
  return (author?.displayName as string) || "Unknown author";
});

const openWorkspaceId = computed(() =>
  props.item.role === "author" && props.item.existingWorkspaceId && !props.item.reviewWorkspaceId
    ? (props.item.existingWorkspaceId as string)
    : "",
);

const actionLabel = computed(() => {
  if (props.item.role === "author" && props.item.existingWorkspaceId && !props.item.reviewWorkspaceId) return "Attach";
  if (props.item.reviewWorkspaceId) return "Open";
  return "Review";
});

const actionTitle = computed(() => {
  if (actionLabel.value === "Attach") {
    return "Attach this PR to your existing workspace at the same source branch — no review workspace will be created.";
  }
  if (actionLabel.value === "Open") {
    return "Switch to the review workspace already prepared for this PR.";
  }
  return "Create a fresh review workspace: clone the PR branch into the review root and open it for inspection.";
});

function stripRef(ref: unknown) {
  return String(ref || "").replace(/^refs\/heads\//, "");
}
</script>
