<template>
  <div class="dialog ssh-key-generate">
    <div v-if="!embedded" class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Generate Key</h2>
      </div>
    </div>
    <div v-else class="ssh-embedded-header">
      <div class="ssh-embedded-header__title">
        <p class="eyebrow">SSH</p>
        <h2>Generate Key</h2>
      </div>
      <div class="ssh-embedded-header__actions">
        <button
          type="button"
          class="button button--ghost"
          title="Return to SSH keys without creating a key."
          :disabled="busy"
          @click="requestClose"
        >
          {{ backLabel }}
        </button>
        <button
          type="button"
          class="button"
          title="Generate and save this private key in the strIDEterm credential store."
          :disabled="busy"
          @click="generate"
        >
          {{ busy ? "Generating…" : "Generate" }}
        </button>
      </div>
    </div>
    <p v-if="embedded && error" class="error-msg" role="alert">{{ error }}</p>

    <div class="form-group">
      <label
        >Key type
        <HelpTooltip
          text="Ed25519 is a modern, compact key and the recommended choice for most servers. Choose ECDSA or RSA only when a server or older system requires it."
          label="Key type help"
      /></label>
      <CustomSelect v-model="form.kind" :options="kindOptions" />

      <label
        >Comment / label
        <HelpTooltip
          text="A recognizable name stored with the key, such as your device name. It does not affect server access."
          label="Key label help"
      /></label>
      <input v-model="form.comment" type="text" class="input" placeholder="e.g. user@laptop" />

      <label
        >Key passphrase (optional)
        <HelpTooltip
          text="Protects the generated private key with a passphrase. This is not your server account password. If provided, strIDEterm saves it with the key under your chosen storage policy, so you usually will not be asked on each connection."
          label="Generated key passphrase help"
      /></label>
      <input v-model="form.passphrase" type="password" class="input" />
    </div>

    <div v-if="!embedded" class="dialog__footer dialog__footer--end">
      <p v-if="error" class="error-msg">{{ error }}</p>
      <button type="button" class="button button--ghost" :disabled="busy" @click="requestClose">Cancel</button>
      <button type="button" class="button" :disabled="busy" @click="generate">
        {{ busy ? "Generating..." : "Generate" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";
import CustomSelect from "../common/CustomSelect.vue";
import HelpTooltip from "../common/HelpTooltip.vue";

const props = withDefaults(
  defineProps<{ onGenerated?: (key: unknown) => void; backLabel?: string; embedded?: boolean }>(),
  {
    backLabel: "Back to keys",
    embedded: false,
  },
);
const { embedded, backLabel } = props;

const emit = defineEmits<{
  (e: "cancel"): void;
}>();
const sshStore = useSshStore();
const appStore = useAppStore();
const busy = ref(false);
const confirmingDiscard = ref(false);
const error = ref("");

const form = reactive({
  kind: "ed25519",
  comment: "",
  passphrase: "",
});
const initialDraft = JSON.stringify(form);
async function requestClose() {
  if (busy.value || confirmingDiscard.value) return;
  if (JSON.stringify(form) !== initialDraft) {
    confirmingDiscard.value = true;
    try {
      const discard = await appStore.confirmInApp({
        title: "Discard SSH key generation?",
        message: "Your key type, label and passphrase have not been used to create a key.",
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

const kindOptions = [
  { value: "ed25519", label: "ed25519 (Recommended)" },
  { value: "ecdsa", label: "ECDSA" },
  { value: "rsa", label: "RSA" },
];

async function generate() {
  busy.value = true;
  error.value = "";
  try {
    const result = await sshStore.generateKey({
      kind: form.kind,
      comment: form.comment,
      passphrase: form.passphrase,
    });
    form.passphrase = "";
    props.onGenerated?.(result);
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
