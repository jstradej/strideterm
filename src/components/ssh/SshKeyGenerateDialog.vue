<template>
  <div class="dialog ssh-key-generate">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Generate Key</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>

    <div class="form-group">
      <label>Key Type</label>
      <CustomSelect v-model="form.kind" :options="kindOptions" />

      <label>Comment / Label</label>
      <input v-model="form.comment" type="text" class="input" placeholder="e.g. user@laptop" />

      <label>Passphrase (Optional)</label>
      <input v-model="form.passphrase" type="password" class="input" />
    </div>

    <div class="dialog__footer">
      <p v-if="error" class="error-msg">{{ error }}</p>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
      <button type="button" class="button" :disabled="busy" @click="generate">
        {{ busy ? "Generating..." : "Generate" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import CustomSelect from "../common/CustomSelect.vue";

const emit = defineEmits<{
  (e: "cancel"): void;
}>();
const sshStore = useSshStore();
const busy = ref(false);
const error = ref("");

const form = reactive({
  kind: "ed25519",
  comment: "",
  passphrase: "",
});

const kindOptions = [
  { value: "ed25519", label: "ed25519 (Recommended)" },
  { value: "ecdsa", label: "ECDSA" },
  { value: "rsa", label: "RSA" },
];

async function generate() {
  busy.value = true;
  error.value = "";
  try {
    await sshStore.generateKey({
      kind: form.kind,
      comment: form.comment,
      passphrase: form.passphrase,
    });
    emit("cancel");
  } catch (e) {
    error.value = (e as Error).message || "Failed to generate key.";
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.ssh-key-generate {
  width: min(400px, 100%);
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
.error-msg {
  color: var(--danger);
  font-size: 13px;
  margin-right: auto;
}
</style>
