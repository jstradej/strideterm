<template>
  <span class="git-detail-list__row">
    <strong>{{ label }}:</strong>
    <CustomSelect
      class="git-branch-select"
      :model-value="modelValue"
      placeholder="-- select --"
      :options="optionList"
      searchable
      search-placeholder="Filter branches…"
      @change="onChange"
    />
    <slot name="after" />
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";

const props = withDefaults(defineProps<{ modelValue?: string; options?: string[]; label?: string }>(), {
  modelValue: "",
  options: () => [],
  label: "Base branch",
});

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const PRIORITY = ["main", "develop", "master"];

const sortedOptions = computed(() => {
  const out = [...props.options];
  out.sort((a: string, b: string) => {
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

const optionList = computed(() => sortedOptions.value.map((b: string) => ({ value: b, label: b })));

function onChange(value: string | number) {
  emit("update:modelValue", String(value));
}
</script>
