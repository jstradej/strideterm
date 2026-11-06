<template>
  <section
    v-if="activeView === 'board' && (boardId || searchHasRun)"
    class="jira-board-toolbar"
    aria-label="Board filters and synchronization status"
  >
    <div v-if="isNativeSavedView" class="jira-native-view-toolbar">
      <div class="jira-native-view-toolbar__modes" role="group" aria-label="Issue presentation">
        <button
          class="jira-native-view-toolbar__mode"
          :aria-pressed="nativePresentation === 'board'"
          type="button"
          title="Show these issues in columns by status, like the Jira board."
          @click="selectNativePresentation('board')"
        >
          Board
        </button>
        <button
          class="jira-native-view-toolbar__mode"
          :aria-pressed="nativePresentation === 'list'"
          type="button"
          title="Show these issues as one list with a text filter."
          @click="selectNativePresentation('list')"
        >
          List
        </button>
      </div>
      <label
        v-if="isCompactPane"
        class="jira-native-view-toolbar__status-picker"
        title="Show only the loaded issues in one status. The numbers count loaded issues."
      >
        <span class="jira-native-view-toolbar__status-label">Filter by issue status</span>
        <CustomSelect
          v-model="nativeStatusSelectValue"
          :options="nativeStatusSelectOptions"
          button-class="jira-native-view-toolbar__status-select"
        />
      </label>
      <div v-else class="jira-native-view-toolbar__statuses" role="group" aria-label="Filter by issue status">
        <button
          v-for="option in nativeStatusOptions"
          :key="option.key || 'all'"
          class="jira-native-view-toolbar__status"
          :data-tone="option.tone"
          :aria-pressed="nativeStatusFilter === option.key"
          type="button"
          :title="
            option.key === null
              ? 'Show the loaded issues in every status.'
              : `Show only the loaded issues in status ${option.label}.`
          "
          @click="selectNativeStatusFilter(option.key)"
        >
          {{ option.label }} <span>{{ option.count }}</span>
        </button>
      </div>
      <div
        v-if="isCompactPane && nativePresentation === 'board' && issueFilterText.trim()"
        class="jira-native-board-filter-indicator"
        role="group"
        :aria-label="`Active issue filter: ${issueFilterText}`"
      >
        <span title="A text filter is active">Filter</span>
        <button
          class="button button--ghost button--small"
          type="button"
          title="Clear the text filter and the status filter on this view."
          @click="clearNativeIssueFilter"
        >
          Clear
        </button>
      </div>
    </div>
    <template v-if="!boardId">
      <span v-if="!ownIssuesBoardMode || !isCompactPane" class="jira-help">
        <template v-if="ownIssuesBoardMode"
          >My issues · {{ ownSearchIdentityLabel || "verified human identity" }}</template
        >
        <template v-else>Search results · {{ activeSearchLabel }}</template>
        <template v-if="searchRefreshing">· Refreshing…</template>
      </span>
      <details v-if="selectedNativeView?.kind === 'personal'" class="jira-board-filter-details jira-personal-scope">
        <summary title="Choose open or all issues, and which projects this My issues view covers.">
          Issue scope
          <span class="jira-board-filter-count">{{ nativePersonalScope === "open" ? "Open only" : "All issues" }}</span>
          <span class="jira-project-scope-inline">{{ projectScopeLabel }}</span>
        </summary>
        <label title="Open issues leaves out Done issues. The choice is saved with this view.">
          Show issues
          <CustomSelect v-model="nativePersonalScopeChoice" :options="personalScopeOptions" />
        </label>
        <p class="jira-help">Open only hides Done issues. All includes completed issues.</p>
        <JiraProjectScopePicker
          :model-value="projectScopeChoice"
          :projects="projectCatalog"
          :default-project-keys="selectedConnection?.projectKeys || []"
          :loading="projectCatalogLoading"
          :truncated="projectCatalogTruncated"
          :error="projectCatalogError"
          :save-error="projectScopeError"
          @open="loadJiraProjectCatalog(connectionId)"
          @update:model-value="setProjectScope"
        />
      </details>
      <div v-if="!selectedNativeView && activeView === 'board' && connectionId !== '__all__'">
        <JiraProjectScopePicker
          :model-value="projectScopeChoice"
          :projects="projectCatalog"
          :default-project-keys="selectedConnection?.projectKeys || []"
          :loading="projectCatalogLoading"
          :truncated="projectCatalogTruncated"
          :error="projectCatalogError"
          :save-error="projectScopeError"
          @open="loadJiraProjectCatalog(connectionId)"
          @update:model-value="setProjectScope"
        />
      </div>
    </template>
    <div v-if="boardId" class="jira-board-people" role="group" aria-label="Filter board by assignee">
      <button
        class="jira-assignee-chip jira-assignee-chip--all"
        type="button"
        :aria-pressed="selectedBoardAssignee === null"
        title="Show the issues of every assignee."
        @click="clearBoardAssignee"
      >
        All
      </button>
      <button
        v-for="user in peopleChips"
        :key="jiraUserOptionKey(user)"
        class="jira-assignee-chip"
        type="button"
        :aria-label="user.displayName"
        :aria-pressed="isBoardAssignee(user)"
        :title="
          isBoardAssignee(user)
            ? `Showing only ${user.displayName}'s issues. Click again to show everyone.`
            : `Show only issues assigned to ${user.displayName}${isOwnJiraUser(user) ? ' (you)' : ''}.`
        "
        @click="isBoardAssignee(user) ? clearBoardAssignee() : selectBoardAssignee(user)"
      >
        <JiraPerson
          :display-name="user.displayName"
          size="md"
          :show-name="isBoardAssignee(user)"
          :me="isOwnJiraUser(user)"
          hide-title
        />
      </button>
      <button
        class="jira-assignee-chip"
        type="button"
        aria-label="Unassigned"
        :aria-pressed="selectedBoardAssignee?.kind === 'unassigned'"
        :title="
          selectedBoardAssignee?.kind === 'unassigned'
            ? 'Showing only issues with no assignee. Click again to show everyone.'
            : 'Show only issues with no assignee.'
        "
        @click="selectedBoardAssignee?.kind === 'unassigned' ? clearBoardAssignee() : selectUnassignedAssignee()"
      >
        <JiraPerson size="md" :show-name="selectedBoardAssignee?.kind === 'unassigned'" hide-title />
      </button>
      <button
        class="jira-board-people__find"
        type="button"
        aria-label="Find another assignee"
        title="Find any Jira user, also one with no issue on this board yet, and show only their issues."
        @click="openAssigneeSearch"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4.5 10.5a6 6 0 1 0 12 0a6 6 0 1 0-12 0" />
          <path d="M15 15l5 5" />
        </svg>
      </button>
    </div>
    <div v-if="boardId" class="jira-board-toolbar__end">
      <JiraBoardOptions />
      <JiraBoardInfo />
      <details
        ref="boardFilterDetailsRef"
        class="jira-board-filter-details"
        :open="boardFilterDetailsOpen"
        @toggle="onBoardFilterDetailsToggle"
        @keydown.capture="onBoardFilterDetailsKeydown"
      >
        <summary
          tabindex="0"
          title="Jira quick filters of this board, My issues and a search over all Jira users. The number shows how many filters are active."
        >
          Board filters
          <span v-if="selectedBoardAssignee !== null || selectedQuickFilterIds.length" class="jira-board-filter-count">
            {{ selectedQuickFilterIds.length + Number(selectedBoardAssignee !== null) }} active
          </span>
        </summary>
        <div class="jira-board-filter-content">
          <JiraBusyButton
            v-if="selectedConnection?.ownIdentity"
            class="button button--ghost button--small"
            :aria-pressed="isOwnBoardFilterSelected"
            :busy="isBusy('my-issues-board')"
            :title="`Open My issues for ${selectedConnection.ownIdentity.displayName}: the issues assigned to your Jira user on this connection.`"
            @click="openMyIssuesBoard"
          >
            {{ isOwnBoardFilterSelected ? `My issues · ${selectedConnection.ownIdentity.displayName}` : "My issues" }}
          </JiraBusyButton>
          <div v-if="boardQuickFilters.length" class="jira-board-quick-filters" aria-label="Jira quick filters">
            <button
              v-for="filter in boardQuickFilters"
              :key="filter.id"
              class="jira-board-filter-chip"
              :aria-pressed="selectedQuickFilterIds.includes(filter.id)"
              :title="
                filter.description ||
                `Apply the Jira quick filter “${filter.name}” to this board. Click again to remove it.`
              "
              type="button"
              @click="toggleQuickFilter(filter.id)"
            >
              {{ filter.name }}
            </button>
          </div>
          <div class="jira-assignee-filter">
            <label for="jira-assignee-search">Search all Jira users</label>
            <input
              id="jira-assignee-search"
              v-model="assigneeSearchText"
              type="search"
              autocomplete="off"
              placeholder="Find another assignee…"
              @input="queueAssigneeSearch"
              @keydown.enter.prevent="chooseFirstAssigneeResult"
              @keydown.esc="assigneeSearchResults = []"
            />
            <div
              v-if="assigneeSearchResults.length || assigneeSearchLoading || assigneeSearchText"
              class="jira-assignee-results"
              role="listbox"
              aria-label="Jira user search results"
            >
              <button type="button" title="Show only issues with no assignee." @click="selectUnassignedAssignee">
                Unassigned
              </button>
              <button
                v-for="user in assigneeSearchResults"
                :key="jiraUserOptionKey(user)"
                type="button"
                role="option"
                :aria-selected="
                  selectedBoardAssignee?.kind === 'user' && selectedBoardAssignee.id === jiraUserIdentity(user)
                "
                :title="`Show only issues assigned to ${user.displayName}.`"
                @click="selectBoardAssignee(user)"
              >
                {{ user.displayName
                }}<small>{{ user.kind === "cloud" ? user.accountId : user.key || user.name }}</small>
              </button>
              <span v-if="assigneeSearchLoading" role="status">Searching…</span>
              <span v-else-if="assigneeSearchError" role="alert" class="jira-inline-error">{{
                assigneeSearchError
              }}</span>
              <span v-else-if="assigneeSearchText && !assigneeSearchResults.length">No Jira users found.</span>
            </div>
          </div>
          <p v-if="boardQuickFilterError" class="jira-cache-status jira-cache-status--error" role="status">
            {{ boardQuickFilterError }}
          </p>
        </div>
      </details>
    </div>
    <JiraBusyButton
      v-if="ownIssuesBoardMode ? searchHasMore : boardHasMore"
      class="button button--ghost jira-board-load-more"
      :busy="isBusy(ownIssuesBoardMode ? 'search-more' : 'board-more')"
      :title="
        ownIssuesBoardMode
          ? 'Load the next page of your issues from Jira.'
          : 'Load the next page of this board’s issues from Jira.'
      "
      @click="ownIssuesBoardMode ? loadMore() : loadMoreBoard()"
    >
      Load more
    </JiraBusyButton>
    <p v-if="workspaceViewSaveError" class="jira-cache-status jira-cache-status--error" role="status">
      {{ workspaceViewSaveError }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import JiraBoardInfo from "./JiraBoardInfo.vue";
import JiraBoardOptions from "./JiraBoardOptions.vue";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraPerson from "./JiraPerson.vue";
import JiraProjectScopePicker from "./JiraProjectScopePicker.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";
import type { JiraUserRef } from "./pane/jira-pane-types.js";

const {
  activeSearchLabel,
  activeView,
  assigneeCatalog,
  assigneeSearchLoading,
  assigneeSearchResults,
  assigneeSearchText,
  boardFilterDetailsOpen,
  boardFilterDetailsRef,
  boardHasMore,
  boardId,
  boardQuickFilterError,
  boardQuickFilters,
  chooseFirstAssigneeResult,
  clearBoardAssignee,
  clearNativeIssueFilter,
  connectionId,
  isCompactPane,
  isNativeSavedView,
  isOwnBoardFilterSelected,
  isBusy,
  isOwnJiraUser,
  issueFilterText,
  jiraUserIdentity,
  jiraUserOptionKey,
  loadJiraProjectCatalog,
  loadMore,
  loadMoreBoard,
  nativePersonalScope,
  nativePersonalScopeChoice,
  nativePresentation,
  nativeStatusFilter,
  nativeStatusOptions,
  nativeStatusSelectOptions,
  nativeStatusSelectValue,
  onBoardFilterDetailsKeydown,
  onBoardFilterDetailsToggle,
  openMyIssuesBoard,
  ownIssuesBoardMode,
  ownSearchIdentityLabel,
  personalScopeOptions,
  projectCatalog,
  projectCatalogError,
  projectCatalogLoading,
  projectCatalogTruncated,
  projectScopeChoice,
  projectScopeLabel,
  queueAssigneeSearch,
  searchHasMore,
  searchHasRun,
  searchRefreshing,
  selectBoardAssignee,
  selectNativePresentation,
  selectNativeStatusFilter,
  selectUnassignedAssignee,
  selectedBoardAssignee,
  selectedConnection,
  selectedNativeView,
  selectedQuickFilterIds,
  setProjectScope,
  toggleQuickFilter,
  workspaceViewSaveError,
  assigneeSearchError,
  projectScopeError,
} = useJiraPaneContext();

const peopleChips = computed(() => [
  ...assigneeCatalog.value.filter((user) => isOwnJiraUser(user)),
  ...assigneeCatalog.value.filter((user) => !isOwnJiraUser(user)),
]);

function isBoardAssignee(user: JiraUserRef) {
  return selectedBoardAssignee.value?.kind === "user" && selectedBoardAssignee.value.id === jiraUserIdentity(user);
}

async function openAssigneeSearch() {
  const details = boardFilterDetailsRef.value;
  if (!details) return;
  details.open = true;
  await nextTick();
  details.querySelector<HTMLInputElement>(".jira-assignee-filter input")?.focus();
}
</script>
