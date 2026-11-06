<template>
  <div class="review-panel">
    <div class="review-grid review-grid--summary">
      <article class="git-card review-card review-card--hero">
        <div class="section-head">
          <div>
            <p class="eyebrow">Overview</p>
            <h3>{{ pullRequest.title || "Azure review" }}</h3>
          </div>
        </div>
        <div v-if="pullRequest.description" class="git-card__hint azure-review__description">
          <MarkdownContent :text="pullRequest.description" :jira-routes="jiraRoutes || []" />
        </div>
        <section v-if="jiraIssueRefs?.length" class="git-card" aria-label="Linked Jira context">
          <strong>Linked Jira context</strong>
          <button
            v-for="item in jiraIssueRefs"
            :key="`${item.ref.connectionId}:${item.ref.issueId}`"
            type="button"
            class="button button--ghost button--small"
            @click="loadJiraContext(item)"
          >
            {{ item.ref.issueKey }} · {{ item.summary }} <span v-if="item.status">({{ item.status }})</span>
          </button>
          <p v-if="jiraContextLoading" class="git-card__hint" role="status">Loading Jira issue…</p>
          <article v-if="jiraIssue" class="review-jira-issue" aria-label="Jira issue detail">
            <header class="review-jira-issue__head">
              <strong class="review-jira-issue__key">{{ jiraIssue.ref?.issueKey }}</strong>
              <span v-if="jiraIssue.status" class="review-jira-issue__status">{{ jiraIssue.status }}</span>
            </header>
            <p class="review-jira-issue__summary">{{ jiraIssue.summary }}</p>
            <p class="review-jira-issue__meta">
              {{ jiraIssueMeta }}
            </p>
            <MarkdownContent
              v-if="jiraIssue.descriptionMarkdown || jiraIssue.description"
              class="review-jira-issue__description"
              :text="jiraIssue.descriptionMarkdown || jiraIssue.description"
              :jira-routes="jiraRoutes || []"
              :rich-text="!!jiraIssue.descriptionMarkdown"
              :plain-text="!jiraIssue.descriptionMarkdown"
            />
          </article>
          <p v-if="jiraContextError" class="git-card__hint git-card__hint--warning" role="alert">
            {{ jiraContextError }}
          </p>
        </section>
        <p class="git-card__hint" style="font-family: monospace; font-size: 12px">
          {{ stripRef(pullRequest.sourceRefName) }} &rarr; {{ stripRef(pullRequest.targetRefName) }}
        </p>

        <!-- Author & meta -->
        <div v-if="detail" style="display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 4px 0">
          <span v-if="detail.author" class="review-meta"
            ><span class="review-meta__label">Author</span> {{ detail.author.displayName }}</span
          >
          <span v-if="pullRequest.creationDate" class="review-meta"
            ><span class="review-meta__label">Created</span> {{ formatDate(pullRequest.creationDate) }}</span
          >
          <span
            v-if="pullRequest.isDraft"
            class="workspace-chip"
            style="background: var(--accent); color: var(--bg); font-size: 10px"
            >Draft</span
          >
          <span class="review-meta"
            ><span class="review-meta__label">Status</span> {{ pullRequest.status || "unknown" }}</span
          >
          <span v-if="detail.role" class="review-meta"
            ><span class="review-meta__label">Role</span> {{ detail.role }}</span
          >
        </div>

        <!-- Merge status / Conflicts — always prominent -->
        <div v-if="conflictInfo.hasConflicts" class="review-conflict-banner review-conflict-banner--danger">
          <span class="review-conflict-banner__icon">✗</span>
          <div>
            <strong>{{ conflictInfo.label }}</strong>
            <p class="review-conflict-banner__hint">
              Merge conflicts between <code>{{ stripRef(pullRequest.sourceRefName) }}</code> and
              <code>{{ stripRef(pullRequest.targetRefName) }}</code>
            </p>
            <ul v-if="changedFiles.length" class="review-conflict-files">
              <li v-for="file in changedFiles" :key="file.path">
                <span class="git-status-code">{{ file.changeType || "edit" }}</span>
                <span class="git-list__text git-list__text--path">{{ file.path }}</span>
              </li>
            </ul>
          </div>
        </div>
        <div v-else class="review-conflict-banner review-conflict-banner--ok">
          <span class="review-conflict-banner__icon">✓</span>
          <div>
            <strong>{{ conflictInfo.label }}</strong>
          </div>
        </div>

        <div class="review-section-divider"><span>Review actions</span></div>
        <div class="docker-card__actions docker-card__actions--end">
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'vote-10' && 'button--busy']"
            :disabled="!!busyAction || !canVote"
            :title="
              voteDisabledTitle(
                'Vote +10: Approve this PR on Azure DevOps. The vote is recorded under your reviewer profile.',
              )
            "
            @click="handleVote(prKey, 10, 'Approve')"
          >
            {{ busyAction === "vote-10" ? "Approving…" : "Approve" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'vote-5' && 'button--busy']"
            :disabled="!!busyAction || !canVote"
            :title="
              voteDisabledTitle(
                'Vote +5: Approve with suggestions — looks good but has minor feedback that the author can address before merge.',
              )
            "
            @click="handleVote(prKey, 5, 'Approve')"
          >
            {{ busyAction === "vote-5" ? "Submitting…" : "Approve with suggestions" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'vote--5' && 'button--busy']"
            :disabled="!!busyAction || !canVote"
            :title="
              voteDisabledTitle(
                'Vote -5: Wait for author — changes needed before approval. Author should address comments and re-request review.',
              )
            "
            @click="handleVote(prKey, -5, 'Wait')"
          >
            {{ busyAction === "vote--5" ? "Submitting…" : "Wait" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', 'danger', busyAction === 'vote--10' && 'button--busy']"
            :disabled="!!busyAction || !canVote"
            :title="
              voteDisabledTitle(
                'Vote -10: Reject this PR. Strong signal — only Reset Vote or a new revision can clear it.',
              )
            "
            @click="handleVote(prKey, -10, 'Reject')"
          >
            {{ busyAction === "vote--10" ? "Rejecting…" : "Reject" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'vote-0' && 'button--busy']"
            :disabled="!!busyAction || !canVote"
            :title="voteDisabledTitle('Reset your vote to 0 (no vote) on this PR.')"
            @click="handleVote(prKey, 0, 'Clear')"
          >
            {{ busyAction === "vote-0" ? "Clearing…" : "Clear vote" }}
          </button>
        </div>
        <div class="docker-card__actions">
          <button
            type="button"
            class="button"
            :disabled="!!busyAction"
            title="Create a new draft comment — saved locally, you can edit and publish to Azure later"
            @click="$emit('new-comment')"
          >
            New comment
          </button>
        </div>

        <div class="review-section-divider"><span>Git operations</span></div>
        <div class="docker-card__actions docker-card__actions--end">
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'push' && 'button--busy']"
            :disabled="!!busyAction || gitOperationRunning || !canPush"
            :title="
              !canPush
                ? 'Nothing to push — no local commits ahead of the remote tracking branch.'
                : 'Push the commits of this checkout to the source branch of the pull request. The runtime checks the real state first and only fast-forwards; it explains why when it cannot.'
            "
            @click="handlePush(workspaceId)"
          >
            {{ busyAction === "push" ? "Pushing…" : "Push branch" }}
          </button>
          <!-- Advanced git actions (history-rewriting or ad-hoc) live behind
               this menu so the common flow — Refresh + Push — isn't
               crowded by buttons most reviews never need. -->
          <div ref="advancedMenuRef" style="position: relative">
            <button
              type="button"
              class="button button--ghost"
              :aria-expanded="advancedMenuOpen"
              title="More git actions: rebase onto target or force push"
              @click="advancedMenuOpen = !advancedMenuOpen"
            >
              More git actions ⋯
            </button>
            <div
              v-if="advancedMenuOpen"
              style="
                position: absolute;
                right: 0;
                top: 100%;
                margin-top: 4px;
                z-index: 20;
                display: flex;
                flex-direction: column;
                gap: 4px;
                padding: 6px;
                background: var(--bg-elevated, var(--panel, #1e1e1e));
                border: 1px solid var(--border);
                border-radius: 6px;
                min-width: 220px;
              "
            >
              <button
                type="button"
                :class="['button', 'button--ghost', busyAction === 'rebase' && 'button--busy']"
                :disabled="!!busyAction || gitOperationRunning || !canRebase"
                :title="
                  !canRebase
                    ? 'Rebase is unnecessary — your branch is already up to date with the PR target.'
                    : 'Rebase this checkout onto the latest pull request target branch (you are shown what is rewritten and asked first). It never pushes. Conflicts will be reported in the Conflicts tab.'
                "
                @click="handleRebase(workspaceId)"
              >
                {{ busyAction === "rebase" ? "Rebasing…" : "Rebase on target" }}
              </button>
              <button
                type="button"
                :class="['button', 'button--ghost', busyAction === 'force-push' && 'button--busy']"
                :disabled="!!busyAction || gitOperationRunning || !canForcePush"
                :title="
                  !canForcePush
                    ? 'Force push is unnecessary — local and remote agree.'
                    : 'Force push to the source branch of the pull request, leasing the exact commit currently on the server. Use after a rebase; you are asked first if the server has commits you do not have.'
                "
                @click="handleForcePush(workspaceId)"
              >
                {{ busyAction === "force-push" ? "Force pushing…" : "Force push" }}
              </button>
            </div>
          </div>
        </div>
        <p v-if="pushError" class="git-card__hint" style="color: var(--danger, #e53935); padding: 4px 0">
          {{ pushError }}
        </p>
      </article>
      <div class="review-sidebar">
        <!-- Checks -->
        <article class="git-card review-card">
          <div class="section-head">
            <div><p class="eyebrow">Checks</p></div>
          </div>
          <template v-if="checks.items?.length">
            <div v-for="item in checks.items" :key="item.id" class="review-check-row">
              <span :class="['review-check-icon', `review-check-icon--${item.state}`]">{{
                checkIcon(item.state)
              }}</span>
              <div>
                <strong style="font-size: 12px">{{ item.name }}</strong>
                <p v-if="item.stateLabel && item.stateLabel !== item.state" class="git-card__hint" style="margin: 0">
                  {{ item.stateLabel }}
                </p>
                <p v-if="item.source" class="git-card__hint" style="margin: 0; font-size: 10px; color: var(--muted)">
                  {{ item.optional ? "optional" : "required" }} &middot; {{ item.source }}
                </p>
              </div>
            </div>
          </template>
          <p v-else class="git-card__hint" style="color: var(--muted)">No checks configured</p>
        </article>
        <!-- Reviewers -->
        <article class="git-card review-card">
          <div class="section-head">
            <div><p class="eyebrow">Reviewers</p></div>
          </div>
          <ul v-if="reviewers.length" class="git-list">
            <li v-for="r in reviewers" :key="r.displayName" style="display: flex; align-items: center; gap: 8px">
              <span :class="['review-vote-badge', `review-vote-badge--${voteClass(r.vote)}`]">{{ r.vote }}</span>
              <div>
                <span class="git-list__text">{{ r.displayName }}</span>
                <br /><small style="color: var(--muted)"
                  >{{ voteLabel(r.vote) }}{{ r.isRequired ? "" : " (optional)" }}</small
                >
              </div>
            </li>
          </ul>
          <p v-else class="git-card__hint" style="color: var(--muted)">No reviewers assigned</p>
        </article>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { useDismissable } from "../../../composables/useDismissable.js";
import MarkdownContent from "./MarkdownContent.vue";
import { userFacingMessage } from "../../../lib/error-message.js";
import { rlog } from "../../../lib/renderer-log.js";
import { jiraFailureCode } from "../jira/pane/jira-failure.js";

const props = defineProps<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detail?: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pullRequest: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reviewers: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checks: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changedFiles: Array<Record<string, any>>;
  prKey: string;
  workspaceId: string;
  jiraIssueRefs?: Array<{
    ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
    summary?: string;
    status?: string;
  }>;
  jiraRoutes?: Array<{ connectionId: string; label: string; webUrl: string; issueKeyPrefixes: string[] }>;
}>();

defineEmits<{ (e: "new-comment"): void }>();

const appStore = useAppStore();
const notifications = useNotificationStore();
type JiraReviewIssue = {
  ref?: { issueKey?: string };
  summary?: string;
  status?: string;
  issueType?: string;
  projectKey?: string;
  updated?: string;
  assignee?: string;
  description?: string;
  descriptionMarkdown?: string;
};
const jiraIssue = ref<JiraReviewIssue | null>(null);
const jiraContextLoading = ref(false);
const jiraContextError = ref("");
let jiraContextRequestId = 0;
const jiraIssueMeta = computed(() => {
  const issue = jiraIssue.value;
  if (!issue) return "";
  const updated = issue.updated ? Date.parse(issue.updated) : NaN;
  return [
    issue.issueType,
    issue.projectKey,
    issue.assignee ? `Assignee: ${issue.assignee}` : "",
    issue.updated
      ? `Updated ${Number.isNaN(updated) ? issue.updated : new Date(updated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
});
async function loadJiraContext(item: NonNullable<typeof props.jiraIssueRefs>[number]) {
  const requestId = ++jiraContextRequestId;
  jiraIssue.value = null;
  jiraContextError.value = "";
  jiraContextLoading.value = true;
  try {
    const issue = await appStore
      .getApi()
      .getJiraIssue?.({ connectionId: item.ref.connectionId, issueId: item.ref.issueId });
    if (!issue) throw new Error("Jira issue detail is unavailable.");
    if (requestId !== jiraContextRequestId) return;
    jiraIssue.value = issue as JiraReviewIssue;
  } catch (cause) {
    if (requestId !== jiraContextRequestId) return;
    jiraContextError.value = userFacingMessage(cause, "Could not load Jira review context.");
    rlog("warn", "[jira] review summary issue load failed", {
      issueKey: item.ref.issueKey,
      code: jiraFailureCode(cause),
    });
  } finally {
    if (requestId === jiraContextRequestId) jiraContextLoading.value = false;
  }
}

const busyAction = ref<string>("");

// 6.2: surface why a button is disabled. Voting on your own PR is rejected
// by Azure; force-push only makes sense after a rebase or when ahead of
// remote; rebase only makes sense when the branch is behind its target;
// push only makes sense when there are local commits ahead of remote.
const isOwnPr = computed(() => {
  const me = String(props.detail?.currentUserId || props.detail?.connection?.currentUserId || "").toLowerCase();
  const author = String(
    props.pullRequest?.createdBy?.id || props.pullRequest?.createdBy?.uniqueName || props.detail?.author?.id || "",
  ).toLowerCase();
  return !!me && !!author && me === author;
});

const isReviewer = computed(() => {
  const role = String(props.detail?.role || "").toLowerCase();
  if (role === "reviewer") return true;
  return Array.isArray(props.reviewers) && props.reviewers.length > 0;
});

const gitSnapshot = computed(() => appStore.getGitSnapshot(props.workspaceId) as Record<string, unknown> | null);
const aheadCount = computed(() => Number((gitSnapshot.value as { aheadCount?: number } | null)?.aheadCount || 0));
const behindCount = computed(() => Number((gitSnapshot.value as { behindCount?: number } | null)?.behindCount || 0));

// Rebase-on-target must be driven by HEAD vs the PR's TARGET branch, not the
// top-level aheadCount/behindCount above (those are HEAD vs the source
// branch's upstream — see git-manager.ts's readBaseComparison comment). A
// dedicated, ad-hoc compare kept local to this component (not the shared
// git-ui `baseComparison` slot, which the Git tab's "Compare with base"
// picker also writes to for an unrelated branch).
const targetComparison = ref<{ aheadCount: number; behindCount: number; ok: boolean } | null>(null);

async function refreshTargetComparison(): Promise<void> {
  const targetBranch = stripRef(props.pullRequest?.targetRefName || "");
  if (!targetBranch || !props.workspaceId) {
    targetComparison.value = null;
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    const result = await api.gitCompareBranch({ workspaceId: props.workspaceId, baseBranch: `origin/${targetBranch}` });
    targetComparison.value = {
      aheadCount: Number(result?.aheadCount || 0),
      behindCount: Number(result?.behindCount || 0),
      ok: !!result?.ok,
    };
  } catch {
    targetComparison.value = { aheadCount: 0, behindCount: 0, ok: false };
  }
}

// Re-check whenever the target ref changes, or whenever the git snapshot
// moves (after Refresh/rebase/push) — the target comparison itself is not
// part of the snapshot and would otherwise go stale.
watch(
  [() => props.workspaceId, () => props.pullRequest?.targetRefName, gitSnapshot],
  () => {
    void refreshTargetComparison();
  },
  { immediate: true },
);

const voteDisabledReason = computed(() => {
  if (busyAction.value) return "";
  if (isOwnPr.value) return "Azure DevOps does not allow voting on your own pull request.";
  if (!isReviewer.value)
    return "Only assigned reviewers can vote. Add yourself as a reviewer in Azure or via the &quot;Add me&quot; flow.";
  return "";
});
const canVote = computed(() => !voteDisabledReason.value);
const voteDisabledTitle = (base: string) => (voteDisabledReason.value ? voteDisabledReason.value : base);

// A review Git operation is running for this workspace (backend state: it also
// shows after a reload, or when an agent or another client started it).
const gitOperationRunning = computed(() => appStore.isReviewGitBusy?.(props.workspaceId) === true);
const canPush = computed(() => aheadCount.value > 0);
const canForcePush = computed(() => aheadCount.value > 0 || behindCount.value > 0);
const canRebase = computed(() => (targetComparison.value?.behindCount || 0) > 0);

// Advanced git actions (rebase/force-push/Lazygit) live in this overflow
// menu — see the "Git operations" section above.
const advancedMenuOpen = ref(false);
const advancedMenuRef = ref<HTMLElement | null>(null);
useDismissable(advancedMenuOpen, advancedMenuRef, { onDismiss: () => (advancedMenuOpen.value = false) });

const conflictInfo = computed(() => {
  const status = props.pullRequest.mergeStatus || "";
  const conflictStatuses = ["conflicts", "rejectedByPolicy", "renamedSourceBranch", "manualMergeRequired"];
  const hasConflicts = conflictStatuses.includes(status);
  return {
    hasConflicts,
    label: hasConflicts
      ? "Merge conflicts detected"
      : status === "succeeded"
        ? "No merge conflicts"
        : `Merge status: ${status || "unknown"}`,
  };
});

function checkIcon(state: unknown) {
  if (state === "passed" || state === "approved") return "✓";
  if (state === "failed" || state === "rejected") return "✗";
  return "●";
}

function voteClass(vote: unknown): string {
  if ((vote as number) > 0) return "approved";
  if ((vote as number) < 0) return "rejected";
  return "none";
}

function voteLabel(vote: unknown): string {
  if (vote === 10) return "Approved";
  if (vote === 5) return "Approved with suggestions";
  if (vote === -5) return "Waiting for author";
  if (vote === -10) return "Rejected";
  return "No vote yet";
}

function formatDate(iso: unknown): string {
  if (!iso) return "";
  const d = new Date(iso as string);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

async function handleVote(prKey: string, vote: number, label: string) {
  busyAction.value = `vote-${vote}`;
  try {
    await notifications.runWithToast(`${label} failed`, () => appStore.azureVote(prKey, vote));
  } finally {
    busyAction.value = "";
  }
}

// A blocked outcome is a refusal with a reason, not a crash: it reads as the
// action's own error. A declined confirmation is "nothing happened".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function failureOf(outcome: any): string {
  const result = outcome?.push ?? outcome;
  if (result?.status === "blocked") return [result.message, result.guidance].filter(Boolean).join(" ");
  if (result?.status === "conflict") return result.message || "The rebase stopped with conflicts.";
  return "";
}

async function handleRebase(workspaceId: string) {
  busyAction.value = "rebase";
  try {
    await notifications.runWithToast("Rebase failed", async () => {
      const failure = failureOf(await appStore.rebaseReviewCheckout(workspaceId));
      if (failure) throw new Error(failure);
    });
  } finally {
    busyAction.value = "";
  }
}

const pushError = ref<string>("");

async function handlePush(workspaceId: string, { force = false } = {}) {
  busyAction.value = force ? "force-push" : "push";
  pushError.value = "";
  try {
    pushError.value = failureOf(await appStore.pushReviewCheckout(workspaceId, { force }));
  } catch (error) {
    pushError.value = (error as Error)?.message || String(error || (force ? "Force push failed." : "Push failed."));
  } finally {
    busyAction.value = "";
  }
}

function handleForcePush(workspaceId: string) {
  return handlePush(workspaceId, { force: true });
}

function stripRef(ref: unknown) {
  return String(ref || "").replace(/^refs\/heads\//, "");
}
</script>

<style scoped>
.review-jira-issue {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
}
.review-jira-issue__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.review-jira-issue__status {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--muted);
  font-size: 11px;
}
.review-jira-issue__summary {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.review-jira-issue__meta {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.review-jira-issue__description {
  max-height: 240px;
  overflow: auto;
  padding-top: 6px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
</style>
