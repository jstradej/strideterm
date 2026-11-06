import { computed } from "vue";
import { useJiraPaneContext } from "./jira-pane-context.js";

/** A compact Issues list keeps one search row on screen and moves its narrowing tools into a bottom sheet. */
export function useJiraFilterSheetMode() {
  const { activeView, isCompactPane, jiraViewId } = useJiraPaneContext();
  return computed(() => isCompactPane.value && jiraViewId.value === "issues" && activeView.value === "issues");
}
