<template>
  <article :class="['azure-pr-row', item.hasAttention && 'azure-pr-row--attention']">
    <div class="azure-pr-row__main">
      <div class="azure-pr-row__title">
        <span class="azure-pr-row__id">#{{ pullRequest.number || pullRequest.id }}</span>
        <strong>{{ pullRequest.title || "Untitled pull request" }}</strong>
        <span v-if="pullRequest.draft || pullRequest.isDraft" class="workspace-chip" style="font-size: 10px">
          <span class="chip-icon">✎</span>Draft
        </span>
        <span v-if="item.hasAttention" class="workspace-chip workspace-chip--alert" style="font-size: 10px">
          <span class="chip-icon">{{ attentionIcon }}</span
          >{{ item.attentionReason || "attention" }}
        </span>
      </div>
      <div class="azure-pr-row__meta">
        <span>{{ item.repository?.fullName || "" }}</span>
        <span>&middot;</span>
        <span>{{ authorName }}</span>
        <span>&middot;</span>
        <span class="workspace-chip" style="font-size: 10px; padding: 0 6px">
          <span class="chip-icon">{{ roleIcon }}</span
          >{{ item.role || "reviewer" }}
        </span>
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
      <button
        v-if="showSeen"
        type="button"
        class="button button--ghost"
        :disabled="!item.hasAttention"
        :title="
          item.hasAttention
            ? 'Acknowledge: clear the &quot;needs attention&quot; flag for this PR until it changes again.'
            : 'No new activity on this PR — nothing to acknowledge.'
        "
        @click="item.hasAttention && $emit('seen', item.prKey)"
      >
        Seen
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = withDefaults(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineProps<{ item: Record<string, any>; showSeen?: boolean }>(),
  { showSeen: true },
);

const emit = defineEmits<{
  (e: "open", payload: { prKey: string; workspaceId: string }): void;
  (e: "browser", url: string): void;
  (e: "seen", prKey: string): void;
}>();

const busy = ref(false);
const pullRequest = computed(() => props.item.pullRequest || {});
const authorName = computed(() => {
  const author = props.item.author;
  return (author?.displayName as string) || (author?.login as string) || "Unknown author";
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

const roleIcon = computed(() => {
  const role = String(props.item.role || "reviewer");
  if (role === "reviewer") return "\u{1F441}"; // 👁
  if (role === "author") return "✎"; // ✎
  return "•"; // bullet
});

const attentionIcon = computed(() => {
  const reason = String(props.item.attentionReason || "").toLowerCase();
  if (reason.includes("comment")) return "\u{1F4AC}"; // 💬
  if (reason.includes("review state") || reason.includes("review decision")) return "✓";
  if (reason.includes("update") || reason.includes("branch")) return "↻";
  if (reason.includes("check") || reason.includes("fail") || reason.includes("policy")) return "⚠";
  return "⚡";
});

function stripRef(ref: unknown) {
  return String(ref || "").replace(/^refs\/heads\//, "");
}

function handleOpen() {
  busy.value = true;
  emit("open", { prKey: props.item.prKey as string, workspaceId: openWorkspaceId.value });
  // busy stays true until the pane switches away — parent handles the async
}
</script>
