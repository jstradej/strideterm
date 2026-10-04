<template>
  <div class="dialog ssh-connection-test" :class="{ 'ssh-connection-test--inline': inline }">
    <header v-if="!inline && !embedded" class="dialog__header">
      <div>
        <p class="eyebrow">SSH connection test</p>
        <h2>Test connection</h2>
      </div>
    </header>
    <header v-else-if="!inline && embedded" class="ssh-embedded-header">
      <div class="ssh-embedded-header__title">
        <p class="eyebrow">SSH connection test</p>
        <h2>Test connection</h2>
      </div>
      <div class="ssh-embedded-header__actions">
        <button
          v-if="currentStatus === 'error' || errorMessage"
          type="button"
          class="button button--ghost"
          :disabled="starting || stopping"
          title="Start another connection test with the current settings."
          @click="startTest"
        >
          Try again
        </button>
        <button
          type="button"
          class="button"
          title="Stop the test if needed and return to the SSH editor."
          :disabled="starting || stopping"
          @click="requestClose"
        >
          {{ stopping ? "Stopping…" : mode === "system-ssh" || mode === "wsl" ? "Stop and return" : "Return" }}
        </button>
      </div>
    </header>

    <main class="ssh-connection-test__body">
      <p v-if="!sessionId && !errorMessage" role="status">
        {{ inline ? "Starting a test with this saved host…" : "Starting a test with the current unsaved settings…" }}
      </p>
      <p v-else-if="mode === 'ssh2' && currentStatus === 'connecting'" role="status">
        Connecting. Complete any sign-in prompt that appears.
      </p>
      <p v-else-if="mode === 'ssh2' && currentStatus === 'authenticated'" class="success" role="status">
        Authentication succeeded. The test session has closed.
      </p>
      <template v-else-if="mode === 'system-ssh' || mode === 'wsl'">
        <p v-if="currentStatus === 'authenticated'" class="success" role="status">
          OpenSSH authentication and verification succeeded. The test process has closed.
        </p>
        <p v-else role="status">
          {{
            currentStatus === "process-running"
              ? "SSH process running; verification is pending. Complete any sign-in prompt in the terminal."
              : currentStatus === "disconnected" || currentStatus === "cancelled"
                ? "The SSH process ended before verification completed."
                : currentStatus === "error"
                  ? "SSH verification failed."
                  : "Starting the SSH process. Login status will not be reported by this method."
          }}
        </p>
        <div
          v-if="sessionId && currentStatus !== 'authenticated'"
          class="ssh-connection-test__terminal"
          aria-label="Temporary SSH test terminal"
        >
          <TerminalPane :session-id="sessionId" />
        </div>
      </template>
      <p v-if="errorMessage" class="dialog__error" role="alert">{{ errorMessage }}</p>
    </main>

    <footer v-if="!embedded || inline" class="dialog__footer">
      <button
        v-if="!inline && (currentStatus === 'error' || errorMessage)"
        type="button"
        class="button button--ghost"
        :disabled="starting || stopping"
        @click="startTest"
      >
        Try again
      </button>
      <button type="button" class="button" :disabled="starting || stopping" @click="requestClose">
        {{
          stopping
            ? "Stopping…"
            : inline
              ? "Stop test"
              : mode === "system-ssh" || mode === "wsl"
                ? "Stop and return"
                : "Return"
        }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useSshStore } from "../../stores/ssh.js";
import { useTerminalStore } from "../../stores/terminal.js";
import TerminalPane from "../workspace/TerminalPane.vue";
import type { SshTestStatePayload } from "../../transport.js";

type TestResult = {
  mode: SshTestStatePayload["mode"] | null;
  status: SshTestStatePayload["status"] | null;
  error: string;
};

const props = defineProps<{
  profileId: string;
  draft: Record<string, unknown>;
  inline?: boolean;
  embedded?: boolean;
  onResult?: (result: TestResult) => void;
}>();
const emit = defineEmits<{ cancel: [] }>();
const app = useAppStore();
const ssh = useSshStore();
const terminal = useTerminalStore();
const sessionId = ref("");
const mode = ref<SshTestStatePayload["mode"] | null>(null);
const initialStatus = ref<SshTestStatePayload["status"] | null>(null);
const errorMessage = ref("");
const starting = ref(false);
const stopping = ref(false);
const activeProfileId = computed(() => app.myActiveProfileId || "default");
const currentStatus = computed(() =>
  sessionId.value ? (ssh.sshTestStates[sessionId.value]?.status ?? initialStatus.value) : null,
);
let startPromise: Promise<void> | null = null;
let stopPromise: Promise<void> | null = null;
let closePromise: Promise<void> | null = null;
const autoFinishedSessions = new Set<string>();

function applyStatus(state: SshTestStatePayload): void {
  if (state.sessionId !== sessionId.value) return;
  mode.value = state.mode;
  initialStatus.value = state.status;
  if (state.status === "error") errorMessage.value = state.error || "SSH connection test failed.";
  if (
    props.inline &&
    !autoFinishedSessions.has(state.sessionId) &&
    ["authenticated", "error", "disconnected", "cancelled"].includes(state.status)
  ) {
    autoFinishedSessions.add(state.sessionId);
    void requestClose();
  }
}

watch(
  () => (sessionId.value ? ssh.sshTestStates[sessionId.value] : undefined),
  (state) => {
    if (state) applyStatus(state);
  },
  { immediate: true },
);

watch(activeProfileId, (next) => {
  if (next !== props.profileId) void requestClose();
});

async function startTest(): Promise<void> {
  if (starting.value || stopping.value) return;
  starting.value = true;
  const previousId = sessionId.value;
  const previousMode = mode.value;
  sessionId.value = "";
  mode.value = null;
  errorMessage.value = "";
  initialStatus.value = null;
  const pendingStart = (async () => {
    let previousStopped = false;
    try {
      if (previousId) {
        await ssh.stopTestConnection(previousId);
        if (previousMode !== "ssh2") terminal.releaseTestSession(previousId);
        ssh.clearTestConnectionState(previousId);
        previousStopped = true;
      }
      const result = await ssh.startTestConnection(props.profileId, props.draft);
      sessionId.value = result.sessionId;
      mode.value = result.mode;
      initialStatus.value = ssh.sshTestStates[result.sessionId]?.status ?? result.status;
      if (result.mode !== "ssh2") terminal.retainTestSession(result.sessionId);
      const latest = ssh.sshTestStates[result.sessionId];
      applyStatus(latest || { ...result, sessionId: result.sessionId });
    } catch (error) {
      if (!previousStopped) {
        sessionId.value = previousId;
        mode.value = previousMode;
      }
      errorMessage.value = (error as Error).message || "Could not start SSH connection test.";
    } finally {
      starting.value = false;
    }
  })();
  startPromise = pendingStart;
  await pendingStart;
  if (props.inline && errorMessage.value && !sessionId.value) await requestClose();
}

async function stopCurrentTest(): Promise<void> {
  if (!sessionId.value) return;
  if (stopPromise) return stopPromise;
  const id = sessionId.value;
  stopPromise = ssh
    .stopTestConnection(id)
    .then(() => {
      if (mode.value !== "ssh2") terminal.releaseTestSession(id);
      ssh.clearTestConnectionState(id);
      sessionId.value = "";
      mode.value = null;
      initialStatus.value = null;
    })
    .finally(() => {
      stopPromise = null;
    });
  return stopPromise;
}

async function requestClose(): Promise<void> {
  if (closePromise) return closePromise;
  const pendingClose = closeTest();
  closePromise = pendingClose;
  try {
    await pendingClose;
  } finally {
    if (closePromise === pendingClose) closePromise = null;
  }
}

async function closeTest(): Promise<void> {
  if (stopping.value) return;
  stopping.value = true;
  const previousError = errorMessage.value;
  errorMessage.value = "";
  try {
    if (startPromise) await startPromise;
    const result: TestResult = {
      mode: mode.value,
      status: currentStatus.value,
      error: errorMessage.value || (currentStatus.value === "error" || !sessionId.value ? previousError : ""),
    };
    await stopCurrentTest();
    if (sessionId.value) throw new Error("The test session could not be stopped.");
    props.onResult?.(result);
    emit("cancel");
  } catch (error) {
    errorMessage.value = (error as Error).message || "Could not stop SSH connection test.";
  } finally {
    stopping.value = false;
  }
}

defineExpose({ requestClose });

onBeforeUnmount(() => {
  void (async () => {
    try {
      if (startPromise) await startPromise;
      await stopCurrentTest();
    } finally {
      if (sessionId.value) {
        if (mode.value !== "ssh2") terminal.releaseTestSession(sessionId.value);
        ssh.clearTestConnectionState(sessionId.value);
      }
    }
  })().catch(() => {});
});

void startTest();
</script>

<style scoped>
.ssh-connection-test {
  width: min(760px, 94vw);
  height: min(720px, 88vh);
  display: flex;
  flex-direction: column;
}
.ssh-connection-test--inline {
  width: 100%;
  height: auto;
  min-height: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.16);
}
.ssh-embedded-header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 8px 0;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.ssh-embedded-header__title {
  flex: 1 1 auto;
}
.ssh-embedded-header__title h2 {
  margin: 0;
}
.ssh-embedded-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-left: auto;
}
.ssh-connection-test--inline .ssh-connection-test__body {
  flex: initial;
}
.ssh-connection-test--inline .ssh-connection-test__terminal {
  min-height: 220px;
  height: 260px;
}
.ssh-connection-test--inline .ssh-connection-test__terminal :deep(.workspace-pane__body--terminal) {
  height: 100%;
}
.ssh-connection-test__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ssh-connection-test__terminal {
  flex: 1;
  min-height: 220px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #08090c;
}
.ssh-connection-test__terminal :deep(.workspace-pane__body--terminal) {
  position: relative;
  height: 100%;
  min-height: 220px;
}
.ssh-connection-test > .dialog__footer {
  justify-content: flex-end;
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-top: 12px;
}
.success {
  color: var(--success, #55bd7b);
}
</style>
