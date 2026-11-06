<template>
  <details class="jira-board-options" @keydown.esc="onMenuEscape">
    <summary class="button button--ghost" :title="summaryTitle">
      <span v-if="boardMode === 'sprints' && selectedSprintId" class="jira-sprint-bar" aria-label="Selected sprint">
        <strong class="jira-sprint-bar__name">{{ selectedSprint?.name || "Selected sprint" }}</strong>
        <span v-if="sprintRemainingLabel" class="jira-sprint-bar__remaining">{{ sprintRemainingLabel }}</span>
        <span v-if="sprintProgress.total" class="jira-sprint-bar__progress">
          <span class="jira-sprint-bar__meter" aria-hidden="true"
            ><span :style="{ width: `${Math.round((sprintProgress.done / sprintProgress.total) * 100)}%` }"
          /></span>
          {{ sprintProgress.done }} / {{ sprintProgress.total }}
        </span>
      </span>
      <span v-else>{{ modeLabel }}</span>
    </summary>
    <div class="jira-board-options__panel">
      <p v-if="boardMode === 'sprints' && selectedSprint" class="jira-board-options__sprint">
        <strong>{{ selectedSprint.name }}</strong>
        <span v-if="selectedSprint.state" class="jira-sprint-bar__state" :data-state="selectedSprint.state">
          {{ selectedSprint.state }}
        </span>
        <span v-if="sprintDateRange">{{ sprintDateRange }}</span>
      </p>
      <label
        >Board view<CustomSelect v-model="boardMode" :options="boardModeOptions" @change="onBoardModeChange"
      /></label>
      <label v-if="boardMode === 'sprints' && boardSprints.length"
        >Sprint<CustomSelect
          v-model.number="selectedSprintId"
          :options="sprintOptions"
          :loading="isBusy('sprint')"
          placeholder="Choose a sprint"
          @change="loadSelectedSprintIssues"
      /></label>
      <p v-else-if="boardMode === 'sprints'" class="jira-board-options__empty">
        No sprints are available for this board. Switch to Issues or Backlog.
      </p>
      <label v-if="boardMode === 'issues'"
        >Completed issues<CustomSelect v-model="doneWithinChoice" :options="doneWithinOptions" @change="loadBoard"
      /></label>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from "vue";

import CustomSelect from "../../common/CustomSelect.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  boardMode,
  boardModeOptions,
  boardSprints,
  doneWithinChoice,
  doneWithinDays,
  doneWithinOptions,
  isBusy,
  loadBoard,
  loadSelectedSprintIssues,
  onBoardModeChange,
  onMenuEscape,
  selectedSprint,
  selectedSprintId,
  sprintDateRange,
  sprintOptions,
  sprintProgress,
  sprintRemainingLabel,
} = useJiraPaneContext();

const modeLabel = computed(() => {
  if (boardMode.value === "backlog") return "Backlog";
  if (boardMode.value === "sprints") return "Choose a sprint";
  const label = boardModeOptions.value.find((option) => option.value === boardMode.value)?.label || "All issues";
  return doneWithinDays.value ? `${label} · done in ${doneWithinDays.value} d` : label;
});

const summaryTitle = computed(() => {
  if (boardMode.value === "sprints" && selectedSprintId.value)
    return "The sprint this board shows, how long it has left and how much is done. Click to pick another sprint, the backlog or all issues.";
  if (boardMode.value === "issues" && doneWithinDays.value)
    return `Open issues plus those completed or changed in the last ${doneWithinDays.value} days. Click to change it or to show a sprint or the backlog.`;
  return "Show the board by sprint, as the backlog or as all issues, and choose how long completed issues stay on it.";
});
</script>
