<template>
  <Teleport to="body">
    <div v-if="visible" ref="dropdownRef" class="tab-picker-dropdown" :style="dropdownStyle" @click.stop>
      <div v-if="showCwdPicker" class="tab-picker-dropdown__cwd-row">
        <span class="tab-picker-dropdown__cwd-label">Working directory</span>
        <select v-model="selectedCwd" class="tab-picker-dropdown__cwd-select">
          <option value="">Workspace default</option>
          <option v-for="root in gitRoots" :key="root" :value="root">{{ formatRootLabel(root) }}</option>
        </select>
      </div>
      <button
        v-for="tmpl in templates"
        :key="tmpl.title"
        type="button"
        class="tab-picker-dropdown__item"
        @click="addTemplateTab(tmpl)"
      >
        {{ tmpl.icon || "" }} {{ tmpl.title || "Shell" }}
      </button>
      <button type="button" class="tab-picker-dropdown__item" @click="addCustomTab">+ Custom</button>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { useAppStore } from "../../stores/app.js";

const FALLBACK_TEMPLATES = [
  { title: "Shell", command: "", icon: "\u{1F4BB}" },
  { title: "PowerShell", command: "powershell", icon: "\u{1F537}", platforms: ["win32"] },
  { title: "Bash", command: "bash", icon: "\u{1F41A}", platforms: ["darwin", "linux"] },
  { title: "Zsh", command: "zsh", icon: "\u{1F41A}", platforms: ["darwin", "linux"] },
  { title: "Claude Code", command: "claude", icon: "\u{1F916}" },
  { title: "Browser", command: "https://", icon: "\u{1F310}" },
  { title: "Files", command: "__files__", icon: "\u{1F4C2}" },
];

const props = defineProps({
  anchorRect: { type: Object, default: null },
});

const emit = defineEmits(["close"]);

const store = useAppStore();
const dropdownRef = ref(null);
const visible = computed(() => Boolean(props.anchorRect));
const selectedCwd = ref("");

const templates = computed(() => {
  const tpls = store.payload?.appState?.tabTemplates;
  const list = Array.isArray(tpls) && tpls.length ? tpls : FALLBACK_TEMPLATES;
  const platform = store.payload?.meta?.platform || "";
  return list.filter((tmpl) => !Array.isArray(tmpl.platforms) || !platform || tmpl.platforms.includes(platform));
});

const activeWorkspace = computed(() => {
  const ws = store.payload?.workspace;
  return ws?.workspace || ws?.project || null;
});

const gitRoots = computed(() => {
  const ws = activeWorkspace.value;
  return Array.isArray(ws?.gitRoots) && ws.gitRoots.length >= 2 ? ws.gitRoots : [];
});

const showCwdPicker = computed(() => gitRoots.value.length >= 2);

function formatRootLabel(rootPath) {
  if (!rootPath) return "";
  return rootPath.split(/[\\/]/).filter(Boolean).at(-1) || rootPath;
}

const dropdownStyle = computed(() => {
  if (!props.anchorRect) return {};
  const anchor = props.anchorRect;
  return {
    position: "fixed",
    top: `${anchor.bottom + 4}px`,
    right: `${window.innerWidth - anchor.right}px`,
    zIndex: 9999,
  };
});

function addTemplateTab(tmpl) {
  emit("close");
  const title = `${tmpl.icon || ""} ${tmpl.title || "Shell"}`.trim();
  store.openNewTabDialog(selectedCwd.value, title, tmpl.command || "");
}

function addCustomTab() {
  emit("close");
  store.openNewTabDialog(selectedCwd.value);
}

function onDocumentClick(e) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target)) {
    emit("close");
  }
}

watch(visible, (isVisible) => {
  document.removeEventListener("click", onDocumentClick);
  if (isVisible) {
    selectedCwd.value = "";
    requestAnimationFrame(() => document.addEventListener("click", onDocumentClick));
  }
});

onBeforeUnmount(() => document.removeEventListener("click", onDocumentClick));
</script>
