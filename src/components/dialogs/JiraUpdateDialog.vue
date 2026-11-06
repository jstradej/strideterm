<template>
  <div class="dialog jira-update-dialog" role="dialog" :aria-label="`Update ${issue.ref.issueKey} in Jira`">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Jira · {{ issue.ref.issueKey }}</p>
        <h2>Update the Jira issue</h2>
      </div>
    </div>
    <p class="jira-update-dialog__lead">
      Pull request {{ pullRequest.number ? `#${pullRequest.number} ` : "" }}is created. Tell {{ issue.ref.issueKey
      }}<template v-if="issue.summary"> · {{ issue.summary }}</template> about it?
    </p>
    <form class="form" @submit.prevent="onPrimary">
      <fieldset class="jira-update-dialog__actions" :disabled="phase !== 'edit'">
        <label class="jira-update-dialog__check"> <input v-model="withComment" type="checkbox" /> Add a comment </label>
        <textarea
          v-if="withComment"
          v-model="comment"
          rows="5"
          aria-label="Comment for the Jira issue"
          class="jira-update-dialog__comment"
        />
        <label class="jira-update-dialog__check">
          <input v-model="withLink" type="checkbox" /> Link the pull request to the issue
        </label>
        <label>
          <span>Change status</span>
          <CustomSelect
            v-model="transitionId"
            :options="transitionOptions"
            :loading="transitionsLoading"
            :placeholder="transitionsLoading ? 'Loading transitions…' : 'Keep the current status'"
          />
          <small v-if="transitionsError" class="form__hint form__hint--error">{{ transitionsError }}</small>
          <small v-else-if="hiddenTransitions" class="form__hint">
            {{ hiddenTransitions }} transition{{ hiddenTransitions === 1 ? " needs" : "s need" }} extra fields; use Jira
            for {{ hiddenTransitions === 1 ? "it" : "them" }}.
          </small>
        </label>
      </fieldset>

      <section
        v-if="phase === 'confirm' || phase === 'sending'"
        class="jira-update-dialog__previews"
        aria-label="Preview"
      >
        <p>Sent to Jira by {{ account || "the connected Jira account" }}. Nothing is written until you confirm.</p>
        <div v-for="step in steps" :key="step.action" class="jira-update-dialog__preview">
          <strong>{{ step.label }}</strong>
          <pre>{{ step.confirmation.preview }}</pre>
        </div>
      </section>

      <ul v-if="results.length" class="jira-update-dialog__results" role="status">
        <li v-for="result in results" :key="result.label" :class="{ 'is-failed': !result.ok }">
          {{ result.ok ? "✓" : "⚠" }} {{ result.label
          }}<template v-if="result.message">: {{ result.message }}</template>
        </li>
      </ul>
      <div v-if="errorMessage" class="dialog__error" role="alert">
        <span class="dialog__error-icon" aria-hidden="true">⚠</span>
        <span class="dialog__error-text">{{ errorMessage }}</span>
      </div>

      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" :disabled="phase === 'sending' || busy" @click="close">
          {{ phase === "done" ? "Close" : "Not now" }}
        </button>
        <button
          v-if="phase === 'confirm'"
          type="button"
          class="button button--ghost"
          :disabled="busy"
          @click="phase = 'edit'"
        >
          Back
        </button>
        <button
          v-if="phase !== 'done'"
          type="submit"
          class="button"
          :disabled="!canSubmit || busy || phase === 'sending'"
        >
          {{ phase === "confirm" || phase === "sending" ? "Confirm and send" : "Preview" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import CustomSelect from "../common/CustomSelect.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { userFacingMessage } from "../../lib/error-message.js";
import type {
  JiraWriteConfirmationDto,
  JiraWriteExecutePayload,
  JiraWritePreviewPayload,
} from "../../../electron/backend/ipc-schemas.js";

type IssueRef = { connectionId: string; issueId: string; issueKey: string };
type Transition = { id: string; name: string; to: string; requiredFields?: unknown[] };
type Step = {
  action: "comment" | "remote-link" | "transition";
  label: string;
  preview: JiraWritePreviewPayload;
  confirmation: JiraWriteConfirmationDto & { account?: { displayName: string } };
};

const props = defineProps<{
  issue: { ref: IssueRef; summary?: string; status?: string };
  pullRequest: { url: string; title: string; number?: number | string };
  onClose: () => void;
}>();

const appStore = useAppStore();
const notifications = useNotificationStore();
const api = appStore.getApi();

const issueRef = computed(() => ({
  connectionId: props.issue.ref.connectionId,
  issueId: props.issue.ref.issueId,
  issueKey: props.issue.ref.issueKey,
}));
const withComment = ref(true);
const comment = ref(
  [
    `Pull request${props.pullRequest.number ? ` #${props.pullRequest.number}` : ""} is ready for review: ${props.pullRequest.url}`,
    props.pullRequest.title,
  ]
    .filter(Boolean)
    .join("\n\n"),
);
const withLink = ref(true);
const transitions = ref<Transition[]>([]);
const transitionsLoading = ref(false);
const transitionsError = ref("");
const transitionId = ref<string>("");
const phase = ref<"edit" | "confirm" | "sending" | "done">("edit");
const busy = ref(false);
const steps = ref<Step[]>([]);
const results = ref<Array<{ label: string; ok: boolean; message?: string }>>([]);
const errorMessage = ref("");

const usableTransitions = computed(() => transitions.value.filter((item) => !item.requiredFields?.length));
const hiddenTransitions = computed(() => transitions.value.length - usableTransitions.value.length);
const transitionOptions = computed(() => [
  { value: "", label: `Keep ${props.issue.status ? `“${props.issue.status}”` : "the current status"}` },
  ...usableTransitions.value.map((item) => ({
    value: item.id,
    label: item.to && item.to !== item.name ? `${item.name} → ${item.to}` : item.name,
  })),
]);
const chosenTransition = computed(() => usableTransitions.value.find((item) => item.id === transitionId.value));
const canSubmit = computed(
  () => (withComment.value && comment.value.trim().length > 0) || withLink.value || Boolean(chosenTransition.value),
);
const account = computed(
  () => steps.value.find((step) => step.confirmation.account)?.confirmation.account?.displayName,
);

onMounted(async () => {
  if (!api?.listJiraTransitions) return;
  transitionsLoading.value = true;
  try {
    transitions.value = ((await api.listJiraTransitions({ ref: issueRef.value })) as Transition[]) || [];
    // A pull request usually moves the issue to review; offer that, never pick it silently.
    const review = usableTransitions.value.find((item) => /review/i.test(`${item.to} ${item.name}`));
    if (review) transitionId.value = review.id;
  } catch (cause) {
    transitionsError.value = `Could not load the issue's transitions: ${userFacingMessage(cause, "unknown error")}`;
  } finally {
    transitionsLoading.value = false;
  }
});

function plannedSteps(): Array<Omit<Step, "confirmation">> {
  const planned: Array<Omit<Step, "confirmation">> = [];
  if (withComment.value && comment.value.trim())
    planned.push({
      action: "comment",
      label: "Comment",
      preview: {
        action: "comment",
        ref: issueRef.value,
        body: comment.value.trim(),
        intent: "Report the created pull request on the Jira issue",
      },
    });
  if (withLink.value)
    planned.push({
      action: "remote-link",
      label: "Pull request link",
      preview: {
        action: "remote-link",
        ref: issueRef.value,
        url: props.pullRequest.url,
        title: props.pullRequest.title || props.pullRequest.url,
        globalId: props.pullRequest.url,
        intent: "Link the created pull request to this Jira issue",
      },
    });
  if (chosenTransition.value)
    planned.push({
      action: "transition",
      label: `Status → ${chosenTransition.value.to || chosenTransition.value.name}`,
      preview: {
        action: "transition",
        ref: issueRef.value,
        transitionId: chosenTransition.value.id,
        intent: "Move the Jira issue on now that its pull request exists",
      },
    });
  return planned;
}

async function preview() {
  if (!api?.previewJiraWrite) throw new Error("Jira write actions are available in the desktop app.");
  const prepared: Step[] = [];
  for (const step of plannedSteps()) {
    const confirmation = (await api.previewJiraWrite(step.preview)) as Step["confirmation"];
    prepared.push({ ...step, confirmation });
  }
  steps.value = prepared;
  phase.value = "confirm";
}

function executePayload(step: Step): JiraWriteExecutePayload {
  const confirmation = {
    token: step.confirmation.token,
    intent: step.confirmation.intent,
    preview: step.confirmation.preview,
  };
  const { intent: _intent, ...rest } = step.preview;
  return { ...rest, confirmation } as JiraWriteExecutePayload;
}

async function send() {
  if (!api?.executeJiraWrite) throw new Error("Jira write actions are available in the desktop app.");
  phase.value = "sending";
  results.value = [];
  for (const step of steps.value) {
    try {
      const result = await api.executeJiraWrite(executePayload(step));
      if (result.ok) results.value.push({ label: step.label, ok: true });
      else
        results.value.push({
          label: step.label,
          ok: false,
          message:
            result.error.status === "unknown"
              ? `it may have been applied; check ${props.issue.ref.issueKey} in Jira before retrying. ${userFacingMessage(result.error.message, "")}`
              : userFacingMessage(result.error.message, "Jira did not accept it."),
        });
    } catch (cause) {
      results.value.push({ label: step.label, ok: false, message: userFacingMessage(cause, "unknown error") });
    }
  }
  phase.value = "done";
  const failed = results.value.filter((result) => !result.ok);
  if (failed.length)
    notifications.showError(
      `Jira update incomplete · ${props.issue.ref.issueKey}`,
      failed.map((result) => `${result.label}: ${result.message || "failed"}`).join("\n"),
    );
  else
    notifications.pushEphemeralToast({
      title: `${props.issue.ref.issueKey} updated`,
      body: results.value.map((result) => result.label).join(", "),
      kind: "info",
    });
}

async function onPrimary() {
  if (busy.value || !canSubmit.value) return;
  busy.value = true;
  errorMessage.value = "";
  try {
    if (phase.value === "edit") await preview();
    else if (phase.value === "confirm") await send();
  } catch (cause) {
    const message = userFacingMessage(cause, "unknown error");
    errorMessage.value = `Could not prepare the Jira update: ${message}`;
    notifications.showError(`Could not update ${props.issue.ref.issueKey}`, message);
    phase.value = "edit";
  } finally {
    busy.value = false;
  }
}

function close() {
  props.onClose();
}
</script>

<style scoped>
.jira-update-dialog {
  width: min(620px, 100%);
}
.jira-update-dialog__lead {
  margin: 0 0 12px;
  color: var(--muted);
}
.jira-update-dialog__actions {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  border: 0;
}
.jira-update-dialog__check {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.jira-update-dialog__comment {
  width: 100%;
  resize: vertical;
}
.jira-update-dialog__previews {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}
.jira-update-dialog__previews p {
  margin: 0;
  color: var(--muted);
}
.jira-update-dialog__preview pre {
  margin: 4px 0 0;
  padding: 8px;
  max-height: 160px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: pre-wrap;
  font-size: var(--font-size-caption);
}
.jira-update-dialog__results {
  margin: 12px 0 0;
  padding-left: 18px;
}
.jira-update-dialog__results .is-failed {
  color: var(--danger, #e53935);
}
</style>
