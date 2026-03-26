<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      :title="paneTitle"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!summary" class="terminal-empty" style="padding:24px;">
      <p>No pull request context available</p>
      <small>Open a GitHub PR from the inbox to see review details.</small>
    </div>
    <div v-else class="azure-review">
      <!-- Header -->
      <div class="azure-review__header">
        <div class="azure-review__title-row">
          <span class="azure-pr-card__repo">{{ summary.repository?.fullName }}</span>
          <span class="azure-pr-card__id">#{{ summary.pullRequest?.number }}</span>
          <span v-if="summary.pullRequest?.draft" class="azure-pr-card__draft">Draft</span>
        </div>
        <h3 style="margin:4px 0 0;">{{ summary.pullRequest?.title }}</h3>
        <div class="azure-pr-card__meta">
          <span>{{ summary.pullRequest?.sourceBranch }} &rarr; {{ summary.pullRequest?.targetBranch }}</span>
          <span>{{ summary.role }}</span>
        </div>
      </div>

      <!-- Quick actions -->
      <div class="azure-review__actions">
        <button type="button" class="button button--ghost" @click="openInBrowser">Open in browser</button>
        <button type="button" class="button button--ghost" @click="handleFetch">Fetch</button>
        <button type="button" class="button button--ghost" @click="handleRebase">Rebase on target</button>
        <button type="button" class="button button--ghost" @click="handlePush">Push branch</button>
      </div>

      <!-- Reviewer summary -->
      <div v-if="summary.reviewerSummary" class="azure-review__section">
        <h4>Reviewers</h4>
        <div v-for="reviewer in summary.reviewerSummary.reviewers" :key="reviewer.login" class="azure-review__reviewer">
          <span>{{ reviewer.displayName || reviewer.login }}</span>
          <span :class="['azure-review__state', `azure-review__state--${reviewer.state}`]">{{ reviewer.state }}</span>
        </div>
      </div>

      <!-- Checks -->
      <div v-if="summary.checks?.items?.length" class="azure-review__section">
        <h4>Checks</h4>
        <div v-for="check in summary.checks.items" :key="check.id" class="azure-review__check">
          <span :class="['azure-review__check-dot', `azure-review__check-dot--${check.state}`]"></span>
          <span>{{ check.name }}</span>
        </div>
      </div>

      <!-- Changed files -->
      <div v-if="summary.changedFiles?.length" class="azure-review__section">
        <h4>Changed files ({{ summary.changedFiles.length }})</h4>
        <div v-for="file in summary.changedFiles" :key="file.path" class="azure-review__file">
          <span class="azure-review__file-status">{{ file.changeType }}</span>
          <span>{{ file.path }}</span>
        </div>
      </div>

      <!-- Review actions -->
      <div v-if="summary.role === 'reviewer'" class="azure-review__section">
        <h4>Submit review</h4>
        <textarea v-model="reviewBody" placeholder="Leave a comment (optional)" rows="3" style="width:100%;"></textarea>
        <div class="azure-review__actions" style="margin-top:8px;">
          <button type="button" class="button button--ghost" @click="submitReview('COMMENT')">Comment</button>
          <button type="button" class="button" @click="submitReview('APPROVE')">Approve</button>
          <button type="button" class="button button--ghost" style="color:var(--danger);" @click="submitReview('REQUEST_CHANGES')">Request changes</button>
        </div>
      </div>

      <!-- General comment -->
      <div class="azure-review__section">
        <h4>Add comment</h4>
        <textarea v-model="commentBody" placeholder="Write a comment..." rows="3" style="width:100%;"></textarea>
        <div class="azure-review__actions" style="margin-top:8px;">
          <button type="button" class="button" :disabled="!commentBody.trim()" @click="addComment">Post comment</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { useAppStore } from "../../stores/app.js";
import PaneShell from "../layout/PaneShell.vue";

const props = defineProps({
  workspaceId: { type: String, default: "" },
  showHeader: { type: Boolean, default: false },
});

const appStore = useAppStore();
const reviewBody = ref("");
const commentBody = ref("");

const workspace = computed(() => (appStore.payload?.appState?.workspaces || []).find((w) => w.id === props.workspaceId));
const prKey = computed(() => workspace.value?.review?.prKey || "");
const summary = computed(() => appStore.payload?.github?.pullRequests?.[prKey.value] || null);

const paneTitle = computed(() => {
  if (!summary.value) return "GitHub Review";
  return `PR #${summary.value.pullRequest?.number} \u00B7 ${summary.value.repository?.fullName || ""}`;
});

const headerStatus = computed(() => summary.value?.role || "");

const headerActions = computed(() => [
  { className: "workspace-pane__icon-btn", action: "refresh-github", title: "Refresh GitHub", label: "\u21BB" },
]);

function onHeaderAction(action) {
  if (action.action === "refresh-github") appStore.refreshGitHub();
}

function openInBrowser() {
  const url = summary.value?.pullRequest?.webUrl;
  if (url) appStore.openExternal(url);
}

async function handleFetch() {
  try { await appStore.githubFetchReviewWorkspace(props.workspaceId); } catch {}
}

async function handleRebase() {
  try { await appStore.githubRebaseReviewWorkspace(props.workspaceId); } catch {}
}

async function handlePush() {
  try { await appStore.githubPushReviewWorkspace(props.workspaceId); } catch {}
}

async function submitReview(event) {
  if (!prKey.value) return;
  try {
    await appStore.githubSubmitReview(prKey.value, event, reviewBody.value.trim());
    reviewBody.value = "";
  } catch {}
}

async function addComment() {
  const body = commentBody.value.trim();
  if (!body || !prKey.value) return;
  try {
    await appStore.githubComment(prKey.value, body);
    commentBody.value = "";
  } catch {}
}
</script>
