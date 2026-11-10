<template>
  <div v-if="!connectionsOnly" class="jira-topbar">
    <header class="jira-head">
      <div class="jira-head__identity">
        <h2>
          {{
            setupVisible
              ? "Connect Jira"
              : noConnectionManager
                ? "Jira connections"
                : activeView === "settings"
                  ? "Jira settings"
                  : activeView === "board"
                    ? jiraViewId !== "issues"
                      ? selectedNativeView?.title || selectedNativeView?.boardName || "Board"
                      : "Board"
                    : "Issues"
          }}
        </h2>
        <label
          v-if="jiraViewId === 'issues' && !setupVisible && !noConnectionManager && activeView !== 'settings'"
          class="jira-head__connection"
          title="The Jira connection this tab uses. All connections runs a text search on each; JQL and boards need one connection."
          >Connection<CustomSelect
            v-model="connectionId"
            :options="connectionOptions"
            placeholder="Select a connection"
            @change="onConnectionChange"
        /></label>
        <button
          v-if="activeView !== 'settings'"
          class="jira-head__refresh"
          type="button"
          :disabled="isVisibleSyncing"
          :aria-busy="isVisibleSyncing ? 'true' : undefined"
          :aria-label="isVisibleSyncing ? 'Refreshing Jira data' : 'Refresh Jira data'"
          :title="
            isVisibleSyncing
              ? 'Jira data is being refreshed.'
              : 'Reload this view and the open issue from Jira. What is shown now stays until the new data arrives.'
          "
          @click="refreshVisibleJiraData({ userInitiated: true })"
        >
          <Spinner v-if="refreshSpinnerVisible" aria-hidden="true" label="Refreshing Jira data" />
          <svg v-else aria-hidden="true" viewBox="0 0 24 24">
            <path d="M20 7v5h-5M4 17v-5h5M5.5 9a7 7 0 0 1 11.7-2L20 12M4 12l2.8 5a7 7 0 0 0 11.7-2" />
          </svg>
        </button>
        <p
          v-if="activeView !== 'settings'"
          class="jira-head__sync"
          :class="{
            'jira-head__sync--error': visibleSyncError || backgroundFailureText || headFailure,
            'jira-head__sync--loading': headLoading,
            'jira-head__sync--filled': headSyncFilled,
          }"
          role="status"
          aria-live="polite"
          :aria-busy="stripBusy ? 'true' : undefined"
        >
          <span v-if="headLoading" class="jira-head__sync-status">
            <Spinner v-if="!refreshSpinnerVisible" aria-hidden="true" :label="shownStripLabel" />
            <span class="jira-head__sync-text" :title="stripExistingResultsNote ? existingResultsNote : undefined">{{
              shownStripLabel
            }}</span>
          </span>
          <span v-else-if="headFailure" class="jira-head__sync-status jira-native-view-sync-error" role="alert">
            <span class="jira-head__sync-text" :title="headFailure.text">{{ headFailure.text }}</span>
            <button
              class="button button--ghost button--small"
              type="button"
              :title="headFailure.title"
              @click="headFailure.retry()"
            >
              Retry
            </button>
          </span>
          <template v-else>
            <span v-if="headSyncLabel">{{ headSyncLabel }}</span>
            <time
              v-if="headCacheMetadata"
              :datetime="new Date(headCacheMetadata.fetchedAt).toISOString()"
              :title="formatJiraDate(new Date(headCacheMetadata.fetchedAt).toISOString())"
            >
              {{ formatSyncAge(headCacheMetadata.fetchedAt) }} ago
            </time>
            <span v-if="backgroundFailureText">{{ backgroundFailureText }}</span>
            <span v-else-if="visibleSyncError">· {{ visibleSyncError }}</span>
            <span v-if="isVisibleSyncing">· Refreshing…</span>
          </template>
        </p>
      </div>
      <div
        v-if="
          (compactBoardLayout && !compactSelectedIssue && activeView === 'issues') ||
          (connections.length && canManageConnections && jiraViewId === 'issues' && activeView !== 'settings')
        "
        class="jira-head__actions"
      >
        <button
          v-if="compactBoardLayout && !compactSelectedIssue && activeView === 'issues'"
          class="button button--ghost"
          type="button"
          :title="
            searchToolsOpen
              ? 'Hide the advanced search, JQL and saved query tools.'
              : 'Show advanced search with JQL, filters and saved queries.'
          "
          @click="toggleAdvancedSearch"
        >
          {{ searchToolsOpen ? "Hide search" : "Search & filters" }}
        </button>
        <button
          v-if="connections.length && canManageConnections && jiraViewId === 'issues'"
          class="button button--ghost jira-head__add"
          type="button"
          title="Open the settings of the selected Jira connection."
          @click="openConnectionSettings"
        >
          Connection settings
        </button>
        <p v-if="boardActionError" class="jira-inline-error" role="alert">{{ boardActionError }}</p>
      </div>
    </header>
    <JiraViewTabs v-if="viewTabs" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import Spinner from "../../common/Spinner.vue";
import { useDelayedFlag } from "../../../composables/useDelayedFlag.js";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraViewTabs from "./JiraViewTabs.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

defineProps<{ viewTabs?: boolean }>();

const {
  activeView,
  canManageConnections,
  compactBoardLayout,
  compactSelectedIssue,
  connectionId,
  connectionOptions,
  connections,
  connectionsOnly,
  backgroundFailureText,
  formatJiraDate,
  formatSyncAge,
  headCacheMetadata,
  headSyncLabel,
  isVisibleSyncing,
  jiraViewId,
  noConnectionManager,
  onConnectionChange,
  openConnectionSettings,
  refreshVisibleJiraData,
  searchToolsOpen,
  selectedNativeView,
  setupVisible,
  toggleAdvancedSearch,
  visibleSyncError,
  boardActionError,
  isNativeSavedView,
  nativeViewSync,
  refreshFailure,
  shownStripLabel,
  stripBackground,
  stripBusy,
  stripExistingResultsNote,
  stripVisible,
} = useJiraPaneContext();
const existingResultsNote = "Existing results remain visible while the refresh completes.";
const headLoading = computed(() => stripVisible.value && !stripBackground.value);
const headFailure = computed(() => {
  if (stripBusy.value) return null;
  if (isNativeSavedView.value && activeView.value === "board" && nativeViewSync.value?.state === "error")
    return {
      text:
        backgroundFailureText.value ||
        `Jira sync failed. ${visibleSyncError.value || "Cached issues remain available."}`,
      title: "Sync this view with Jira again. Cached issues stay visible meanwhile.",
      retry: () => refreshVisibleJiraData(),
    };
  if (refreshFailure.value)
    return {
      text: refreshFailure.value,
      title: "Load this view from Jira again. The issues already shown stay visible meanwhile.",
      retry: () => refreshVisibleJiraData({ userInitiated: true }),
    };
  return null;
});
const headSyncFilled = computed(
  () =>
    headLoading.value ||
    Boolean(headFailure.value) ||
    Boolean(headSyncLabel.value) ||
    Boolean(headCacheMetadata.value) ||
    Boolean(backgroundFailureText.value) ||
    Boolean(visibleSyncError.value) ||
    isVisibleSyncing.value,
);
const refreshSpinnerVisible = useDelayedFlag(isVisibleSyncing);
</script>
