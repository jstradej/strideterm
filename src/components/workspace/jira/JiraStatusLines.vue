<template>
  <p v-if="showChooseBoardHint" class="jira-board-empty" role="status">
    {{
      connectionId === "__all__"
        ? "Select one Jira connection to choose a board."
        : "Choose a board above to view its columns and issues."
    }}
  </p>
  <p v-if="showOwnIssuesEmpty" class="jira-board-empty" role="status">
    No issues assigned to {{ selectedConnection?.ownIdentity?.displayName || "your Jira identity" }}.
  </p>
  <p v-else-if="showBoardEmpty" class="jira-board-empty" role="status">This board has no issues in the current view.</p>
  <p v-else-if="showNoSprints" class="jira-board-empty" role="status">This board has no sprints available.</p>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  activeView,
  boardHasMore,
  boardId,
  boardMode,
  boardSprints,
  boardViewLoaded,
  boardsLoading,
  connectionId,
  contentPending,
  issues,
  ownIssuesBoardMode,
  selectedConnection,
} = useJiraPaneContext();

const isBoard = computed(() => activeView.value === "board");
const showChooseBoardHint = computed(
  () =>
    isBoard.value &&
    !boardId.value &&
    !ownIssuesBoardMode.value &&
    !boardsLoading.value &&
    !contentPending.value &&
    !issues.value.length,
);
const showOwnIssuesEmpty = computed(
  () =>
    isBoard.value && ownIssuesBoardMode.value && boardViewLoaded.value && !issues.value.length && !contentPending.value,
);
const showBoardEmpty = computed(
  () =>
    isBoard.value &&
    Boolean(boardId.value) &&
    boardViewLoaded.value &&
    !contentPending.value &&
    boardMode.value !== "sprints" &&
    !issues.value.length &&
    !boardHasMore.value,
);
const showNoSprints = computed(
  () =>
    isBoard.value &&
    Boolean(boardId.value) &&
    boardViewLoaded.value &&
    !contentPending.value &&
    boardMode.value === "sprints" &&
    !boardSprints.value.length,
);
</script>
