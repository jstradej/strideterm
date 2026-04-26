<template>
  <Teleport to="body">
    <div v-if="visible" ref="dropdownRef" class="tab-picker-dropdown" :style="dropdownStyle" @click.stop>
      <div v-if="showCwdPicker" class="tab-picker-dropdown__cwd-row">
        <span class="tab-picker-dropdown__cwd-label">Working directory</span>
        <CustomSelect v-model="selectedCwd" class="tab-picker-dropdown__cwd-select" :options="cwdOptions" />
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
      <button type="button" class="tab-picker-dropdown__item" @click="addSshTab">🔐 SSH…</button>
      <button type="button" class="tab-picker-dropdown__item" @click="addCustomTab">+ Custom</button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, type CSSProperties } from "vue";
import { useAppStore } from "../../stores/app.js";
import CustomSelect from "../common/CustomSelect.vue";

interface TabTemplate {
  title?: string;
  command?: string;
  icon?: string;
  platforms?: string[];
}

interface AnchorRect {
  bottom: number;
  right: number;
}

const FALLBACK_TEMPLATES: TabTemplate[] = [
  { title: "Shell", command: "", icon: "\u{1F4BB}" },
  { title: "PowerShell", command: "powershell", icon: "\u{1F537}", platforms: ["win32"] },
  { title: "Bash", command: "bash", icon: "\u{1F41A}", platforms: ["darwin", "linux"] },
  { title: "Zsh", command: "zsh", icon: "\u{1F41A}", platforms: ["darwin", "linux"] },
  { title: "Claude Code", command: "claude", icon: "\u{1F916}" },
  { title: "Browser", command: "https://", icon: "\u{1F310}" },
  { title: "Files", command: "__files__", icon: "\u{1F4C2}" },
];

const props = withDefaults(
  defineProps<{
    anchorRect?: AnchorRect | null;
  }>(),
  {
    anchorRect: null,
  },
);

const emit = defineEmits<{
  (e: "close"): void;
}>();

const store = useAppStore();
const dropdownRef = ref<HTMLElement | null>(null);
const visible = computed(() => Boolean(props.anchorRect));
const selectedCwd = ref("");

const templates = computed(() => {
  const tpls = store.payload?.appState?.tabTemplates;
  const list = Array.isArray(tpls) && tpls.length ? tpls : FALLBACK_TEMPLATES;
  const platform = store.payload?.meta?.platform || "";
  return list.filter((tmpl) => !Array.isArray(tmpl.platforms) || !platform || tmpl.platforms.includes(platform));
});

const activeWorkspace = computed(() => {
  return store.payload?.workspace || null;
});

const gitRoots = computed(() => {
  const ws = activeWorkspace.value;
  return Array.isArray(ws?.gitRoots) && ws.gitRoots.length >= 2 ? ws.gitRoots : [];
});

const showCwdPicker = computed(() => gitRoots.value.length >= 2);

const cwdOptions = computed(() => [
  { value: "", label: "Workspace default" },
  ...gitRoots.value.map((root: string) => ({ value: root, label: formatRootLabel(root) })),
]);

function formatRootLabel(rootPath: string): string {
  if (!rootPath) return "";
  return rootPath.split(/[\\/]/).filter(Boolean).at(-1) || rootPath;
}

const dropdownStyle = computed((): CSSProperties => {
  if (!props.anchorRect) return {};
  const anchor = props.anchorRect;
  return {
    position: "fixed",
    top: `${anchor.bottom + 4}px`,
    right: `${window.innerWidth - anchor.right}px`,
    zIndex: 9999,
  };
});

function addTemplateTab(tmpl: TabTemplate): void {
  emit("close");
  const title = `${tmpl.icon || ""} ${tmpl.title || "Shell"}`.trim();
  store.openNewTabDialog(selectedCwd.value, title, tmpl.command || "");
}

function addCustomTab() {
  emit("close");
  store.openNewTabDialog(selectedCwd.value);
}

function addSshTab() {
  emit("close");
  store.openNewTabDialog(selectedCwd.value, "", "", { tabType: "ssh" });
}

function onDocumentClick(e: MouseEvent): void {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
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
