<template>
  <section v-if="signInExpired && signInConnection" class="jira-sign-in-card" aria-labelledby="jira-sign-in-title">
    <h3 id="jira-sign-in-title">Sign-in expired for {{ signInConnection.label }}</h3>
    <p>
      Jira no longer accepts the saved sign-in for this connection, so nothing can be loaded or changed until you sign
      in again. Your saved views, queries and drafts are kept.
    </p>
    <div class="jira-sign-in-card__actions">
      <JiraBusyButton
        v-if="canManageConnections"
        class="button jira-sign-in-card__primary"
        :busy="isBusy('sign-in')"
        title="Open this connection’s credentials form to enter a new API token, access token or gateway key. Saved views, queries and drafts are kept."
        @click="signInAgain"
      >
        Sign in again
      </JiraBusyButton>
      <button
        v-if="canManageConnections"
        class="button button--ghost jira-sign-in-card__settings"
        type="button"
        title="Manage Jira connections: test them, change credentials or disconnect."
        @click="openJiraSettings"
      >
        Open Jira settings
      </button>
    </div>
    <p v-if="!canManageConnections" class="jira-help">Signing in again is available in the desktop app.</p>
  </section>
</template>

<script setup lang="ts">
import JiraBusyButton from "./JiraBusyButton.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const { canManageConnections, isBusy, openJiraSettings, signInAgain, signInConnection, signInExpired } =
  useJiraPaneContext();
</script>
