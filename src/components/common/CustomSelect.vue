<template>
  <div ref="rootRef" :class="['custom-select', { 'custom-select--open': open, 'custom-select--disabled': disabled }]">
    <button
      ref="buttonRef"
      type="button"
      :class="['custom-select__button', buttonClass]"
      :disabled="disabled"
      :aria-expanded="open ? 'true' : 'false'"
      aria-haspopup="listbox"
      @click="toggle"
      @keydown="onButtonKeydown"
    >
      <span class="custom-select__value" :class="{ 'custom-select__value--placeholder': !selectedLabel }">
        {{ selectedLabel || placeholder }}
      </span>
      <span class="custom-select__arrow" aria-hidden="true">▾</span>
    </button>
    <Teleport to="body">
      <ul
        v-if="open"
        ref="listRef"
        class="custom-select__list"
        role="listbox"
        tabindex="-1"
        :style="listStyle"
        @keydown="onListKeydown"
      >
        <li
          v-for="(opt, idx) in options"
          :key="opt.value"
          :class="[
            'custom-select__option',
            {
              'custom-select__option--selected': opt.value === modelValue,
              'custom-select__option--active': idx === activeIndex,
              'custom-select__option--disabled': opt.disabled,
            },
          ]"
          role="option"
          :aria-selected="opt.value === modelValue ? 'true' : 'false'"
          :aria-disabled="opt.disabled ? 'true' : 'false'"
          @mousedown.prevent="onOptionMousedown(opt)"
          @mouseenter="onOptionMouseenter(idx, opt)"
        >
          {{ opt.label }}
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from "vue";

interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

interface Props {
  modelValue?: string | number | null;
  options?: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  buttonClass?: string | string[] | Record<string, boolean>;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: "",
  options: () => [],
  placeholder: "Select…",
  disabled: false,
  buttonClass: "",
});

const emit = defineEmits<{
  "update:modelValue": [value: string | number];
  change: [value: string | number];
}>();

const open = ref(false);
const activeIndex = ref(-1);
const rootRef = ref<HTMLElement | null>(null);
const buttonRef = ref<HTMLButtonElement | null>(null);
const listRef = ref<HTMLUListElement | null>(null);
const listStyle = ref<Record<string, string>>({});

const MAX_LIST_HEIGHT = 260;

function updateListPosition() {
  if (!buttonRef.value) return;
  const rect = buttonRef.value.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const spaceBelow = vh - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  const flipAbove = spaceBelow < Math.min(MAX_LIST_HEIGHT, 160) && spaceAbove > spaceBelow;
  const maxHeight = Math.max(120, Math.min(MAX_LIST_HEIGHT, flipAbove ? spaceAbove : spaceBelow));
  listStyle.value = {
    position: "fixed",
    left: `${rect.left}px`,
    minWidth: `${rect.width}px`,
    maxWidth: `${Math.max(160, vw - rect.left - 8)}px`,
    width: "max-content",
    maxHeight: `${maxHeight}px`,
    ...(flipAbove ? { bottom: `${vh - rect.top + 3}px` } : { top: `${rect.bottom + 3}px` }),
  };
}

const selectedLabel = computed(() => {
  const opt = props.options.find((o) => o.value === props.modelValue);
  return opt ? opt.label : "";
});

function firstEnabledIndex(from = 0, dir = 1) {
  const n = props.options.length;
  for (let i = 0; i < n; i++) {
    const idx = (from + i * dir + n) % n;
    if (!props.options[idx]?.disabled) return idx;
  }
  return -1;
}

function openList() {
  if (props.disabled || open.value) return;
  updateListPosition();
  open.value = true;
  const selIdx = props.options.findIndex((o) => o.value === props.modelValue);
  activeIndex.value = selIdx >= 0 && !props.options[selIdx].disabled ? selIdx : firstEnabledIndex(0, 1);
  nextTick(() => scrollActiveIntoView());
}

function closeList() {
  if (!open.value) return;
  open.value = false;
  activeIndex.value = -1;
}

function toggle() {
  if (open.value) closeList();
  else openList();
}

function select(value: string | number) {
  emit("update:modelValue", value);
  emit("change", value);
  closeList();
  buttonRef.value?.focus();
}

function moveActive(dir: number) {
  if (props.options.length === 0) return;
  const start = activeIndex.value < 0 ? (dir > 0 ? -1 : 0) : activeIndex.value;
  activeIndex.value = firstEnabledIndex(start + dir, dir);
  scrollActiveIntoView();
}

function scrollActiveIntoView() {
  if (!listRef.value || activeIndex.value < 0) return;
  const el = listRef.value.children[activeIndex.value];
  if (el?.scrollIntoView) el.scrollIntoView({ block: "nearest" });
}

function onButtonKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!open.value) openList();
    else moveActive(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (!open.value) openList();
    else if (activeIndex.value >= 0) {
      const opt = props.options[activeIndex.value];
      if (opt && !opt.disabled) select(opt.value);
    }
  } else if (e.key === "Escape") {
    if (open.value) {
      e.preventDefault();
      // Keep ESC from bubbling to the dialog's backdrop-close listener —
      // first ESC should only close this dropdown.
      e.stopPropagation();
      closeList();
    }
  } else if (e.key === "Tab") {
    closeList();
  }
}

function onListKeydown(e: KeyboardEvent) {
  onButtonKeydown(e);
}

function onOptionMousedown(opt: SelectOption) {
  if (opt.disabled) return;
  select(opt.value);
}

function onOptionMouseenter(idx: number, opt: SelectOption) {
  if (opt.disabled) return;
  activeIndex.value = idx;
}

function onDocumentMousedown(e: MouseEvent) {
  if (!open.value) return;
  const inRoot = rootRef.value && rootRef.value.contains(e.target as Node);
  const inList = listRef.value && listRef.value.contains(e.target as Node);
  if (!inRoot && !inList) closeList();
}

function onWindowBlur() {
  closeList();
}

watch(
  () => props.options,
  () => {
    if (open.value) {
      const n = props.options.length;
      if (activeIndex.value >= n) activeIndex.value = firstEnabledIndex(0, 1);
    }
  },
  { deep: false },
);

function onReposition() {
  if (open.value) updateListPosition();
}

onMounted(() => {
  document.addEventListener("mousedown", onDocumentMousedown);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("resize", onReposition);
  window.addEventListener("scroll", onReposition, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocumentMousedown);
  window.removeEventListener("blur", onWindowBlur);
  window.removeEventListener("resize", onReposition);
  window.removeEventListener("scroll", onReposition, true);
});

defineExpose({ focus: () => buttonRef.value?.focus() });
</script>

<style scoped>
.custom-select {
  position: relative;
  width: 100%;
}
.custom-select__button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: rgba(var(--tint), 0.04);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  line-height: 1.2;
  cursor: pointer;
  text-align: left;
}
.custom-select__button:hover:not(:disabled) {
  background: rgba(var(--tint), 0.08);
}
.custom-select__button:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.custom-select--disabled .custom-select__button,
.custom-select__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.custom-select__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.custom-select__value--placeholder {
  color: var(--muted);
}
.custom-select__arrow {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 10px;
}
.custom-select__list {
  position: absolute;
  top: calc(100% + 3px);
  left: 0;
  right: 0;
  z-index: 10050;
  max-height: 260px;
  overflow-y: auto;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  background: var(--panel-elevated);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  font-size: 13px;
}
.custom-select__option {
  padding: 6px 10px;
  cursor: pointer;
  color: var(--text);
  white-space: nowrap;
}
.custom-select__option--active:not(.custom-select__option--selected) {
  background: rgba(var(--tint), 0.12);
}
.custom-select__option--selected {
  background: var(--accent);
  color: #000;
  font-weight: 600;
}
.custom-select__option--selected.custom-select__option--active {
  filter: brightness(0.92);
}
.custom-select__option--disabled {
  opacity: 0.5;
  cursor: not-allowed;
  color: var(--muted);
}
</style>
