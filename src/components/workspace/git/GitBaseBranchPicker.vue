<template>
  <span class="git-detail-list__row">
    <strong>{{ label }}:</strong>
    <BranchSelectPopover
      class="git-branch-select"
      :model-value="modelValue"
      placeholder="-- select --"
      :options="props.options || []"
      :default-branch="defaultBranch"
      :default-remote="defaultRemote"
      :remote-names="remoteNames"
      search-placeholder="Filter branches…"
      @update:model-value="onChange"
    />
    <slot name="after" />
  </span>
</template>

<script setup lang="ts">
import BranchSelectPopover from "./BranchSelectPopover.vue";

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    options?: string[];
    label?: string;
    defaultBranch?: string;
    defaultRemote?: string;
    remoteNames?: string[];
  }>(),
  {
    modelValue: "",
    options: () => [],
    label: "Base branch",
    defaultBranch: "",
    defaultRemote: "",
    remoteNames: () => [],
  },
);

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

function onChange(value: string) {
  emit("update:modelValue", value);
}
</script>
