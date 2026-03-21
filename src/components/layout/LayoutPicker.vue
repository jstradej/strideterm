<template>
  <Teleport to="body">
    <div
      v-if="store.layoutPickerAnchor"
      ref="pickerRef"
      class="layout-picker"
      :style="pickerStyle"
      @click.stop
    >
      <div class="layout-picker__grid">
        <button
          v-for="[key, layout] in nonSoloLayouts"
          :key="key"
          type="button"
          :class="['layout-picker__item', currentLayout === key && 'layout-picker__item--active']"
          :title="layout.label"
          @click="pickLayout(key)"
        >
          <svg class="layout-thumb" viewBox="0 0 40 30">
            <template v-if="key === 'cols'">
              <rect x="1" y="1" width="18" height="28" rx="1.5" fill="currentColor" opacity="0.5"></rect>
              <rect x="21" y="1" width="18" height="28" rx="1.5" fill="currentColor" opacity="0.3"></rect>
            </template>
            <template v-else-if="key === 'rows'">
              <rect x="1" y="1" width="38" height="13" rx="1.5" fill="currentColor" opacity="0.5"></rect>
              <rect x="1" y="16" width="38" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
            </template>
            <template v-else-if="key === 'top-split'">
              <rect x="1" y="1" width="38" height="13" rx="1.5" fill="currentColor" opacity="0.5"></rect>
              <rect x="1" y="16" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
              <rect x="21" y="16" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
            </template>
            <template v-else-if="key === 'left-split'">
              <rect x="1" y="1" width="18" height="28" rx="1.5" fill="currentColor" opacity="0.5"></rect>
              <rect x="21" y="1" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
              <rect x="21" y="16" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
            </template>
            <template v-else-if="key === 'grid'">
              <rect x="1" y="1" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.5"></rect>
              <rect x="21" y="1" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
              <rect x="1" y="16" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
              <rect x="21" y="16" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
            </template>
            <template v-else>
              <rect x="1" y="1" width="38" height="28" rx="1.5" fill="currentColor" opacity="0.5"></rect>
            </template>
          </svg>
          <span>{{ layout.label }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useAppStore } from "../../stores/app.js";

const LAYOUTS = {
  solo: { slots: 1, label: "Solo" },
  cols: { slots: 2, label: "Columns" },
  rows: { slots: 2, label: "Rows" },
  "top-split": { slots: 3, label: "Top split" },
  "left-split": { slots: 3, label: "Left split" },
  grid: { slots: 4, label: "Grid" },
};

const store = useAppStore();
const pickerRef = ref(null);

const nonSoloLayouts = computed(() =>
  Object.entries(LAYOUTS).filter(([key]) => key !== "solo"),
);

const currentLayout = computed(() => store.splitGroup?.layout || "solo");

const pickerStyle = ref({ position: "fixed", top: "0px", right: "0px", zIndex: 9999 });

watch(() => store.layoutPickerAnchor, async (anchor) => {
  if (!anchor) return;
  // anchorRect is a serialized DOMRect { top, bottom, left, right, width, height }
  await nextTick();
  if (!pickerRef.value) return;
  const pickerRect = pickerRef.value.getBoundingClientRect();
  let top = anchor.bottom + 4;
  let right = window.innerWidth - anchor.right;
  if (pickerRect.left < 0) {
    pickerStyle.value = { position: "fixed", top: `${top}px`, left: "4px", zIndex: 9999 };
  } else if (pickerRect.bottom > window.innerHeight) {
    top = anchor.top - pickerRect.height - 4;
    pickerStyle.value = { position: "fixed", top: `${top}px`, right: `${right}px`, zIndex: 9999 };
  } else {
    pickerStyle.value = { position: "fixed", top: `${top}px`, right: `${right}px`, zIndex: 9999 };
  }
});

function pickLayout(key) {
  store.pickLayout(key);
  store.hideLayoutPicker();
}

function onDocumentClick(e) {
  // Ignore clicks on the Split button itself (it triggers showLayoutPicker)
  if (e.target.closest("[data-role='tab-actions']")) return;
  if (pickerRef.value && !pickerRef.value.contains(e.target)) {
    store.hideLayoutPicker();
  }
}

function onKeydown(e) {
  if (e.key === "Escape") store.hideLayoutPicker();
}

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>
