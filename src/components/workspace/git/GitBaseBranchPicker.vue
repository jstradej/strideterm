<template>
  <span class="git-detail-list__row">
    <strong>{{ label }}:</strong>
    <CustomSelect
      class="git-branch-select"
      :model-value="modelValue"
      placeholder="-- select --"
      :options="optionList"
      @change="onChange"
    />
    <slot name="after" />
  </span>
</template>

<script setup>
import { computed } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";

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

const optionList = computed(() => sortedOptions.value.map((b) => ({ value: b, label: b })));

function onChange(value) {
  emit("update:modelValue", value);
}
</script>
