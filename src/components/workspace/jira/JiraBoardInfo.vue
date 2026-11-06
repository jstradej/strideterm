<template>
  <details
    v-if="boardCapability || deniedCapabilities.length || selectedBoard || boardPageTruncated || pinnedBoardWorkspace"
    class="jira-board-status-details"
  >
    <summary
      class="jira-board-info__trigger"
      aria-label="Board information"
      title="Board information: its Jira filter and owner, and anything this Jira account is not allowed to read."
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0" />
        <path d="M12 11v5.5" />
        <path d="M12 7.6v.1" />
      </svg>
    </summary>
    <div class="jira-board-info__panel">
      <div v-if="pinnedBoardWorkspace" class="jira-board-pin-actions">
        <span>This board also has its own workspace.</span>
        <button
          v-if="currentWorkspace?.kind !== 'jira-board'"
          class="button button--ghost button--small"
          type="button"
          title="Switch to the separate workspace pinned for this board. This tab stays as it is."
          @click="openPinnedBoard(pinnedBoardWorkspace.id)"
        >
          Open pinned board
        </button>
      </div>
      <p v-if="boardCapability" class="jira-help">{{ boardCapability }}</p>
      <p v-if="deniedCapabilities.length" class="jira-help" role="status">
        Jira did not allow this account to read the board’s {{ deniedCapabilities.join(", ") }}.
      </p>
      <p v-if="boardFilter || boardOwner" class="jira-help" aria-label="Board filter and owner metadata">
        <template v-if="boardFilter"
          >Filter: {{ boardFilter.name }}<template v-if="boardFilter.jql"> · {{ boardFilter.jql }}</template></template
        >
        <template v-if="boardOwner"> · Owner: {{ boardOwner.displayName }}</template>
      </p>
      <p v-else-if="selectedBoard" class="jira-help" aria-label="Board filter and owner metadata unavailable">
        Filter and owner metadata are unavailable from this Jira board response.
      </p>
      <p v-if="boardPageTruncated" class="jira-help" role="status">
        Showing the first page of this board. Narrow the filters to see fewer, more relevant issues.
      </p>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  boardCapabilities,
  boardCapability,
  boardFilter,
  boardOwner,
  boardPageTruncated,
  currentWorkspace,
  openPinnedBoard,
  pinnedBoardWorkspace,
  selectedBoard,
} = useJiraPaneContext();

const deniedCapabilities = computed(() =>
  Object.entries(boardCapabilities.value)
    .filter(([, state]) => state === "permission-denied")
    .map(([name]) => name),
);
</script>
