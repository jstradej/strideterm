<template>
  <div class="dialog ssh-key-import">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Paste Key</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>

    <div class="form-group">
      <label>Private key (PEM or OpenSSH format)</label>
      <textarea
        ref="pemRef"
        v-model="form.pem"
        class="input textarea"
        rows="8"
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
      />
      <p class="hint">The key never leaves your machine — it's copied into the OS credential store.</p>

      <label>Label</label>
      <input v-model="form.label" type="text" class="input" placeholder="e.g. laptop-ed25519" />

      <label>Passphrase (leave empty for unencrypted keys)</label>
      <input v-model="form.passphrase" type="password" class="input" />
    </div>

    <div class="dialog__footer">
      <p v-if="error" class="error-msg">{{ error }}</p>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
      <button type="button" class="button" :disabled="busy || !form.pem.trim()" @click="submit">
        {{ busy ? "Importing…" : "Import" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, nextTick } from "vue";
import { useSshStore } from "../../stores/ssh.js";

const emit = defineEmits<{
  (e: "cancel"): void;
}>();
const sshStore = useSshStore();
const busy = ref(false);
const error = ref("");
const pemRef = ref<HTMLTextAreaElement | null>(null);

const form = reactive({
  pem: "",
  label: "",
  passphrase: "",
});

onMounted(() => nextTick(() => pemRef.value?.focus()));

async function submit() {
  const pem = form.pem.trim();
  if (!pem) return;
  busy.value = true;
  error.value = "";
  try {
    await sshStore.importKey(pem, form.label.trim() || "Imported key", form.passphrase);
    emit("cancel");
  } catch (e) {
    error.value = (e as Error).message || "Import failed.";
  } finally {
    busy.value = false;
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
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
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
.error-msg {
  color: var(--danger);
  font-size: 13px;
  margin-right: auto;
}
</style>
