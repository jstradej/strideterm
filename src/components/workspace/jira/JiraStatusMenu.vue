<template>
  <details
    v-if="canWriteJira && selected.ref"
    ref="statusMenuRef"
    class="jira-extra-actions jira-status-menu"
    @keydown.esc="onMenuEscape"
    @keydown="onMenuKeydown"
    @focusout="closeExtraActionsWhenFocusLeaves"
    @toggle="onStatusMenuToggle"
  >
    <summary
      ref="statusPillRef"
      class="jira-status-pill"
      :data-tone="jiraStatusTone(selected.status, selected.statusCategory)"
      :aria-label="`Status ${selected.status || 'Open'}. Change status`"
      :title="`Move ${selected.ref?.issueKey || 'this issue'} to another status. Only moves Jira allows are listed, and you confirm before anything is sent.`"
    >
      {{ selected.status || "Open" }}
    </summary>
    <div class="jira-extra-actions__menu" role="menu" aria-label="Move to status" @click="closeMenuOnItemClick">
      <p v-if="transitionsLoading && !transitions.length" class="jira-menu__note" role="status">
        <Spinner aria-hidden="true" label="Loading transitions" /> Loading transitions…
      </p>
      <p v-else-if="transitionsError" class="jira-inline-error" role="alert">{{ transitionsError }}</p>
      <p v-else-if="!transitions.length && !transitionsLoading" class="jira-menu__note">
        No status changes are available for this issue.
      </p>
      <button
        v-for="transition in transitions"
        :key="transition.id"
        class="jira-menu__item"
        role="menuitem"
        type="button"
        :aria-busy="transitionsLoading ? 'true' : undefined"
        @click="pickTransition(transition)"
      >
        <span>{{ transition.to }}</span>
        <small v-if="transition.name !== transition.to">{{ transition.name }}</small>
      </button>
    </div>
  </details>
  <span v-else class="jira-status-pill" :data-tone="jiraStatusTone(selected.status, selected.statusCategory)">{{
    selected.status || "Open"
  }}</span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import Spinner from "../../common/Spinner.vue";
import { jiraStatusTone } from "./jiraPeople";

import type { JiraIssue } from "./pane/jira-pane-types.js";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  canWriteJira,
  closeExtraActionsWhenFocusLeaves,
  closeMenuOnItemClick,
  onMenuEscape,
  onMenuKeydown,
  onStatusMenuToggle,
  pickTransition,
  selected: selectedIssue,
  statusMenuRef,
  statusPillRef,
  transitions,
  transitionsError,
  transitionsLoading,
} = useJiraPaneContext();
const selected = computed(() => selectedIssue.value as JiraIssue);
</script>
