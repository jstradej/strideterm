<template>
  <section
    v-if="humanIdentitySetupOpen && selectedConnection"
    class="jira-human-identity-setup"
    aria-labelledby="jira-human-identity-setup-title"
  >
    <h3 id="jira-human-identity-setup-title">Choose your Jira identity</h3>
    <p>
      Pick yourself so My issues and Assign to me know who you are. Changes in Jira are still made by the connected
      account.
    </p>
    <form class="jira-human-identity-setup__search" @submit.prevent="searchHumanIdentityUsers">
      <label>
        Search Jira users
        <input v-model="humanIdentitySearchText" autocomplete="off" placeholder="Name or email" />
      </label>
      <JiraBusyButton
        class="button button--ghost"
        type="submit"
        :busy="humanIdentitySearchLoading"
        :disabled="!humanIdentitySearchText.trim()"
        :title="
          humanIdentitySearchText.trim()
            ? 'Find Jira users on this connection by name or email.'
            : 'Type a name or email to search for.'
        "
      >
        Search
      </JiraBusyButton>
    </form>
    <ul v-if="humanIdentitySearchResults.length" class="jira-human-identity-setup__results" aria-label="Jira users">
      <li v-for="user in humanIdentitySearchResults" :key="jiraUserOptionKey(user)">
        <button
          class="button button--ghost"
          type="button"
          :aria-pressed="
            humanIdentitySelectedUser ? jiraUserOptionKey(humanIdentitySelectedUser) === jiraUserOptionKey(user) : false
          "
          :title="`Choose ${user.displayName} as you. Nothing is saved until Verify and continue.`"
          @click="selectHumanIdentityUser(user)"
        >
          {{ user.displayName }}
        </button>
      </li>
    </ul>
    <p v-if="humanIdentitySearchError" class="jira-human-identity-setup__error" role="alert">
      {{ humanIdentitySearchError }}
    </p>
    <p v-if="humanIdentitySelectedUser" class="jira-human-identity-setup__selected" role="status">
      Selected: {{ humanIdentitySelectedUser.displayName }}
    </p>
    <div class="jira-human-identity-setup__actions">
      <JiraBusyButton
        class="button"
        :busy="humanIdentitySaving"
        :disabled="!humanIdentitySelectedUser"
        :title="
          humanIdentitySelectedUser
            ? `Check ${humanIdentitySelectedUser.displayName} with Jira and save them as you for My issues and Assign to me.`
            : 'Choose your user from the search results first.'
        "
        @click="saveSelectedHumanIdentity"
      >
        Verify and continue
      </JiraBusyButton>
      <button
        class="button button--ghost"
        type="button"
        :disabled="humanIdentitySaving"
        :title="humanIdentitySaving ? 'Wait until saving finishes.' : 'Close without changing your Jira identity.'"
        @click="closeInlineHumanIdentitySetup"
      >
        Cancel
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import JiraBusyButton from "./JiraBusyButton.vue";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  closeInlineHumanIdentitySetup,
  humanIdentitySaving,
  humanIdentitySearchError,
  humanIdentitySearchLoading,
  humanIdentitySearchResults,
  humanIdentitySearchText,
  humanIdentitySelectedUser,
  humanIdentitySetupOpen,
  jiraUserOptionKey,
  saveSelectedHumanIdentity,
  searchHumanIdentityUsers,
  selectHumanIdentityUser,
  selectedConnection,
} = useJiraPaneContext();
</script>
