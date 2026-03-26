<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="dropdownRef"
      class="tab-picker-dropdown"
      :style="dropdownStyle"
      @click.stop
    >
      <button
        v-for="tmpl in templates"
        :key="tmpl.title"
        type="button"
        class="tab-picker-dropdown__item"
        @click="addTemplateTab(tmpl)"
      >{{ tmpl.icon || '' }} {{ tmpl.title || 'Shell' }}</button>
      <button type="button" class="tab-picker-dropdown__item" @click="addCustomTab">+ Custom</button>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useAppStore } from "../../stores/app.js";

const FALLBACK_TEMPLATES = [
  { title: "Shell", command: "", icon: "\u{1F4BB}" },
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

const templates = computed(() => {
  const tpls = store.payload?.appState?.tabTemplates;
  return Array.isArray(tpls) && tpls.length ? tpls : FALLBACK_TEMPLATES;
});

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

async function addTemplateTab(tmpl) {
  emit("close");
  const title = `${tmpl.icon || ""} ${tmpl.title || "Shell"}`.trim();
  await store.quickAddTemplateTab(tmpl.command || "", title);
}

async function addCustomTab() {
  emit("close");
  await store.quickAddTab();
}

function onDocumentClick(e) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target)) {
    emit("close");
  }
}

onMounted(() => setTimeout(() => document.addEventListener("click", onDocumentClick), 0));
onBeforeUnmount(() => document.removeEventListener("click", onDocumentClick));
</script>
