<template>
  <div class="dialog prompt-dialog">
    <div class="dialog__header">
      <div>
        <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ title }}</h2>
        <p v-if="subtitle" class="prompt-dialog__subtitle">{{ subtitle }}</p>
      </div>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span>{{ label }}</span>
        <input
          ref="inputRef"
          v-model="inputValue"
          name="prompt-value"
          :placeholder="placeholder"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <p v-if="inputValue && !isValid" class="prompt-dialog__error">{{ invalidHint }}</p>

      <label v-if="checkboxLabel" class="prompt-dialog__checkbox">
        <input v-model="checked" type="checkbox" name="prompt-checkbox" />
        <span>{{ checkboxLabel }}</span>
      </label>
      <p
        v-if="checkboxLabel && checkboxHint"
        :class="['prompt-dialog__hint', checkboxHintWarn && 'prompt-dialog__hint--warn']"
      >
        {{ checkboxHint }}
      </p>

      <footer class="dialog__footer prompt-dialog__footer">
        <button type="button" class="button button--ghost" @click="emit('cancel')">{{ cancelLabel }}</button>
        <button type="submit" class="button" :disabled="!isValid">{{ submitLabel }}</button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    eyebrow?: string;
    subtitle?: string;
    label: string;
    value?: string;
    placeholder?: string;
    submitLabel?: string;
    cancelLabel?: string;
    /** Source string for a validation regex; empty means "non-empty only". */
    pattern?: string;
    invalidHint?: string;
    checkboxLabel?: string;
    checkboxInitial?: boolean;
    checkboxHint?: string;
    checkboxHintWarn?: boolean;
  }>(),
  {
    eyebrow: "Git",
    subtitle: "",
    value: "",
    placeholder: "",
    submitLabel: "OK",
    cancelLabel: "Cancel",
    pattern: "",
    invalidHint: "Invalid value.",
    checkboxLabel: "",
    checkboxInitial: false,
    checkboxHint: "",
    checkboxHintWarn: false,
  },
);

const emit = defineEmits<{
  cancel: [];
  submit: [value: string, checked: boolean];
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const inputValue = ref(props.value);
const checked = ref(props.checkboxInitial);

const regex = computed(() => (props.pattern ? new RegExp(props.pattern) : null));
const isValid = computed(() => {
  const v = inputValue.value.trim();
  if (!v) return false;
  return regex.value ? regex.value.test(v) : true;
});

onMounted(() =>
  requestAnimationFrame(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  }),
);

function handleSubmit() {
  if (!isValid.value) return;
  emit("submit", inputValue.value.trim(), checked.value);
}
</script>

<style scoped>
.prompt-dialog {
  width: min(460px, 100%);
}

.prompt-dialog__subtitle {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}

.prompt-dialog__error {
  margin: -4px 0 0;
  color: var(--danger, #d9534f);
  font-size: 12px;
}

.prompt-dialog__checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.prompt-dialog__checkbox input {
  width: auto;
  margin: 0;
}

.prompt-dialog__hint {
  margin: -4px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}

.prompt-dialog__hint--warn {
  color: var(--warning, #c08a2d);
}

.prompt-dialog__footer {
  margin-top: 18px;
  justify-content: flex-end;
}
</style>
