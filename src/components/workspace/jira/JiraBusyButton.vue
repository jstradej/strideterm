<template>
  <button
    ref="buttonRef"
    type="button"
    :class="{ 'button--pending': pending }"
    :aria-busy="busy ? 'true' : undefined"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
import { ref, toRef } from "vue";

import { useDelayedFlag } from "../../../composables/useDelayedFlag.js";

/**
 * A button whose own action is running. The label never changes and stays in the layout, so the button keeps its
 * size; the spinner appears only after the action has taken noticeably long. The action itself guards against a
 * second submit, so the button is not disabled by `busy` - `disabled` is for a missing precondition only.
 */
const props = withDefaults(defineProps<{ busy?: boolean; disabled?: boolean }>(), { busy: false, disabled: false });
const pending = useDelayedFlag(toRef(props, "busy"));
const buttonRef = ref<HTMLButtonElement | null>(null);
defineExpose({ focus: (options?: FocusOptions) => buttonRef.value?.focus(options) });
</script>
