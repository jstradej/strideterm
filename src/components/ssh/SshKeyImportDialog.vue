<template>
  <div class="dialog ssh-key-import" :class="{ 'ssh-key-import--embedded': embedded }">
    <div v-if="!embedded" class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Import SSH key</h2>
      </div>
    </div>
    <div v-else class="ssh-embedded-header">
      <div class="ssh-embedded-header__title">
        <p class="eyebrow">SSH</p>
        <h2>Import SSH key</h2>
      </div>
      <div class="ssh-embedded-header__actions">
        <button
          type="button"
          class="button button--ghost"
          title="Return to SSH keys without importing a key."
          :disabled="busy"
          @click="requestClose"
        >
          {{ backLabel }}
        </button>
        <button
          type="button"
          class="button"
          title="Import this private key into the strIDEterm credential store."
          :disabled="busy || !form.pem.trim()"
          @click="submit"
        >
          {{ busy ? "Importing…" : "Import" }}
        </button>
      </div>
    </div>
    <p v-if="embedded && error" class="error-msg" role="alert">{{ error }}</p>

    <div class="form-group">
      <label
        >Private key (PEM or OpenSSH format)
        <HelpTooltip
          text="Select or paste your private key. It stays in strIDEterm's local credential store and is not uploaded. If encrypted, enter its key passphrase below; that is not your server account password. A supplied passphrase is saved with the key under your chosen storage policy, so you usually will not be asked again on every connection."
          label="Private key import help"
      /></label>
      <textarea
        ref="pemRef"
        v-model="form.pem"
        class="input textarea"
        rows="8"
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
      />
      <div class="file-row">
        <input ref="fileRef" class="visually-hidden" type="file" accept=".pem,.key,*/*" @change="readFile" />
        <button type="button" class="button button--ghost button--small" @click="fileRef?.click()">
          Choose key file…
        </button>
        <span class="hint">The private key is sent only to strIDEterm’s local credential store.</span>
      </div>

      <label
        >Label
        <HelpTooltip
          text="A name to help you recognize this key in the host editor. It does not change how the key connects."
          label="Key label help"
      /></label>
      <input v-model="form.label" type="text" class="input" placeholder="e.g. laptop-ed25519" />

      <label
        >Key passphrase (leave empty for unencrypted keys)
        <HelpTooltip
          text="Enter the passphrase that protects this private key file, if it has one. This unlocks the key; it is not your password for the server account. A supplied passphrase is saved with the key under your chosen storage policy."
          label="Private key passphrase help"
      /></label>
      <input v-model="form.passphrase" type="password" class="input" />
    </div>

    <div v-if="!embedded" class="dialog__footer dialog__footer--end">
      <p v-if="error" class="error-msg">{{ error }}</p>
      <button type="button" class="button button--ghost" :disabled="busy" @click="requestClose">Cancel</button>
      <button type="button" class="button" :disabled="busy || !form.pem.trim()" @click="submit">
        {{ busy ? "Importing…" : "Import" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, nextTick } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";
import HelpTooltip from "../common/HelpTooltip.vue";

const emit = defineEmits<{
  (e: "cancel"): void;
}>();
const sshStore = useSshStore();
const appStore = useAppStore();
const busy = ref(false);
const confirmingDiscard = ref(false);
const error = ref("");
const pemRef = ref<HTMLTextAreaElement | null>(null);
const fileRef = ref<HTMLInputElement | null>(null);

const props = withDefaults(
  defineProps<{ onImported?: (key: unknown) => void; backLabel?: string; embedded?: boolean }>(),
  {
    backLabel: "Back to keys",
    embedded: false,
  },
);
const { embedded, backLabel } = props;

const form = reactive({
  pem: "",
  label: "",
  passphrase: "",
});
const initialDraft = JSON.stringify(form);
async function requestClose() {
  if (busy.value || confirmingDiscard.value) return;
  if (JSON.stringify(form) !== initialDraft) {
    confirmingDiscard.value = true;
    try {
      const discard = await appStore.confirmInApp({
        title: "Discard SSH key import?",
        message: "The key and passphrase have not been imported.",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        danger: true,
      });
      if (!discard) return;
    } finally {
      confirmingDiscard.value = false;
    }
  }
  emit("cancel");
}
defineExpose({ requestClose });

onMounted(() => nextTick(() => pemRef.value?.focus()));

async function submit() {
  const pem = form.pem.trim();
  if (!pem) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await sshStore.importKey(pem, form.label.trim() || "Imported key", form.passphrase);
    form.pem = "";
    form.passphrase = "";
    props.onImported?.(result);
    emit("cancel");
  } catch (e) {
    error.value = (e as Error).message || "Import failed.";
  } finally {
    busy.value = false;
  }
}

async function readFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    form.pem = await file.text();
    if (!form.label.trim()) form.label = file.name.replace(/\.[^.]+$/, "");
    error.value = "";
  } catch {
    error.value = "Could not read the selected key file.";
  }
}
</script>

<style scoped>
.ssh-key-import {
  width: min(480px, 100%);
  display: flex;
  flex-direction: column;
}
.form-group {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 0;
}
.dialog__footer {
  flex-shrink: 0;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
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
.ssh-key-import--embedded label {
  display: flex;
  align-items: center;
  gap: 6px;
}
label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.input {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px;
  border-radius: 4px;
}
.textarea {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  resize: vertical;
}
.hint {
  margin: -8px 0 0;
  font-size: 11px;
  color: var(--muted);
}
.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
.error-msg {
  color: var(--danger);
  font-size: 13px;
  margin-right: auto;
}
</style>
