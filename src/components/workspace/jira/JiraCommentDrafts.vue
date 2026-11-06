<template>
  <p v-if="commentDraftsError && !connectionsOnly" class="jira-error jira-inline-error" role="alert">
    {{ commentDraftsError }}
  </p>
  <details v-if="!connectionsOnly && jiraCommentDrafts.length" class="jira-mcp-drafts">
    <summary
      title="Comments that agents proposed for Jira issues. None has been posted; each is previewed for you to confirm."
    >
      Agent comment drafts ({{ jiraCommentDrafts.length }})
    </summary>
    <p class="jira-help">
      These drafts have not been sent to Jira. Review and use one to enter the normal preview and confirmation flow.
    </p>
    <article
      v-for="draftItem in jiraCommentDrafts"
      :key="`${draftItem.sourceWorkspaceId}:${draftItem.id}`"
      class="jira-mcp-drafts__item"
    >
      <div class="jira-mcp-drafts__body">
        <strong>{{ draftItem.ref.issueKey }}</strong>
        <small>From {{ jiraDraftSourceName(draftItem.sourceWorkspaceId) }}</small>
        <p>{{ draftItem.body }}</p>
      </div>
      <div class="jira-mcp-drafts__actions">
        <button
          class="button button--ghost"
          type="button"
          :title="`Open ${draftItem.ref.issueKey} and preview this comment. It is posted only after you confirm.`"
          @click="useJiraCommentDraft(draftItem)"
        >
          Use draft
        </button>
        <button
          class="button button--ghost"
          type="button"
          :title="`Delete this unsent draft for ${draftItem.ref.issueKey} after you confirm. Nothing is posted to Jira.`"
          @click="clearJiraCommentDraft(draftItem)"
        >
          Clear
        </button>
      </div>
    </article>
  </details>
</template>

<script setup lang="ts">
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  clearJiraCommentDraft,
  commentDraftsError,
  connectionsOnly,
  jiraCommentDrafts,
  jiraDraftSourceName,
  useJiraCommentDraft,
} = useJiraPaneContext();
</script>
