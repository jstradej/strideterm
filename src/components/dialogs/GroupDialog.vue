<template>
  <div class="dialog" style="width: min(420px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Group</p>
        <h2>{{ title }}</h2>
      </div>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span>Name</span>
        <input
          ref="inputRef"
          v-model="name"
          name="name"
          required
          :disabled="submitting"
          data-validation-required="Enter a name for the group."
        />
      </label>
      <label>
        <span>Badge</span>
        <input v-model="icon" name="icon" maxlength="4" :disabled="submitting" />
        <div class="icon-picker">
          <button
            v-for="candidate in BADGE_ICONS"
            :key="candidate"
            type="button"
            class="button button--ghost icon-picker__btn"
            :title="`Use ${candidate} as the badge.`"
            @click="icon = candidate"
          >
            {{ candidate }}
          </button>
        </div>
      </label>
      <label>
        <span>Accent</span>
        <input v-model="color" name="color" type="color" class="color-input" :disabled="submitting" />
      </label>
      <div v-if="errorMessage" class="dialog__error" role="alert">
        <span class="dialog__error-icon" aria-hidden="true">⚠</span>
        <span class="dialog__error-text">{{ errorMessage }}</span>
      </div>
      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" :disabled="submitting" @click="emit('cancel')">
          Cancel
        </button>
        <button
          type="submit"
          class="button"
          :class="{ 'button--pending': submitting }"
          :aria-busy="submitting ? 'true' : 'false'"
          :disabled="submitting"
        >
          <span>{{ submitLabel }}</span>
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, useAttrs } from "vue";
import { BADGE_ICONS } from "../../lib/badge-icons.js";
import { userFacingMessage } from "../../lib/error-message.js";
import { rlog } from "../../lib/renderer-log.js";

interface Props {
  title?: string;
  submitLabel?: string;
  name?: string;
  icon?: string;
  color?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: "New group",
  submitLabel: "Create",
  name: "",
  icon: "\u{1F4C1}",
  color: "#ffa424",
});

// "submit" is deliberately not a declared emit: the caller's promise is awaited so a failure is shown here and the
// dialog closes only after it succeeded (the caller closes it). inheritAttrs: false keeps Vue from binding onSubmit as
// a native "submit" listener on the root element.
const emit = defineEmits<{
  cancel: [];
}>();
const attrs = useAttrs();
defineOptions({ inheritAttrs: false });

const inputRef = ref<HTMLInputElement | null>(null);
const name = ref(props.name);
const icon = ref(props.icon);
const color = ref(props.color);
const submitting = ref(false);
const errorMessage = ref("");
let unmounted = false;
onBeforeUnmount(() => {
  unmounted = true;
});

onMounted(() =>
  requestAnimationFrame(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  }),
);

async function handleSubmit() {
  const trimmed = name.value.trim();
  if (!trimmed || submitting.value) return;
  submitting.value = true;
  errorMessage.value = "";
  try {
    await (
      attrs.onSubmit as ((value: { name: string; icon: string; color: string }) => void | Promise<void>) | undefined
    )?.({ name: trimmed, icon: icon.value.trim(), color: color.value });
  } catch (error) {
    // A caller that already closed the dialog has nowhere to show it here.
    if (unmounted) throw error;
    errorMessage.value = userFacingMessage(error, "Could not save the group.");
    rlog("warn", `[dialog] ${props.title} failed`, { error: errorMessage.value });
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.icon-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, 32px);
  gap: 4px;
  max-height: 120px;
  overflow-y: auto;
  margin-top: 6px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.icon-picker__btn {
  padding: 0;
  width: 32px;
  height: 32px;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 3px;
}
.color-input {
  width: 48px;
  height: 36px;
  padding: 2px;
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
}
</style>
