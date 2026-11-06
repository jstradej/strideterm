<template>
  <details
    v-if="selected.ref && canWriteJira"
    ref="writeDetailsRef"
    class="jira-action-details jira-write-details"
    @toggle="onFormToggle"
  >
    <summary
      :title="`Add a web link to ${issueKey} or log time on it. You review each change before it is sent to Jira.`"
    >
      Link or work log
    </summary>
    <section class="jira-write">
      <h3>{{ writeAction === "worklog" ? "Log work" : "Add a link" }}</h3>
      <label
        title="Add link attaches a web link to the issue. Log work records time spent and needs a personal Jira account."
        >Action<CustomSelect v-model="writeAction" :options="writeActionOptions" @change="resetWrite"
      /></label>
      <template v-if="writeAction === 'remote-link'"
        ><label>URL<input v-model="remoteUrl" type="url" required /></label
        ><label>Title<input v-model="remoteTitle" required /></label
      ></template>
      <template v-if="writeAction === 'worklog'"
        ><label
          >Time spent<input
            v-model="worklogDuration"
            autocomplete="off"
            placeholder="1h 30m"
            required
            :aria-invalid="worklogDurationInvalid ? 'true' : undefined" /></label
        ><label>Started<input v-model="worklogStarted" type="datetime-local" required /></label
        ><label>Worklog comment<textarea v-model="worklogComment" rows="2" /></label
      ></template>
      <JiraWriteReason :reason="writeReason" />
      <p v-if="writeFieldError" class="jira-field-error" role="status">{{ writeFieldError }}</p>
      <JiraBusyButton
        class="button"
        :busy="isBusy('write-preview')"
        :disabled="isBusy('write-send') || !canPreviewWrite"
        :title="reviewButtonTitle"
        @click="previewFormWrite"
      >
        Review {{ writeAction === "worklog" ? "work log" : "link" }}
      </JiraBusyButton>
      <p v-if="writeSurface === 'form' && writeError" class="jira-inline-error" role="alert">{{ writeError }}</p>
      <div
        v-if="writeConfirmation && writeSurface === 'form'"
        class="jira-confirm"
        role="dialog"
        aria-label="Confirm Jira action"
      >
        <p>
          Sent to Jira as
          {{
            writeConfirmation.account?.displayName ||
            selectedConnection?.verifiedIdentity?.displayName ||
            "the connected Jira account"
          }}
          · {{ writeConfirmation.account?.purpose || selectedConnection?.accountPurpose || "unknown purpose" }}.
        </p>
        <pre>{{ writeConfirmation.preview }}</pre>
        <JiraBusyButton
          class="button"
          :busy="isBusy('write-send')"
          :title="`Send this ${writeAction === 'worklog' ? 'work log' : 'link'} to ${issueKey} exactly as previewed above.`"
          @click="sendWrite"
        >
          Confirm and send
        </JiraBusyButton>
        <button
          class="button button--ghost"
          type="button"
          :disabled="isBusy('write-send')"
          :title="
            isBusy('write-send')
              ? 'It is being sent and can no longer be cancelled.'
              : 'Discard this preview. Your entries stay in the form.'
          "
          @click="writeConfirmation = null"
        >
          Cancel
        </button>
      </div>
      <p v-if="writeSurface === 'form' && writeMessage" role="status">{{ writeMessage }}</p>
    </section>
  </details>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraWriteReason from "./JiraWriteReason.vue";

import type { JiraIssue } from "./pane/jira-pane-types.js";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  canPreviewWrite,
  canWriteJira,
  isBusy,
  previewFormWrite,
  remoteTitle,
  remoteUrl,
  resetWrite,
  selected: selectedIssue,
  selectedConnection,
  sendWrite,
  openFormAction,
  worklogComment,
  worklogDuration,
  worklogSeconds,
  worklogStarted,
  writeAction,
  writeActionOptions,
  writeConfirmation,
  writeDetailsRef,
  writeError,
  writeFieldError,
  writeMessage,
  writeReason,
  writeSurface,
} = useJiraPaneContext();
const selected = computed(() => selectedIssue.value as JiraIssue);
const worklogDurationInvalid = computed(() => writeAction.value === "worklog" && worklogSeconds.value === 0);
const issueKey = computed(() => selected.value.ref?.issueKey || selected.value.key || "this issue");
const reviewButtonTitle = computed(() => {
  const worklog = writeAction.value === "worklog";
  if (isBusy("write-send")) return "Wait until the current change has been sent.";
  if (canPreviewWrite.value)
    return `Preview the ${worklog ? "work log" : "link"} for ${issueKey.value}. Nothing is sent until you confirm.`;
  if (writeFieldError.value) return writeFieldError.value;
  if (writeReason.error.value) return writeReason.error.value;
  if (writeReason.state.text.trim().length < writeReason.min)
    return `Give a reason of at least ${writeReason.min} characters first.`;
  return worklog ? "Enter the time spent and when you started first." : "Enter the URL and a title first.";
});

function onFormToggle(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open && !["remote-link", "worklog"].includes(writeAction.value))
    void openFormAction("remote-link");
}
</script>
