<template>
  <section
    v-if="writeCardKind && selected.ref"
    ref="writeCardRef"
    class="jira-write-card"
    role="group"
    :aria-label="`Confirm: ${question}`"
    @keydown.esc.stop.prevent="closeWriteCard({ restoreFocus: true })"
  >
    <p class="jira-write-card__question">{{ question }}</p>
    <template v-if="writeCardKind === 'transition'">
      <p
        v-for="field in activeRequiredFields.filter((field) => field.required && !field.supported)"
        :key="field.id"
        class="jira-help"
      >
        Jira requires “{{ field.name }}”, but this field type is not supported by the current form.
      </p>
      <div v-if="activeRequiredFields.some((field) => field.supported)" class="jira-write-card__fields">
        <label
          v-for="field in activeRequiredFields.filter((field) => field.supported)"
          :key="field.id"
          :title="
            field.required
              ? `Jira requires ${field.name} for this status change.`
              : `${field.name} is optional for this status change.`
          "
          >{{ field.name
          }}<template v-if="field.allowedValues?.length"
            ><CustomSelect
              :model-value="transitionFields.get(field.id) || ''"
              :options="
                field.allowedValues.map((choice) => ({
                  value: choice.value,
                  label: choice.label || choice.value,
                }))
              "
              :placeholder="`Choose ${field.name}`"
              @update:model-value="(value) => transitionFields.set(field.id, String(value))" /></template
          ><template v-else
            ><input
              :value="transitionFields.get(field.id) || ''"
              :required="field.required"
              :type="
                field.type === 'number'
                  ? 'number'
                  : field.type === 'date'
                    ? 'date'
                    : field.type === 'datetime'
                      ? 'datetime-local'
                      : 'text'
              "
              @input="transitionFields.set(field.id, ($event.target as HTMLInputElement).value)" /></template
        ></label>
      </div>
    </template>
    <JiraWriteReason :reason="writeReason" />
    <p v-if="writeFieldError" class="jira-field-error" role="status">{{ writeFieldError }}</p>
    <p class="jira-help jira-write-card__actor">Sent to Jira as {{ actorLabel }}.</p>
    <p v-if="writeSurface === 'header' && writeError" class="jira-inline-error" role="alert">{{ writeError }}</p>
    <div class="jira-write-card__actions">
      <JiraBusyButton
        class="button jira-write-card__confirm"
        :busy="isBusy('write-preview', 'write-send')"
        :disabled="!canPreviewWrite"
        :title="confirmTitle"
        @click="confirmWriteCard"
      >
        Confirm
      </JiraBusyButton>
      <button
        class="button button--ghost"
        type="button"
        :disabled="isBusy('write-send')"
        :title="
          isBusy('write-send')
            ? 'The change is being sent and can no longer be cancelled.'
            : 'Close without changing the issue (Esc).'
        "
        @click="closeWriteCard({ restoreFocus: true })"
      >
        Cancel
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraWriteReason from "./JiraWriteReason.vue";

import type { JiraIssue } from "./pane/jira-pane-types.js";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  activeRequiredFields,
  assignTarget,
  canPreviewWrite,
  closeWriteCard,
  confirmWriteCard,
  isBusy,
  selected: selectedIssue,
  selectedConnection,
  transitionFields,
  transitionId,
  transitions,
  writeCardKind,
  writeCardRef,
  writeError,
  writeFieldError,
  writeReason,
  writeSurface,
} = useJiraPaneContext();
const selected = computed(() => selectedIssue.value as JiraIssue);
const issueKey = computed(() => selected.value.ref?.issueKey || selected.value.key || "this issue");
const question = computed(() => {
  if (writeCardKind.value === "assign") {
    const target = assignTarget.value;
    if (!target || target.request.kind === "unassigned") return `Unassign ${issueKey.value}?`;
    if (target.request.kind === "me") {
      const own = selectedConnection.value?.ownIdentity?.displayName;
      return `Assign ${issueKey.value} to me${own ? ` (${own})` : ""}?`;
    }
    return `Assign ${issueKey.value} to ${target.label}?`;
  }
  const to = transitions.value.find((item) => item.id === transitionId.value)?.to;
  return `${issueKey.value} → ${to || "new status"}?`;
});
const actorLabel = computed(() => {
  const connection = selectedConnection.value;
  const name = connection?.verifiedIdentity?.displayName || "the connected Jira account";
  return connection?.accountPurpose === "technical" ? `${name} (technical account)` : name;
});
const confirmTitle = computed(() => {
  if (canPreviewWrite.value) return `Send this change to Jira now as ${actorLabel.value}. There is no further preview.`;
  if (writeFieldError.value) return writeFieldError.value;
  if (writeReason.error.value) return writeReason.error.value;
  if (writeReason.state.text.trim().length < writeReason.min)
    return `Give a reason of at least ${writeReason.min} characters first.`;
  if (writeCardKind.value !== "transition") return "Choose who to assign the issue to first.";
  return activeRequiredFields.value.some((field) => field.required && !field.supported)
    ? "Jira requires a field this form cannot fill. Change the status in Jira instead."
    : "Fill in the fields Jira requires for this status change first.";
});
</script>
