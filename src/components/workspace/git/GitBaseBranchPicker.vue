<template>
  <span class="git-detail-list__row">
    <strong>{{ label }}:</strong>
    <select class="git-branch-select" :value="modelValue" @change="onChange">
      <option v-if="!modelValue" value="" disabled>-- select --</option>
      <option v-for="b in sortedOptions" :key="b" :value="b">{{ b }}</option>
    </select>
    <slot name="after" />
  </span>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
  options: { type: Array, default: () => [] },
  label: { type: String, default: "Base branch" },
});

const emit = defineEmits(["update:modelValue"]);

const PRIORITY = ["main", "develop", "master"];

const sortedOptions = computed(() => {
  const out = [...props.options];
  out.sort((a, b) => {
    const ai = PRIORITY.indexOf(a);
    const bi = PRIORITY.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    const aRemote = a.startsWith("origin/");
    const bRemote = b.startsWith("origin/");
    if (aRemote !== bRemote) return aRemote ? 1 : -1;
    return a.localeCompare(b);
  });
  return out;
});

function onChange(event) {
  emit("update:modelValue", event.target.value);
}
</script>
