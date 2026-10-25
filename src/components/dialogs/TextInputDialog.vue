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
          :data-validation-required="`Enter a value for ${label.toLowerCase()}.`"
        />
      </label>
      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button type="submit" class="button">{{ submitLabel }}</button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";

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

const emit = defineEmits<{
  cancel: [];
  submit: [value: string];
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const inputValue = ref(props.value);

onMounted(() =>
  requestAnimationFrame(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  }),
);

function handleSubmit() {
  const val = inputValue.value.trim();
  if (!val) return;
  emit("submit", val);
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
