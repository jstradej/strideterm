<template>
  <article :class="['azure-pr-row', item.hasAttention && 'azure-pr-row--attention']">
    <div class="azure-pr-row__main">
      <div class="azure-pr-row__title">
        <span class="azure-pr-row__id">#{{ pullRequest.id }}</span>
        <strong>{{ pullRequest.title || 'Untitled pull request' }}</strong>
        <span v-if="pullRequest.isDraft" class="workspace-chip" style="font-size:10px;">Draft</span>
        <span v-if="item.hasAttention" class="workspace-chip workspace-chip--alert" style="font-size:10px;">{{ item.attentionReason || 'attention' }}</span>
      </div>
      <div class="azure-pr-row__meta">
        <span>{{ item.project?.name || '' }} / {{ item.repository?.name || '' }}</span>
        <span>&middot;</span>
        <span>{{ authorName }}</span>
        <span>&middot;</span>
        <span class="workspace-chip" style="font-size:10px;padding:0 4px;">{{ item.role || 'reviewer' }}</span>
      </div>
      <div class="azure-pr-row__branch">
        {{ stripRef(pullRequest.sourceRefName) }} &rarr; {{ stripRef(pullRequest.targetRefName) }}
      </div>
    </div>
    <div class="azure-pr-row__actions">
      <button type="button" class="button" @click="$emit('open', { prKey: item.prKey, workspaceId: openWorkspaceId })">{{ actionLabel }}</button>
      <button type="button" class="button button--ghost" @click="$emit('browser', pullRequest.webUrl || pullRequest.url)">Browser</button>
      <button v-if="item.hasAttention" type="button" class="button button--ghost" @click="$emit('seen', item.prKey)">Seen</button>
    </div>
  </article>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
  item: { type: Object, required: true },
});

defineEmits(["open", "browser", "seen"]);

const pullRequest = computed(() => props.item.pullRequest || {});
const authorName = computed(() => props.item.author?.displayName || "Unknown author");

const openWorkspaceId = computed(() =>
  props.item.role === "author" && props.item.existingWorkspaceId && !props.item.reviewWorkspaceId
    ? props.item.existingWorkspaceId
    : "",
);

const actionLabel = computed(() => {
  if (props.item.role === "author" && props.item.existingWorkspaceId && !props.item.reviewWorkspaceId) return "Attach";
  if (props.item.reviewWorkspaceId) return "Open";
  return "Review";
});

function stripRef(ref) {
  return String(ref || "").replace(/^refs\/heads\//, "");
}
</script>
