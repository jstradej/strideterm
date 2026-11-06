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
import { ref, computed, watch, type CSSProperties } from "vue";
import { useAppStore } from "../../stores/app.js";
import CustomSelect from "../common/CustomSelect.vue";
import { useDismissable } from "../../composables/useDismissable.js";
import { templatesForPlatform, type TabTemplate } from "../../app/tab-templates.js";

interface AnchorRect {
  bottom: number;
  right: number;
}

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

const templates = computed(() =>
  templatesForPlatform(store.payload?.appState?.tabTemplates, store.payload?.meta?.platform || ""),
);

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

useDismissable(visible, dropdownRef, { onDismiss: () => emit("close"), deferAttach: true });

watch(visible, (isVisible) => {
  if (isVisible) selectedCwd.value = "";
});
</script>
