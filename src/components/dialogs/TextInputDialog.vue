<template>
  <div class="dialog" style="width: min(420px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ title }}</h2>
      </div>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span>{{ label }}</span>
        <input ref="inputRef" v-model="inputValue" name="value" :placeholder="placeholder" required />
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
