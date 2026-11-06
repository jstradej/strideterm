<template>
  <div
    class="workspace-pane__body workspace-pane__body--git jira-pane"
    :class="{
      'jira-pane--plain': connectionsOnly,
      'jira-pane--compact-board': compactBoardLayout,
      'jira-pane--issues-view': activeView === 'issues',
      'jira-pane--compact-detail': compactSelectedIssue,
    }"
  >
    <PaneShell v-if="showHeader" title="Jira" :status="status" />
    <JiraViewTabs v-if="viewTabsAvailable && !isMobile" />
    <div
      ref="jiraRootRef"
      class="workspace-pane__body workspace-pane__body--git jira-inbox"
      :class="{
        'subtabs-panel': viewTabsAvailable && !isMobile && !compactSelectedIssue,
        'jira-inbox--setup': setupVisible,
        'jira-inbox--connections-only': connectionsOnly,
        'jira-inbox--no-connections': noConnectionManager,
        'jira-inbox--compact': isCompactPane,
        'jira-inbox--compact-board': compactBoardLayout,
        'jira-inbox--compact-detail': compactSelectedIssue,
        'jira-inbox--board-detail': boardIssueDetailOpen && !boardDrawerMode,
        'jira-inbox--board-drawer': boardDrawerMode,
        'jira-inbox--sign-in': signInExpired,
        'jira-inbox--native-view': jiraViewId !== 'issues',
        'jira-inbox--native-list': nativeListPresentation,
        'jira-inbox--issues-view': activeView === 'issues',
        'jira-inbox--board-view': activeView === 'board',
        'jira-inbox--settings-view': activeView === 'settings',
        'jira-inbox--filter-sheet': filterSheetMode,
      }"
      @focusin="onFocusin"
      @keydown="onPaneKeydown"
    >
      <JiraTopbar :view-tabs="viewTabsAvailable && isMobile" />
      <JiraCommentDrafts />
      <JiraSignInCard />
      <JiraHumanIdentitySetup />
      <JiraConnectionManager />
      <JiraSearchToolbar />
      <JiraStatusLines />
      <JiraErrorBanner />
      <JiraBoardToolbar />
      <JiraNativeIssueList />
      <JiraBoardView />
      <JiraIssueBrowser />
      <JiraIssuePreview />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, provide } from "vue";

import PaneShell from "../layout/PaneShell.vue";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import JiraTopbar from "./jira/JiraTopbar.vue";
import JiraViewTabs from "./jira/JiraViewTabs.vue";
import JiraCommentDrafts from "./jira/JiraCommentDrafts.vue";
import JiraErrorBanner from "./jira/JiraErrorBanner.vue";
import JiraSignInCard from "./jira/JiraSignInCard.vue";
import JiraConnectionManager from "./jira/JiraConnectionManager.vue";
import JiraSearchToolbar from "./jira/JiraSearchToolbar.vue";
import JiraHumanIdentitySetup from "./jira/JiraHumanIdentitySetup.vue";
import JiraStatusLines from "./jira/JiraStatusLines.vue";
import JiraBoardToolbar from "./jira/JiraBoardToolbar.vue";
import JiraNativeIssueList from "./jira/JiraNativeIssueList.vue";
import JiraBoardView from "./jira/JiraBoardView.vue";
import JiraIssueBrowser from "./jira/JiraIssueBrowser.vue";
import JiraIssuePreview from "./jira/JiraIssuePreview.vue";
import { createJiraPaneContext } from "./jira/pane/createJiraPaneContext.js";
import { jiraPaneContextKey } from "./jira/pane/jira-pane-context.js";
import "./jira/jira-inbox.css";

const props = withDefaults(
  defineProps<{ workspaceId?: string; jiraViewId?: string; showHeader?: boolean; connectionsOnly?: boolean }>(),
  {
    workspaceId: "",
    jiraViewId: "issues",
    showHeader: false,
    connectionsOnly: false,
  },
);
const ctx = createJiraPaneContext(props);
const jiraViewId = computed(() => props.jiraViewId || "issues");
provide(jiraPaneContextKey, ctx);
const {
  activeView,
  boardDrawerMode,
  boardIssueDetailOpen,
  compactBoardLayout,
  compactSelectedIssue,
  isCompactPane,
  jiraRootRef,
  nativeListPresentation,
  noConnectionManager,
  onPaneFocusin,
  onPaneKeydown,
  setupVisible,
  signInExpired,
  status,
} = ctx;
// Desktop shows the views as folder tabs above a framed panel; a phone keeps them in the header row, where they
// scroll away with it instead of costing a fixed row of a landscape screen.
const { isMobile } = useIsNarrow();
const viewTabsAvailable = computed(
  () => jiraViewId.value === "issues" && !props.connectionsOnly && !setupVisible.value && !noConnectionManager.value,
);
const connectionsOnly = computed(() => props.connectionsOnly);
// The pane provides the context, so it cannot inject it through useJiraFilterSheetMode().
const filterSheetMode = computed(
  () => isCompactPane.value && jiraViewId.value === "issues" && activeView.value === "issues",
);
function onFocusin(event: FocusEvent) {
  onPaneFocusin(event);
}
</script>
