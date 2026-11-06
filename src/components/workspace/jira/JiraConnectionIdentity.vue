<template>
  <section
    v-if="selectedConnection && !api.isRemote"
    v-show="identityPanelOpen"
    class="jira-identity"
    aria-label="Your Jira user for My issues"
  >
    <p>Pick the person whose issues appear under My issues. Changes in Jira are still made by the connected account.</p>
    <label
      >{{ selectedConnection.deployment === "cloud" ? "Cloud accountId" : "Data Center username"
      }}<input v-model="identityValue" /></label
    ><JiraBusyButton
      class="button"
      :busy="isBusy('identity')"
      :title="`Look up this ${selectedConnection.deployment === 'cloud' ? 'accountId' : 'username'} in Jira and save it as you for My issues.`"
      @click="verifyOwnIdentity"
      >Verify and save personal identity</JiraBusyButton
    >
    <p v-if="identityError" class="jira-inline-error" role="alert">{{ identityError }}</p>
  </section>
</template>

<script setup lang="ts">
import JiraBusyButton from "./JiraBusyButton.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const { api, identityError, identityPanelOpen, identityValue, isBusy, selectedConnection, verifyOwnIdentity } =
  useJiraPaneContext();
</script>
