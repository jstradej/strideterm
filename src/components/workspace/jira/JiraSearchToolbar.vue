<template>
  <section class="jira-controls">
    <div v-if="toolbarRowVisible" class="jira-toolbar-row">
      <form v-if="activeView === 'issues'" class="jira-quick-search" role="search" @submit.prevent="searchQuick">
        <input
          ref="quickSearchInputRef"
          v-model="quickSearchText"
          type="search"
          autocomplete="off"
          maxlength="200"
          aria-label="Search Jira by issue key or words"
          title="Use an issue key or words. Punctuation is ignored, and all words must match. Press / to focus."
          placeholder="Issue key or words…  ( / )"
          @input="quickSearchError = ''"
        />
        <JiraBusyButton
          class="button"
          type="submit"
          :busy="isBusy('search')"
          :disabled="!quickSearchText.trim()"
          :title="
            quickSearchText.trim()
              ? 'Open the issue with this key, or list issues whose text contains all of these words'
              : 'Type an issue key (ABC-123) or some words first'
          "
        >
          Search
        </JiraBusyButton>
        <small v-if="quickSearchError" class="jira-quick-search__error" role="status">{{ quickSearchError }}</small>
      </form>
      <div v-else-if="connectionId !== '__all__'" class="jira-board-controls">
        <label
          ref="boardChooserLabelRef"
          title="Choose a board to show here. Use Save as tab to keep it as its own tab."
          @click.capture="onBoardChooserOpen"
          >Board<CustomSelect
            v-model.number="boardId"
            :options="boardOptions"
            :searchable="true"
            :loading="boardsLoading"
            :has-more="boardsHaveMore"
            search-placeholder="Filter Jira boards…"
            @search="queueBoardSearch"
            @load-more="loadMoreBoards"
            @change="onBoardChange"
        /></label>
      </div>
      <p v-else class="jira-help">Select one Jira connection to choose a board.</p>
      <JiraFilterSheet v-if="filterSheetMode" />
      <JiraViewsMenu />
      <JiraProjectScopePicker
        v-if="connectionId !== '__all__'"
        class="jira-primary-project-scope"
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
      <details
        class="jira-extra-actions jira-toolbar-more"
        @keydown.esc="onMenuEscape"
        @keydown="onMenuKeydown"
        @focusout="closeExtraActionsWhenFocusLeaves"
        @toggle="positionExtraActionsMenu"
      >
        <summary
          class="button button--ghost"
          aria-label="More search options"
          title="Search with your own JQL, or open My issues as its own tab"
        >
          ⋯
        </summary>
        <div
          class="jira-extra-actions__menu"
          role="menu"
          aria-label="More search options"
          @click="closeMenuOnItemClick"
        >
          <button
            v-if="activeView === 'issues'"
            class="jira-menu__item"
            role="menuitem"
            type="button"
            @click="openAdvancedJql"
          >
            <JiraMenuIcon name="code" />
            <span>Advanced JQL…</span>
          </button>
          <button
            v-if="connectionId !== '__all__' && selectedConnection && !connectionsOnly"
            class="jira-menu__item"
            role="menuitem"
            type="button"
            :disabled="isBusy('my-issues-board')"
            :title="
              selectedConnection.ownIdentity
                ? 'Add a tab with the issues assigned to you on this connection'
                : 'Tell strIDEterm which Jira user you are first, so it knows whose issues to show'
            "
            @click="selectedConnection.ownIdentity ? openMyIssuesBoard() : openInlineHumanIdentitySetup('tab')"
          >
            <JiraMenuIcon name="tab" />
            <span>Open My issues as a tab</span>
            <small v-if="!selectedConnection.ownIdentity">Choose your Jira identity first</small>
          </button>
        </div>
      </details>
      <JiraBusyButton
        v-if="activeView !== 'issues' && connectionId !== '__all__' && boardId && !connectionsOnly"
        class="button jira-save-board-tab"
        :class="{ 'button--ghost': boardSavedAsTab }"
        :busy="workspaceViewSaving"
        :title="
          boardSavedAsTab
            ? 'This board already has its own tab. Switch to it.'
            : 'Keep this board as its own tab, so it is one click away and refreshes on its own.'
        "
        @click="openSelectedBoardAsNativeTab"
      >
        {{ boardSavedAsTab ? "Open saved tab" : "Save as tab" }}
      </JiraBusyButton>
    </div>
    <JiraSmartFilters
      v-if="
        !filterSheetMode &&
        jiraViewId === 'issues' &&
        activeView === 'issues' &&
        connectionId &&
        connectionId !== '__all__' &&
        !connectionsOnly
      "
    />
    <p
      v-if="jiraViewId === 'issues' && activeView === 'board' && boardPickerNotice"
      class="jira-board-picker-notice"
      role="status"
    >
      {{ boardPickerNotice }}
    </p>
    <p
      v-if="
        activeView === 'issues' &&
        selectedConnection?.accountPurpose === 'technical' &&
        /currentUser\(\)/i.test(activeSearchJql)
      "
      class="jira-help"
      role="status"
    >
      These results are for the shared API account, not for you. Choose your Jira user to see your own issues.
    </p>
    <p
      v-if="connectionVerificationResults[connectionId] && !connectionsOnly"
      class="jira-connection-verify-result"
      :class="{ 'jira-connection-verify-result--error': !connectionVerificationResults[connectionId]?.ok }"
      :role="connectionVerificationResults[connectionId]?.ok ? 'status' : 'alert'"
      aria-live="polite"
    >
      {{ connectionVerificationResults[connectionId]?.message }}
    </p>
    <details
      v-if="activeView === 'issues' && connectionId && (!compactBoardLayout || searchToolsOpen)"
      ref="searchDetailsRef"
      class="jira-search-details"
      :class="{ 'jira-search-details--requested': searchToolsOpen }"
      @toggle="onSearchDetailsToggle"
    >
      <summary title="Search with your own JQL, save it as a query, or open a Jira filter by its ID">
        Advanced JQL
        <span class="jira-project-scope-inline">{{ projectScopeLabel }}</span>
      </summary>
      <form v-if="connectionId === '__all__'" class="jira-search" @submit.prevent="searchAllText">
        <label
          >Text search across connections<input v-model="textSearch" maxlength="200" placeholder="Search issue text"
        /></label>
        <JiraBusyButton
          class="button"
          type="submit"
          :busy="isBusy('search')"
          :disabled="!textSearch.trim()"
          :title="
            textSearch.trim()
              ? 'Search issue text on every Jira connection at once'
              : 'Type some words to search for first'
          "
        >
          Search all
        </JiraBusyButton>
      </form>
      <template v-else>
        <form class="jira-search" @submit.prevent="search()">
          <label
            >JQL
            <input ref="jqlInputRef" v-model="jql" placeholder="assignee = currentUser() ORDER BY updated DESC" />
          </label>
          <JiraBusyButton
            class="button"
            type="submit"
            :busy="isBusy('search')"
            :disabled="!connectionId"
            title="Run this JQL on the selected connection and list the results"
          >
            Run
          </JiraBusyButton>
        </form>
        <form v-if="canManageQueries" class="jira-search jira-save-query" @submit.prevent="saveQuery">
          <label
            >Save this JQL as a query
            <input v-model="queryName" maxlength="100" placeholder="Query name" />
          </label>
          <JiraBusyButton
            class="button button--ghost"
            type="submit"
            :busy="isBusy('query-save')"
            title="Keep this JQL under the name above; it then appears in Views under Saved queries"
          >
            Save query
          </JiraBusyButton>
        </form>
        <p v-if="queryError" class="jira-inline-error" role="alert">{{ queryError }}</p>
        <p v-if="queryNotice" class="jira-help" role="status">{{ queryNotice }}</p>
        <form v-if="!api.isRemote" class="jira-search jira-filter-by-id" @submit.prevent="runSavedFilterById">
          <label
            >Open Jira filter by ID<input
              v-model="savedFilterLookupId"
              inputmode="numeric"
              pattern="[0-9]{1,20}"
              maxlength="20"
          /></label>
          <JiraBusyButton
            class="button button--ghost"
            type="submit"
            :busy="isBusy('search')"
            :disabled="!savedFilterLookupId"
            :title="
              savedFilterLookupId
                ? 'Load the saved Jira filter with this ID into the JQL editor and run it'
                : 'Enter the numeric ID of a Jira filter first'
            "
          >
            Load and run
          </JiraBusyButton>
        </form>
      </template>
      <p v-if="ownSearchIdentityLabel" class="jira-help" role="status">
        Showing issues for {{ ownSearchIdentityLabel }}. The JQL editor remains unchanged.
      </p>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraMenuIcon from "./JiraMenuIcon.vue";
import JiraProjectScopePicker from "./JiraProjectScopePicker.vue";
import JiraSmartFilters from "./JiraSmartFilters.vue";
import JiraFilterSheet from "./JiraFilterSheet.vue";
import { useJiraFilterSheetMode } from "./pane/useJiraFilterSheetMode.js";
import JiraViewsMenu from "./JiraViewsMenu.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  activeSearchJql,
  activeView,
  api,
  boardChooserLabelRef,
  boardId,
  boardOptions,
  boardPickerNotice,
  boardsHaveMore,
  boardsLoading,
  canManageQueries,
  closeExtraActionsWhenFocusLeaves,
  compactBoardLayout,
  closeMenuOnItemClick,
  connectionId,
  connectionVerificationResults,
  connectionsOnly,
  isBusy,
  jiraViewId,
  jql,
  jqlInputRef,
  loadJiraProjectCatalog,
  loadMoreBoards,
  onBoardChange,
  onBoardChooserOpen,
  onMenuEscape,
  onMenuKeydown,
  openInlineHumanIdentitySetup,
  openMyIssuesBoard,
  openSelectedBoardAsNativeTab,
  ownSearchIdentityLabel,
  positionExtraActionsMenu,
  projectCatalog,
  projectCatalogError,
  projectCatalogLoading,
  projectCatalogTruncated,
  projectScopeChoice,
  projectScopeError,
  projectScopeLabel,
  queryError,
  queryName,
  queryNotice,
  queueBoardSearch,
  quickSearchError,
  quickSearchInputRef,
  quickSearchText,
  runSavedFilterById,
  saveQuery,
  savedFilterLookupId,
  search,
  searchAllText,
  searchDetailsRef,
  searchQuick,
  selectedBoardSavedView,
  searchToolsOpen,
  selectedConnection,
  setProjectScope,
  textSearch,
  workspaceViewSaving,
} = useJiraPaneContext();
const filterSheetMode = useJiraFilterSheetMode();

const boardSavedAsTab = computed(() => Boolean(selectedBoardSavedView.value));
const toolbarRowVisible = computed(
  () => jiraViewId.value === "issues" && Boolean(connectionId.value) && activeView.value !== "settings",
);

function onSearchDetailsToggle(event: Event) {
  if (!(event.currentTarget as HTMLDetailsElement).open) searchToolsOpen.value = false;
}

async function openAdvancedJql() {
  searchToolsOpen.value = true;
  await nextTick();
  if (searchDetailsRef.value) searchDetailsRef.value.open = true;
  await nextTick();
  searchDetailsRef.value?.scrollIntoView?.({ block: "nearest" });
  (jqlInputRef.value ?? searchDetailsRef.value?.querySelector<HTMLInputElement>("input"))?.focus();
}
</script>
