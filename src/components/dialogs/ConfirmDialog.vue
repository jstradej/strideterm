<template>
  <div class="dialog confirm-dialog">
    <div class="dialog__header">
      <div>
        <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
        <h2>
          <component :is="seg.code ? 'code' : 'span'" v-for="(seg, i) in titleSegments" :key="i">{{
            seg.text
          }}</component>
        </h2>
      </div>
    </div>
    <p class="confirm-dialog__message">
      <component :is="seg.code ? 'code' : 'span'" v-for="(seg, i) in messageSegments" :key="i">{{
        seg.text
      }}</component>
    </p>
    <footer class="dialog__footer confirm-dialog__footer">
      <button type="button" class="button button--ghost" @click="emit('cancel')">
        {{ cancelLabel }}
      </button>
      <button type="button" :class="['button', danger && 'button--danger']" @click="emit('confirm')">
        {{ confirmLabel }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    message: string;
    eyebrow?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }>(),
  {
    eyebrow: "",
    confirmLabel: "OK",
    cancelLabel: "Cancel",
    danger: false,
  },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

// Split on backtick `code` spans: odd segments render as monospace <code>
// chips (e.g. branch names), the rest as plain text. Rendered as text nodes —
// no v-html — so any ref name is escaped and safe. Newlines in plain segments
// survive via the message container's `white-space: pre-wrap`.
function toSegments(value: string): { text: string; code: boolean }[] {
  return String(value || "")
    .split("`")
    .map((text, index) => ({ text, code: index % 2 === 1 }))
    .filter((seg) => seg.text.length > 0);
}

const titleSegments = computed(() => toSegments(props.title));
const messageSegments = computed(() => toSegments(props.message));
</script>

<style scoped>
.confirm-dialog {
  width: min(460px, 100%);
}

.confirm-dialog__message {
  margin-top: 14px;
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
}

/* Branch/ref names wrapped in backticks render as subtle monospace chips so
   they stand out from the surrounding prose and don't break mid-name. */
.confirm-dialog code {
  font-family: var(--mono, "Cascadia Mono", "JetBrains Mono", "Consolas", monospace);
  font-size: 0.9em;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 4px;
  padding: 0 5px;
  white-space: nowrap;
}

.confirm-dialog h2 {
  /* Allow long refs in the heading to wrap rather than overflow the dialog. */
  overflow-wrap: anywhere;
}

.confirm-dialog h2 code {
  font-size: 0.78em;
  font-weight: 600;
}

.confirm-dialog__footer {
  margin-top: 18px;
  justify-content: flex-end;
}
</style>
