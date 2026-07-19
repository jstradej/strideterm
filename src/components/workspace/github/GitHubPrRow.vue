<template>
  <article
    :class="['azure-pr-row', item.hasAttention && 'azure-pr-row--attention', expanded && 'azure-pr-row--expanded']"
  >
    <div class="azure-pr-row__main">
      <div class="azure-pr-row__title">
        <button
          type="button"
          class="azure-pr-row__expand"
          :aria-expanded="expanded"
          :aria-label="expanded ? 'Hide pull request details' : 'Show pull request details'"
          :title="
            expanded
              ? 'Collapse — hide description and details.'
              : 'Expand — preview description, status and reviewers without opening the PR.'
          "
          @click="expanded = !expanded"
        >
          <span class="azure-pr-row__expand-caret" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
        </button>
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
      <div v-if="expanded" class="azure-pr-row__details">
        <p v-if="description" class="azure-pr-row__description">{{ description }}</p>
        <p v-else class="azure-pr-row__description azure-pr-row__description--empty">No description provided.</p>
        <dl class="azure-pr-row__facts">
          <div v-if="pullRequest.createdAt" class="azure-pr-row__fact">
            <dt>Created</dt>
            <dd>{{ formatDate(pullRequest.createdAt) }}</dd>
          </div>
          <div v-if="pullRequest.updatedAt" class="azure-pr-row__fact">
            <dt>Updated</dt>
            <dd>{{ formatDate(pullRequest.updatedAt) }}</dd>
          </div>
          <div class="azure-pr-row__fact">
            <dt>State</dt>
            <dd>{{ pullRequest.state || "open" }}</dd>
          </div>
          <div v-if="mergeStatusLabel" class="azure-pr-row__fact">
            <dt>Merge</dt>
            <dd>{{ mergeStatusLabel }}</dd>
          </div>
          <div v-if="commentLabel" class="azure-pr-row__fact">
            <dt>Comments</dt>
            <dd>{{ commentLabel }}</dd>
          </div>
          <div v-if="checksLabel" class="azure-pr-row__fact">
            <dt>Checks</dt>
            <dd>{{ checksLabel }}</dd>
          </div>
          <div v-if="reviewerLabel" class="azure-pr-row__fact">
            <dt>Reviewers</dt>
            <dd>{{ reviewerLabel }}</dd>
          </div>
          <div v-if="pullRequest.headSha" class="azure-pr-row__fact">
            <dt>HEAD</dt>
            <dd>
              <code>{{ shortSha(pullRequest.headSha) }}</code>
            </dd>
          </div>
        </dl>
      </div>
    </div>
    <div class="azure-pr-row__actions">
      <button type="button" :class="['button', opening && 'button--busy']" :disabled="opening" @click="handleOpen">
        {{ opening ? "Opening…" : actionLabel }}
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
import { stripRef } from "../azure/azurePipelineFormat.js";
import { shortSha, formatDate } from "../prRowFormat.js";

const props = withDefaults(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineProps<{ item: Record<string, any>; showSeen?: boolean; opening?: boolean }>(),
  { showSeen: true, opening: false },
);

const emit = defineEmits<{
  (e: "open", payload: { prKey: string; workspaceId: string }): void;
  (e: "browser", url: string): void;
  (e: "seen", prKey: string): void;
}>();

const expanded = ref(false);
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

const description = computed(() => {
  // GitHub stores PR body under `body`; older code may have populated
  // `description` directly. Check both for forward compatibility.
  const text = String(pullRequest.value.body || pullRequest.value.description || "").trim();
  return text;
});

const mergeStatusLabel = computed(() => {
  const status = String(pullRequest.value.mergeableState || "");
  if (!status) return "";
  if (status === "clean") return "No conflicts";
  if (status === "dirty") return "Conflicts detected";
  if (status === "blocked") return "Blocked";
  if (status === "behind") return "Behind base";
  if (status === "unstable") return "Unstable (failing checks)";
  if (status === "unknown") return "";
  return status;
});

const commentLabel = computed(() => {
  const total = Number(props.item.commentCount || 0);
  const fresh = Number(props.item.newCommentsCount || 0);
  if (!total && !fresh) return "";
  const parts: string[] = [];
  if (total) parts.push(`${total} total`);
  if (fresh) parts.push(`${fresh} new`);
  return parts.join(" · ");
});

const checksLabel = computed(() => {
  const checks = props.item.checks;
  if (!checks) return "";
  const passed = Number(checks.passedCount || 0);
  const failed = Number(checks.failedCount || 0);
  const pending = Number(checks.pendingCount || 0);
  if (!passed && !failed && !pending) return "";
  const parts: string[] = [];
  if (passed) parts.push(`${passed} passed`);
  if (failed) parts.push(`${failed} failed`);
  if (pending) parts.push(`${pending} pending`);
  return parts.join(" · ");
});

const reviewerLabel = computed(() => {
  const summary = props.item.reviewerSummary;
  const reviewers: Array<{ state?: string; isRequested?: boolean }> = (summary?.reviewers || []) as Array<{
    state?: string;
    isRequested?: boolean;
  }>;
  if (!reviewers.length) return "";
  const approved = Number(summary?.approvedCount || 0);
  const changesRequested = Number(summary?.changesRequestedCount || 0);
  const requested = Number(summary?.requestedCount || 0);
  const parts = [`${reviewers.length} total`];
  if (approved) parts.push(`${approved} approved`);
  if (changesRequested) parts.push(`${changesRequested} changes requested`);
  if (requested) parts.push(`${requested} requested`);
  return parts.join(" · ");
});

function handleOpen() {
  emit("open", { prKey: props.item.prKey as string, workspaceId: openWorkspaceId.value });
}
</script>
