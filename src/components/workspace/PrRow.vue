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
        <span class="azure-pr-row__id">#{{ prNumber }}</span>
        <strong>{{ pullRequest.title || "Untitled pull request" }}</strong>
        <span v-if="isDraft" class="workspace-chip" style="font-size: 10px">
          <span class="chip-icon">✎</span>Draft
        </span>
        <span v-if="item.hasAttention" class="workspace-chip workspace-chip--alert" style="font-size: 10px">
          <span class="chip-icon">{{ attentionIcon }}</span
          >{{ item.attentionReason || "attention" }}
        </span>
      </div>
      <div class="azure-pr-row__meta">
        <span>{{ repoMeta }}</span>
        <span>&middot;</span>
        <span>{{ authorName }}</span>
        <span>&middot;</span>
        <span class="workspace-chip" style="font-size: 10px; padding: 0 6px">
          <span class="chip-icon">{{ roleIcon }}</span
          >{{ item.role || "reviewer" }}
        </span>
        <template v-if="isGitHub && item.reviewerSummary?.approvedCount">
          <span>&middot;</span>
          <span style="color: #6edfb6">{{ item.reviewerSummary.approvedCount }} approved</span>
        </template>
        <template v-if="isGitHub && item.reviewerSummary?.changesRequestedCount">
          <span>&middot;</span>
          <span style="color: #ff6f8d">{{ item.reviewerSummary.changesRequestedCount }} changes requested</span>
        </template>
      </div>
      <div class="azure-pr-row__branch">
        {{ stripRef(pullRequest.sourceRefName) }} &rarr; {{ stripRef(pullRequest.targetRefName) }}
      </div>
      <div v-if="expanded" class="azure-pr-row__details">
        <p v-if="descriptionText" class="azure-pr-row__description">{{ descriptionText }}</p>
        <p v-else class="azure-pr-row__description azure-pr-row__description--empty">No description provided.</p>
        <dl class="azure-pr-row__facts">
          <div v-if="createdDate" class="azure-pr-row__fact">
            <dt>Created</dt>
            <dd>{{ formatDate(createdDate) }}</dd>
          </div>
          <div v-if="isGitHub && pullRequest.updatedAt" class="azure-pr-row__fact">
            <dt>Updated</dt>
            <dd>{{ formatDate(pullRequest.updatedAt) }}</dd>
          </div>
          <div class="azure-pr-row__fact">
            <dt>{{ isGitHub ? "State" : "Status" }}</dt>
            <dd>{{ isGitHub ? pullRequest.state || "open" : pullRequest.status || "unknown" }}</dd>
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
          <div v-if="headShaValue" class="azure-pr-row__fact">
            <dt>HEAD</dt>
            <dd>
              <code>{{ shortSha(headShaValue) }}</code>
            </dd>
          </div>
        </dl>
        <p v-if="!isGitHub && latestCommentPreview" class="azure-pr-row__comment-preview">
          <span class="azure-pr-row__comment-label">Latest comment</span>
          <span class="azure-pr-row__comment-body">{{ latestCommentPreview }}</span>
        </p>
      </div>
    </div>
    <div class="azure-pr-row__actions">
      <button
        type="button"
        :class="['button', opening && 'button--busy']"
        :disabled="opening"
        :title="isGitHub ? undefined : actionTitle"
        @click="handleOpen"
      >
        {{ opening ? "Opening…" : actionLabel }}
      </button>
      <button
        type="button"
        class="button button--ghost"
        :title="isGitHub ? undefined : 'Open this pull request in your default browser.'"
        @click="handleBrowser"
      >
        Browser
      </button>
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
import { stripRef } from "./azure/azurePipelineFormat.js";
import { shortSha, formatDate } from "./prRowFormat.js";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    item: Record<string, any>;
    showSeen?: boolean;
    opening?: boolean;
    provider?: "azure" | "github";
  }>(),
  { showSeen: true, opening: false, provider: "azure" },
);

const emit = defineEmits<{
  (e: "open", payload: { prKey: string; workspaceId: string }): void;
  (e: "browser", url: string): void;
  (e: "seen", prKey: string): void;
}>();

const isGitHub = computed(() => props.provider === "github");

const expanded = ref(false);

const pullRequest = computed(() => props.item.pullRequest || {});

const prNumber = computed(() => (isGitHub.value ? pullRequest.value.number || pullRequest.value.id : pullRequest.value.id));

const isDraft = computed(() => (isGitHub.value ? pullRequest.value.draft || pullRequest.value.isDraft : pullRequest.value.isDraft));

const repoMeta = computed(() =>
  isGitHub.value
    ? props.item.repository?.fullName || ""
    : `${props.item.project?.name || ""} / ${props.item.repository?.name || ""}`,
);

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

// Azure-only tooltip for the primary action button — GitHub's button has none.
const actionTitle = computed(() => {
  if (actionLabel.value === "Attach") {
    return "Attach this PR to your existing workspace at the same source branch — no review workspace will be created.";
  }
  if (actionLabel.value === "Open") {
    return "Switch to the review workspace already prepared for this PR.";
  }
  return "Create a fresh review workspace: clone the PR branch into the review root and open it for inspection.";
});

const roleIcon = computed(() => {
  const role = String(props.item.role || "reviewer");
  if (role === "reviewer") return "\u{1F441}"; // 👁
  if (role === "author") return "✎"; // ✎
  return "•"; // bullet
});

// Pick an icon that mirrors the attentionReason text. Falls back to a
// generic alert glyph if the reason is empty / unknown. "vote" only ever
// appears in Azure's attentionReason vocabulary — harmless no-op for GitHub.
const attentionIcon = computed(() => {
  const reason = String(props.item.attentionReason || "").toLowerCase();
  if (reason.includes("comment")) return "\u{1F4AC}"; // 💬
  if (reason.includes("vote") || reason.includes("review state") || reason.includes("review decision")) return "✓"; // ✓
  if (reason.includes("update") || reason.includes("branch")) return "↻"; // ↻
  if (reason.includes("policy") || reason.includes("check") || reason.includes("fail")) return "⚠"; // ⚠
  return "⚡"; // ⚡ generic attention
});

const descriptionText = computed(() => {
  if (isGitHub.value) {
    // GitHub stores PR body under `body`; older code may have populated
    // `description` directly. Check both for forward compatibility.
    return String(pullRequest.value.body || pullRequest.value.description || "").trim();
  }
  return pullRequest.value.description || "";
});

const createdDate = computed(() => pullRequest.value.creationDate || pullRequest.value.createdAt);

const mergeStatusLabel = computed(() => {
  if (isGitHub.value) {
    const status = String(pullRequest.value.mergeableState || "");
    if (!status) return "";
    if (status === "clean") return "No conflicts";
    if (status === "dirty") return "Conflicts detected";
    if (status === "blocked") return "Blocked";
    if (status === "behind") return "Behind base";
    if (status === "unstable") return "Unstable (failing checks)";
    if (status === "unknown") return "";
    return status;
  }
  const status = String(pullRequest.value.mergeStatus || "");
  if (!status) return "";
  if (status === "succeeded") return "No conflicts";
  if (status === "conflicts") return "Conflicts detected";
  return status;
});

const commentLabel = computed(() => {
  const total = Number(props.item.commentCount || 0);
  const fresh = Number(props.item.newCommentsCount || 0);
  if (isGitHub.value) {
    if (!total && !fresh) return "";
    const parts: string[] = [];
    if (total) parts.push(`${total} total`);
    if (fresh) parts.push(`${fresh} new`);
    return parts.join(" · ");
  }
  const unresolved = Number(props.item.unresolvedThreadCount || 0);
  if (!total && !unresolved && !fresh) return "";
  const parts = [`${total} total`];
  if (unresolved) parts.push(`${unresolved} unresolved`);
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
  if (isGitHub.value) {
    const reviewers = (summary?.reviewers || []) as unknown[];
    if (!reviewers.length) return "";
    const approved = Number(summary?.approvedCount || 0);
    const changesRequested = Number(summary?.changesRequestedCount || 0);
    const requested = Number(summary?.requestedCount || 0);
    const parts = [`${reviewers.length} total`];
    if (approved) parts.push(`${approved} approved`);
    if (changesRequested) parts.push(`${changesRequested} changes requested`);
    if (requested) parts.push(`${requested} requested`);
    return parts.join(" · ");
  }
  const reviewers: Array<{ vote?: number; isRequired?: boolean }> = (summary?.reviewers || []) as Array<{
    vote?: number;
    isRequired?: boolean;
  }>;
  if (!reviewers.length) return "";
  const approved = reviewers.filter((r) => Number(r.vote) > 0).length;
  const waiting = reviewers.filter((r) => Number(r.vote) === -5).length;
  const rejected = reviewers.filter((r) => Number(r.vote) === -10).length;
  const required = reviewers.filter((r) => r.isRequired).length;
  const parts = [`${reviewers.length} total`];
  if (required) parts.push(`${required} required`);
  if (approved) parts.push(`${approved} approved`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (rejected) parts.push(`${rejected} rejected`);
  return parts.join(" · ");
});

const headShaValue = computed(() => (isGitHub.value ? pullRequest.value.headSha : pullRequest.value.sourceCommitId));

// Azure-only — GitHub's data never carries this field, so this stays empty for GitHub.
const latestCommentPreview = computed(() => {
  const text = String(props.item.latestCommentPreview || "").trim();
  if (!text) return "";
  // Truncate long previews so the row stays readable when expanded.
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
});

function handleOpen() {
  emit("open", { prKey: props.item.prKey as string, workspaceId: openWorkspaceId.value });
}

function handleBrowser() {
  // Azure PR summaries may only carry a legacy `.url`; GitHub always has webUrl.
  emit("browser", isGitHub.value ? pullRequest.value.webUrl : pullRequest.value.webUrl || pullRequest.value.url);
}
</script>
