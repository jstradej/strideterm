<template>
  <section class="sandbox-section" data-testid="sandbox-section">
    <label
      class="sandbox-option"
      :title="
        task
          ? 'Runs the Worker and Judge of this task in an isolated environment.'
          : 'Runs this workspace\'s agent tabs, and the Worker and Judge of its tasks, in an isolated environment.'
      "
    >
      <input v-model="enabled" type="checkbox" data-testid="sandbox-checkbox" :disabled="locked || forced" />
      {{ task ? "Run in isolation" : "Work in isolation" }}
      <span class="sandbox-hint">
        <template v-if="task">
          The Worker and Judge run isolated: they cannot read your home folder or other drives, and reach the network
          only through strIDEterm. A task that cannot start isolated does not start at all.
          <template v-if="forced"> The workspace is isolated, so its tasks always are.</template>
        </template>
        <template v-else>
          Agent tabs of this workspace run isolated: they cannot read your home folder or other drives, and reach the
          network only through strIDEterm. Agent tabs are restarted to apply it; a tab that cannot start isolated does
          not start at all.
        </template>
        <template v-if="locked"> Desktop only — change it in the desktop app.</template>
      </span>
    </label>

    <template v-if="enabled">
      <div class="sandbox-section__not-protected" data-testid="sandbox-not-protected">
        <strong>Not protected by isolation</strong>
        <ul>
          <li v-for="line in SANDBOX_NOT_PROTECTED" :key="line">{{ line }}</li>
        </ul>
      </div>

      <div v-if="!locked" class="sandbox-section__status" data-testid="sandbox-status">
        <p v-if="loading" class="sandbox-section__muted">Checking this machine…</p>
        <template v-else-if="status">
          <ul class="sandbox-section__checks">
            <li
              v-for="item in status.prerequisites"
              :key="item.id"
              :class="{ 'sandbox-section__check--missing': !item.ok }"
            >
              <span aria-hidden="true">{{ item.ok ? "✓" : "✗" }}</span>
              {{ item.label }}
              <small v-if="item.detail">— {{ item.detail }}</small>
            </li>
          </ul>
          <p v-if="status.agents?.length" class="sandbox-section__muted"><strong>Agents</strong></p>
          <ul v-if="status.agents?.length" class="sandbox-section__checks" data-testid="sandbox-agents">
            <li
              v-for="agent in status.agents"
              :key="agent.id"
              :class="{ 'sandbox-section__check--missing': !agent.ok }"
            >
              <span aria-hidden="true">{{ agent.ok ? "✓" : "✗" }}</span>
              {{ agent.id }}
              <small v-if="agent.detail">— {{ agent.detail }}</small>
            </li>
          </ul>
          <p v-for="note in status.notes" :key="note" class="sandbox-section__muted">{{ note }}</p>
          <div v-if="slowDrive" class="sandbox-section__muted" data-testid="sandbox-slow-drive">
            <p>
              This workspace is on a Windows drive, which WSL reaches through a slower file system. A workspace stored
              inside WSL is faster.
            </p>
            <button
              v-if="!task && api?.browseDirectory"
              type="button"
              class="button button--ghost"
              data-testid="sandbox-choose-wsl"
              @click="chooseWslFolder"
            >
              Choose a folder inside WSL…
            </button>
          </div>
          <p v-if="status.gateway === 'unavailable' && status.gatewayDetail" class="sandbox-section__muted">
            {{ status.gatewayDetail }}
          </p>
          <div v-if="!status.ready" class="sandbox-section__install">
            <p>
              The sandbox cannot start until the missing parts are installed.
              <template v-if="canInstall">strIDEterm can install them after you confirm.</template>
            </p>
            <button
              v-if="canInstall"
              type="button"
              class="button"
              data-testid="sandbox-install"
              :disabled="installing"
              @click="install"
            >
              {{ installing ? "Installing…" : "Install missing parts" }}
            </button>
          </div>
          <p v-else class="sandbox-section__ready" data-testid="sandbox-ready">Ready: isolated tabs can start.</p>
          <pre v-if="installLog.length" class="sandbox-section__log" data-testid="sandbox-install-log">{{
            installLog.join("\n")
          }}</pre>
          <div v-if="manual.length" class="sandbox-section__manual" data-testid="sandbox-manual">
            <p>Run these yourself, then check again:</p>
            <pre>{{ manual.join("\n") }}</pre>
          </div>
          <button type="button" class="button button--ghost" :disabled="loading || installing" @click="refresh(true)">
            Check again
          </button>
        </template>
      </div>

      <div v-if="allowedDomains.length" class="sandbox-section__domains" data-testid="sandbox-domains">
        <strong>Destinations allowed for this workspace</strong>
        <ul>
          <li v-for="domain in allowedDomains" :key="domain">
            <code>{{ domain }}</code>
            <button
              v-if="!locked"
              type="button"
              class="button button--ghost button--small"
              :aria-label="`Remove ${domain}`"
              @click="removeDomain(domain)"
            >
              Remove
            </button>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from "vue";
import { apiKey } from "../../types/keys.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { Transport } from "../../transport.js";
import { SANDBOX_NOT_PROTECTED, type SandboxStatus } from "../../../electron/shared/sandbox.js";
import { windowsPathToWsl } from "../../../electron/shared/wsl-paths.js";
import { pickPath } from "../../lib/pick-path.js";

const props = defineProps<{
  locked: boolean;
  workspacePath?: string;
  /** The switch belongs to a new task: it can add isolation but never remove its workspace's. */
  task?: boolean;
  /** The switch is on and cannot be turned off. */
  forced?: boolean;
}>();
const emit = defineEmits<{ "update:workspacePath": [path: string] }>();
const enabled = defineModel<boolean>("enabled", { default: false });
const allowedDomains = defineModel<string[]>("allowedDomains", { default: () => [] });

const api = inject<Transport>(apiKey);
const status = ref<SandboxStatus | null>(null);
const loading = ref(false);
const installing = ref(false);
const installLog = ref<string[]>([]);
const manual = ref<string[]>([]);

// A workspace under \wsl$ names its distro; the checks and the install then run there.
const mappedPath = computed(() => windowsPathToWsl(props.workspacePath || ""));
const distroRequest = computed(() => (mappedPath.value?.distro ? { distro: mappedPath.value.distro } : {}));
const slowDrive = computed(() => status.value?.platform === "win32" && mappedPath.value?.windowsDrive === true);

const canInstall = computed(() => status.value?.prerequisites.some((item) => !item.ok && item.installable) === true);

async function refresh(force = false) {
  if (props.locked || !api?.getSandboxStatus) return;
  loading.value = true;
  try {
    status.value = await api.getSandboxStatus({ force, ...distroRequest.value });
  } catch (error) {
    useNotificationStore().showError("Could not check the sandbox prerequisites", error);
  } finally {
    loading.value = false;
  }
}

async function install() {
  if (!api?.installSandboxPrerequisites || installing.value) return;
  installing.value = true;
  installLog.value = [];
  manual.value = [];
  try {
    const result = await api.installSandboxPrerequisites({ ...distroRequest.value });
    status.value = result.status;
    installLog.value = result.log;
    manual.value = result.manual;
    if (result.failed)
      useNotificationStore().showError("Installing the sandbox prerequisites failed", result.log.join("\n"));
  } catch (error) {
    useNotificationStore().showError("Installing the sandbox prerequisites failed", error);
  } finally {
    installing.value = false;
  }
}

// Starts the folder picker in the distro's home: the bare \\wsl.localhost is no folder the Windows dialog can open.
async function chooseWslFolder() {
  const browseDirectory = api?.browseDirectory;
  if (!browseDirectory) return;
  const selected = await pickPath(() => browseDirectory(status.value?.wslHome));
  if (!selected) return;
  if (!windowsPathToWsl(selected)?.distro) {
    useNotificationStore().showError(
      "That folder is not inside WSL",
      "Choose a folder under a WSL distribution (\\\\wsl.localhost\\<distro>\\…) so the sandbox can use it directly.",
    );
    return;
  }
  emit("update:workspacePath", selected);
}

// The checks and the install run in the distro the workspace lives in, so a new folder means a new answer.
watch(
  () => mappedPath.value?.distro,
  () => {
    if (enabled.value) void refresh(true);
  },
);

// Also fires when the switch is turned on from outside (a new task whose workspace is isolated).
watch(enabled, (on) => {
  if (on && !status.value && !loading.value) void refresh();
});

function removeDomain(domain: string) {
  allowedDomains.value = allowedDomains.value.filter((item) => item !== domain);
}

onMounted(() => {
  if (enabled.value) void refresh();
});
</script>

<style scoped>
.sandbox-section {
  display: grid;
  gap: 8px;
}
.sandbox-option {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
}
.sandbox-option input[type="checkbox"] {
  width: auto;
  flex: none;
  margin: 0;
}
/* Undo the global `label span` field-caption style (overlay.css). */
.sandbox-hint {
  flex-basis: 100%;
  font-size: 11px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--muted);
}
.sandbox-section__not-protected,
.sandbox-section__status,
.sandbox-section__domains {
  display: grid;
  gap: 6px;
  margin-left: 24px;
  font-size: 12px;
  color: var(--muted);
}
.sandbox-section .button {
  justify-self: start;
}
.sandbox-section__not-protected ul,
.sandbox-section__domains ul,
.sandbox-section__checks {
  margin: 0;
  padding-left: 18px;
}
.sandbox-section__checks {
  list-style: none;
  padding-left: 0;
}
.sandbox-section__check--missing {
  color: var(--danger, var(--text));
}
.sandbox-section__muted {
  margin: 0;
}
.sandbox-section__ready {
  margin: 0;
  color: var(--text);
}
.sandbox-section__log,
.sandbox-section__manual pre {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  padding: 6px 8px;
  background: rgba(var(--tint), 0.08);
  border-radius: 4px;
  font-size: 11px;
  white-space: pre-wrap;
}
.sandbox-section__domains li {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
