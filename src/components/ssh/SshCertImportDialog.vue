<template>
  <div class="dialog ssh-cert-import">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Paste Certificate</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>

    <div class="form-group">
      <label>OpenSSH certificate</label>
      <textarea
        ref="certRef"
        v-model="cert"
        class="input textarea"
        rows="6"
        placeholder="ssh-ed25519-cert-v01@openssh.com AAAA..."
      />
    </div>

    <div class="dialog__footer">
      <p v-if="error" class="error-msg">{{ error }}</p>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
      <button type="button" class="button" :disabled="busy || !cert.trim()" @click="submit">
        {{ busy ? "Importing…" : "Import" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";
import { useSshStore } from "../../stores/ssh.js";

const props = defineProps<{ keyId: string }>();
const emit = defineEmits<{
  (e: "cancel"): void;
}>();
const sshStore = useSshStore();
const busy = ref(false);
const error = ref("");
const cert = ref("");
const certRef = ref<HTMLTextAreaElement | null>(null);

onMounted(() => nextTick(() => certRef.value?.focus()));

async function submit() {
  const value = cert.value.trim();
  if (!value) return;
  busy.value = true;
  error.value = "";
  try {
    await sshStore.importCertificate(props.keyId, value);
    emit("cancel");
  } catch (e) {
    error.value = (e as Error).message || "Import failed.";
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.ssh-cert-import {
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
.error-msg {
  color: var(--danger);
  font-size: 13px;
  margin-right: auto;
}
</style>
