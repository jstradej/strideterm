<template>
  <div class="jira-popout">
    <JiraIssuePopoutPane v-if="init" :profile-id="init.profileId" :workspace-id="init.workspaceId" :issue="init.ref" />
    <p v-else-if="error" class="jira-popout__message jira-popout__message--error" role="alert">{{ error }}</p>
    <p v-else class="jira-popout__message" role="status">Loading issue…</p>
    <PersistentToastStack />
  </div>
</template>

<script setup lang="ts">
import { inject, onMounted, ref } from "vue";

import JiraIssuePopoutPane from "./components/workspace/JiraIssuePopoutPane.vue";
import PersistentToastStack from "./components/layout/PersistentToastStack.vue";
import { rlog } from "./lib/renderer-log.js";
import { userFacingMessage } from "./lib/error-message.js";
import { apiKey } from "./types/keys.js";

const api = inject(apiKey);
const init = ref<Awaited<ReturnType<NonNullable<NonNullable<typeof api>["getJiraIssuePopoutInit"]>>>>(null);
const error = ref("");

onMounted(async () => {
  try {
    const result = await api?.getJiraIssuePopoutInit?.();
    if (!result) throw new Error("This window has no issue to show. Close it and pop the issue out again.");
    init.value = result;
  } catch (cause) {
    rlog("error", "[jira] Could not start the issue window", { message: (cause as Error)?.message || String(cause) });
    error.value = userFacingMessage((cause as Error)?.message || String(cause), "Could not open the issue.");
  }
});
</script>

<style scoped>
.jira-popout {
  height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
}
.jira-popout > :deep(.jira-inbox--popout) {
  flex: 1;
  min-height: 0;
}
.jira-popout__message {
  margin: auto;
  color: var(--muted);
}
.jira-popout__message--error {
  color: var(--danger, #e5484d);
}
</style>
