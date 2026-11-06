<template>
  <div class="jira-reason">
    <p class="jira-reason__summary">
      <span class="jira-reason__label">Reason:</span>
      <span class="jira-reason__text">{{ reason.state.text || reason.defaultText.value }}</span>
      <button
        type="button"
        class="jira-reason__edit"
        :aria-expanded="reason.state.open ? 'true' : 'false'"
        :title="
          reason.state.open
            ? 'Hide the reason editor.'
            : `Edit the reason for this change (at least ${reason.min} characters). It is not posted to Jira.`
        "
        @click="toggle"
      >
        (edit)
      </button>
    </p>
    <div v-if="reason.state.open" class="jira-reason__editor">
      <input
        ref="inputRef"
        :value="reason.state.text"
        aria-label="Reason for this change"
        :aria-invalid="reason.error.value ? 'true' : undefined"
        autocomplete="off"
        @input="reason.input(($event.target as HTMLInputElement).value)"
        @blur="reason.settle()"
        @keydown.enter.prevent
      />
      <small class="jira-reason__counter" :data-short="reason.state.text.trim().length < reason.min">
        {{ reason.state.text.trim().length }} / {{ reason.min }}+
      </small>
    </div>
    <p v-if="reason.error.value" class="jira-field-error" role="status">{{ reason.error.value }}</p>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from "vue";

import type { JiraWriteReasonControl } from "./pane/useJiraIssueDetail.js";

const props = defineProps<{ reason: JiraWriteReasonControl }>();
const inputRef = ref<HTMLInputElement | null>(null);

async function toggle() {
  props.reason.toggle();
  if (!props.reason.state.open) return;
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
}
</script>
