<template>
  <section
    v-if="activeView === 'settings' && !setupVisible && !connectionsOnly"
    class="jira-settings-manager jira-settings-manager--general"
    aria-label="General Jira settings"
  >
    <h3>General</h3>
    <SettingsJiraCommentAttribution
      :value="jiraSettings?.commentAttribution"
      :connections="jiraSettings?.connections"
    />
  </section>
  <section
    v-if="
      noConnectionManager ||
      (connectionsOnly && !setupInProgress) ||
      (activeView === 'settings' && !setupVisible && !connectionsOnly)
    "
    class="jira-settings-manager"
    aria-label="Jira connections"
  >
    <div class="jira-settings-manager__heading">
      <div>
        <h3>Connections</h3>
        <p>Connect Jira Cloud, a self-hosted Jira site, or a site behind an API gateway.</p>
      </div>
      <button
        v-if="canManageConnections"
        ref="addConnectionButton"
        class="button"
        type="button"
        title="Set up another Jira Cloud, Data Center or API gateway connection. Existing connections stay as they are."
        @click="startConnectionSetup"
      >
        Add connection
      </button>
    </div>
    <p v-if="connectionStatus" role="status">{{ connectionStatus }}</p>
    <p v-if="connectionActionError" class="jira-inline-error" role="alert">{{ connectionActionError }}</p>
    <p class="jira-help jira-status-slot" role="status" :data-active="isBusy('connection')">
      Updating the Jira connection…
    </p>
    <p v-if="!connections.length && connectionsLoaded" class="jira-empty">
      No Jira connections yet. Add one here; you don’t need a Jira workspace.
    </p>
    <p v-if="!canManageConnections" class="jira-help">Connection changes are available in the desktop app.</p>
    <article
      v-for="connection in connections"
      :key="connection.id"
      class="jira-connection-panel"
      :class="{ 'jira-connection-panel--open': openConnectionPanelId === connection.id }"
    >
      <button
        class="jira-connection-panel__header"
        type="button"
        :aria-expanded="openConnectionPanelId === connection.id"
        :aria-controls="`jira-connection-panel-${connection.id}`"
        :title="
          openConnectionPanelId === connection.id
            ? `Hide the settings of ${connection.label}.`
            : `Show the settings, identity and saved queries of ${connection.label}.`
        "
        @click="toggleConnectionPanel(connection.id)"
      >
        <span class="jira-settings-manager__details">
          <strong>{{ connection.label }}</strong>
          <span>{{ connection.webUrl }}</span>
          <small
            >{{ jiraConnectionTypeLabel(connection) }} ·
            {{ connection.verifiedIdentity?.displayName || "Not verified" }}</small
          >
        </span>
        <svg class="jira-connection-panel__chevron" aria-hidden="true" viewBox="0 0 24 24">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div
        v-if="openConnectionPanelId === connection.id"
        :id="`jira-connection-panel-${connection.id}`"
        class="jira-connection-panel__body"
        role="region"
        :aria-label="`${connection.label} settings`"
      >
        <div v-if="canManageConnections" class="jira-settings-manager__actions">
          <button
            class="button"
            type="button"
            :disabled="isBusy('connection')"
            :title="idleTitle(`Change the name, defaults, address or credentials of ${connection.label}.`)"
            @click="runManagedConnectionAction(connection.id, 'edit')"
          >
            Edit
          </button>
          <JiraBusyButton
            class="button button--ghost"
            :busy="verifyingConnectionId === connection.id"
            :disabled="isBusy('connection') && verifyingConnectionId !== connection.id"
            :title="
              isBusy('connection') && verifyingConnectionId !== connection.id
                ? 'Wait until the current connection change finishes.'
                : `Check that ${connection.label} can still sign in and read Jira. Changes nothing.`
            "
            @click="runManagedConnectionAction(connection.id, 'verify')"
          >
            Test connection
          </JiraBusyButton>
          <button
            class="button button--danger"
            type="button"
            :disabled="isBusy('connection')"
            :title="
              idleTitle(
                `Remove ${connection.label} with its credentials, views and watches after you confirm. Nothing in Jira is deleted.`,
              )
            "
            @click="runManagedConnectionAction(connection.id, 'disconnect')"
          >
            Disconnect
          </button>
        </div>
        <p
          v-if="connectionVerificationResults[connection.id]"
          class="jira-connection-verify-result"
          :class="{ 'jira-connection-verify-result--error': !connectionVerificationResults[connection.id]?.ok }"
          :role="connectionVerificationResults[connection.id]?.ok ? 'status' : 'alert'"
          aria-live="polite"
        >
          {{ connectionVerificationResults[connection.id]?.message }}
        </p>
        <template v-if="connectionId === connection.id">
          <JiraConnectionDetails />
          <JiraConnectionIdentity />
          <JiraSavedQueries />
        </template>
      </div>
    </article>
    <p v-if="connectionsLoaded && connections.length === 0 && !canManageConnections" class="jira-empty">
      No Jira connections are available in this profile.
    </p>
  </section>
  <section v-if="setupVisible" class="jira-setup" aria-label="Connect Jira">
    <p class="eyebrow">Jira setup · Step {{ setupStep }} of 3</p>
    <template v-if="setupStep === 1">
      <h2>Connect your Jira site</h2>
      <p>Choose the option that matches your Jira setup. Credentials are saved to this desktop profile.</p>
      <label class="jira-setup__field"
        ><span class="jira-setup__field-title">Connection name</span
        ><input ref="setupNameInput" v-model="draft.label" placeholder="Engineering Jira" /><small
          class="jira-setup__field-help"
          >Optional. We’ll use the Jira site address if blank.</small
        ></label
      >
      <label
        class="jira-setup__field jira-setup__type"
        title="How strIDEterm reaches Jira. The type cannot be changed after saving; add another connection instead."
        ><span class="jira-setup__field-title">Connection type</span
        ><CustomSelect v-model="connectionType" :options="connectionTypeOptions" /><small
          class="jira-setup__field-help"
          >{{ connectionTypeDescription }}</small
        ></label
      >
      <div class="jira-setup__actions">
        <button
          class="button"
          type="button"
          title="Go to step 2 and enter the sign-in details for this connection type."
          @click="goToConnectionDetails"
        >
          Continue
        </button>
        <button
          class="button button--ghost"
          type="button"
          :disabled="isBusy('connection')"
          :title="idleTitle('Leave setup without adding a connection.')"
          @click="cancelConnectionSetup"
        >
          Cancel
        </button>
      </div>
    </template>
    <template v-else-if="setupStep === 2">
      <h2>
        {{
          draft.deployment === "cloud"
            ? draft.id
              ? "Replace Jira API token"
              : "Add your Jira Cloud site"
            : draft.id
              ? draft.authMode === "apim"
                ? "Update gateway credentials"
                : "Replace Jira access token"
              : draft.authMode === "apim"
                ? "Add your gateway details"
                : "Add your Jira site details"
        }}
      </h2>
      <JiraConnectionCredentialsForm />
    </template>
    <template v-else>
      <h2>Jira connection verified</h2>
      <p v-if="connectionsOnly">
        {{ connectionStatus || "Your Jira site is ready." }} The connection is available to Jira workspaces in this
        profile.
      </p>
      <p v-else>
        {{ connectionStatus || "Your Jira site is ready." }} Jira is connected. Choose “Open Jira issues” to search
        issues and view boards.
      </p>
      <section v-if="selectedConnection && !connectionsOnly" class="jira-setup__choices" aria-label="Before you start">
        <div v-if="selectedConnection.accountPurpose === 'technical' && !selectedConnection.ownIdentity">
          <strong>Who are you in Jira?</strong>
          <p class="jira-setup__field-help">
            This is a shared account. Choose your own Jira user, or My issues will show the account’s issues instead of
            yours.
          </p>
          <button
            class="button"
            type="button"
            title="Pick your own Jira user so My issues shows your issues, not the shared account's."
            @click="chooseIdentityAfterSetup"
          >
            Choose my Jira user
          </button>
        </div>
        <div>
          <strong>Which projects?</strong>
          <p class="jira-setup__field-help">Optional. Limit searches and boards to the projects you work in.</p>
          <JiraProjectScopePicker
            :model-value="projectScopeChoice"
            :projects="projectCatalog"
            :default-project-keys="selectedConnection.projectKeys || []"
            :loading="projectCatalogLoading"
            :truncated="projectCatalogTruncated"
            :error="projectCatalogError"
            :save-error="projectScopeError"
            @open="loadJiraProjectCatalog(connectionId)"
            @update:model-value="setProjectScope"
          />
        </div>
      </section>
      <div class="jira-setup__actions">
        <button
          ref="setupFinishButton"
          class="button"
          type="button"
          :title="
            connectionsOnly
              ? 'Close setup. Jira workspaces in this profile can now use the connection.'
              : 'Close setup and start searching issues and boards on this connection.'
          "
          @click="finishSetup"
        >
          {{ connectionsOnly ? "Done" : "Open Jira issues" }}
        </button>
        <button
          class="button button--ghost"
          type="button"
          title="Leave setup and return to the list of Jira connections. The new connection stays saved."
          @click="cancelConnectionSetup"
        >
          Back to connections
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import SettingsJiraCommentAttribution from "../../dialogs/settings/SettingsJiraCommentAttribution.vue";
import { useAppStore } from "../../../stores/app.js";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraConnectionCredentialsForm from "./JiraConnectionCredentialsForm.vue";
import JiraConnectionDetails from "./JiraConnectionDetails.vue";
import JiraConnectionIdentity from "./JiraConnectionIdentity.vue";
import JiraSavedQueries from "./JiraSavedQueries.vue";
import JiraProjectScopePicker from "./JiraProjectScopePicker.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  activeView,
  addConnectionButton,
  isBusy,
  canManageConnections,
  cancelConnectionSetup,
  connectionType,
  connectionTypeDescription,
  connectionTypeOptions,
  connectionId,
  connectionVerificationResults,
  connections,
  connectionsLoaded,
  connectionsOnly,
  draft,
  dynamicApi,
  finishSetup,
  goToConnectionDetails,
  jiraConnectionTypeLabel,
  loadJiraProjectCatalog,
  openInlineHumanIdentitySetup,
  projectCatalog,
  projectCatalogError,
  projectCatalogLoading,
  projectCatalogTruncated,
  projectScopeChoice,
  projectScopeError,
  selectedConnection,
  setProjectScope,
  noConnectionManager,
  connectionStatus,
  runManagedConnectionAction,
  setupFinishButton,
  setupInProgress,
  setupNameInput,
  setupStep,
  setupVisible,
  startConnectionSetup,
  verifyingConnectionId,
  connectionActionError,
  openConnectionPanelId,
  toggleConnectionPanel,
} = useJiraPaneContext();
type JiraAppSettings = {
  commentAttribution?: { enabled: boolean; text: string; position: "before" | "after" };
  connections?: Array<{
    accountPurpose?: string;
    ownIdentity?: { displayName?: string };
    verifiedIdentity?: { displayName?: string };
  }>;
};
const appStore = useAppStore();
const jiraSettings = computed(
  () =>
    (appStore.payload?.appState as { settings?: { integrations?: { jira?: JiraAppSettings } } } | undefined)?.settings
      ?.integrations?.jira,
);

function idleTitle(text: string) {
  return isBusy("connection") ? "Wait until the current connection change finishes." : text;
}
function chooseIdentityAfterSetup() {
  finishSetup();
  openInlineHumanIdentitySetup("list");
}
</script>
