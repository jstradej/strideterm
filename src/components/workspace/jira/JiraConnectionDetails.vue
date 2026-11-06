<template>
  <section v-if="metadataEditing && selectedConnection" class="jira-connection-edit-card" aria-label="Edit connection">
    <div class="jira-connection-edit-card__head">
      <h3 class="jira-connection-edit__title">Edit connection</h3>
      <div class="jira-connection-edit-card__tabs" role="tablist" aria-label="Edit connection">
        <button
          v-for="tab in EDIT_TABS"
          :key="tab.id"
          type="button"
          role="tab"
          class="jira-connection-edit-card__tab"
          :class="{ 'jira-connection-edit-card__tab--active': connectionEditTab === tab.id }"
          :aria-selected="connectionEditTab === tab.id"
          :disabled="isBusy('connection') || connectionTestBusy || connectionSaveBusy"
          :title="tab.title"
          @click="openConnectionEditTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>
    <div v-if="connectionEditTab === 'general'" class="jira-connection-edit" role="tabpanel" aria-label="General">
      <label
        ><span>Connection name</span
        ><input v-model="metadataDraft.label" :aria-invalid="metadataFieldError('label') ? 'true' : undefined"
      /></label>
      <small v-if="metadataFieldError('label')" class="jira-field-error" role="alert">{{
        metadataFieldError("label")
      }}</small>
      <label
        ><span>Search only these projects</span
        ><input
          v-model="metadataDraft.projectKeysText"
          placeholder="ABC, OPS"
          :aria-invalid="metadataFieldError('projectKeys') ? 'true' : undefined"
        /><small class="jira-help"
          >Project keys, comma separated. Issues, boards and searches show only these projects. Empty shows all.</small
        ></label
      >
      <small v-if="metadataFieldError('projectKeys')" class="jira-field-error" role="alert">{{
        metadataFieldError("projectKeys")
      }}</small>
      <label
        ><span>Starting query (JQL)</span
        ><input
          v-model="metadataDraft.defaultJql"
          placeholder="project = ABC ORDER BY updated DESC"
          :aria-invalid="metadataFieldError('defaultJql') ? 'true' : undefined"
        /><small class="jira-help"
          >Runs when you open this connection. Empty shows the issues assigned to you.</small
        ></label
      >
      <small v-if="metadataFieldError('defaultJql')" class="jira-field-error" role="alert">{{
        metadataFieldError("defaultJql")
      }}</small>
      <label
        ><span>Link issue keys to this connection</span
        ><input
          v-model="metadataDraft.issueKeyPrefixesText"
          placeholder="ABC, OPS"
          aria-label="Link issue keys to this connection"
          :aria-invalid="metadataFieldError('issueKeyPrefixes') ? 'true' : undefined"
        /><small class="jira-help"
          >Keys like ABC-123 in pull request comments and other text open in this Jira. Does not filter searches.</small
        ></label
      >
      <small v-if="metadataFieldError('issueKeyPrefixes')" class="jira-field-error" role="alert">{{
        metadataFieldError("issueKeyPrefixes")
      }}</small>
      <label
        ><span>Default poll interval (seconds)</span
        ><input
          v-model.number="metadataDraft.pollSeconds"
          type="number"
          :aria-invalid="metadataFieldError('pollSeconds') ? 'true' : undefined"
        /><small class="jira-help">How often saved queries checked in the background are refreshed.</small></label
      >
      <small v-if="metadataFieldError('pollSeconds')" class="jira-field-error" role="alert">{{
        metadataFieldError("pollSeconds")
      }}</small>
      <label
        title="Technical means a shared service account: comments can carry an attribution line, and My issues needs your own Jira user."
        ><span>Account purpose</span
        ><CustomSelect v-model="metadataDraft.accountPurpose" :options="accountPurposeOptions" /><small
          class="jira-help"
          >Personal acts as you. Technical is a shared service account; then My issues needs your own Jira user.</small
        ></label
      >
      <p v-if="metadataError" class="jira-inline-error" role="alert">{{ metadataError }}</p>
      <div class="jira-connection-edit__actions">
        <JiraBusyButton
          class="button"
          :busy="isBusy('connection')"
          :title="`Save the name, defaults, poll interval and account purpose of ${selectedConnection.label}. Credentials stay as they are.`"
          @click="saveConnectionMetadata"
        >
          Save details
        </JiraBusyButton>
        <button
          class="button button--ghost"
          type="button"
          :disabled="isBusy('connection')"
          :title="
            isBusy('connection')
              ? 'Wait until the current connection change finishes.'
              : 'Close without saving these changes.'
          "
          @click="closeConnectionEdit"
        >
          Cancel
        </button>
      </div>
    </div>
    <div v-else class="jira-setup jira-setup--inline" role="tabpanel" aria-label="Connection">
      <JiraConnectionCredentialsForm />
    </div>
  </section>
  <dl v-if="selectedConnection" class="jira-connection-status" aria-label="Connection status and identity">
    <div class="jira-connection-status__row">
      <dt>Status</dt>
      <dd role="status" aria-label="Jira connection health">
        <span class="jira-connection-status__dot" :data-state="availability.state" aria-hidden="true"></span>
        {{ availability.label }}
        <template v-if="healthProblem">
          · <span class="jira-connection-health">{{ healthProblem }}</span></template
        >
        <small v-if="checkedAt" class="jira-connection-status__muted"> · checked {{ checkedAt }}</small>
      </dd>
    </div>
    <div class="jira-connection-status__row">
      <dt>Jira account</dt>
      <dd class="jira-account">
        {{ selectedConnection.verifiedIdentity?.displayName || "Not verified" }}
        <small class="jira-connection-status__muted">
          · {{ selectedConnection.accountPurpose === "technical" ? "shared technical account" : "personal account" }}
        </small>
      </dd>
    </div>
    <div class="jira-connection-status__row">
      <dt>My issues for</dt>
      <dd>
        {{
          selectedConnection.ownIdentity?.displayName ||
          (selectedConnection.accountPurpose === "technical" ? "Not set" : "The Jira account")
        }}
        <button
          v-if="!api.isRemote"
          class="jira-connection-status__link"
          type="button"
          :aria-expanded="identityPanelOpen"
          title="Choose whose issues My issues shows on this connection."
          @click="identityPanelOpen = !identityPanelOpen"
        >
          {{ identityPanelOpen ? "Close" : "Change" }}
        </button>
      </dd>
    </div>
  </dl>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraConnectionCredentialsForm from "./JiraConnectionCredentialsForm.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";
import type { JiraMetadataField } from "./pane/jira-metadata-validation.js";

const {
  accountPurposeOptions,
  api,
  closeConnectionEdit,
  connectionEditTab,
  connectionSaveBusy,
  connectionTestBusy,
  identityPanelOpen,
  isBusy,
  openConnectionEditTab,
  jiraErrorLabel,
  metadataDraft,
  metadataEditing,
  saveConnectionMetadata,
  selectedConnection,
  metadataError,
  metadataTouched,
  metadataValidation,
} = useJiraPaneContext();
const EDIT_TABS = [
  { id: "general", label: "General", title: "Name, project keys, default JQL, poll interval and account purpose." },
  { id: "connection", label: "Connection", title: "Jira address and credentials. A blank secret keeps the saved one." },
] as const;
const availability = computed(() => {
  const status = selectedConnection.value?.status;
  if (status === "connected") return { state: "ok", label: "Connected" };
  if (status === "needs-login") return { state: "warn", label: "Sign-in required" };
  if (status) return { state: "error", label: "Unavailable / offline" };
  return { state: "unknown", label: "Not checked yet" };
});
const healthProblem = computed(() => {
  const health = selectedConnection.value?.health;
  if (!health || (health.state as string) === "verified") return "";
  const retry = health.retryAfterMs ? `. Retry after ${Math.ceil(health.retryAfterMs / 1000)} seconds` : "";
  return `${jiraErrorLabel(health.state)}${retry}`;
});
const checkedAt = computed(() => {
  const raw = selectedConnection.value?.health?.checkedAt;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : "";
});

function metadataFieldError(field: JiraMetadataField) {
  const validation = metadataValidation.value;
  return metadataTouched.value && !validation.ok ? (validation.errors[field] ?? "") : "";
}
</script>
