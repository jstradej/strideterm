<template>
  <div class="dialog" style="width: min(560px, 100%)">
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

<script setup>
import { ref, onMounted } from "vue";

const props = defineProps({
  eyebrow: { type: String, default: "Workspace" },
  title: { type: String, required: true },
  label: { type: String, required: true },
  value: { type: String, default: "" },
  placeholder: { type: String, default: "" },
  submitLabel: { type: String, default: "Save" },
  secondarySubmitLabel: { type: String, default: "" },
});

const emit = defineEmits(["cancel", "submit", "secondary-submit"]);

const textareaRef = ref(null);
const textValue = ref(props.value);

onMounted(() => requestAnimationFrame(() => textareaRef.value?.focus()));

function handleSubmit() {
  const val = textValue.value.trim();
  if (!val) return;
  emit("submit", val);
}

function handleSecondarySubmit() {
  const val = textValue.value.trim();
  if (!val) return;
  emit("secondary-submit", val);
}
</script>
