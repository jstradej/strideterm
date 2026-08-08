<template>
  <div class="dialog" style="width: min(560px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ title }}</h2>
      </div>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span>{{ label }}</span>
        <textarea ref="textareaRef" v-model="textValue" name="value" rows="8" :placeholder="placeholder" />
      </label>
      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button v-if="secondarySubmitLabel" type="button" class="button button--ghost" @click="handleSecondarySubmit">
          {{ secondarySubmitLabel }}
        </button>
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
  secondarySubmitLabel?: string;
  /**
   * Let an empty value through. Off by default because most callers post the
   * text somewhere (PR comments, commit messages) where blank is meaningless;
   * tab notes need it so clearing the box deletes the note.
   */
  allowEmpty?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  eyebrow: "Workspace",
  value: "",
  placeholder: "",
  submitLabel: "Save",
  secondarySubmitLabel: "",
  allowEmpty: false,
});

const emit = defineEmits<{
  cancel: [];
  submit: [value: string];
  "secondary-submit": [value: string];
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);
const textValue = ref(props.value);

onMounted(() => requestAnimationFrame(() => textareaRef.value?.focus()));

function handleSubmit() {
  const val = textValue.value.trim();
  if (!val && !props.allowEmpty) return;
  emit("submit", val);
}

function handleSecondarySubmit() {
  const val = textValue.value.trim();
  if (!val) return;
  emit("secondary-submit", val);
}
</script>
