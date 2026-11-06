<template>
  <article
    :class="[
      'azure-pr-row',
      showRepo && 'azure-pr-row--with-repo',
      unread && 'azure-pr-row--unread',
      isOld && 'azure-pr-row--old',
      item.hasAttention && 'azure-pr-row--attention',
      expanded && 'azure-pr-row--expanded',
      focused && 'azure-pr-row--focused',
    ]"
    :data-pr-key="item.prKey"
    :data-connection-id="item.connectionId"
  >
    <div class="azure-pr-row__line">
      <!-- One line of fixed columns, so a list reads top to bottom: the repository, the title, then who and when.
           Everything else is in the hover card and in the expanded details. -->
      <div class="azure-pr-row__info" @pointerenter="onHoverStart" @pointerleave="onHoverEnd">
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
          <svg class="pr-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path v-for="d in expanded ? icons.chevronDown : icons.chevronRight" :key="d" :d="d" />
          </svg>
        </button>
        <span v-if="showRepo" class="azure-pr-row__repo" :aria-label="`Repository ${repoMeta}`">{{
          repoParts.name
        }}</span>
        <span class="azure-pr-row__id">#{{ prNumber }}</span>
        <span class="azure-pr-row__title">
          <strong class="azure-pr-row__name"
            ><span v-if="unread" class="azure-pr-row__sr">Unread: </span
            ><span v-if="titleParts.prefix" class="azure-pr-row__keys">{{ titleParts.prefix }}</span
            >{{ titleParts.rest }}</strong
          >
          <span v-if="isDraft" class="azure-pr-row__chip azure-pr-row__chip--draft">Draft</span>
          <span
            v-if="showAttentionChip"
            :class="[
              'azure-pr-row__chip',
              'azure-pr-row__chip--attention',
              isBlockingReason(reasonCode) && 'azure-pr-row__chip--danger',
            ]"
          >
            <svg class="pr-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path v-for="d in icons[attentionIcon]" :key="d" :d="d" />
            </svg>
            {{ attentionText }}
          </span>
        </span>
        <span class="azure-pr-row__flags">
          <span v-if="hasConflicts && reasonCode !== 'conflicts'" class="azure-pr-row__conflicts">
            <svg class="pr-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path v-for="d in icons.warning" :key="d" :d="d" />
            </svg>
            Conflicts
          </span>
          <span v-if="totalComments > 0" class="azure-pr-row__comments" :aria-label="`Comments: ${commentLabel}`">
            <svg class="pr-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path v-for="d in icons.comment" :key="d" :d="d" />
            </svg>
            {{ totalComments }}
          </span>
        </span>
        <span :class="['azure-pr-row__author', isAuthor && 'azure-pr-row__author--you']">{{ authorShort }}</span>
        <span :class="['azure-pr-row__age', `azure-pr-row__age--${ageTone}`]">{{ activityAge }}</span>
      </div>
      <div class="azure-pr-row__actions">
        <button
          v-if="attachWorkspaceId"
          type="button"
          class="azure-pr-row__btn"
          :disabled="opening"
          :title="attachTitle"
          @click="handleAttach"
        >
          Work here
        </button>
        <button
          type="button"
          :class="['azure-pr-row__btn', 'azure-pr-row__btn--primary', opening && 'button--busy']"
          :disabled="opening"
          :title="actionTitle"
          @click="handleOpen"
        >
          {{ opening ? "Opening…" : actionLabel }}
        </button>
        <button
          type="button"
          class="azure-pr-row__btn azure-pr-row__btn--icon"
          :aria-label="`Open #${prNumber} in the browser`"
          title="Open this pull request in your default browser."
          @click="handleBrowser"
        >
          <svg class="pr-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path v-for="d in icons.external" :key="d" :d="d" />
          </svg>
        </button>
        <button
          type="button"
          :class="['azure-pr-row__btn', 'azure-pr-row__btn--icon', !canMarkRead && 'azure-pr-row__btn--idle']"
          :aria-label="`Mark #${prNumber} as read`"
          :disabled="!canMarkRead"
          :tabindex="canMarkRead ? undefined : -1"
          title="Mark as read until this pull request changes again."
          @click="canMarkRead && emit('seen', item.prKey)"
        >
          <svg class="pr-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path v-for="d in icons.check" :key="d" :d="d" />
          </svg>
        </button>
      </div>
    </div>
    <div v-if="expanded" class="azure-pr-row__details">
      <section class="azure-pr-row__section azure-pr-row__section--wide">
        <h3>Since you last looked &middot; {{ lastSeenLabel }}</h3>
        <p v-if="newCommentsLabel" class="azure-pr-row__event">{{ newCommentsLabel }}</p>
        <p v-if="reasonLabel" class="azure-pr-row__event">{{ reasonLabel }}</p>
        <p v-if="!isGitHub && latestCommentPreview" class="azure-pr-row__comment-preview">
          <span class="azure-pr-row__comment-label">Latest comment</span>
          <span class="azure-pr-row__comment-body">{{ latestCommentPreview }}</span>
        </p>
        <p v-if="!newCommentsLabel && !reasonLabel && !latestCommentPreview" class="azure-pr-row__event--empty">
          Nothing new since then.
        </p>
        <p v-if="descriptionText" class="azure-pr-row__description">{{ descriptionText }}</p>
        <p v-else class="azure-pr-row__description azure-pr-row__description--empty">No description provided.</p>
      </section>
      <section class="azure-pr-row__section">
        <h3>Reviewers</h3>
        <div v-for="reviewer in reviewers" :key="reviewer.key" class="azure-pr-row__reviewer">
          <span :class="['azure-pr-row__vote-dot', `azure-pr-row__vote-dot--${reviewer.state}`]"></span>
          <span class="azure-pr-row__reviewer-name"
            >{{ reviewer.name }}{{ reviewer.you ? " (you)" : ""
            }}{{ reviewer.member ? " · you're a member" : "" }}</span
          >
          <span class="azure-pr-row__reviewer-vote">{{ reviewer.voteText }}</span>
          <span v-if="reviewer.required" class="azure-pr-row__required">required</span>
        </div>
        <p v-if="!reviewers.length" class="azure-pr-row__event--empty">No reviewers yet.</p>
      </section>
      <section class="azure-pr-row__section">
        <h3>Status</h3>
        <dl class="azure-pr-row__facts">
          <div v-if="branchLabel" class="azure-pr-row__fact">
            <dt>Branch</dt>
            <dd class="azure-pr-row__fact--mono">{{ branchLabel }}</dd>
          </div>
          <div v-if="mergeStatusLabel" class="azure-pr-row__fact">
            <dt>Merge</dt>
            <dd :class="hasConflicts ? 'azure-pr-row__fact--bad' : mergeClean ? 'azure-pr-row__fact--good' : ''">
              {{ mergeStatusLabel }}
            </dd>
          </div>
          <div v-if="commentLabel" class="azure-pr-row__fact">
            <dt>Comments</dt>
            <dd>{{ commentLabel }}</dd>
          </div>
          <div v-if="checksLabel" class="azure-pr-row__fact">
            <dt>Checks</dt>
            <dd>{{ checksLabel }}</dd>
          </div>
          <div v-if="createdDate" class="azure-pr-row__fact">
            <dt>Opened</dt>
            <dd>{{ formatFull(createdDate) }}</dd>
          </div>
          <div v-if="lastActivity" class="azure-pr-row__fact">
            <dt>Last activity</dt>
            <dd>{{ formatFull(lastActivity) }}</dd>
          </div>
          <div v-if="headShaValue" class="azure-pr-row__fact">
            <dt>HEAD</dt>
            <dd>
              <code>{{ shortSha(headShaValue) }}</code>
            </dd>
          </div>
        </dl>
      </section>
    </div>
    <!-- Informational only (no controls, pointer-events off), so it never holds the pointer; the expanded details
         carry the same facts for touch and keyboard. -->
    <Teleport to="body">
      <div
        v-if="hoverOpen"
        ref="hoverCard"
        class="azure-pr-hovercard"
        role="tooltip"
        :style="{ top: `${hoverPos.top}px`, left: `${hoverPos.left}px` }"
      >
        <div class="azure-pr-hovercard__head">
          <span class="azure-pr-row__id">#{{ prNumber }}</span>
          <span class="azure-pr-hovercard__repo">{{ repoMeta }}</span>
          <span v-if="isDraft" class="azure-pr-row__chip azure-pr-row__chip--draft">Draft</span>
        </div>
        <p class="azure-pr-hovercard__title">{{ titleText }}</p>
        <p
          v-for="reason in reasonTexts"
          :key="reason.text"
          :class="['azure-pr-hovercard__reason', reason.blocking && 'azure-pr-hovercard__reason--danger']"
        >
          {{ reason.text }}
        </p>
        <dl class="azure-pr-row__facts">
          <div class="azure-pr-row__fact">
            <dt>Author</dt>
            <dd>{{ authorFull }}</dd>
          </div>
          <div v-if="branchLabel" class="azure-pr-row__fact">
            <dt>Branch</dt>
            <dd class="azure-pr-row__fact--mono">{{ branchLabel }}</dd>
          </div>
          <div v-if="createdAge" class="azure-pr-row__fact">
            <dt>Opened</dt>
            <dd>{{ createdAge }} &middot; {{ formatFull(createdDate) }}</dd>
          </div>
          <div v-if="activityAge" class="azure-pr-row__fact">
            <dt>Last activity</dt>
            <dd>{{ activityAge }} &middot; {{ formatFull(lastActivity) }}</dd>
          </div>
          <div v-if="commentLabel" class="azure-pr-row__fact">
            <dt>Comments</dt>
            <dd>{{ commentLabel }}</dd>
          </div>
          <div v-if="mergeStatusLabel" class="azure-pr-row__fact">
            <dt>Merge</dt>
            <dd :class="hasConflicts ? 'azure-pr-row__fact--bad' : mergeClean ? 'azure-pr-row__fact--good' : ''">
              {{ mergeStatusLabel }}
            </dd>
          </div>
          <div v-if="checksLabel" class="azure-pr-row__fact">
            <dt>Checks</dt>
            <dd>{{ checksLabel }}</dd>
          </div>
        </dl>
        <div v-if="reviewers.length" class="azure-pr-hovercard__reviewers">
          <div v-for="reviewer in reviewers" :key="reviewer.key" class="azure-pr-hovercard__reviewer">
            <span
              role="img"
              :aria-label="reviewer.title"
              :class="[
                'azure-avatar',
                reviewer.isGroup && 'azure-avatar--group',
                reviewer.ring && 'azure-avatar--ring',
              ]"
              :style="{ background: `hsl(${reviewer.hue} 48% 36%)` }"
            >
              {{ reviewer.initials }}
              <span :class="['azure-avatar__badge', `azure-avatar__badge--${reviewer.state}`]">
                <svg v-if="reviewer.state !== 'none'" class="pr-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    v-for="d in reviewer.state === 'approved'
                      ? icons.check
                      : reviewer.state === 'waiting'
                        ? icons.clock
                        : icons.x"
                    :key="d"
                    :d="d"
                  />
                </svg>
              </span>
            </span>
            <span class="azure-pr-row__reviewer-name"
              >{{ reviewer.name }}{{ reviewer.you ? " (you)" : ""
              }}{{ reviewer.member ? " · you're a member" : "" }}</span
            >
            <span class="azure-pr-row__reviewer-vote">{{ reviewer.voteText }}</span>
            <span v-if="reviewer.required" class="azure-pr-row__required">required</span>
          </div>
        </div>
      </div>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { formatFull, formatRelative, stripRef } from "./azure/azurePipelineFormat.js";
import {
  shortSha,
  daysSince,
  isUnread,
  hasAcknowledgeableChange,
  shortPersonName,
  splitTicketPrefix,
  PR_ICONS,
} from "./prRowFormat.js";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    item: Record<string, any>;
    opening?: boolean;
    focused?: boolean;
    showRepo?: boolean;
    currentUserLogin?: string;
    provider?: "azure" | "github";
    /** Attention reasons the section heading already states ("Waiting for your review"), so no chip repeats them. */
    impliedReasonCodes?: string[];
  }>(),
  {
    opening: false,
    focused: false,
    showRepo: false,
    currentUserLogin: "",
    provider: "azure",
    impliedReasonCodes: () => [],
  },
);

const emit = defineEmits<{
  (e: "open", payload: { prKey: string; workspaceId: string; forceReview?: boolean }): void;
  (e: "browser", url: string): void;
  (e: "seen", prKey: string): void;
}>();

const icons = PR_ICONS;
const isGitHub = computed(() => props.provider === "github");

const expanded = ref(false);

watch(
  () => props.focused,
  (focused) => {
    if (focused) expanded.value = true;
  },
  { immediate: true },
);

const pullRequest = computed(() => props.item.pullRequest || {});

const prNumber = computed(() =>
  isGitHub.value ? pullRequest.value.number || pullRequest.value.id : pullRequest.value.id,
);

const titleText = computed(() => pullRequest.value.title || "Untitled pull request");
const titleParts = computed(() => splitTicketPrefix(titleText.value));

const isDraft = computed(() =>
  isGitHub.value ? pullRequest.value.draft || pullRequest.value.isDraft : pullRequest.value.isDraft,
);

const repoParts = computed(() => {
  if (!isGitHub.value) return { owner: props.item.project?.name || "", name: props.item.repository?.name || "" };
  const fullName = String(props.item.repository?.fullName || "");
  const slash = fullName.indexOf("/");
  return slash < 0
    ? { owner: "", name: fullName }
    : { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
});

// GitHub writes "owner/repo"; Azure DevOps "Project / repo".
const repoSeparator = computed(() => (isGitHub.value ? "/" : " / "));

const repoMeta = computed(() =>
  repoParts.value.owner
    ? `${repoParts.value.owner}${repoSeparator.value}${repoParts.value.name}`
    : repoParts.value.name,
);

const isAuthor = computed(() => props.item.role === "author");

const authorDisplayName = computed(() => {
  const author = props.item.author;
  return (author?.displayName as string) || (author?.login as string) || "";
});
const authorShort = computed(() =>
  isAuthor.value ? "You" : shortPersonName(authorDisplayName.value) || "Unknown author",
);
const authorFull = computed(() =>
  isAuthor.value
    ? authorDisplayName.value
      ? `${authorDisplayName.value} (you)`
      : "You"
    : authorDisplayName.value || "Unknown author",
);

const unread = computed(() => isUnread(props.item));

const lastActivity = computed(() => props.item.lastActivityAt || props.item.lastRemoteActivityAt);
const activityDays = computed(() => daysSince(lastActivity.value));
const isOld = computed(() => (activityDays.value ?? 0) >= 30);
const ageTone = computed(() => {
  const days = activityDays.value;
  if (days == null || days >= 30) return "old";
  if (days < 1) return "fresh";
  return days < 7 ? "recent" : "aging";
});
const activityAge = computed(() => formatRelative(lastActivity.value));

const createdDate = computed(() => pullRequest.value.creationDate || pullRequest.value.createdAt);
const createdAge = computed(() => formatRelative(createdDate.value));

const branchLabel = computed(() => {
  const source = stripRef(pullRequest.value.sourceRefName);
  const target = stripRef(pullRequest.value.targetRefName);
  return source || target ? `${source} → ${target}` : "";
});

// The author's own checkout sitting on this PR's source branch. Offered as a
// second, explicitly-labelled action — never as the primary one: the primary
// button means the same thing on every row, and linking a long-lived working
// checkout to a PR is a deliberate choice, not the default reading of a click.
const attachWorkspaceId = computed(() =>
  props.item.role === "author" && props.item.existingWorkspaceId && !props.item.reviewWorkspaceId
    ? (props.item.existingWorkspaceId as string)
    : "",
);

const actionLabel = computed(() => (props.item.reviewWorkspaceId ? "Open" : "Review"));

// Shown for both providers — the two rows offer the same actions, so leaving
// GitHub's buttons unexplained only made them harder to read.
const actionTitle = computed(() =>
  actionLabel.value === "Open"
    ? "Switch to the review workspace already prepared for this PR."
    : "Create a separate review workspace: clones the PR branch into your review root and opens it with the review pane. Your own checkouts are left alone.",
);

const attachTitle = computed(
  () =>
    "Use the checkout you already have on this branch as the PR's workspace: the review pane and the PR's comments land where you work, so you can act on them and push from there. Nothing is cloned.",
);

// Opening acknowledges only activity-based reasons; a review request stays until the user votes.
const canMarkRead = computed(() => hasAcknowledgeableChange(props.item));

const newComments = computed(() => Number(props.item.newCommentsCount || 0));

// Pick an icon that mirrors the attentionReason text. "vote" only ever
// appears in Azure's attentionReason vocabulary — harmless no-op for GitHub.
const REASON_CODE_ICONS: Record<string, "eye" | "push" | "clock" | "warning" | "comment"> = {
  "review-requested": "eye",
  "group-review-requested": "eye",
  "push-after-approval": "push",
  "push-after-feedback": "push",
  "changes-requested": "clock",
  conflicts: "warning",
  "merge-failed": "warning",
  replies: "comment",
};

const reasonList = computed(() => {
  const reasons = props.item.attentionReasons as Array<{ code: string; label?: string }> | undefined;
  return Array.isArray(reasons) ? reasons : [];
});

// The first reason the section heading does not already state; the chip names that one.
const shownReason = computed(() => reasonList.value.find((r) => !props.impliedReasonCodes.includes(r.code)) || null);

const reasonCode = computed(() => (shownReason.value ? String(shownReason.value.code) : ""));

const showAttentionChip = computed(
  () => Boolean(props.item.hasAttention) && (!reasonList.value.length || Boolean(shownReason.value)),
);

const attentionIcon = computed<"comment" | "push" | "vote" | "warning" | "alert" | "eye" | "clock">(() => {
  if (reasonCode.value) return REASON_CODE_ICONS[reasonCode.value] || "alert";
  const reason = String(props.item.attentionReason || "").toLowerCase();
  if (newComments.value > 0 || reason.includes("comment")) return "comment";
  if (reason.includes("vote") || reason.includes("review state") || reason.includes("review decision")) return "vote";
  if (reason.includes("update") || reason.includes("branch")) return "push";
  if (reason.includes("policy") || reason.includes("check") || reason.includes("fail")) return "warning";
  return "alert";
});

const reasonLabel = computed(() => {
  const reason = String(props.item.attentionReason || "").trim();
  return reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : "";
});

const attentionText = computed(() => {
  if (shownReason.value && shownReason.value !== reasonList.value[0]) return String(shownReason.value.label || "");
  if (reasonCode.value) return String(props.item.attentionReason || "") || reasonLabel.value || "Attention";
  if (newComments.value > 0) return `${newComments.value} new comment${newComments.value === 1 ? "" : "s"}`;
  return reasonLabel.value || "Attention";
});

// Every reason, implied ones too: the hover card is where the whole answer to "why is this here" sits.
const reasonTexts = computed((): Array<{ text: string; blocking: boolean }> => {
  if (!props.item.hasAttention) return [];
  const reasons = reasonList.value
    .filter((r) => r.label)
    .map((r) => ({ text: String(r.label), blocking: isBlockingReason(r.code) }));
  return reasons.length ? reasons : [{ text: attentionText.value, blocking: false }];
});

// The PR cannot merge as it is: drawn in the danger colour, not the accent a review request wears.
function isBlockingReason(code: string): boolean {
  return code === "conflicts" || code === "merge-failed";
}

const newCommentsLabel = computed(() =>
  newComments.value > 0 ? `${newComments.value} new comment${newComments.value === 1 ? "" : "s"}` : "",
);

const lastSeenLabel = computed(() =>
  props.item.lastSeenActivityAt ? formatRelative(props.item.lastSeenActivityAt) || "never opened" : "never opened",
);

const descriptionText = computed(() => {
  if (isGitHub.value) {
    // GitHub stores PR body under `body`; older code may have populated
    // `description` directly. Check both for forward compatibility.
    return String(pullRequest.value.body || pullRequest.value.description || "").trim();
  }
  return pullRequest.value.description || "";
});

const hasConflicts = computed(() =>
  isGitHub.value
    ? pullRequest.value.mergeableState === "dirty"
    : String(pullRequest.value.mergeStatus || "") === "conflicts",
);

const mergeClean = computed(() =>
  isGitHub.value
    ? pullRequest.value.mergeableState === "clean"
    : String(pullRequest.value.mergeStatus || "") === "succeeded",
);

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

const totalComments = computed(() => Number(props.item.commentCount || 0));
const openThreads = computed(() => (isGitHub.value ? 0 : Number(props.item.unresolvedThreadCount || 0)));

const commentLabel = computed(() => {
  const total = totalComments.value;
  const fresh = newComments.value;
  if (isGitHub.value) {
    if (!total && !fresh) return "";
    const parts: string[] = [];
    if (total) parts.push(`${total} total`);
    if (fresh) parts.push(`${fresh} new`);
    return parts.join(" · ");
  }
  const unresolved = openThreads.value;
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

type VoteState = "approved" | "waiting" | "rejected" | "none";
const VOTE_TEXT: Record<VoteState, string> = {
  approved: "Approved",
  waiting: "Waiting for author",
  rejected: "Rejected",
  none: "No vote yet",
};

function azureVoteState(vote: unknown): VoteState {
  const value = Number(vote || 0);
  return value > 0 ? "approved" : value === -5 ? "waiting" : value === -10 ? "rejected" : "none";
}

function initialsOf(name: string): string {
  const words = name.split(/[\s._@-]+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0];
  return letters.toUpperCase();
}

function hueOf(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  return hash;
}

const reviewers = computed(() => {
  const raw = (props.item.reviewerSummary?.reviewers || []) as Array<Record<string, unknown>>;
  const me = props.currentUserLogin.toLowerCase();
  return raw.map((r, index) => {
    let state: VoteState;
    let name: string;
    let you: boolean;
    let isGroup: boolean;
    let required = false;
    let member = false;
    let ring = false;
    let voteText: string;
    if (isGitHub.value) {
      const gh = String(r.state || "");
      state = gh === "approved" ? "approved" : gh === "changes_requested" ? "rejected" : "none";
      name = String(r.displayName || r.login || "Unknown reviewer");
      you = Boolean(me) && String(r.login || "").toLowerCase() === me;
      isGroup = Boolean(r.isTeam);
      voteText = gh === "changes_requested" ? "Changes requested" : state === "none" ? "Review requested" : "Approved";
    } else {
      state = azureVoteState(r.vote);
      isGroup = Boolean(r.isContainer);
      name = String(r.displayName || r.uniqueName || "Unknown reviewer");
      // Azure names project-scoped groups "[Project]\Name"; the web UI shows only "Name".
      if (isGroup) name = name.replace(/^\[[^\]]*\]\\/, "") || name;
      you = Boolean(props.item.myReviewerId) && r.id === props.item.myReviewerId;
      required = Boolean(r.isRequired);
      voteText = VOTE_TEXT[state];
      const via = isGroup
        ? (
            props.item.reviewerVia as
              Array<{ id: string; vote: number; covered?: boolean; coveredBy: string | null }> | undefined
          )?.find((v) => v.id === r.id)
        : undefined;
      if (via) {
        member = true;
        if (via.coveredBy) {
          // The group's own vote may still be 0 while the colleague who acted for it voted.
          const colleague = raw.find(
            (other) =>
              !other.isContainer &&
              Number(other.vote || 0) !== 0 &&
              Array.isArray(other.votedFor) &&
              (other.votedFor as Array<{ id?: string }>).some((group) => group?.id === r.id),
          );
          if (state === "none" && colleague) state = azureVoteState(colleague.vote);
          voteText = state === "none" ? `Covered by ${via.coveredBy}` : `${VOTE_TEXT[state]} by ${via.coveredBy}`;
        }
        ring = !(via.covered ?? via.coveredBy) && Number(via.vote || 0) === 0;
      }
    }
    const label = you ? `${name} (you)` : member ? `${name} (you're a member)` : name;
    return {
      key: String(r.id || r.login || r.uniqueName || index),
      name,
      you,
      member,
      isGroup,
      required,
      state,
      voteText,
      initials: initialsOf(name),
      hue: hueOf(name),
      ring: ring || (you && state === "none"),
      title: `${label}: ${voteText}${required ? " · required" : ""}`,
    };
  });
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
  // An author whose checkout matches the PR's branch is attached by the
  // backend's fallback unless the managed checkout is asked for explicitly.
  emit("open", {
    prKey: props.item.prKey as string,
    workspaceId: "",
    forceReview: Boolean(attachWorkspaceId.value),
  });
}

function handleAttach() {
  emit("open", { prKey: props.item.prKey as string, workspaceId: attachWorkspaceId.value });
}

function handleBrowser() {
  // Azure PR summaries may only carry a legacy `.url`; GitHub always has webUrl.
  emit("browser", isGitHub.value ? pullRequest.value.webUrl : pullRequest.value.webUrl || pullRequest.value.url);
}

const HOVER_DELAY_MS = 350;
const hoverOpen = ref(false);
const hoverPos = ref({ top: 0, left: 0 });
const hoverCard = ref<HTMLElement | null>(null);
let hoverTimer: ReturnType<typeof setTimeout> | undefined;

function clearHoverTimer() {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = undefined;
}

// Below the row, starting near the pointer; above it when it would leave the window.
function placeHoverCard(anchor: HTMLElement, pointerX: number) {
  const rect = anchor.getBoundingClientRect();
  const card = hoverCard.value?.getBoundingClientRect();
  const width = card?.width || 420;
  const height = card?.height || 0;
  const below = rect.bottom + 6;
  hoverPos.value = {
    top: below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below,
    left: Math.min(Math.max(8, pointerX - 32), Math.max(8, window.innerWidth - width - 8)),
  };
}

function onHoverStart(event: PointerEvent) {
  // A touch has no hover to end it; the expand toggle shows the same facts there.
  if (event.pointerType === "touch" || expanded.value) return;
  const anchor = event.currentTarget as HTMLElement;
  const pointerX = event.clientX;
  clearHoverTimer();
  hoverTimer = setTimeout(() => {
    hoverTimer = undefined;
    hoverOpen.value = true;
    placeHoverCard(anchor, pointerX);
    void nextTick(() => placeHoverCard(anchor, pointerX));
    window.addEventListener("scroll", closeHoverCard, true);
    window.addEventListener("pointerdown", closeHoverCard, true);
    window.addEventListener("blur", closeHoverCard);
  }, HOVER_DELAY_MS);
}

function closeHoverCard() {
  clearHoverTimer();
  hoverOpen.value = false;
  window.removeEventListener("scroll", closeHoverCard, true);
  window.removeEventListener("pointerdown", closeHoverCard, true);
  window.removeEventListener("blur", closeHoverCard);
}

function onHoverEnd() {
  closeHoverCard();
}

watch(expanded, (open) => {
  if (open) closeHoverCard();
});

onBeforeUnmount(closeHoverCard);
</script>
