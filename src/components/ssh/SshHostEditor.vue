<template>
  <div class="dialog ssh-host-editor">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>{{ isNew ? "Add Host" : "Edit Host" }}</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>

    <div class="ssh-host-editor__tabs">
      <button :class="['tab-btn', { active: activeTab === 'general' }]" @click="activeTab = 'general'">General</button>
      <button :class="['tab-btn', { active: activeTab === 'auth' }]" @click="activeTab = 'auth'">Auth</button>
      <button :class="['tab-btn', { active: activeTab === 'advanced' }]" @click="activeTab = 'advanced'">
        Advanced
      </button>
    </div>

    <div class="ssh-host-editor__content">
      <div v-if="activeTab === 'general'" class="form-group">
        <div class="field">
          <label>Name</label>
          <input v-model="form.name" type="text" class="input" placeholder="e.g. prod-bastion" />
        </div>

        <div class="field">
          <label>Hostname / IP</label>
          <input v-model="form.host" type="text" class="input" placeholder="e.g. 192.168.1.10" />
        </div>

        <div class="field">
          <label>Port</label>
          <input v-model.number="form.port" type="number" class="input" />
        </div>

        <div class="field">
          <label>Username</label>
          <input v-model="form.username" type="text" class="input" />
        </div>

        <div class="field">
          <label>Tags (comma separated)</label>
          <input v-model="tagsString" type="text" class="input" placeholder="prod, web, us-east" />
        </div>
      </div>

      <div v-if="activeTab === 'auth'" class="form-group">
        <div class="field">
          <label>Authentication Methods (try in order)</label>
          <div class="checkbox-group">
            <label class="checkbox-label">
              <input v-model="form.auth.methods" type="checkbox" value="publickey" />
              <span>Public Key / Certificate</span>
            </label>
            <label class="checkbox-label">
              <input v-model="form.auth.methods" type="checkbox" value="keyboard-interactive" />
              <span>Password / MFA (prompt on connect)</span>
            </label>
            <label class="checkbox-label">
              <input v-model="form.auth.methods" type="checkbox" value="agent" />
              <span>SSH Agent</span>
            </label>
          </div>
          <p class="field-help">
            Tip: "Password / MFA" means the server will prompt you interactively — no credentials are stored by
            strideterm.
          </p>
        </div>

        <template v-if="form.auth.methods.includes('publickey')">
          <div class="field">
            <label>SSH Key</label>
            <CustomSelect v-model="form.auth.keyRef" :options="keyOptions" />
          </div>
          <div class="field">
            <label>Certificate (Optional)</label>
            <CustomSelect v-model="form.auth.certRef" :options="certOptions" />
          </div>
        </template>

        <div v-if="form.auth.methods.includes('agent')" class="field">
          <label>Agent Mode</label>
          <CustomSelect v-model="form.auth.agent" :options="agentOptions" />
        </div>
      </div>

      <div v-if="activeTab === 'advanced'" class="form-group">
        <div class="field">
          <label>Launch Via</label>
          <CustomSelect v-model="form.advanced.launchVia" :options="launchViaOptions" />
        </div>

        <div class="field">
          <label>Keepalive Interval (ms)</label>
          <input v-model.number="form.advanced.keepaliveIntervalMs" type="number" class="input" />
        </div>

        <div class="field">
          <label>Post-login command</label>
          <input v-model="form.advanced.command" type="text" class="input" placeholder="e.g. tmux attach" />
        </div>

        <div class="field">
          <label class="checkbox-label">
            <input v-model="form.advanced.agentForward" type="checkbox" />
            <span>Agent Forwarding</span>
          </label>
          <p class="field-help">Warning: the remote host can access your local agent keys.</p>
        </div>
      </div>
    </div>

    <div class="dialog__footer ssh-host-editor__footer">
      <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
      <button type="button" class="button" @click="save">Save</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import CustomSelect from "../common/CustomSelect.vue";
import type { SshHost as BaseSshHost } from "../../../electron/shared/types/ssh.js";

// Extended host type with UI-only fields
interface SshHost extends BaseSshHost {
  name?: string;
  tags?: string[];
  advanced?: {
    launchVia?: string;
    keepaliveIntervalMs?: number;
    command?: string;
    agentForward?: boolean;
  };
}

// Extended cert type — backend returns extra fields
interface SshCertExtended {
  id: string;
  keyIdString?: string;
}

const props = withDefaults(defineProps<{
  host?: SshHost | null;
}>(), {
  host: null,
});

const emit = defineEmits<{
  (e: "cancel"): void;
  (e: "save"): void;
}>();
const sshStore = useSshStore();

const isNew = !props.host;
const activeTab = ref("general");

const keyOptions = computed(() => [
  { value: "", label: "(None)" },
  ...sshStore.keys.map((k) => ({ value: k.id, label: k.label })),
]);
const certOptions = computed(() => [
  { value: "", label: "(None)" },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...(sshStore.certificates as any[]).map((c: SshCertExtended) => ({ value: c.id, label: c.keyIdString || c.id })),
]);
const agentOptions = [
  { value: "auto", label: "Auto" },
  { value: "pageant", label: "Pageant (Windows)" },
  { value: "pipe", label: "Named Pipe (Windows)" },
  { value: "socket", label: "Unix Socket" },
  { value: "off", label: "Off" },
];
const launchViaOptions = [
  { value: "ssh2", label: "ssh2 (Built-in)" },
  { value: "system-ssh", label: "System SSH" },
  { value: "wsl", label: "WSL" },
];

const form = reactive({
  name: "",
  host: "",
  port: 22,
  username: "",
  auth: {
    methods: ["publickey"] as string[],
    keyRef: "",
    certRef: "",
    agent: "auto",
  },
  advanced: {
    launchVia: "ssh2",
    keepaliveIntervalMs: 30000,
    command: "",
    agentForward: false,
  },
  tags: [] as string[],
});

const tagsString = computed({
  get() {
    return form.tags.join(", ");
  },
  set(val) {
    form.tags = val
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  },
});

onMounted(() => {
  if (props.host) {
    Object.assign(form, JSON.parse(JSON.stringify(props.host)));
    if (!form.advanced)
      form.advanced = { launchVia: "ssh2", keepaliveIntervalMs: 30000, command: "", agentForward: false };
    if (!form.auth) form.auth = { methods: ["publickey"], keyRef: "", certRef: "", agent: "auto" };
  }
  // Migrate legacy "password" method (non-interactive, needed stored
  // passwordRef that no UI ever set) → "keyboard-interactive" so the existing
  // "Password / MFA (prompt)" checkbox reflects the saved state.
  if (Array.isArray(form.auth?.methods) && form.auth.methods.includes("password")) {
    const rest = form.auth.methods.filter((m) => m !== "password");
    if (!rest.includes("keyboard-interactive")) rest.push("keyboard-interactive");
    form.auth.methods = rest;
  }
});

async function save() {
  const payload = JSON.parse(JSON.stringify(form));
  if (props.host) payload.id = props.host.id;
  await sshStore.saveHost(payload);
  emit("cancel");
}
</script>

<style scoped>
.ssh-host-editor {
  width: min(500px, 100%);
  height: min(560px, 85vh);
  display: flex;
  flex-direction: column;
}
.ssh-host-editor__tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
  padding-bottom: 8px;
  flex-shrink: 0;
}
.tab-btn {
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 4px;
}
.tab-btn.active {
  color: var(--text);
  background: rgba(255, 255, 255, 0.1);
}
.ssh-host-editor__content {
  flex: 1;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding-right: 4px;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/* Override the global `label { display: grid }` from overlay.css so our labels
   behave as plain block elements inside this dialog. */
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field > label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}
.input {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px;
  border-radius: 4px;
  font: inherit;
}
.select {
  color-scheme: dark;
  appearance: auto;
}
.select option {
  background: var(--panel-elevated);
  color: var(--text);
}
.select option:checked {
  background: var(--accent) !important;
  box-shadow: inset 0 0 0 100px var(--accent);
  color: #000 !important;
}
.checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
}
.checkbox-label {
  display: flex !important;
  align-items: center;
  gap: 8px;
  font-weight: normal !important;
  cursor: pointer;
  margin: 0;
  padding: 0;
}
.checkbox-label input[type="checkbox"] {
  width: auto;
  margin: 0;
  flex-shrink: 0;
  accent-color: var(--accent);
}
.checkbox-label span {
  font-size: 13px;
  color: var(--text);
  text-transform: none;
  letter-spacing: normal;
}
.field-help {
  font-size: 12px;
  color: var(--muted);
  margin: 2px 0 0 24px;
  line-height: 1.4;
}
.ssh-host-editor__footer {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
</style>
