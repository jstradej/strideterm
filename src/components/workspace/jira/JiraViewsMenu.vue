<template>
  <details
    class="jira-extra-actions jira-views-menu"
    data-align="start"
    @keydown.esc="onMenuEscape"
    @keydown="onMenuKeydown"
    @focusout="closeExtraActionsWhenFocusLeaves"
    @toggle="positionExtraActionsMenu"
  >
    <summary
      class="button button--ghost"
      aria-label="Views"
      title="My issues, recent searches, favorites, saved queries"
    >
      Views
    </summary>
    <div
      class="jira-extra-actions__menu jira-views-menu__panel"
      role="menu"
      aria-label="Views"
      @click="closeMenuOnItemClick"
    >
      <template v-if="canRunMyIssues">
        <button class="jira-menu__item" role="menuitem" type="button" @click="runMyIssues(false)">
          <span>My issues</span>
          <small v-if="!hasOwnIdentity">Choose your Jira identity first</small>
          <small v-else>Assigned to you, not done</small>
        </button>
        <button v-if="hasOwnIdentity" class="jira-menu__item" role="menuitem" type="button" @click="runMyIssues(true)">
          <span>My issues, including done</span>
        </button>
      </template>
      <template v-if="!isAllConnections">
        <p class="jira-menu__heading">Recent</p>
        <button
          v-for="recent in recentDevelopmentWorkspaces"
          :key="`dev:${recent.id}:${recent.issueKey}`"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          @click="openRecentDevelopment(recent.id)"
        >
          <span>{{ recent.issueKey }} · {{ recent.name }}</span>
          <small>Development · {{ recent.statusLabel }}</small>
        </button>
        <button
          v-for="(recent, index) in recentSearches"
          :key="`search:${recent.connectionId}:${recent.jql}:${index}`"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          :title="recent.jql"
          @click="run(() => runRecentSearch(recent))"
        >
          <span>{{ recent.label || "JQL search" }}</span>
          <small>{{ recent.jql }}</small>
        </button>
        <button
          v-for="recent in recentViewedIssuesInScope"
          :key="`viewed:${recent.ref.connectionId}:${recent.ref.issueId}`"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          @click="run(() => openRecentIssue(recent))"
        >
          <span>{{ recent.ref.issueKey }} · {{ recent.summary }}</span>
          <small>{{ recent.status || "Status unavailable" }}</small>
        </button>
        <p
          v-if="!recentDevelopmentWorkspaces.length && !recentSearches.length && !recentViewedIssuesInScope.length"
          class="jira-menu__note"
        >
          Nothing yet. Searches and issues you open appear here.
        </p>
        <p class="jira-menu__heading">Favorites</p>
        <p v-if="favoriteFiltersUnavailable" class="jira-menu__note" role="status">
          Jira favorite filters are unavailable on this connection or account.
        </p>
        <p v-else-if="!favoriteFilters.length" class="jira-menu__note">You have no favorite filters in Jira.</p>
        <button
          v-for="filter in favoriteFilters"
          :key="filter.id"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          @click="run(() => runFavoriteFilter(filter.id))"
        >
          <span>{{ filter.name }}</span>
        </button>
        <p class="jira-menu__heading">Saved queries</p>
        <p v-if="queryError" class="jira-inline-error" role="alert">{{ queryError }}</p>
        <p v-if="!savedQueries.length" class="jira-menu__note">None yet. Save one from Advanced JQL.</p>
        <button
          v-for="query in savedQueries"
          :key="query.id"
          class="jira-menu__item"
          role="menuitem"
          type="button"
          :title="query.jql"
          @click="run(() => runSavedQuery(query.id))"
        >
          <span>{{ query.name }}</span>
        </button>
      </template>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  closeExtraActionsWhenFocusLeaves,
  closeMenuOnItemClick,
  connectionId,
  connections,
  favoriteFilters,
  favoriteFiltersUnavailable,
  onMenuEscape,
  onMenuKeydown,
  openInlineHumanIdentitySetup,
  openRecentDevelopment,
  openRecentIssue,
  positionExtraActionsMenu,
  queryError,
  recentDevelopmentWorkspaces,
  recentSearches,
  recentViewedIssuesInScope,
  runFavoriteFilter,
  runRecentSearch,
  runSavedQuery,
  savedQueries,
  searchAllMyIssues,
  searchOwnIssues,
  selectedConnection,
  showIssuesView,
} = useJiraPaneContext();

const isAllConnections = computed(() => connectionId.value === "__all__");
const hasOwnIdentity = computed(() =>
  isAllConnections.value
    ? connections.value.some((connection) => connection.ownIdentity)
    : Boolean(selectedConnection.value?.ownIdentity),
);
const canRunMyIssues = computed(() => (isAllConnections.value ? hasOwnIdentity.value : Boolean(connectionId.value)));

function run(action: () => unknown) {
  showIssuesView();
  void action();
}

function runMyIssues(includeDone: boolean) {
  if (!hasOwnIdentity.value) {
    openInlineHumanIdentitySetup();
    return;
  }
  const baseJql = includeDone ? undefined : "statusCategory != Done";
  run(() => (isAllConnections.value ? searchAllMyIssues(baseJql) : searchOwnIssues(baseJql)));
}
</script>
