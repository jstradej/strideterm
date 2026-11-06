<template>
  <form v-if="canWriteJira && selected.ref" class="jira-comment-composer" @submit.prevent="sendComment">
    <label class="jira-visually-hidden" for="jira-comment-composer-input">Write a comment</label>
    <textarea
      id="jira-comment-composer-input"
      ref="commentComposerInput"
      v-model="commentBody"
      rows="3"
      placeholder="Write a comment… (Ctrl+Enter to send)"
      :aria-invalid="commentBodyError ? 'true' : undefined"
      @keydown.ctrl.enter.prevent="sendComment"
      @keydown.meta.enter.prevent="sendComment"
    />
    <p v-if="commentBodyError" class="jira-field-error" role="status">{{ commentBodyError }}</p>
    <div class="jira-comment-composer__meta" :inert="commentBody.trim() ? undefined : true">
      <JiraWriteReason :reason="commentReason" />
      <p class="jira-help">Posts to Jira as {{ actorLabel }}.</p>
      <p v-if="attributionHint" class="jira-help" data-testid="jira-comment-attribution-hint">
        {{ attributionHint }}
      </p>
    </div>
    <p v-if="writeSurface === 'composer' && writeError" class="jira-inline-error" role="alert">{{ writeError }}</p>
    <p v-if="writeSurface === 'composer' && writeMessage" class="jira-comment-composer__done" role="status">
      {{ writeMessage }}
    </p>
    <div
      v-if="draftReviewActive && writeConfirmation"
      class="jira-confirm"
      role="dialog"
      aria-label="Confirm agent comment"
    >
      <p>
        Agent-written comment, not yet sent. It will be posted to Jira as
        {{ writeConfirmation.account?.displayName || actorName }}.
      </p>
      <pre>{{ writeConfirmation.preview }}</pre>
      <JiraBusyButton
        class="button button--small"
        :busy="isBusy('write-send')"
        :title="`Post this agent-written comment to ${issueKey} exactly as shown above.`"
        @click="confirmDraftReview"
      >
        Confirm and send
      </JiraBusyButton>
      <button
        class="button button--ghost button--small"
        type="button"
        :disabled="isBusy('write-send')"
        :title="
          isBusy('write-send')
            ? 'The comment is being sent and can no longer be cancelled.'
            : 'Close this review without posting. The text stays in the comment box.'
        "
        @click="cancelDraftReview"
      >
        Cancel
      </button>
    </div>
    <div class="jira-comment-composer__actions">
      <JiraBusyButton
        class="button button--small"
        type="submit"
        :busy="isBusy('write-preview', 'write-send')"
        :disabled="!canSendComment || draftReviewActive"
        :title="commentButtonTitle"
      >
        Comment
      </JiraBusyButton>
      <button
        v-if="commentBody.trim()"
        class="button button--ghost button--small"
        type="button"
        :disabled="isBusy('write-send')"
        :title="
          isBusy('write-send')
            ? 'Wait until the comment has been sent.'
            : `Delete this unsent comment on ${issueKey}. You confirm first; nothing is posted.`
        "
        @click="discardCommentDraft"
      >
        Discard
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed } from "vue";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraWriteReason from "./JiraWriteReason.vue";

import type { JiraIssue } from "./pane/jira-pane-types.js";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";
import { useAppStore } from "../../../stores/app.js";
import {
  normalizeJiraCommentAttribution,
  renderJiraCommentAttribution,
} from "../../../../electron/shared/jira-comment-attribution.js";

const {
  cancelDraftReview,
  canSendComment,
  canWriteJira,
  confirmDraftReview,
  draftReviewActive,
  commentBody,
  commentBodyError,
  commentComposerInput,
  commentReason,
  discardCommentDraft,
  isBusy,
  selected: selectedIssue,
  selectedConnection,
  sendComment,
  writeConfirmation,
  writeError,
  writeMessage,
  writeSurface,
} = useJiraPaneContext();
const selected = computed(() => selectedIssue.value as JiraIssue);
const actorName = computed(() => {
  const connection = selectedConnection.value;
  return (
    connection?.verifiedIdentity?.displayName || connection?.ownIdentity?.displayName || "the connected Jira account"
  );
});
const appStore = useAppStore();
const attributionHint = computed(() => {
  const connection = selectedConnection.value;
  if (connection?.accountPurpose !== "technical") return "";
  const appState = appStore.payload?.appState as
    | {
        settings?: { integrations?: { jira?: { commentAttribution?: unknown } } };
        profiles?: { id: string; name?: string }[];
      }
    | undefined;
  const setting = normalizeJiraCommentAttribution(appState?.settings?.integrations?.jira?.commentAttribution);
  const text = renderJiraCommentAttribution(setting, {
    user: connection.ownIdentity?.displayName,
    profile: appState?.profiles?.find((profile) => profile.id === appStore.myActiveProfileId)?.name,
    account: connection.verifiedIdentity?.displayName,
  });
  return text ? `Adds: “${text}” ${setting.position === "after" ? "after" : "before"} the comment` : "";
});
const actorLabel = computed(() =>
  selectedConnection.value?.accountPurpose === "technical" ? `${actorName.value} (technical account)` : actorName.value,
);
const issueKey = computed(() => selected.value.ref?.issueKey || selected.value.key || "this issue");
const commentButtonTitle = computed(() => {
  if (draftReviewActive.value) return "Confirm or cancel the agent comment above first.";
  if (canSendComment.value) return `Post this comment to ${issueKey.value} as ${actorLabel.value} (Ctrl+Enter).`;
  if (!commentBody.value.trim()) return "Write a comment first.";
  if (commentReason.error.value) return commentReason.error.value;
  if (commentReason.state.text.trim().length < commentReason.min)
    return `Give a reason of at least ${commentReason.min} characters first.`;
  return "Shorten the comment; Jira accepts up to 32,000 characters.";
});
</script>
