<template>
  <details v-if="connectionId && connectionId !== '__all__'" class="jira-saved-query-details">
    <summary
      title="Rename or delete the saved JQL queries of this connection, and choose which are checked for changes in the background."
    >
      Saved queries
    </summary>
    <section class="jira-saved-queries" aria-label="Saved Jira queries">
      <p v-if="queryError" class="jira-inline-error" role="alert">{{ queryError }}</p>
      <p class="jira-help">
        Saved queries run from the Views menu in Issues. Here you can rename them, delete them, or ask strIDEterm to
        check one for changes in the background.
      </p>
      <p v-if="!savedQueries.length" class="jira-help">You have no saved queries yet. Save one from Advanced JQL.</p>
      <ul v-if="savedQueries.length" class="jira-saved-queries__list">
        <li v-for="query in savedQueries" :key="query.id" class="jira-saved-queries__item">
          <input
            v-if="canManageQueries"
            :value="query.name"
            :aria-label="`Name of saved query ${query.name}`"
            maxlength="100"
            @change="renameQuery(query, ($event.target as HTMLInputElement).value)"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
          />
          <strong v-else>{{ query.name }}</strong>
          <code class="jira-saved-queries__jql" :title="query.jql">{{ query.jql }}</code>
          <label v-if="canManageQueries" class="jira-query-notifications"
            ><input
              type="checkbox"
              :checked="query.notificationsEnabled"
              :disabled="isBusy('query-save', 'query-delete')"
              @change="updateSavedQuery(query, { notificationsEnabled: ($event.target as HTMLInputElement).checked })"
            />
            Check for updates in the background</label
          >
          <JiraBusyButton
            v-if="canManageQueries"
            class="button button--ghost button--small"
            :busy="isBusy('query-delete')"
            :disabled="isBusy('query-save')"
            :title="
              isBusy('query-save')
                ? 'Wait until the current save finishes.'
                : `Delete “${query.name}” after you confirm. Its background checks stop too.`
            "
            @click="deleteQuery(query.id)"
          >
            Delete
          </JiraBusyButton>
        </li>
      </ul>
      <p v-if="savedQueries.length && canManageQueries" class="jira-help">
        Background checks look for changed issues in the query. They are off until you enable them and do not capture
        the full Jira notification stream.
      </p>
      <p v-else-if="savedQueries.length" class="jira-help">
        Saved query editing and polling controls are available in the desktop app.
      </p>
    </section>
  </details>
</template>

<script setup lang="ts">
import JiraBusyButton from "./JiraBusyButton.vue";

import type { JiraSavedQuery } from "./pane/jira-pane-types.js";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const { canManageQueries, connectionId, deleteQuery, isBusy, queryError, savedQueries, updateSavedQuery } =
  useJiraPaneContext();

function renameQuery(query: JiraSavedQuery, value: string) {
  const name = value.trim();
  if (!name || name === query.name) return;
  void updateSavedQuery(query, { name });
}
</script>
