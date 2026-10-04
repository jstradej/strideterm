<template>
  <div v-if="payload" class="ssh-auth-prompt" @keydown.esc.stop.prevent="cancel">
    <div class="prompt-box">
      <div class="prompt-heading">
        <h3>{{ promptData.name || "SSH Authentication" }}</h3>
        <HelpTooltip
          text="This sign-in step may ask for your server account password or a one-time verification code. If strIDEterm asks to unlock a private key, enter that key's passphrase instead; it is not your server account password. Multi-step sign-in may ask again after you submit. These answers are used for this connection and are not saved as a host setting."
          label="SSH sign-in prompt help"
        />
      </div>
      <p v-if="promptData.instructions" class="instructions">{{ promptData.instructions }}</p>

      <div v-for="(p, i) in promptData.prompts" :key="i" class="prompt-field">
        <label>{{ p.prompt }}</label>
        <input
          :ref="(el) => (inputs[i] = el as HTMLInputElement)"
          v-model="answers[i]"
          :type="p.echo ? 'text' : 'password'"
          class="input"
          :disabled="busy"
          @keyup.enter="submit"
        />
      </div>

      <div class="actions">
        <button type="button" class="button button--ghost" :disabled="busy" @click="cancel">Cancel</button>
        <button type="button" class="button" :disabled="busy" @click="submit">
          {{ busy ? "Sending…" : "Submit" }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import HelpTooltip from "../common/HelpTooltip.vue";

interface SshAuthPromptPayload {
  sessionId: string;
  promptId: string;
  prompt?: {
    name?: string;
    instructions?: string;
    prompts?: { prompt: string; echo: boolean }[];
  };
}

const props = withDefaults(
  defineProps<{
    prompt?: SshAuthPromptPayload | null;
  }>(),
  {
    prompt: null,
  },
);

const sshStore = useSshStore();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const payload = computed(() => props.prompt || (sshStore.authPrompt as any as SshAuthPromptPayload | null));
const promptData = computed(() => payload.value?.prompt || {});
const answers = ref<string[]>([]);
const busy = ref(false);
const inputs = ref<HTMLInputElement[]>([]);

watch(
  payload,
  (next) => {
    if (next) {
      busy.value = false;
      answers.value = new Array(next.prompt?.prompts?.length || 0).fill("");
      nextTick(() => {
        if (inputs.value[0]) inputs.value[0].focus();
      });
    } else {
      answers.value = [];
    }
  },
  { immediate: true },
);

async function submit() {
  if (!payload.value || busy.value) return;
  const promptId = payload.value.promptId;
  busy.value = true;
  await sshStore.answerAuthPrompt(payload.value.sessionId, answers.value, promptId);
  if (payload.value?.promptId === promptId) busy.value = false;
}

async function cancel() {
  if (!payload.value) return;
  if (busy.value) return;
  const promptId = payload.value.promptId;
  busy.value = true;
  await sshStore.cancelAuthPrompt(payload.value.sessionId, promptId);
  if (payload.value?.promptId === promptId) busy.value = false;
}
</script>

<style scoped>
.ssh-auth-prompt {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
.prompt-box {
  width: 380px;
  max-width: 95vw;
  background: #1a1a1c;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
}
.prompt-box h3 {
  margin: 0 0 12px 0;
  font-size: 16px;
}
.prompt-heading {
  display: flex;
  align-items: center;
  gap: 4px;
}
.instructions {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 16px;
  white-space: pre-wrap;
}
.prompt-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}
.prompt-field label {
  font-size: 13px;
}
.input {
  width: 100%;
  padding: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 4px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
</style>
