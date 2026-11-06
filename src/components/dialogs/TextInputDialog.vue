<template>
  <div class="dialog" style="width: min(420px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ title }}</h2>
      </div>
    </div>
    <div v-if="context" class="text-input-dialog__context">
      <p class="text-input-dialog__context-label">Starting point</p>
      <p class="text-input-dialog__context-summary">{{ context.summary }}</p>
      <p v-if="context.detail" class="text-input-dialog__context-detail">{{ context.detail }}</p>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span>{{ label }}</span>
        <input
          ref="inputRef"
          v-model="inputValue"
          name="value"
          :placeholder="placeholder"
          required
          :disabled="submitting"
          :data-validation-required="`Enter a value for ${label.toLowerCase()}.`"
        />
      </label>
      <div v-if="errorMessage" class="dialog__error" role="alert">
        <span class="dialog__error-icon" aria-hidden="true">⚠</span>
        <span class="dialog__error-text">{{ errorMessage }}</span>
      </div>
      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" :disabled="submitting" @click="emit('cancel')">
          Cancel
        </button>
        <button
          type="submit"
          class="button"
          :class="{ 'button--pending': submitting }"
          :aria-busy="submitting ? 'true' : 'false'"
          :disabled="submitting"
        >
          <span>{{ submitLabel }}</span>
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, useAttrs } from "vue";
import { userFacingMessage } from "../../lib/error-message.js";
import { rlog } from "../../lib/renderer-log.js";

interface Props {
  eyebrow?: string;
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  submitLabel?: string;
  context?: { summary: string; detail?: string };
}

const props = withDefaults(defineProps<Props>(), {
  eyebrow: "Workspace",
  value: "",
  placeholder: "",
  submitLabel: "Save",
});

// "submit" is deliberately NOT a declared emit: emit is fire-and-forget, so a
// rejected rename closed nothing and showed nothing. Calling attrs.onSubmit
// lets us await it, show the rejection inline and close only after success
// (the caller closes the dialog). inheritAttrs: false stops Vue from also
// binding onSubmit as a native "submit" listener on the root div.
const emit = defineEmits<{
  cancel: [];
}>();
const attrs = useAttrs();
defineOptions({ inheritAttrs: false });

const inputRef = ref<HTMLInputElement | null>(null);
const inputValue = ref(props.value);
const submitting = ref(false);
const errorMessage = ref("");
let unmounted = false;
onBeforeUnmount(() => {
  unmounted = true;
});

onMounted(() =>
  requestAnimationFrame(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  }),
);

async function handleSubmit() {
  const val = inputValue.value.trim();
  if (!val || submitting.value) return;
  submitting.value = true;
  errorMessage.value = "";
  try {
    await (attrs.onSubmit as ((value: string) => void | Promise<void>) | undefined)?.(val);
  } catch (error) {
    // A caller that already closed the dialog has nowhere to show it here.
    if (unmounted) throw error;
    errorMessage.value = userFacingMessage(error, "Could not save.");
    rlog("warn", `[dialog] ${props.title} failed`, { error: errorMessage.value });
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.text-input-dialog__context {
  margin-top: 12px;
}

.text-input-dialog__context-label {
  margin: 0 0 4px;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.text-input-dialog__context-summary {
  margin: 0;
  color: var(--text);
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.text-input-dialog__context-detail {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
</style>
