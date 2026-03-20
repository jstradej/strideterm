<template>
  <div class="review-panel">
    <div class="review-grid review-grid--summary">
      <article class="git-card review-card review-card--hero">
        <div class="section-head">
          <div>
            <p class="eyebrow">Overview</p>
            <h3>{{ pullRequest.title || 'Azure review' }}</h3>
          </div>
        </div>
        <p v-if="pullRequest.description" class="git-card__hint azure-review__description">{{ pullRequest.description }}</p>
        <p class="git-card__hint" style="font-family:monospace;font-size:12px;">{{ stripRef(pullRequest.sourceRefName) }} &rarr; {{ stripRef(pullRequest.targetRefName) }}</p>

        <div class="review-section-divider"><span>Review actions</span></div>
        <div class="docker-card__actions">
          <button type="button" :class="['button', 'button--ghost', busyAction === 'vote-10' && 'button--busy']" :disabled="!!busyAction" @click="handleVote(prKey, 10, 'Approve')">{{ busyAction === 'vote-10' ? 'Approving…' : 'Approve' }}</button>
          <button type="button" :class="['button', 'button--ghost', busyAction === 'vote-5' && 'button--busy']" :disabled="!!busyAction" @click="handleVote(prKey, 5, 'Approve')">{{ busyAction === 'vote-5' ? 'Submitting…' : 'Approve with suggestions' }}</button>
          <button type="button" :class="['button', 'button--ghost', busyAction === 'vote--5' && 'button--busy']" :disabled="!!busyAction" @click="handleVote(prKey, -5, 'Wait')">{{ busyAction === 'vote--5' ? 'Submitting…' : 'Wait' }}</button>
          <button type="button" :class="['button', 'button--ghost', 'danger', busyAction === 'vote--10' && 'button--busy']" :disabled="!!busyAction" @click="handleVote(prKey, -10, 'Reject')">{{ busyAction === 'vote--10' ? 'Rejecting…' : 'Reject' }}</button>
          <button type="button" :class="['button', 'button--ghost', busyAction === 'vote-0' && 'button--busy']" :disabled="!!busyAction" @click="handleVote(prKey, 0, 'Clear')">{{ busyAction === 'vote-0' ? 'Clearing…' : 'Clear vote' }}</button>
        </div>
        <div class="docker-card__actions">
          <button type="button" class="button" :disabled="!!busyAction" @click="$emit('new-comment')">New comment</button>
        </div>

        <div class="review-section-divider"><span>Git operations</span></div>
        <div class="docker-card__actions">
          <button type="button" :class="['button', 'button--ghost', busyAction === 'fetch' && 'button--busy']" :disabled="!!busyAction" @click="handleFetch(workspaceId)">{{ busyAction === 'fetch' ? 'Fetching…' : 'Fetch' }}</button>
          <button type="button" :class="['button', 'button--ghost', busyAction === 'rebase' && 'button--busy']" :disabled="!!busyAction" @click="handleRebase(workspaceId)">{{ busyAction === 'rebase' ? 'Rebasing…' : 'Rebase on target' }}</button>
          <button type="button" :class="['button', 'button--ghost', busyAction === 'push' && 'button--busy']" :disabled="!!busyAction" @click="handlePush(workspaceId)">{{ busyAction === 'push' ? 'Pushing…' : 'Push branch' }}</button>
          <button type="button" class="button button--ghost" :disabled="!!busyAction" @click="gitUiStore.openLazygit(workspaceId)">Open Lazygit</button>
        </div>
      </article>
      <div class="review-sidebar">
        <!-- Reviewers -->
        <article class="git-card review-card">
          <div class="section-head"><div><p class="eyebrow">Reviewers</p></div></div>
          <ul v-if="reviewers.length" class="git-list">
            <li v-for="r in reviewers" :key="r.displayName">
              <span class="git-status-code">{{ r.vote }}</span>
              <span class="git-list__text">{{ r.displayName }}</span>
            </li>
          </ul>
          <p v-else class="git-card__hint" style="color:var(--muted);">No reviewers assigned</p>
        </article>
        <!-- Changed files count -->
        <article class="git-card review-card">
          <div class="section-head"><div><p class="eyebrow">Changed Files</p><h3>{{ changedFiles.length }} files</h3></div></div>
          <ul class="git-list">
            <li v-for="file in changedFiles.slice(0, 10)" :key="file.path">
              <span class="git-status-code">{{ file.changeType || 'M' }}</span>
              <span class="git-list__text git-list__text--path">{{ file.path }}</span>
            </li>
            <li v-if="changedFiles.length > 10"><span class="git-card__hint">… and {{ changedFiles.length - 10 }} more</span></li>
          </ul>
        </article>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";

defineProps({
  detail: { type: Object, required: true },
  pullRequest: { type: Object, required: true },
  reviewers: { type: Array, required: true },
  checks: { type: Object, required: true },
  changedFiles: { type: Array, required: true },
  prKey: { type: String, required: true },
  workspaceId: { type: String, required: true },
});

defineEmits(["new-comment"]);

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

const busyAction = ref("");

async function handleVote(prKey, vote, label) {
  busyAction.value = `vote-${vote}`;
  try { await appStore.azureVote(prKey, vote); }
  finally { busyAction.value = ""; }
}

async function handleFetch(workspaceId) {
  busyAction.value = "fetch";
  try { await appStore.azureFetchReviewWorkspace(workspaceId); }
  finally { busyAction.value = ""; }
}

async function handleRebase(workspaceId) {
  busyAction.value = "rebase";
  try { await appStore.azureRebaseReviewWorkspace(workspaceId); }
  finally { busyAction.value = ""; }
}

async function handlePush(workspaceId) {
  busyAction.value = "push";
  try { await appStore.azurePushReviewWorkspace(workspaceId); }
  finally { busyAction.value = ""; }
}

function stripRef(ref) { return String(ref || "").replace(/^refs\/heads\//, ""); }
</script>
