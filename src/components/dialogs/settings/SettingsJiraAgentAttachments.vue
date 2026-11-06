<template>
  <section class="agent-attachments" data-testid="jira-agent-attachments">
    <h3 class="agent-attachments__title">Agent attachment folder</h3>
    <div class="agent-attachments__row">
      <label class="agent-attachments__field">
        <span>Max files</span>
        <input
          v-model.number="draft.maxFiles"
          type="number"
          data-testid="jira-agent-attachments-files"
          :min="1"
          :max="JIRA_AGENT_ATTACHMENT_MAX_FILES_LIMIT"
          :disabled="isRemote || busy"
          @change="save"
        />
      </label>
      <label class="agent-attachments__field">
        <span>Max size (MB)</span>
        <input
          v-model.number="draft.maxMegabytes"
          type="number"
          data-testid="jira-agent-attachments-megabytes"
          :min="1"
          :max="JIRA_AGENT_ATTACHMENT_MAX_MEGABYTES_LIMIT"
          :disabled="isRemote || busy"
          @change="save"
        />
      </label>
    </div>
    <small class="agent-attachments__hint">
      Attachments an agent downloads are kept per workspace. When a new one would exceed either limit, the oldest files
      are deleted to make room. The folder is removed with its workspace.
    </small>
    <small v-if="isRemote" class="agent-attachments__hint agent-attachments__hint--warn">
      Desktop only — change this on the machine that runs strIDEterm.
    </small>
    <small
      v-else
      class="agent-attachments__status"
      :class="{ 'agent-attachments__status--failed': status === 'failed' }"
      role="status"
    >
      {{ status === "saved" ? "Saved" : status === "failed" ? "Not saved" : "" }}
    </small>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, reactive, ref, watch } from "vue";
import { apiKey } from "../../../types/keys.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import type { Transport } from "../../../transport.js";
import {
  DEFAULT_JIRA_AGENT_ATTACHMENT_LIMITS,
  JIRA_AGENT_ATTACHMENT_MAX_FILES_LIMIT,
  JIRA_AGENT_ATTACHMENT_MAX_MEGABYTES_LIMIT,
  normalizeJiraAgentAttachmentLimits,
  type JiraAgentAttachmentLimits,
} from "../../../../electron/shared/jira-agent-attachments.js";

const props = defineProps<{ value?: Partial<JiraAgentAttachmentLimits> }>();
const api = inject<Transport>(apiKey);

const isRemote = computed(() => Boolean(api?.isRemote));
const draft = reactive<JiraAgentAttachmentLimits>({ ...DEFAULT_JIRA_AGENT_ATTACHMENT_LIMITS });
const busy = ref(false);
const status = ref<"" | "saved" | "failed">("");

function syncFromProps() {
  Object.assign(draft, normalizeJiraAgentAttachmentLimits(props.value));
}
syncFromProps();
watch(() => props.value, syncFromProps, { deep: true });

async function save() {
  if (isRemote.value || !api?.setJiraAgentAttachmentLimits || busy.value) return;
  const next = normalizeJiraAgentAttachmentLimits(draft);
  Object.assign(draft, next);
  busy.value = true;
  status.value = "";
  try {
    await api.setJiraAgentAttachmentLimits(next);
    status.value = "saved";
  } catch (error) {
    status.value = "failed";
    syncFromProps();
    useNotificationStore().showError("Failed to save the agent attachment limits", error);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.agent-attachments {
  display: grid;
  gap: 8px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.agent-attachments__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.agent-attachments__row {
  display: flex;
  gap: 12px;
}
.agent-attachments__field {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.agent-attachments__field input {
  width: 110px;
  font: inherit;
  font-size: 13px;
}
.agent-attachments__hint,
.agent-attachments__status {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
.agent-attachments__hint--warn {
  color: var(--warning, var(--muted));
}
.agent-attachments__status {
  min-height: 1.4em;
}
.agent-attachments__status--failed {
  color: var(--danger, var(--text));
}
</style>
