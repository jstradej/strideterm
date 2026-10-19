<template>
  <section
    class="dialog review-agent-preparation-dialog"
    tabindex="-1"
    @keydown.capture.alt.n.prevent.stop="advanceOrFinish"
  >
    <header class="dialog__header">
      <div>
        <p class="eyebrow">Review agent preparation</p>
        <h2>{{ currentRepositoryName }}</h2>
        <p class="field-hint">Repository {{ index + 1 }} of {{ queue.length }} · {{ agentName || "Agent" }}</p>
      </div>
      <div class="review-agent-preparation-dialog__actions">
        <button
          v-if="failed"
          type="button"
          class="button button--ghost"
          :disabled="busy"
          title="Stop the current setup attempt and relaunch the configured agent command in this repository."
          @click="retryCurrent"
        >
          Retry
        </button>
        <button
          type="button"
          class="button button--ghost"
          :disabled="transitioning || stopping"
          :title="
            index === queue.length - 1
              ? 'Stop the current session and close setup. Shortcut: Alt+N. No additional workspace is created.'
              : 'Stop this session and start the agent in the next selected repository. Shortcut: Alt+N.'
          "
          @click="advanceOrFinish"
        >
          {{ index === queue.length - 1 ? "Finish" : "Next" }}
        </button>
        <button
          type="button"
          class="button"
          :disabled="closed || stopping"
          title="Stop the temporary setup terminal and close. No additional workspace is created."
          @click="close"
        >
          Close
        </button>
      </div>
    </header>
    <p v-if="errorMessage" class="dialog__error" role="alert">{{ errorMessage }}</p>
    <p v-else-if="!sessionId" class="field-hint" role="status">
      {{ starting ? "Preparing repository…" : "Starting agent…" }} You can confirm any workspace trust prompt in the
      terminal.
    </p>
    <main class="review-agent-preparation-dialog__terminal" aria-label="Temporary review agent terminal">
      <TerminalPane v-if="sessionId" :key="sessionId" :session-id="sessionId" />
    </main>
    <footer class="dialog__footer">
      <span>Use the terminal normally to confirm trust. Alt+N stops this session and continues.</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { OperationFinished } from "../../../electron/shared/operation-events.js";
import type { StartReviewAgentPreparation } from "../../../electron/backend/ipc-schemas.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { useAppStore } from "../../stores/app.js";
import TerminalPane from "../workspace/TerminalPane.vue";

type Selection = StartReviewAgentPreparation extends infer Request
  ? Request extends object
    ? Omit<Request, "parentWorkspaceId" | "idempotencyKey">
    : never
  : never;
type QueueEntry = { selection: Selection; repositoryName: string };
const props = defineProps<{
  parentWorkspaceId: string;
  profileId: string;
  selections: QueueEntry[];
  onStart: (
    selection: Selection,
    parentWorkspaceId: string,
    idempotencyKey: string,
  ) => Promise<{ operationId: string }>;
  onStop: (operationId: string) => Promise<unknown>;
  subscribe: (listener: (operation: OperationFinished) => void) => () => void;
  getResult: (operationId: string) => OperationFinished | undefined;
  onCancel: () => void;
}>();

const terminal = useTerminalStore();
const notifications = useNotificationStore();
const app = useAppStore();
const queue = props.selections;
const index = ref(0);
const sessionId = ref("");
const operationId = ref("");
const agentName = ref("");
const errorMessage = ref("");
const starting = ref(false);
const stopping = ref(false);
const transitioning = ref(false);
const closed = ref(false);
const currentRepositoryName = computed(() => queue[index.value]?.repositoryName || "Preparation complete");
const failed = computed(() => Boolean(errorMessage.value));
const busy = computed(() => starting.value || stopping.value || transitioning.value);
let unsubscribe: (() => void) | undefined;
let startPromise: Promise<void> | undefined;
let stopPromise: Promise<void> | undefined;
let lastHandledOperationId = "";

function focusTemporaryTerminal(): void {
  let attempts = 0;
  const tryFocus = () => {
    if (closed.value || stopping.value || !sessionId.value) return;
    const view = terminal.views.get(sessionId.value);
    if (view) view.term.focus();
    else if (attempts++ < 20) requestAnimationFrame(tryFocus);
  };
  void nextTick(() => requestAnimationFrame(tryFocus));
}

watch(
  () => app.myActiveProfileId,
  (profileId) => {
    if (profileId && profileId !== props.profileId) void close();
  },
);

function acceptOperation(operation: OperationFinished): void {
  if (
    closed.value ||
    stopping.value ||
    !operationId.value ||
    operation.operationId !== operationId.value ||
    operation.profileId !== props.profileId ||
    lastHandledOperationId === operation.operationId
  )
    return;
  lastHandledOperationId = operation.operationId;
  starting.value = false;
  if ("error" in operation) {
    errorMessage.value = operation.error.message || "Agent setup failed.";
    notifications.showError("Agent setup failed", errorMessage.value, { profileId: props.profileId });
    return;
  }
  const result = operation.result;
  if (typeof result.sessionId !== "string" || !result.sessionId) {
    errorMessage.value = "The setup operation did not return a terminal session.";
    notifications.showError("Agent setup failed", errorMessage.value, { profileId: props.profileId });
    return;
  }
  sessionId.value = result.sessionId;
  agentName.value = typeof result.agentName === "string" ? result.agentName : "Agent";
  terminal.retainTestSession(sessionId.value);
  focusTemporaryTerminal();
}

async function startCurrent(): Promise<void> {
  if (starting.value || stopping.value || closed.value || !queue[index.value]) return;
  starting.value = true;
  errorMessage.value = "";
  sessionId.value = "";
  operationId.value = "";
  const pending = (async () => {
    try {
      const accepted = await props.onStart(queue[index.value].selection, props.parentWorkspaceId, crypto.randomUUID());
      operationId.value = accepted.operationId;
      const completed = props.getResult(accepted.operationId);
      if (completed) acceptOperation(completed);
    } catch (error) {
      starting.value = false;
      errorMessage.value = error instanceof Error ? error.message : String(error);
      notifications.showError("Couldn't prepare agent", error, { profileId: props.profileId });
    }
  })();
  startPromise = pending;
  await pending;
}

async function stopCurrent(): Promise<void> {
  if (stopPromise) return stopPromise;
  const id = operationId.value;
  if (!id) return;
  stopping.value = true;
  let stopped = false;
  const pending = (async () => {
    try {
      await props.onStop(id);
      stopped = true;
    } finally {
      if (stopped) {
        if (sessionId.value) terminal.releaseTestSession(sessionId.value);
        sessionId.value = "";
        operationId.value = "";
      }
      stopping.value = false;
    }
  })();
  stopPromise = pending;
  try {
    await pending;
  } finally {
    if (stopPromise === pending) stopPromise = undefined;
  }
}

async function nextRepository(): Promise<void> {
  if (closed.value || transitioning.value || stopping.value || index.value >= queue.length - 1) return;
  transitioning.value = true;
  try {
    if (startPromise) await startPromise;
    if (closed.value) return;
    await stopCurrent();
    if (closed.value) return;
    index.value += 1;
    await nextTick();
    transitioning.value = false;
    await startCurrent();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    notifications.showError("Couldn't continue agent setup", error, { profileId: props.profileId });
  } finally {
    transitioning.value = false;
  }
}

async function advanceOrFinish(): Promise<void> {
  if (index.value === queue.length - 1) await close();
  else await nextRepository();
}

async function retryCurrent(): Promise<void> {
  if (closed.value || busy.value) return;
  transitioning.value = true;
  try {
    if (startPromise) await startPromise;
    if (closed.value) return;
    await stopCurrent();
    if (closed.value) return;
    transitioning.value = false;
    await startCurrent();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    notifications.showError("Couldn't retry agent setup", error, { profileId: props.profileId });
  } finally {
    transitioning.value = false;
  }
}

async function close(): Promise<void> {
  if (closed.value || stopping.value) return;
  closed.value = true;
  try {
    if (startPromise) await startPromise;
    await stopCurrent();
    props.onCancel();
  } catch (error) {
    closed.value = false;
    errorMessage.value = error instanceof Error ? error.message : String(error);
    notifications.showError("Couldn't stop agent setup", error, { profileId: props.profileId });
  }
}

defineExpose({ requestClose: close });

onMounted(() => {
  unsubscribe = props.subscribe(acceptOperation);
  void startCurrent();
});

onBeforeUnmount(() => {
  closed.value = true;
  unsubscribe?.();
  void (async () => {
    if (startPromise) await startPromise;
    await stopCurrent();
  })().catch(() => {});
});
</script>

<style scoped>
.review-agent-preparation-dialog {
  width: min(960px, 94vw);
  height: min(620px, 88vh);
  display: flex;
  flex-direction: column;
}
.review-agent-preparation-dialog > .dialog__header {
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 14px;
}
.review-agent-preparation-dialog > .dialog__header > div:first-child {
  min-width: 0;
  line-height: 1.4;
}
.review-agent-preparation-dialog > .dialog__header h2 {
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.review-agent-preparation-dialog > .dialog__header .field-hint {
  margin: 6px 0 0;
  line-height: 1.4;
}
.review-agent-preparation-dialog__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  gap: 8px;
}
.review-agent-preparation-dialog__terminal {
  flex: 1;
  min-height: 260px;
  overflow: hidden;
  box-sizing: border-box;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #08090c;
}
.review-agent-preparation-dialog__terminal :deep(.workspace-pane__body--terminal) {
  height: 100%;
  min-height: 260px;
}
.review-agent-preparation-dialog .dialog__footer {
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding-top: 10px;
  line-height: 1.45;
}
</style>
