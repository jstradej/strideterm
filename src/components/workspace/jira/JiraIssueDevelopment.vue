<template>
  <section
    v-if="matchingDevelopmentWorkspaces.length || matchingBranchWorkspaces.length"
    class="jira-development-links jira-detail-card"
    aria-label="Development for this Jira issue"
  >
    <h3 class="jira-detail-card__title">Development</h3>
    <p v-if="developmentError" class="jira-inline-error" role="alert">{{ developmentError }}</p>
    <p v-if="hasExistingDevelopmentWorkspace" class="jira-help" role="status">
      A development task already exists for this issue. Open it to continue.
    </p>
    <p v-for="workspace in matchingBranchWorkspaces" :key="workspace.id" class="jira-development-links__item">
      <span>
        <strong>Branch</strong>
        · {{ workspace.name }}
        <small v-if="workspace.repository">{{ workspace.repository }}</small>
        <small v-if="workspace.baseBranch">from {{ workspace.baseBranch }}</small>
      </span>
      <button
        class="button button--ghost button--small"
        type="button"
        :title="`Switch to the workspace ${workspace.name}, the checkout of this branch linked to this issue.`"
        @click="openDevelopmentWorkspace(workspace.id)"
      >
        Open branch
      </button>
    </p>
    <p v-for="workspace in matchingDevelopmentWorkspaces" :key="workspace.id" class="jira-development-links__item">
      <span>
        <strong>{{ workspace.statusLabel }}</strong>
        · {{ workspace.name }}
        <small>{{ workspace.summary }}</small>
      </span>
      <button
        class="button button--ghost button--small"
        type="button"
        :title="
          workspace.terminal
            ? `Switch to ${workspace.name} to review what the finished task did.`
            : workspace.status === 'started'
              ? `Switch to the running task workspace ${workspace.name}.`
              : `Switch to ${workspace.name}. Start its Worker and Judge from the task's Dashboard.`
        "
        @click="openDevelopmentWorkspace(workspace.id)"
      >
        {{
          workspace.terminal
            ? "Open development history"
            : workspace.status === "started"
              ? "Open development"
              : "Open prepared task"
        }}
      </button>
    </p>
  </section>
</template>

<script setup lang="ts">
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  hasExistingDevelopmentWorkspace,
  matchingBranchWorkspaces,
  matchingDevelopmentWorkspaces,
  openDevelopmentWorkspace,
  developmentError,
} = useJiraPaneContext();
</script>
