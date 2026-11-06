<template>
  <div class="jira-detail-header__actions">
    <details
      v-if="canWriteJira && selected.ref"
      ref="assignMenuRef"
      class="jira-extra-actions jira-assign-menu"
      @keydown.esc="onMenuEscape"
      @keydown="onMenuKeydown"
      @focusout="closeExtraActionsWhenFocusLeaves"
      @toggle="onAssignMenuToggle"
    >
      <summary
        ref="assignTriggerRef"
        class="button button--ghost button--small"
        aria-label="Assign this issue"
        :title="`Assign ${issueLabel} to yourself, to someone else or to nobody. You confirm before Jira changes.`"
      >
        Assign
      </summary>
      <div class="jira-extra-actions__menu" role="menu" aria-label="Assign issue" @click="closeMenuOnItemClick">
        <button class="jira-menu__item" role="menuitem" type="button" @click="assignToMe">
          <JiraMenuIcon name="user" />
          <span>Assign to me</span>
          <small v-if="!selectedConnection?.ownIdentity">Choose your Jira identity first</small>
        </button>
        <button
          class="jira-menu__item"
          role="menuitem"
          type="button"
          @click="pickAssignee({ kind: 'unassigned' }, 'nobody')"
        >
          <JiraMenuIcon name="user-remove" />
          <span>Unassign</span>
        </button>
        <label class="jira-assign-search">
          <span class="jira-visually-hidden">Find a Jira user</span>
          <input
            v-model="assignSearchText"
            type="search"
            autocomplete="off"
            maxlength="100"
            placeholder="Find a user…"
          />
        </label>
        <p v-if="assignSearchLoading" class="jira-menu__note" role="status">Searching…</p>
        <p v-else-if="assignSearchError" class="jira-inline-error" role="alert">{{ assignSearchError }}</p>
        <p v-else-if="assignSearchText.trim() && !assignSearchResults.length" class="jira-menu__note" role="status">
          No Jira users found.
        </p>
        <button
          v-for="user in assignSearchResults"
          :key="user.id"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          @click="pickAssignee({ kind: 'user', id: user.id, displayName: user.label }, user.label)"
        >
          <span>{{ user.label }}</span>
        </button>
      </div>
    </details>
    <button
      v-if="canWriteJira && selected.ref"
      class="button button--ghost button--small"
      type="button"
      aria-label="Write a comment on this Jira issue"
      :title="`Write a comment on ${issueLabel}. You see a preview before it is posted to Jira.`"
      @click="openJiraAction('comment')"
    >
      Comment
    </button>
    <button
      v-if="selected.ref && primaryBranchWorkspace"
      class="button button--small"
      type="button"
      :aria-label="`Open the branch workspace ${primaryBranchWorkspace.name}`"
      :title="`Switch to ${primaryBranchWorkspace.name}, the branch workspace linked to ${issueLabel}.`"
      @click="openDevelopmentWorkspace(primaryBranchWorkspace.id)"
    >
      Open branch
    </button>
    <button
      v-else-if="selected.ref"
      class="button button--small"
      type="button"
      aria-label="Start development: create a branch workspace from this Jira issue"
      :disabled="!hasBranchConnections"
      :title="
        hasBranchConnections
          ? `Create a branch for ${issueLabel} in its own workspace and link it to this issue. You choose the repository and base branch first.`
          : 'Add an Azure DevOps or GitHub connection first'
      "
      @click="openBranchStart"
    >
      Start development
    </button>
    <a
      v-if="selected.url"
      class="button button--ghost button--small"
      aria-label="Open this issue in Jira in your browser"
      :title="`Open ${issueLabel} on the Jira website in your browser, for anything strIDEterm cannot do here.`"
      :href="selected.url"
      target="_blank"
      rel="noreferrer"
      >Open in Jira ↗</a
    >
    <details
      class="jira-extra-actions"
      @keydown.esc="onMenuEscape"
      @keydown="onMenuKeydown"
      @focusout="closeExtraActionsWhenFocusLeaves"
      @toggle="positionExtraActionsMenu"
    >
      <summary
        class="button button--ghost button--small"
        aria-label="More actions"
        title="Copy the key or link, start another branch, add an attachment or a web link, link a workspace, log work"
      >
        ⋯
      </summary>
      <div class="jira-extra-actions__menu" role="menu" aria-label="More issue actions" @click="closeMenuOnItemClick">
        <button class="jira-menu__item" role="menuitem" type="button" @click="copyIssueText('key')">
          <JiraMenuIcon name="copy" />
          <span>Copy key</span>
        </button>
        <button class="jira-menu__item" role="menuitem" type="button" @click="copyIssueText('link')">
          <JiraMenuIcon name="link" />
          <span>Copy link</span>
        </button>
        <button
          v-if="canUseAttachmentFileDialogs && selected.ref"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          :disabled="attachmentUploadState === 'uploading'"
          :title="`Choose a file on this computer and upload it to ${issueLabel} in Jira.`"
          @click="uploadIssueAttachment"
        >
          <JiraMenuIcon name="attachment" />
          <span>Add attachment</span>
        </button>
        <button
          v-if="canLinkWorkspaces && selected.ref"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          title="Show this issue on one of your strIDEterm workspaces, or remove it from one."
          @click="workspaceLinksOpen = !workspaceLinksOpen"
        >
          <JiraMenuIcon name="workspace" />
          <span>{{ workspaceLinksOpen ? "Close workspace linking" : "Link workspace…" }}</span>
        </button>
        <button
          v-if="selected.ref && primaryBranchWorkspace && hasBranchConnections"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          :title="`Create another branch for ${issueLabel} in a new workspace. You choose the repository and base branch first.`"
          @click="openBranchStart"
        >
          <JiraMenuIcon name="branch" />
          <span>New branch…</span>
        </button>
        <button
          v-if="selected.ref && !hasBranchConnections"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          title="Set up an Azure DevOps connection, so Start development can create branches in its repositories."
          @click="addBranchConnection('azure')"
        >
          <JiraMenuIcon name="link" />
          <span>Add Azure DevOps connection…</span>
        </button>
        <button
          v-if="selected.ref && !hasBranchConnections"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          title="Set up a GitHub connection, so Start development can create branches in its repositories."
          @click="addBranchConnection('github')"
        >
          <JiraMenuIcon name="link" />
          <span>Add GitHub connection…</span>
        </button>
        <button
          v-if="canWriteJira && selected.ref"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          :title="`Add a web link (URL and title) to ${issueLabel} in Jira. You review it before it is sent.`"
          @click="openFormAction('remote-link')"
        >
          <JiraMenuIcon name="web-link" />
          <span>Add link…</span>
        </button>
        <button
          v-if="canWriteJira && selected.ref"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          :title="`Record time spent on ${issueLabel} in Jira. You review it before it is sent.`"
          @click="openFormAction('worklog')"
        >
          <JiraMenuIcon name="clock" />
          <span>Log work…</span>
        </button>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import JiraMenuIcon from "./JiraMenuIcon.vue";
import type { JiraIssue } from "./pane/jira-pane-types.js";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  assignMenuRef,
  assignSearchError,
  assignSearchLoading,
  assignSearchResults,
  assignSearchText,
  assignToMe,
  assignTriggerRef,
  addBranchConnection,
  attachmentUploadState,
  canLinkWorkspaces,
  canUseAttachmentFileDialogs,
  canWriteJira,
  closeExtraActionsWhenFocusLeaves,
  closeMenuOnItemClick,
  copyIssueText,
  hasBranchConnections,
  onAssignMenuToggle,
  onMenuEscape,
  onMenuKeydown,
  openFormAction,
  openBranchStart,
  openDevelopmentWorkspace,
  openJiraAction,
  pickAssignee,
  positionExtraActionsMenu,
  primaryBranchWorkspace,
  selected: selectedIssue,
  selectedConnection,
  uploadIssueAttachment,
  workspaceLinksOpen,
} = useJiraPaneContext();
const selected = computed(() => selectedIssue.value as JiraIssue);
const issueLabel = computed(() => selected.value.ref?.issueKey || "this issue");
</script>
