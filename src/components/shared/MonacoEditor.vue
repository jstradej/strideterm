<template>
  <div ref="container" class="monaco-editor-container" />
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import * as monaco from "monaco-editor";

// Configure workers for Vite — Monaco needs this for syntax validation.
// Use inline data-uri workers to avoid separate worker file bundling issues.
self.MonacoEnvironment = self.MonacoEnvironment || {
  getWorker(_moduleId, _label) {
    // For simple use (markdown, json, plaintext) we don't need language workers.
    // Return a minimal no-op worker via blob URL.
    const blob = new Blob(["self.onmessage = function() {}"], { type: "application/javascript" });
    return new Worker(URL.createObjectURL(blob));
  },
};

const props = defineProps({
  modelValue: { type: String, default: "" },
  language: { type: String, default: "markdown" },
  readOnly: { type: Boolean, default: false },
});

const emit = defineEmits(["update:modelValue", "save"]);

const container = ref(null);
let editor = null;

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
    automaticLayout: true,
    padding: { top: 8 },
    renderLineHighlight: "gutter",
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: {
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
    },
  });

  // Emit changes
  editor.onDidChangeModelContent(() => {
    emit("update:modelValue", editor.getValue());
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
  if (editor) {
    editor.dispose();
    editor = null;
  }
});
</script>

<style scoped>
.monaco-editor-container {
  width: 100%;
  height: 100%;
  min-height: 200px;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  overflow: hidden;
}
</style>
