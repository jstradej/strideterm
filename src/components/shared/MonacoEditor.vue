<template>
  <div ref="container" class="monaco-editor-container" />
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import "../../app/monaco-setup.js";
import * as monaco from "monaco-editor";

interface Props {
  modelValue?: string;
  language?: string;
  readOnly?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: "",
  language: "markdown",
  readOnly: false,
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
  save: [];
}>();

const container = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  if (!container.value) return;

  editor = monaco.editor.create(container.value, {
    value: props.modelValue,
    language: props.language,
    theme: "vs-dark",
    readOnly: props.readOnly,
    minimap: { enabled: false },
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    wordWrap: "on",
    wrappingIndent: "indent",
    fontSize: 13,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
    tabSize: 2,
    automaticLayout: false,
    padding: { top: 8 },
    renderLineHighlight: "gutter",
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: {
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
    },
  });

  // Observe the *parent* of the container (.td__editor-wrap or similar) and
  // force the container + Monaco to that size. Monaco's built-in
  // automaticLayout observes the container itself, which can get stuck at
  // min-height when wrapped in ambiguous flex/grid chains. Driving from the
  // parent's size avoids the chicken-and-egg between container height and
  // Monaco's measured viewport.
  const parent = container.value.parentElement;
  if (parent) {
    const applySize = () => {
      const rect = parent.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w > 0 && h > 0) {
        container.value!.style.width = `${w}px`;
        container.value!.style.height = `${h}px`;
        editor?.layout({ width: w, height: h });
      }
    };
    resizeObserver = new ResizeObserver(applySize);
    resizeObserver.observe(parent);
    applySize();
  }

  // Emit changes
  editor.onDidChangeModelContent(() => {
    emit("update:modelValue", editor!.getValue());
  });

  // Ctrl+S to save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    emit("save");
  });
});

// Sync external value changes into editor (e.g. file switch, revert)
watch(
  () => props.modelValue,
  (newVal) => {
    if (editor && editor.getValue() !== newVal) {
      editor.setValue(newVal || "");
    }
  },
);

watch(
  () => props.language,
  (newLang) => {
    if (editor) {
      const model = editor.getModel();
      if (model) {
        monaco.editor.setModelLanguage(model, newLang);
      }
    }
  },
);

watch(
  () => props.readOnly,
  (val) => {
    if (editor) {
      editor.updateOptions({ readOnly: val });
    }
  },
);

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (editor) {
    editor.dispose();
    editor = null;
  }
});
</script>

<style scoped>
/* Size is driven entirely from JS (ResizeObserver on parent). Omitting
   intrinsic sizing here prevents Monaco's scoped min-height from winning
   the cascade against our inline pixel dimensions. */
.monaco-editor-container {
  display: block;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  overflow: hidden;
}
</style>
