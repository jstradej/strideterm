<template>
  <article
    class="jira-detail"
    aria-label="Issue details"
    :data-selected="Boolean(selected || issueLoading)"
    :aria-busy="issueLoading ? 'true' : undefined"
    :inert="issueLoading && Boolean(selected)"
  >
    <Spinner
      v-if="issuePendingSpinner && selected"
      class="jira-detail__pending-spinner"
      aria-hidden="true"
      label="Loading issue details"
    />
    <button
      v-if="boardIssueDetailOpen && boardDrawerMode"
      class="button button--ghost button--small jira-detail__close"
      type="button"
      aria-label="Close issue details"
      title="Close the issue details (Esc). An unsent comment is kept for this issue."
      @click="clearSelectedIssue"
    >
      ✕ <span>Close</span>
    </button>
    <button
      v-else-if="boardIssueDetailOpen"
      class="button button--ghost jira-detail__back"
      type="button"
      title="Return to the board (Esc). An unsent comment is kept for this issue."
      @click="clearSelectedIssue"
    >
      ← <span>Back to board</span>
    </button>
    <template v-if="selected">
      <button
        v-if="!boardIssueDetailOpen && !boardDrawerMode && !detached"
        class="button button--ghost jira-detail__back"
        type="button"
        title="Return to the issue list (Esc). An unsent comment is kept for this issue."
        @click="clearSelectedIssue"
      >
        ← <span>Back to issues</span>
      </button>
      <header class="jira-detail-header">
        <div class="jira-detail-title">
          <p class="jira-detail-crumbs">
            <template v-if="selected.projectKey"
              ><span class="jira-detail-crumbs__project">{{ selected.projectKey }}</span
              ><span aria-hidden="true">/</span></template
            ><span class="jira-detail-key">{{ selected.ref?.issueKey || selected.key }}</span>
            <button
              v-if="canPopOutIssue"
              class="button button--ghost button--small jira-detail__popout"
              type="button"
              aria-label="Open this issue in its own window"
              title="Open this issue in its own window; the board stays as it is."
              @click="popOutSelectedIssue"
            >
              ⧉ <span>Pop out</span>
            </button>
          </p>
          <h2 ref="jiraDetailHeadingRef" tabindex="-1">{{ selected.summary || selected.title }}</h2>
          <div class="jira-detail-meta" aria-label="Issue summary">
            <JiraStatusMenu />
            <JiraIssueBadges
              :issue-type="selected.issueType || 'Unknown type'"
              :priority="selected.priority || 'Unspecified'"
            />
            <span class="jira-detail-meta__person">
              <span class="jira-detail-meta__label">Assignee</span>
              <JiraPerson :display-name="selected.assignee" :me="isOwnJiraAssignee(selected)" />
            </span>
          </div>
          <p
            class="jira-detail-meta__freshness jira-status-slot"
            role="status"
            :data-active="
              Boolean(
                selected.cache?.stale ||
                selectedRefreshing ||
                selectedRefreshError ||
                attachmentUploadState !== 'idle' ||
                headerFeedback,
              )
            "
          >
            <template v-if="selected.cache?.stale || selectedRefreshing">
              <template v-if="selected.cache?.stale">Saved snapshot</template>
              <template v-if="selectedRefreshing">{{ selected.cache?.stale ? "· " : "" }}Refreshing…</template>
            </template>
            <span v-if="selectedRefreshError || selected.cache?.refreshError" class="jira-detail-refresh-error">
              Showing saved issue details. {{ selectedRefreshError || selected.cache?.refreshError?.message }}
            </span>
            <span v-if="headerFeedback" class="jira-write-feedback">· {{ headerFeedback }}</span>
            <span v-if="attachmentUploadState === 'uploading'" class="jira-upload-status">
              · Uploading attachment…
            </span>
            <span v-else-if="attachmentUploadState === 'uploaded'" class="jira-upload-status">
              · Attachment uploaded; refreshing issue.
            </span>
          </p>
          <p v-if="attachmentError" class="jira-inline-error" role="alert">{{ attachmentError }}</p>
          <p v-if="copyError" class="jira-inline-error" role="alert">{{ copyError }}</p>
        </div>
        <JiraIssueActions />
        <p
          v-if="selected.ref && !(canWriteJira && canUseAttachmentFileDialogs)"
          class="jira-help jira-detail-readonly"
          role="note"
        >
          {{
            canWriteJira
              ? "Attachments are available in the desktop app."
              : "Read-only here. Editing and attachments are available in the desktop app."
          }}
        </p>
      </header>
      <JiraWriteCard />
      <JiraWriteReconcile />
      <JiraIssueDevelopment />
      <div class="jira-detail-layout">
        <div class="jira-detail-main">
          <section class="jira-description-section jira-detail-card" aria-label="Issue description">
            <h3 class="jira-detail-card__title">Description</h3>
            <JiraRichText
              v-if="selected.descriptionHtml || selected.descriptionMarkdown || selected.description"
              class="jira-description"
              :html="selected.descriptionHtml"
              :markdown="selected.descriptionMarkdown"
              :text="selected.description"
              :connection-id="selected.ref?.connectionId"
              :issue-id="selected.ref?.issueId"
              :base-url="selected.url"
              :jira-routes="jiraDescriptionRoutes"
            />
            <p v-else class="jira-description-empty">This issue has no description available in Jira.</p>
          </section>
          <section
            v-if="selected.issueLinks?.length"
            class="jira-issue-links jira-detail-card"
            aria-label="Linked issues"
          >
            <h3 class="jira-detail-card__title">
              Linked issues <span class="jira-detail-card__count">{{ selected.issueLinks.length }}</span>
            </h3>
            <ul>
              <li
                v-for="(link, index) in selected.issueLinks"
                :key="`${link.type}:${link.issueKey}:${link.direction}:${index}`"
              >
                <span class="jira-issue-links__type" :title="`${link.type} · ${link.direction}`"
                  >{{ link.direction === "outward" ? "→" : "←" }} {{ link.type }}</span
                >
                <a
                  :href="issueUrl(link.issueKey)"
                  target="_blank"
                  rel="noreferrer"
                  :title="`Open ${link.issueKey} on the Jira website.`"
                  ><strong>{{ link.issueKey }}</strong
                  ><span v-if="link.summary">{{ link.summary }}</span></a
                >
                <span v-if="link.status" class="jira-status-pill" :data-tone="jiraStatusTone(link.status)">{{
                  link.status
                }}</span>
              </li>
            </ul>
          </section>
          <details
            v-if="selected.attachments?.length"
            class="jira-attachments jira-detail-card"
            aria-label="Issue attachments"
            open
          >
            <summary
              class="jira-detail-card__title"
              :title="
                canUseAttachmentFileDialogs
                  ? `Show or hide the files attached to ${issueKey}. Files up to 10 MiB can be saved to your computer.`
                  : `Show or hide the files attached to ${issueKey}.`
              "
            >
              Attachments <span class="jira-detail-card__count">{{ selected.attachments.length }}</span>
            </summary>
            <ul v-if="selected.attachments?.length">
              <li v-for="attachment in selected.attachments" :key="attachment.id">
                <span class="jira-attachment__name">{{ attachment.fileName }}</span>
                <small>{{ formatAttachmentSize(attachment.sizeBytes) }}</small>
                <JiraBusyButton
                  v-if="canUseAttachmentFileDialogs"
                  class="button button--ghost button--small"
                  :busy="attachmentDownloads[attachment.id] === 'saving'"
                  :disabled="attachment.sizeBytes > 10 * 1024 * 1024"
                  :title="
                    attachment.sizeBytes > 10 * 1024 * 1024
                      ? 'Files over 10 MiB cannot be downloaded here. Open the issue in Jira to get it.'
                      : `Save ${attachment.fileName} to a folder you choose.`
                  "
                  @click="downloadIssueAttachment(attachment)"
                >
                  {{ attachment.sizeBytes > 10 * 1024 * 1024 ? "Over 10 MiB" : "Download" }}
                </JiraBusyButton>
                <small v-if="attachment.sizeBytes > 10 * 1024 * 1024">Download limit is 10 MiB.</small>
                <small v-if="attachmentDownloads[attachment.id] === 'cancelled'" role="status">Save cancelled.</small>
                <small v-else-if="attachmentDownloads[attachment.id] === 'saved'" role="status">Saved.</small>
              </li>
            </ul>
          </details>
          <section v-if="workspaceLinksOpen || linkedWorkspaces.length" class="jira-workspace-links jira-detail-card">
            <h3 class="jira-detail-card__title">Linked workspaces</h3>
            <p v-if="workspaceLinkError" class="jira-inline-error" role="alert">{{ workspaceLinkError }}</p>
            <div v-if="workspaceLinksOpen" class="jira-workspace-links__form">
              <label title="Workspaces in this profile. A link is kept in strIDEterm only; Jira is not changed."
                >Choose a workspace<CustomSelect
                  v-model="linkWorkspaceId"
                  :options="workspaceSelectOptions"
                  placeholder="Select workspace"
              /></label>
              <JiraBusyButton
                class="button button--ghost button--small"
                :busy="isBusy('link')"
                :disabled="!linkWorkspaceId"
                :title="
                  linkWorkspaceId
                    ? `Link ${issueKey} to the chosen workspace. Only strIDEterm records the link; Jira is not changed.`
                    : 'Choose a workspace first.'
                "
                @click="attachSelectedIssue"
              >
                Link issue
              </JiraBusyButton>
            </div>
            <p v-for="workspace in linkedWorkspaces" :key="workspace.id" class="jira-workspace-link-card">
              <span>{{ workspace.name }}</span>
              <JiraBusyButton
                class="button button--ghost button--small"
                :busy="isBusy('link')"
                :title="`Remove the link between ${issueKey} and ${workspace.name}. Jira is not changed.`"
                @click="detachSelectedIssue(workspace.id)"
              >
                Unlink
              </JiraBusyButton>
            </p>
          </section>
          <section class="jira-comments jira-detail-card" aria-label="Comments">
            <header class="jira-detail-card__header">
              <h3 class="jira-detail-card__title">
                Comments <span v-if="comments.length" class="jira-detail-card__count">{{ comments.length }}</span>
              </h3>
              <JiraBusyButton
                class="button button--ghost button--small"
                :busy="commentsLoading"
                :title="`Reload the comments on ${issueKey} from Jira.`"
                @click="loadComments()"
              >
                Refresh comments
              </JiraBusyButton>
            </header>
            <p v-if="commentsError" class="jira-comments__notice jira-comments__notice--error" role="status">
              {{ commentsError }}
            </p>
            <p v-else-if="commentsLoading && !comments.length" class="jira-comments__notice" role="status">
              <Spinner aria-hidden="true" label="Loading comments" /> Loading comments…
            </p>
            <p v-else-if="!comments.length" class="jira-comments__notice">No comments on this issue yet.</p>
            <ol v-if="comments.length" ref="commentsListRef" class="jira-comments__list">
              <li v-for="comment in comments" :key="comment.id" class="jira-comment" tabindex="-1">
                <JiraPerson :display-name="jiraCommentAuthor(comment)" size="lg" :show-name="false" />
                <div class="jira-comment__bubble">
                  <p class="jira-comment__meta">
                    <strong>{{ jiraPersonName(jiraCommentAuthor(comment)) }}</strong>
                    <time :datetime="comment.created" :title="formatJiraDate(comment.created)">{{
                      formatJiraRelativeTime(comment.created)
                    }}</time>
                  </p>
                  <JiraRichText
                    class="jira-comment__body"
                    :html="comment.bodyHtml"
                    :text="comment.body"
                    :connection-id="selected.ref?.connectionId"
                    :issue-id="selected.ref?.issueId"
                    :base-url="selected.url"
                    :jira-routes="jiraDescriptionRoutes"
                  />
                </div>
              </li>
            </ol>
            <JiraCommentComposer />
          </section>
        </div>
        <details class="jira-detail-sidebar" aria-label="Issue metadata" :open="!isCompactPane">
          <summary
            class="jira-detail-card__title"
            title="Show or hide the status, people, priority, labels, versions and dates of this issue."
          >
            Details
          </summary>
          <dl>
            <dt>Status</dt>
            <dd>
              <span class="jira-status-pill" :data-tone="jiraStatusTone(selected.status, selected.statusCategory)">{{
                selected.status || "Open"
              }}</span>
            </dd>
            <dt>Assignee</dt>
            <dd>
              <JiraPerson :display-name="selected.assignee" show-organization :me="isOwnJiraAssignee(selected)" />
            </dd>
            <template v-if="selected.reporter">
              <dt>Reporter</dt>
              <dd><JiraPerson :display-name="selected.reporter" show-organization /></dd>
            </template>
            <template v-if="selected.priority">
              <dt>Priority</dt>
              <dd><JiraIssueBadges :priority="selected.priority" only="priority" /></dd>
            </template>
            <template v-if="selected.issueType">
              <dt>Type</dt>
              <dd><JiraIssueBadges :issue-type="selected.issueType" only="type" /></dd>
            </template>
            <template v-if="selected.resolution">
              <dt>Resolution</dt>
              <dd>{{ selected.resolution }}</dd>
            </template>
            <template v-if="selected.labels?.length">
              <dt>Labels</dt>
              <dd class="jira-metadata-tags">
                <span v-for="label in selected.labels" :key="label">{{ label }}</span>
              </dd>
            </template>
            <template v-if="selected.components?.length">
              <dt>Components</dt>
              <dd class="jira-metadata-tags jira-metadata-tags--plain">
                <span v-for="component in selected.components" :key="component">{{ component }}</span>
              </dd>
            </template>
            <template v-if="selected.versions?.length">
              <dt>Fix versions</dt>
              <dd class="jira-metadata-tags jira-metadata-tags--plain">
                <span v-for="version in selected.versions" :key="version">{{ version }}</span>
              </dd>
            </template>
            <template v-if="selected.projectKey">
              <dt>Project</dt>
              <dd>{{ selected.projectKey }}</dd>
            </template>
          </dl>
          <dl v-if="selected.created || selected.updated" class="jira-detail-sidebar__dates">
            <template v-if="selected.created">
              <dt>Created</dt>
              <dd>
                <time :datetime="selected.created">{{ formatJiraRelativeTime(selected.created) }}</time>
                <small>{{ formatJiraDate(selected.created) }}</small>
              </dd>
            </template>
            <template v-if="selected.updated">
              <dt>Updated</dt>
              <dd>
                <time :datetime="selected.updated">{{ formatJiraRelativeTime(selected.updated) }}</time>
                <small>{{ formatJiraDate(selected.updated) }}</small>
              </dd>
            </template>
          </dl>
        </details>
      </div>
      <JiraIssueWrite />
      <JiraBranchStart />
    </template>
    <p v-else class="jira-empty" role="status">
      <template v-if="issueLoading"
        ><Spinner aria-hidden="true" label="Loading issue details" /> Loading issue details…</template
      >
      <template v-else
        ><strong>Select an issue to view its details.</strong
        ><span>Choose an issue from the list on the left.</span></template
      >
    </p>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import Spinner from "../../common/Spinner.vue";
import { useDelayedFlag } from "../../../composables/useDelayedFlag.js";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraRichText from "./JiraRichText.vue";
import JiraIssueBadges from "./JiraIssueBadges.vue";
import JiraPerson from "./JiraPerson.vue";
import { formatJiraRelativeTime, jiraPersonName, jiraStatusTone } from "./jiraPeople";
import JiraIssueActions from "./JiraIssueActions.vue";
import JiraIssueDevelopment from "./JiraIssueDevelopment.vue";
import JiraIssueWrite from "./JiraIssueWrite.vue";
import JiraStatusMenu from "./JiraStatusMenu.vue";
import JiraWriteReconcile from "./JiraWriteReconcile.vue";
import JiraWriteCard from "./JiraWriteCard.vue";
import JiraCommentComposer from "./JiraCommentComposer.vue";
import JiraBranchStart from "./JiraBranchStart.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  attachSelectedIssue,
  attachmentDownloads,
  attachmentUploadState,
  boardDrawerMode,
  boardIssueDetailOpen,
  canPopOutIssue,
  canUseAttachmentFileDialogs,
  canWriteJira,
  clearSelectedIssue,
  comments,
  commentsError,
  commentsListRef,
  commentsLoading,
  copyError,
  copyNotice,
  detached,
  detachSelectedIssue,
  downloadIssueAttachment,
  formatAttachmentSize,
  formatJiraDate,
  isBusy,
  isCompactPane,
  isOwnJiraAssignee,
  issueLoading,
  issueUrl,
  jiraCommentAuthor,
  jiraDescriptionRoutes,
  jiraDetailHeadingRef,
  linkWorkspaceId,
  linkedWorkspaces,
  loadComments,
  popOutSelectedIssue,
  selected,
  selectedRefreshError,
  selectedRefreshing,
  workspaceLinksOpen,
  workspaceSelectOptions,
  attachmentError,
  workspaceLinkError,
  writeMessage,
  writeSurface,
} = useJiraPaneContext();
const headerFeedback = computed(
  () =>
    copyNotice.value || (writeSurface.value !== "composer" && writeSurface.value !== "form" ? writeMessage.value : ""),
);
const issuePendingSpinner = useDelayedFlag(issueLoading);
const issueKey = computed(() => selected.value?.ref?.issueKey || selected.value?.key || "this issue");
</script>
