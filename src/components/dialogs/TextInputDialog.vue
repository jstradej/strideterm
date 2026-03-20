<template>
  <div class="dialog" style="width:min(420px,100%);">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ title }}</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span>{{ label }}</span>
        <input ref="inputRef" name="value" v-model="inputValue" :placeholder="placeholder" required />
      </label>
      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button type="submit" class="button">{{ submitLabel }}</button>
      </footer>
    </form>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";

const props = defineProps({
  eyebrow: { type: String, default: "Workspace" },
  title: { type: String, required: true },
  label: { type: String, required: true },
  value: { type: String, default: "" },
  placeholder: { type: String, default: "" },
  submitLabel: { type: String, default: "Save" },
});

const emit = defineEmits(["cancel", "submit"]);

const inputRef = ref(null);
const inputValue = ref(props.value);

onMounted(() => {
  inputRef.value?.focus();
  inputRef.value?.select();
});

function handleSubmit() {
  const val = inputValue.value.trim();
  if (!val) return;
  emit("submit", val);
}
</script>
