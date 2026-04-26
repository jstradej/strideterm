<template>
  <div class="dialog edit-tab-dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ mode === "new" ? "New tab" : "Edit tab" }}</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>

    <form class="form edit-tab-dialog__form" @submit.prevent="handleSubmit">
      <div v-if="mode === 'new'" class="segmented" role="tablist" aria-label="Tab type">
        <button
          type="button"
          role="tab"
          :aria-selected="tabType === 'local'"
          :class="['segmented__btn', { 'segmented__btn--active': tabType === 'local' }]"
          @click="tabType = 'local'"
        >
          💻 Local shell
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tabType === 'ssh'"
          :class="['segmented__btn', { 'segmented__btn--active': tabType === 'ssh' }]"
          @click="tabType = 'ssh'"
        >
          🔐 SSH
        </button>
      </div>

      <label class="field">
        <span>Title</span>
        <div class="title-row">
          <button type="button" class="icon-btn" :title="'Pick icon'" @click="showIconPicker = !showIconPicker">
            {{ currentIcon || "\u{1F4BB}" }}
          </button>
          <input ref="titleRef" v-model="titleInput" class="title-input" maxlength="60" required />
        </div>
        <div v-if="showIconPicker" class="icon-picker">
          <button
            v-for="icon in BADGE_ICONS"
            :key="icon"
            type="button"
            class="icon-picker__btn"
            @click="pickIcon(icon)"
          >
            {{ icon }}
          </button>
        </div>
      </label>

      <template v-if="tabType === 'ssh'">
        <div class="segmented" role="tablist" aria-label="SSH mode">
          <button
            type="button"
            role="tab"
            :aria-selected="sshMode === 'saved'"
            :class="['segmented__btn', { 'segmented__btn--active': sshMode === 'saved' }]"
            :disabled="sshHosts.length === 0"
            :title="sshHosts.length === 0 ? 'No saved hosts yet — use Quick connect' : ''"
            @click="sshMode = 'saved'"
          >
            Saved host
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="sshMode === 'quick'"
            :class="['segmented__btn', { 'segmented__btn--active': sshMode === 'quick' }]"
            @click="sshMode = 'quick'"
          >
            Quick connect
          </button>
        </div>

        <template v-if="sshMode === 'saved'">
          <div class="field saved-host-field">
            <div class="saved-host-field__label">SSH Host</div>
            <div class="saved-host-row">
              <CustomSelect
                v-model="selectedSshHostId"
                class="saved-host-row__select"
                placeholder="Select a host…"
                :options="hostOptions"
                @change="onHostSelected"
              />
              <button
                type="button"
                class="button button--ghost saved-host-row__edit"
                :disabled="!selectedSshHostId"
                title="Open the full host editor"
                @click="editSelectedHost"
              >
                Edit…
              </button>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="quick-grid">
            <label class="field">
              <span>User</span>
              <input v-model="quick.username" placeholder="alice" required />
            </label>
            <label class="field">
              <span>Host</span>
              <input v-model="quick.host" placeholder="bastion.example.com" required @input="autofillTitle" />
            </label>
            <label class="field">
              <span>Port</span>
              <input v-model.number="quick.port" type="number" min="1" max="65535" />
            </label>
          </div>

          <label class="field">
            <span>Authentication</span>
            <CustomSelect v-model="quick.authMethod" :options="authMethodOptions" />
          </label>

          <label v-if="quick.authMethod === 'publickey'" class="field">
            <span>Key</span>
            <CustomSelect v-model="quick.keyRef" placeholder="Select a key…" :options="keyOptions" />
          </label>

          <div class="save-row">
            <label class="save-row__toggle">
              <input v-model="saveToBook" type="checkbox" />
              <span>Save to host book</span>
            </label>
            <input
              v-model="savedHostName"
              class="save-row__input"
              placeholder="e.g. prod-bastion"
              :disabled="!saveToBook"
              maxlength="60"
            />
          </div>
          <p v-if="quick.error" class="error-msg">{{ quick.error }}</p>
        </template>

        <label class="field">
          <span>Initial command (optional)</span>
          <input v-model="commandInput" placeholder="e.g. tmux attach" maxlength="500" />
        </label>
      </template>

      <template v-else>
        <label class="field">
          <span>Command</span>
          <input v-model="commandInput" placeholder="optional boot command" maxlength="500" />
        </label>
      </template>

      <footer class="dialog__footer edit-tab-dialog__footer">
        <button type="button" class="button button--ghost" :disabled="submitting" @click="emit('cancel')">
          Cancel
        </button>
        <button type="submit" class="button" :disabled="submitting">
          {{ submitting ? "Saving…" : mode === "new" ? "Create tab" : "Save" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";
import CustomSelect from "../common/CustomSelect.vue";

const BADGE_ICONS = [
  "\u{1F4BB}",
  "\u{2328}",
  "\u{1F527}",
  "⚙",
  "\u{1F6E0}",
  "\u{1F4E6}",
  "\u{1F528}",
  "\u{1F5A5}",
  "\u{1F4C4}",
  "\u{1F4DD}",
  "\u{270F}",
  "\u{2702}",
  "\u{1F33F}",
  "\u{1F500}",
  "\u{1F4CB}",
  "\u{1F433}",
  "\u{1F3D7}",
  "\u{2601}",
  "\u{1F310}",
  "\u{1F50C}",
  "\u{1F4E1}",
  "\u{1F680}",
  "\u{1F5C4}",
  "\u{1F4BE}",
  "\u{1F4CA}",
  "\u{1F4C8}",
  "\u{1F9EA}",
  "✅",
  "\u{1F50D}",
  "\u{1F41B}",
  "\u{1F916}",
  "\u{1F9E0}",
  "✨",
  "⚡",
  "\u{1F3AF}",
  "\u{1F512}",
  "\u{1F511}",
  "\u{1F4C1}",
  "\u{1F4A1}",
  "⭐",
  "\u{1F3A8}",
  "\u{1F525}",
  "\u{1F48E}",
  "\u{2764}",
  "\u{1F4AC}",
  "\u{1F514}",
  "\u{1F6A9}",
  "\u{1F5D1}",
];

interface SshHostState {
  title: string;
  command: string;
  sshMode: string;
  sshHostId: string;
}

interface Props {
  eyebrow?: string;
  title?: string;
  command?: string;
  mode?: string;
  presetTabType?: string;
  presetSshMode?: string;
  presetSshHostId?: string;
  onEditSshHost?: ((host: unknown, state: SshHostState) => void) | null;
}

const props = withDefaults(defineProps<Props>(), {
  eyebrow: "Workspace",
  title: "",
  command: "",
  mode: "edit",
  presetTabType: "local",
  presetSshMode: "saved",
  presetSshHostId: "",
  onEditSshHost: null,
});

const emit = defineEmits<{
  cancel: [];
  submit: [payload: unknown];
}>();

const sshStore = useSshStore();
const appStore = useAppStore();
const sshHosts = computed(() => sshStore.hosts || []);
const sshKeys = computed(() => sshStore.keys || []);

const hostOptions = computed(() =>
  sshHosts.value.map((h) => ({ value: h.id, label: `${h.label ?? h.host} (${h.host})` })),
);

const authMethodOptions = computed(() => [
  { value: "agent", label: "SSH Agent (recommended)" },
  {
    value: "publickey",
    label: `Saved key${sshKeys.value.length === 0 ? " — none imported yet" : ""}`,
    disabled: sshKeys.value.length === 0,
  },
  { value: "keyboard-interactive", label: "Password / prompt (MFA)" },
]);

const keyOptions = computed(() => sshKeys.value.map((k) => ({ value: k.id, label: k.label })));

function editSelectedHost() {
  const host = sshHosts.value.find((h) => h.id === selectedSshHostId.value);
  if (!host) return;
  // When the new-tab dialog supplied an onEditSshHost hook, let it coordinate
  // the swap + return flow so the user lands back on the new-tab dialog after
  // saving. Fallback (e.g. in edit-mode) is the one-shot open without return.
  if (props.onEditSshHost) {
    props.onEditSshHost(host, {
      title: titleInput.value,
      command: commandInput.value,
      sshMode: sshMode.value,
      sshHostId: selectedSshHostId.value,
    });
    return;
  }
  emit("cancel");
  appStore.openSshHostEditor(host);
}

const titleRef = ref<HTMLInputElement | null>(null);
const titleInput = ref(props.title);
const commandInput = ref(props.command);
const showIconPicker = ref(false);
const submitting = ref(false);

const tabType = ref(props.presetTabType === "ssh" ? "ssh" : "local");
const sshMode = ref(props.presetSshMode === "quick" ? "quick" : "saved");
const selectedSshHostId = ref(props.presetSshHostId || "");

const quick = reactive({
  host: "",
  port: 22,
  username: "",
  authMethod: "agent",
  keyRef: "",
  error: "",
});
const saveToBook = ref(false);
const savedHostName = ref("");

watch(tabType, (next, prev) => {
  if (next === prev) return;
  commandInput.value = "";
  if (next === "ssh") {
    if (sshHosts.value.length === 0) sshMode.value = "quick";
    else if (!selectedSshHostId.value) {
      selectedSshHostId.value = sshHosts.value[0].id;
      onHostSelected();
    }
  } else if (!titleInput.value) {
    titleInput.value = "Shell";
  }
});

function onHostSelected() {
  const host = sshHosts.value.find((h) => h.id === selectedSshHostId.value);
  if (host) titleInput.value = `\u{1F310} ${host.label ?? host.host}`;
}

function autofillTitle() {
  // Only populate the title if the user hasn't typed something custom.
  const trimmed = titleInput.value.trim();
  const defaults = ["", "Shell", "\u{1F310}"];
  const isDefault = defaults.includes(trimmed) || /^\u{1F310}\s/u.test(trimmed);
  if (isDefault && quick.host.trim()) {
    titleInput.value = `\u{1F310} ${quick.username || ""}@${quick.host}`.trim();
  }
}

const currentIcon = computed(() => {
  const match = String(titleInput.value || "").match(/^([\p{Emoji}\p{S}])\s*/u);
  return match ? match[1] : "";
});

function pickIcon(icon: string) {
  const rest = String(titleInput.value || "").replace(/^[\p{Emoji}\p{S}]\s*/u, "");
  titleInput.value = `${icon} ${rest}`.trimEnd();
  showIconPicker.value = false;
}

onMounted(async () => {
  if (sshHosts.value.length === 0) await sshStore.load();
  if (tabType.value === "ssh") {
    if (sshHosts.value.length === 0) sshMode.value = "quick";
    else if (!selectedSshHostId.value) {
      selectedSshHostId.value = sshHosts.value[0].id;
      onHostSelected();
    }
  }
  requestAnimationFrame(() => {
    titleRef.value?.focus();
    titleRef.value?.select();
  });
});

function buildInlineHost() {
  const methods = [];
  if (quick.authMethod === "agent") methods.push("agent");
  if (quick.authMethod === "publickey") methods.push("publickey");
  if (quick.authMethod === "keyboard-interactive") methods.push("keyboard-interactive");

  return {
    host: quick.host.trim(),
    port: Number(quick.port) > 0 ? Number(quick.port) : 22,
    username: quick.username.trim(),
    hostKeyPolicy: "warn",
    auth: {
      methods,
      keyRef: quick.authMethod === "publickey" ? quick.keyRef : "",
      agent: "auto",
    },
    advanced: { launchVia: "ssh2" },
  };
}

async function handleSubmit() {
  const nextTitle = titleInput.value.trim();
  if (!nextTitle) return;

  // Classic local shell or saved SSH host — simple payload.
  if (tabType.value !== "ssh" || sshMode.value === "saved") {
    // CustomSelect has no native `required`, so guard the saved-host path
    // explicitly — we don't want to submit a saved-host tab with no host id.
    if (tabType.value === "ssh" && sshMode.value === "saved" && !selectedSshHostId.value) return;
    emit("submit", {
      title: nextTitle,
      command: commandInput.value.trim(),
      kind: tabType.value === "ssh" ? "ssh" : undefined,
      sshHostId: tabType.value === "ssh" ? selectedSshHostId.value : undefined,
    });
    return;
  }

  // Quick-connect path. Validate minimally; the backend schema is the source
  // of truth but we want a useful inline error before round-tripping.
  quick.error = "";
  if (!quick.host.trim() || !quick.username.trim()) {
    quick.error = "Host and username are required.";
    return;
  }
  if (quick.authMethod === "publickey" && !quick.keyRef) {
    quick.error = "Select a key or switch to agent.";
    return;
  }

  submitting.value = true;
  try {
    // "Save to host book" promotes the ad-hoc config to a saved host first,
    // then the panel just references it by id. Declined: inline sticks on
    // the panel and dies when the tab is removed.
    if (saveToBook.value) {
      const name = savedHostName.value.trim() || `${quick.username}@${quick.host}`;
      const inline = buildInlineHost();
      const newHost = {
        label: name,
        host: inline.host,
        port: inline.port,
        username: inline.username,
        hostKeyPolicy: inline.hostKeyPolicy,
        auth: inline.auth,
        jump: [],
        advanced: inline.advanced,
        tags: [],
      };
      await sshStore.saveHost(newHost as unknown as Parameters<typeof sshStore.saveHost>[0]);
      await sshStore.load();
      const saved = sshStore.hosts.find((h) => h.label === name);
      if (!saved) {
        quick.error = "Failed to save host to book.";
        return;
      }
      emit("submit", {
        title: nextTitle,
        command: commandInput.value.trim(),
        kind: "ssh",
        sshHostId: saved.id,
      });
      return;
    }

    emit("submit", {
      title: nextTitle,
      command: commandInput.value.trim(),
      kind: "ssh",
      sshInline: buildInlineHost(),
    });
  } catch (err) {
    quick.error = (err as Error).message || "Failed to create tab";
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.edit-tab-dialog {
  width: min(520px, 100%);
}
.edit-tab-dialog__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Segmented control — replaces ugly radio rows for binary toggles.
   Overrides the global `label { display: grid }` by using plain <button>s. */
.segmented {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
}
.segmented__btn {
  flex: 1;
  padding: 8px 14px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background 0.12s,
    color 0.12s;
}
.segmented__btn:hover:not(:disabled):not(.segmented__btn--active) {
  color: var(--text);
  background: rgba(255, 255, 255, 0.04);
}
.segmented__btn--active {
  background: var(--accent);
  color: #000;
}
.segmented__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Fields — standard label + input pair (overlay.css already grids them). */
.field {
  margin: 0;
}

.title-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
}
.icon-btn {
  width: 40px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  font-size: 16px;
  padding: 0;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}
.title-input {
  flex: 1;
  min-width: 0;
}
.icon-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px;
  margin-top: 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
  max-height: 160px;
  overflow-y: auto;
}
.icon-picker__btn {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 15px;
  padding: 0;
}
.icon-picker__btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: var(--border);
}

/* Saved-host: label stands alone on top (like a caption), then a flex row
   holds the dropdown and the Edit button side-by-side with matching heights. */
.saved-host-field__label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  margin-bottom: 4px;
}
.saved-host-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.saved-host-row__select {
  flex: 1;
  min-width: 0;
}
.saved-host-row__edit {
  flex-shrink: 0;
  white-space: nowrap;
}

/* Quick-connect grid: user ~35%, host flexes, port fixed narrow. */
.quick-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) 80px;
  gap: 10px;
}

/* Save-row: checkbox toggle on the left, name input expanding to the right. */
.save-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
}
.save-row__toggle {
  display: flex !important;
  align-items: center;
  gap: 8px;
  margin: 0;
  cursor: pointer;
  white-space: nowrap;
}
.save-row__toggle input[type="checkbox"] {
  width: auto;
  padding: 0;
  margin: 0;
  flex-shrink: 0;
  accent-color: var(--accent);
}
.save-row__toggle span {
  font-size: 13px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--text);
  font-weight: 500;
}
.save-row__input {
  flex: 1;
  min-width: 0;
}
.save-row__input:disabled {
  opacity: 0.5;
}

.error-msg {
  color: #ff6b6b;
  font-size: 13px;
  margin: 0;
}

.edit-tab-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

/* The global `input { width: 100% }` from overlay.css is way too broad —
   checkboxes and radios should never stretch. This scoped override prevents
   the "giant radio circle" effect seen in the old radio-row design. */
:deep(input[type="checkbox"]),
:deep(input[type="radio"]) {
  width: auto;
  padding: 0;
}
</style>
