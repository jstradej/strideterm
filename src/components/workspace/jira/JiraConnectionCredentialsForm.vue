<template>
  <template v-if="draft.deployment === 'cloud'">
    <p>
      Enter your Jira site address, the email of your Atlassian account and an API token. The token stays on this
      computer.
    </p>
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">Jira site URL</span
      ><input
        ref="setupWebUrlInput"
        v-model="draft.webUrl"
        :required="!draft.id"
        type="url"
        placeholder="https://your-site.atlassian.net"
        :aria-invalid="connectionTestFieldError === 'webUrl' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help">Address where you open Jira in your browser.</small
      ><small v-if="connectionTestFieldError === 'webUrl'" class="jira-setup__field-error">{{
        setupValidationError || "Review the Jira site address after reading the test result."
      }}</small></label
    >
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">Email</span
      ><input
        ref="setupEmailInput"
        v-model="draft.email"
        required
        type="email"
        autocomplete="off"
        placeholder="me@example.com"
        :aria-invalid="connectionTestFieldError === 'email' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help">The email address of the Atlassian account that owns the token.</small
      ><small v-if="connectionTestFieldError === 'email'" class="jira-setup__field-error">{{
        setupValidationError || "Review the email address after reading the test result."
      }}</small></label
    >
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">API token</span
      ><input
        ref="setupApiTokenInput"
        v-model="draft.apiToken"
        type="password"
        :required="!draft.id"
        autocomplete="new-password"
        :placeholder="draft.id ? 'Leave blank to keep the saved token' : ''"
        :aria-invalid="connectionTestFieldError === 'apiToken' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help"
        >{{ draft.id ? "Leave blank to keep the saved token. " : "" }}
        <a
          href="https://id.atlassian.com/manage-profile/security/api-tokens"
          class="link-accent"
          @click.prevent="openApiTokenHelp"
          >Create an API token</a
        ></small
      ><small v-if="connectionTestFieldError === 'apiToken'" class="jira-setup__field-error">{{
        setupValidationError || "Review the API token after reading the test result."
      }}</small></label
    >
    <label
      v-if="!credentialsInline"
      class="jira-setup__field"
      title="Technical means a shared service account: comments can carry an attribution line, and My issues needs your own Jira user."
      ><span class="jira-setup__field-title">Account purpose</span
      ><CustomSelect
        v-model="draft.accountPurpose"
        :options="accountPurposeOptions"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help"
        >Personal acts as you. Technical is a shared service account; then My issues needs your own Jira user.</small
      ></label
    >
  </template>
  <template v-else-if="draft.authMode === 'apim'">
    <p>
      {{
        draft.id
          ? "Update the gateway key or certificate. Leave a secret blank to keep the saved value."
          : "Enter the Jira address and the API gateway address provided by your administrator. The gateway URL may include a path prefix."
      }}
    </p>
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">Jira web URL</span
      ><input
        ref="setupWebUrlInput"
        v-model="draft.webUrl"
        required
        type="url"
        placeholder="https://jira.example.com"
        :aria-invalid="connectionTestFieldError === 'webUrl' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help">Address where you open Jira.</small
      ><small v-if="connectionTestFieldError === 'webUrl'" class="jira-setup__field-error">{{
        setupValidationError || "Review the Jira web address after reading the test result."
      }}</small></label
    >
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">API gateway base URL</span
      ><input
        ref="setupApiUrlInput"
        v-model="draft.apiBaseUrl"
        required
        type="url"
        placeholder="https://gateway.example.com/jira"
        :aria-invalid="connectionTestFieldError === 'apiBaseUrl' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help"
        >Use the gateway URL from your organization, including its path prefix.</small
      ><small v-if="connectionTestFieldError === 'apiBaseUrl'" class="jira-setup__field-error">{{
        setupValidationError || "Review the gateway URL after reading the test result."
      }}</small></label
    >
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">Subscription header name</span
      ><input
        ref="setupHeaderInput"
        v-model="draft.subscriptionHeaderName"
        required
        autocomplete="off"
        :aria-invalid="connectionTestFieldError === 'subscriptionHeaderName' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help"
        >Header used for the gateway key. Default: Ocp-Apim-Subscription-Key.</small
      ><small v-if="connectionTestFieldError === 'subscriptionHeaderName'" class="jira-setup__field-error">{{
        setupValidationError || "Review the header name after reading the test result."
      }}</small></label
    >
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">Subscription key</span
      ><input
        ref="setupKeyInput"
        v-model="draft.subscriptionKey"
        type="password"
        :required="!draft.id"
        autocomplete="new-password"
        :placeholder="draft.id ? 'Leave blank to keep the saved key' : ''"
        :aria-invalid="connectionTestFieldError === 'subscriptionKey' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help">{{
        draft.id
          ? "Key from your gateway administrator. Leave blank to keep the saved key."
          : "Key from your gateway administrator, not a Jira personal access token."
      }}</small
      ><small v-if="connectionTestFieldError === 'subscriptionKey'" class="jira-setup__field-error">{{
        setupValidationError || "Review the subscription key after reading the test result."
      }}</small></label
    >
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">Client certificate file</span
      ><span class="jira-setup__file-row"
        ><input
          ref="setupCertificateInput"
          :value="draft.clientCertificatePath"
          readonly
          placeholder="Optional .pfx or .p12 file"
          :aria-invalid="connectionTestFieldError === 'certificate' ? 'true' : undefined"
          :disabled="connectionSaveBusy"
        /><button
          class="button button--ghost"
          type="button"
          :disabled="isBusy('connection') || connectionTestBusy || connectionSaveBusy"
          :title="
            isBusy('connection') || connectionTestBusy || connectionSaveBusy
              ? 'Wait until the current test or save finishes.'
              : 'Pick the .pfx or .p12 client certificate your API gateway requires.'
          "
          @click="chooseClientCertificate"
        >
          Choose file
        </button></span
      ><small class="jira-setup__field-help">Optional PFX or P12 certificate from your administrator.</small
      ><small v-if="connectionTestFieldError === 'certificate'" class="jira-setup__field-error">{{
        setupValidationError || "Review the certificate file after reading the test result."
      }}</small></label
    >
    <label v-if="draft.clientCertificatePath" class="jira-setup__field"
      ><span class="jira-setup__field-title">Certificate password</span
      ><input
        ref="setupCertificatePasswordInput"
        v-model="draft.clientCertificatePassword"
        type="password"
        autocomplete="new-password"
        :aria-invalid="connectionTestFieldError === 'certificatePassword' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help">{{
        draft.id
          ? "Leave blank to keep it for this same file. Enter the password if you choose another file."
          : "Leave blank if the certificate has no password."
      }}</small
      ><small v-if="connectionTestFieldError === 'certificatePassword'" class="jira-setup__field-error">{{
        setupValidationError || "Review the certificate password after reading the test result."
      }}</small></label
    >
    <label
      v-if="!credentialsInline"
      class="jira-setup__field"
      title="Technical means a shared service account: comments can carry an attribution line, and My issues needs your own Jira user."
      ><span class="jira-setup__field-title">Account purpose</span
      ><CustomSelect
        v-model="draft.accountPurpose"
        :options="accountPurposeOptions"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help"
        >Personal acts as you. Technical is a shared service account; then My issues needs your own Jira user.</small
      ></label
    >
  </template>
  <template v-else>
    <p>
      Enter the address you use in your browser and the Jira API address provided by your Jira administrator. Then save
      and test the connection.
    </p>
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">Jira web URL</span
      ><input
        ref="setupWebUrlInput"
        v-model="draft.webUrl"
        :required="!draft.id"
        type="url"
        placeholder="https://jira.example.com"
        :aria-invalid="connectionTestFieldError === 'webUrl' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help">Address where you open Jira.</small
      ><small v-if="connectionTestFieldError === 'webUrl'" class="jira-setup__field-error">{{
        setupValidationError || "Review the Jira web address after reading the test result."
      }}</small></label
    >
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">Jira API URL</span
      ><input
        ref="setupApiUrlInput"
        v-model="draft.apiBaseUrl"
        :required="!draft.id"
        type="url"
        placeholder="https://jira.example.com"
        :aria-invalid="connectionTestFieldError === 'apiBaseUrl' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help">Use the API address supplied by your Jira administrator.</small
      ><small v-if="connectionTestFieldError === 'apiBaseUrl'" class="jira-setup__field-error">{{
        setupValidationError || "Review the Jira API address after reading the test result."
      }}</small></label
    >
    <label class="jira-setup__field"
      ><span class="jira-setup__field-title">Personal access token</span
      ><input
        ref="setupPatInput"
        v-model="draft.pat"
        type="password"
        :required="!draft.id"
        autocomplete="new-password"
        :placeholder="draft.id ? 'Leave blank to keep the saved token' : ''"
        :aria-invalid="connectionTestFieldError === 'pat' ? 'true' : undefined"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help">{{
        draft.id
          ? "Leave blank to keep the saved token."
          : "Create a personal access token in Jira account settings; it stays on this computer."
      }}</small
      ><small v-if="connectionTestFieldError === 'pat'" class="jira-setup__field-error">{{
        setupValidationError || "Review the access token after reading the test result."
      }}</small></label
    >
    <label
      v-if="!credentialsInline"
      class="jira-setup__field"
      title="Technical means a shared service account: comments can carry an attribution line, and My issues needs your own Jira user."
      ><span class="jira-setup__field-title">Account purpose</span
      ><CustomSelect
        v-model="draft.accountPurpose"
        :options="accountPurposeOptions"
        :disabled="connectionSaveBusy"
      /><small class="jira-setup__field-help"
        >Personal acts as you. Technical is a shared service account; then My issues needs your own Jira user.</small
      ></label
    >
  </template>
  <p v-if="setupValidationError" class="jira-error" role="alert">{{ setupValidationError }}</p>
  <div class="jira-setup__actions">
    <JiraBusyButton
      class="button button--ghost"
      :busy="connectionTestBusy"
      :disabled="isBusy('connection') || connectionSaveBusy"
      :title="
        isBusy('connection') || connectionSaveBusy
          ? 'Wait until the current save finishes.'
          : 'Check these details against Jira without saving anything.'
      "
      @click="testSetupConnection"
    >
      Test connection
    </JiraBusyButton>
    <JiraBusyButton
      class="button"
      :busy="connectionSaveBusy"
      :disabled="isBusy('connection') || connectionTestBusy"
      :title="
        isBusy('connection') || connectionTestBusy
          ? 'Wait until the current test or save finishes.'
          : draft.id
            ? 'Check the new details with Jira, then replace the saved ones. A blank secret keeps its saved value.'
            : 'Check these details with Jira, then save the connection and its credentials.'
      "
      @click="saveSetupConnection"
    >
      Save connection
    </JiraBusyButton>
    <button
      v-if="!draft.id"
      class="button button--ghost"
      type="button"
      :disabled="isBusy('connection') || connectionTestBusy || connectionSaveBusy"
      :title="
        isBusy('connection') || connectionTestBusy || connectionSaveBusy
          ? 'Wait until the current test or save finishes.'
          : 'Return to step 1 to choose a different connection type.'
      "
      @click="backToConnectionType"
    >
      Back
    </button>
    <button
      class="button button--ghost"
      type="button"
      :disabled="isBusy('connection') || connectionSaveBusy"
      :title="
        isBusy('connection') || connectionSaveBusy
          ? 'Wait until the current save finishes.'
          : draft.id
            ? 'Close without changing the saved credentials.'
            : 'Leave setup without adding a connection. Nothing is saved.'
      "
      @click="cancelConnectionSetup"
    >
      Cancel
    </button>
  </div>
  <p class="jira-setup__field-help jira-setup__save-hint">
    Test checks the connection without saving. Save verifies and stores it.
  </p>
  <div
    v-if="connectionTestBusy || connectionTestMessage"
    ref="connectionTestResultRef"
    class="jira-setup__test-result"
    :class="{ 'jira-setup__test-result--error': connectionTestState === 'error' }"
    :role="connectionTestState === 'error' ? 'alert' : 'status'"
    aria-live="polite"
    tabindex="-1"
  >
    <Spinner v-if="connectionTestBusy" aria-hidden="true" label="Testing Jira connection" />
    <span>{{ connectionTestBusy ? "Testing connection without saving…" : connectionTestMessage }}</span>
  </div>
  <p v-if="connectionStatus" role="status">{{ connectionStatus }}</p>
  <p
    class="jira-setup__field-help jira-status-slot"
    role="status"
    :data-active="connectionSaveBusy || isBusy('connection')"
  >
    Saving and checking the Jira connection…
  </p>
</template>

<script setup lang="ts">
import CustomSelect from "../../common/CustomSelect.vue";
import Spinner from "../../common/Spinner.vue";
import JiraBusyButton from "./JiraBusyButton.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  accountPurposeOptions,
  backToConnectionType,
  cancelConnectionSetup,
  chooseClientCertificate,
  connectionSaveBusy,
  connectionStatus,
  connectionTestBusy,
  connectionTestFieldError,
  connectionTestMessage,
  connectionTestResultRef,
  connectionTestState,
  credentialsInline,
  draft,
  isBusy,
  openApiTokenHelp,
  saveSetupConnection,
  setupApiTokenInput,
  setupApiUrlInput,
  setupCertificateInput,
  setupCertificatePasswordInput,
  setupEmailInput,
  setupHeaderInput,
  setupKeyInput,
  setupPatInput,
  setupValidationError,
  setupWebUrlInput,
  testSetupConnection,
} = useJiraPaneContext();
</script>
