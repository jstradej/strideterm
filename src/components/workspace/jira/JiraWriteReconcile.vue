<template>
  <section
    v-if="selected.ref && canWriteJira && writeJournal?.status === 'unknown'"
    class="jira-write-reconcile"
    aria-label="Reconcile Jira write outcome"
  >
    <p>The write outcome is unknown. Do not submit it again until reconciliation checks Jira.</p>
    <code>{{ writeJournal.journalId }}</code>
    <JiraBusyButton
      class="button button--ghost"
      :busy="isBusy('write-reconcile')"
      title="Ask Jira whether the earlier write was applied. Nothing is sent again."
      @click="reconcileWrite"
    >
      Reconcile write status
    </JiraBusyButton>
  </section>
  <p v-else-if="writeJournal?.status === 'reconciled'" class="jira-write-reconcile" role="status">
    Jira write reconciled: {{ writeJournal.outcome }}. No retry was sent.
  </p>
</template>

<script setup lang="ts">
import { computed } from "vue";
import JiraBusyButton from "./JiraBusyButton.vue";

import type { JiraIssue } from "./pane/jira-pane-types.js";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const { canWriteJira, isBusy, reconcileWrite, selected: selectedIssue, writeJournal } = useJiraPaneContext();
const selected = computed(() => selectedIssue.value as JiraIssue);
</script>
