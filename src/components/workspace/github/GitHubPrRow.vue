<template>
  <article :class="['azure-pr-row', item.hasAttention && 'azure-pr-row--attention']">
    <div class="azure-pr-row__main">
      <div class="azure-pr-row__title">
        <span class="azure-pr-row__id">#{{ pullRequest.number || pullRequest.id }}</span>
        <strong>{{ pullRequest.title || "Untitled pull request" }}</strong>
        <span v-if="pullRequest.draft || pullRequest.isDraft" class="workspace-chip" style="font-size: 10px"
          >Draft</span
        >
        <span v-if="item.hasAttention" class="workspace-chip workspace-chip--alert" style="font-size: 10px">{{
          item.attentionReason || "attention"
        }}</span>
      </div>
      <div class="azure-pr-row__meta">
        <span>{{ item.repository?.fullName || "" }}</span>
        <span>&middot;</span>
        <span>{{ authorName }}</span>
        <span>&middot;</span>
        <span class="workspace-chip" style="font-size: 10px; padding: 0 4px">{{ item.role || "reviewer" }}</span>
        <template v-if="item.reviewerSummary?.approvedCount">
          <span>&middot;</span>
          <span style="color: #6edfb6">{{ item.reviewerSummary.approvedCount }} approved</span>
        </template>
        <template v-if="item.reviewerSummary?.changesRequestedCount">
          <span>&middot;</span>
          <span style="color: #ff6f8d">{{ item.reviewerSummary.changesRequestedCount }} changes requested</span>
        </template>
      </div>
      <div class="azure-pr-row__branch">
        {{ stripRef(pullRequest.sourceRefName) }} &rarr; {{ stripRef(pullRequest.targetRefName) }}
      </div>
    </div>
    <div class="azure-pr-row__actions">
      <button type="button" :class="['button', busy && 'button--busy']" :disabled="busy" @click="handleOpen">
        {{ busy ? "Opening…" : actionLabel }}
      </button>
      <button type="button" class="button button--ghost" @click="$emit('browser', pullRequest.webUrl)">Browser</button>
      <button v-if="item.hasAttention" type="button" class="button button--ghost" @click="$emit('seen', item.prKey)">
        Seen
      </button>
    </div>
  </article>
</template>

<script setup>
import { computed, ref } from "vue";

const props = defineProps({
  item: { type: Object, required: true },
});

const emit = defineEmits(["open", "browser", "seen"]);

const busy = ref(false);
const pullRequest = computed(() => props.item.pullRequest || {});
const authorName = computed(() => props.item.author?.displayName || props.item.author?.login || "Unknown author");

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

function handleOpen() {
  busy.value = true;
  emit("open", { prKey: props.item.prKey, workspaceId: openWorkspaceId.value });
  // busy stays true until the pane switches away — parent handles the async
}
</script>
