<template>
  <div class="dialog dialog--textarea">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ title }}</h2>
      </div>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span>{{ label }}</span>
        <textarea
          ref="textareaRef"
          v-model="textValue"
          name="value"
          rows="8"
          :class="{ 'textarea--nowrap': nowrap }"
          :placeholder="placeholder"
        />
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
   * Scroll long lines sideways instead of wrapping them. Off by default —
   * prose (commit messages, PR comments) reads better wrapped. Notes are
   * pasted logs and command lines as often as prose, where a wrap in the
   * middle of a path is worse than a scrollbar.
   */
  nowrap?: boolean;
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
  nowrap: false,
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

<style scoped>
/* The textarea carries the browser's native resize handle, but the dialog was
   a fixed 560px with `overflow: auto` — so dragging it wider only pushed the
   extra width (and the Save button) behind the dialog's own scroll area, where
   nobody could see it. Let the dialog track the textarea instead: floored at
   the default width, capped at the overlay so a drag never runs off-screen.
   The default scales with the window because 560px is a postage stamp on a
   2.5K screen; the clamp keeps it at the old size in a small window. */
.dialog--textarea {
  --textarea-dialog-width: clamp(560px, 55vw, 1100px);
  width: fit-content;
  min-width: min(var(--textarea-dialog-width), 100%);
  max-width: 100%;
}

/* Only the textarea gets to widen the dialog past its default. Without this a
   long tab title in the header would stretch it on its own. */
.dialog--textarea .dialog__header {
  max-width: var(--textarea-dialog-width);
}

/* `height`, not `min-height`: the resize handle writes an inline height, which
   overrides this but loses to a min-height — the box has to stay shrinkable. */
.dialog--textarea textarea {
  height: min(45vh, 500px);
}

.textarea--nowrap {
  white-space: pre;
  overflow-x: auto;
}
</style>
