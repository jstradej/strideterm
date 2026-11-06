<template>
  <section
    class="dialog jira-inbox jira-branch-start"
    role="dialog"
    aria-modal="true"
    :aria-label="`Start development on ${selected.ref?.issueKey}`"
  >
    <header class="dialog__header">
      <div>
        <p class="eyebrow">Start development · {{ selected.ref?.issueKey }}</p>
        <h2>{{ selected.summary || selected.ref?.issueKey }}</h2>
      </div>
    </header>
    <p v-if="repoPreferenceNotice" class="jira-help" role="status">{{ repoPreferenceNotice }}</p>
    <p class="jira-help">
      Creates the branch in its own workspace, links it to {{ selected.ref?.issueKey }} and copies the issue — the
      description, every comment and the attachments — into <code>{{ issueDir }}</code> of the checkout. That folder is
      kept out of git.
    </p>
    <template v-if="!hasBranchConnections">
      <p class="jira-help" role="status">There is no Azure DevOps or GitHub connection in this profile yet.</p>
      <div class="jira-branch-start__add">
        <button
          class="button button--ghost button--small"
          type="button"
          title="Set up an Azure DevOps connection so strIDEterm can list its repositories and branches."
          @click="addBranchConnection('azure')"
        >
          Add Azure DevOps connection…
        </button>
        <button
          class="button button--ghost button--small"
          type="button"
          title="Set up a GitHub connection so strIDEterm can list its repositories and branches."
          @click="addBranchConnection('github')"
        >
          Add GitHub connection…
        </button>
      </div>
    </template>
    <div v-else class="jira-branch-start__fields">
      <label
        v-if="branchConnectionOptions.length > 1"
        title="The Azure DevOps or GitHub connection used to list repositories and branches. Changing it clears the choices below."
        >Connection<CustomSelect
          v-model="branchConnectionKey"
          :options="branchConnectionOptions"
          placeholder="Choose connection"
          @change="onBranchConnectionChange"
      /></label>
      <label v-if="branchProvider === 'azure'" title="The Azure DevOps project that holds the repository."
        >Project<CustomSelect
          v-model="branchProjectId"
          :options="branchProjectOptions"
          :placeholder="branchProjectsLoading ? 'Loading projects…' : 'Choose project'"
          :loading="branchProjectsLoading"
          :disabled="branchProjectsLoading || !branchConnectionKey"
          @change="loadBranchRepos"
      /></label>
      <label title="The repository to clone into strIDEterm's own cache and create the branch in."
        >Repository<CustomSelect
          v-model="branchRepoId"
          :options="branchRepoOptions"
          :placeholder="branchReposLoading ? 'Loading repositories…' : 'Choose repository'"
          :loading="branchReposLoading"
          :disabled="branchReposLoading || !branchConnectionKey || (branchProvider === 'azure' && !branchProjectId)"
          @change="selectBranchRepo"
      /></label>
      <label title="The new branch starts from the latest commit of this branch on the remote."
        >Base branch<CustomSelect
          v-model="branchBase"
          :options="branchBaseOptions"
          :placeholder="branchBasesLoading ? 'Loading branches…' : 'Select…'"
          :loading="branchBasesLoading"
          :disabled="branchBasesLoading || !branchRepoId"
      /></label>
      <label
        class="jira-branch-name"
        title="Name of the new branch. It is suggested from the issue key and summary; change it freely."
        >New branch<input v-model="branchName" placeholder="feature/ENG-1-login-fix"
      /></label>
      <div class="jira-branch-agent-row">
        <label
          class="jira-branch-agent"
          title="The agent that starts in the branch workspace and reads the instructions below. Choose No agent to only prepare the branch and the issue files."
          >Agent<CustomSelect v-model="branchAgent" :options="branchAgentOptions"
        /></label>
        <label
          v-if="branchAgent"
          title="Leave empty to keep the model of the agent's tab template, pick a suggestion, or type any model id your CLI supports."
          >Model<input
            v-model="branchModel"
            list="jira-branch-model-choices"
            placeholder="Template default"
            maxlength="100"
            spellcheck="false" />
          <datalist id="jira-branch-model-choices">
            <option
              v-for="model in branchModelChoices"
              :key="model.id"
              :value="model.id"
              :label="model.name"
            /></datalist
        ></label>
        <label
          v-if="branchAgent && branchEffortOptions.length"
          title="Reasoning effort passed to the agent. Template default keeps whatever its tab template sets."
          >Effort<CustomSelect v-model="branchEffort" :options="branchEffortOptions"
        /></label>
      </div>
      <label
        class="jira-branch-task"
        :title="`Saved as ${taskPath} next to the issue; the agent is told to read it. Edit it freely.`"
      >
        <span class="jira-branch-task__head">
          Instructions for the agent
          <span class="segmented jira-branch-mode" role="tablist" aria-label="What the agent does first">
            <button
              type="button"
              role="tab"
              :aria-selected="branchMode === 'analyze'"
              :class="['segmented__btn', { 'segmented__btn--active': branchMode === 'analyze' }]"
              :title="`The agent studies the issue and the code, asks what is unclear, writes the assignment to ${specPath} and replies with a short summary. It changes no code until you tell it to.`"
              @click="branchMode = 'analyze'"
            >
              Analyze first
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="branchMode === 'implement'"
              :class="['segmented__btn', { 'segmented__btn--active': branchMode === 'implement' }]"
              title="The agent plans briefly and goes straight into the implementation, stopping to ask only when the issue is unclear or the change is large."
              @click="branchMode = 'implement'"
            >
              Implement
            </button>
          </span>
          <button
            class="button button--ghost button--small"
            type="button"
            title="Replace the text of this tab with its default instructions for this branch and repository."
            @click="resetBranchTask"
          >
            Reset
          </button>
        </span>
        <textarea v-model="branchTask" rows="12" spellcheck="false" />
        <small
          >Saved as <code>{{ taskPath }}</code
          >; the agent's first message tells it to read that file.</small
        >
      </label>
    </div>
    <p v-if="branchError" class="jira-inline-error" role="alert">{{ branchError }}</p>
    <p v-if="branchStartProgress" class="jira-branch-start__progress" role="status">
      <span class="jira-branch-start__spinner" aria-hidden="true"></span>{{ branchStartProgress }}
    </p>
    <footer class="dialog__footer">
      <button
        class="button button--ghost"
        type="button"
        :disabled="isBusy('branch-start') && !branchStartOperationId"
        :title="
          branchStartOperationId
            ? 'Close this dialog; development keeps starting and the Notification Center says when it is ready.'
            : undefined
        "
        @click="closeBranchStart"
      >
        {{ branchStartOperationId ? "Close" : "Cancel" }}
      </button>
      <JiraBusyButton
        v-if="hasBranchConnections"
        class="button jira-branch-start__submit"
        :busy="isBusy('branch-start')"
        :disabled="!canStartBranch"
        :title="startTitle"
        @click="startBranch"
      >
        {{ branchAgent ? "Start development" : "Create branch" }}
      </JiraBusyButton>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import JiraBusyButton from "./JiraBusyButton.vue";
import {
  jiraDevelopmentRelativeDir,
  jiraSpecFilePath,
  jiraTaskFilePath,
} from "../../../../electron/shared/jira-development.js";
import type { JiraIssue } from "./pane/jira-pane-types.js";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  addBranchConnection,
  branchAgent,
  branchAgentOptions,
  branchEffort,
  branchEffortOptions,
  branchMode,
  branchStartOperationId,
  branchStartProgress,
  branchModel,
  branchModelChoices,
  branchBase,
  branchBaseOptions,
  branchBasesLoading,
  branchConnectionKey,
  branchConnectionOptions,
  branchError,
  branchName,
  branchProjectId,
  branchProjectOptions,
  branchProjectsLoading,
  branchProvider,
  branchRepoId,
  branchRepoOptions,
  branchReposLoading,
  branchTask,
  canStartBranch,
  closeBranchStart,
  hasBranchConnections,
  isBusy,
  loadBranchRepos,
  onBranchConnectionChange,
  repoPreferenceNotice,
  resetBranchTask,
  selectBranchRepo,
  selected: selectedIssue,
  startBranch,
  startBranchDisabledReason,
} = useJiraPaneContext();
const selected = computed(() => selectedIssue.value as JiraIssue);
const issueDir = computed(() => `${jiraDevelopmentRelativeDir(selected.value.ref?.issueKey || "")}/`);
const taskPath = computed(() => jiraTaskFilePath(selected.value.ref?.issueKey || ""));
const specPath = computed(() => jiraSpecFilePath(selected.value.ref?.issueKey || ""));
const startTitle = computed(() =>
  canStartBranch.value
    ? `Clone or update the repository, create ${branchName.value.trim()} from ${branchBase.value}, copy ${selected.value.ref?.issueKey} into it${branchAgent.value ? " and start the agent" : ""}. The dialog closes at once; the Notification Center says when it is ready.`
    : startBranchDisabledReason.value,
);
</script>
