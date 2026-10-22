<template>
  <div ref="rootRef" :class="['history-range-picker', { 'history-range-picker--disabled': disabled }]">
    <button
      ref="buttonRef"
      type="button"
      class="history-range-picker__button"
      aria-label="History reference"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      :data-value="modelValue"
      :disabled="disabled"
      @click="toggle"
      @keydown="onButtonKeydown"
    >
      <span class="history-range-picker__value">{{ buttonText }}</span>
      <span class="history-range-picker__arrow" aria-hidden="true">▾</span>
    </button>
    <Teleport to="body">
      <div v-if="open" ref="listRef" class="history-range-picker__popover" :style="popoverStyle">
        <input
          ref="searchRef"
          v-model="query"
          type="search"
          class="history-range-picker__search"
          placeholder="Branches and tags…"
          aria-label="Search history references"
          @keydown="onSearchKeydown"
        />
        <ul class="history-range-picker__list" role="listbox" tabindex="-1">
          <template
            v-for="(item, idx) in visibleItems"
            :key="`${idx}:${item.kind === 'option' ? item.value : item.label}`"
          >
            <li v-if="item.kind === 'section'" class="history-range-picker__section" role="presentation">
              {{ item.label }}
            </li>
            <li
              v-else
              role="option"
              :aria-selected="item.value === modelValue ? 'true' : 'false'"
              :class="[
                'history-range-picker__row',
                {
                  'history-range-picker__row--active': activeIndex === idx,
                  'history-range-picker__row--selected': item.value === modelValue,
                },
              ]"
              @mousedown.prevent
              @click="select(item.value)"
              @mouseenter="activeIndex = idx"
            >
              <span class="history-range-picker__label" :title="item.label">{{ item.label }}</span>
            </li>
          </template>
        </ul>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDismissable } from "../../../composables/useDismissable.js";

type HistoryRangeItem = { kind: "section"; label: string } | { kind: "option"; value: string; label: string };

const props = withDefaults(
  defineProps<{ modelValue: string; items: HistoryRangeItem[]; disabled?: boolean; searchQuery?: string }>(),
  { disabled: false, searchQuery: "" },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:searchQuery": [value: string];
  change: [value: string];
}>();

const open = ref(false);
const activeIndex = ref(-1);
const rootRef = ref<HTMLElement | null>(null);
const buttonRef = ref<HTMLButtonElement | null>(null);
const listRef = ref<HTMLDivElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);
const query = ref(props.searchQuery);
const popoverStyle = ref<Record<string, string>>({});

const buttonText = computed(() => {
  const match = props.items.find((item) => item.kind === "option" && item.value === props.modelValue);
  return match ? match.label : props.modelValue;
});

const PINNED_VALUES = ["__ALL__", "HEAD"];

const visibleItems = computed<HistoryRangeItem[]>(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return props.items;
  const out: HistoryRangeItem[] = [];
  let pendingSection: HistoryRangeItem | null = null;
  for (const item of props.items) {
    if (item.kind === "section") {
      pendingSection = item;
      continue;
    }
    const matches =
      PINNED_VALUES.includes(item.value) ||
      item.value.toLowerCase().includes(needle) ||
      item.label.toLowerCase().includes(needle);
    if (!matches) continue;
    if (pendingSection) {
      out.push(pendingSection);
      pendingSection = null;
    }
    out.push(item);
  }
  return out;
});

watch(
  () => props.searchQuery,
  (value) => {
    if (value !== query.value) query.value = value;
  },
);

watch(query, (value) => {
  emit("update:searchQuery", value);
  const items = visibleItems.value;
  const first = value.trim()
    ? items.findIndex((item) => item.kind === "option" && !PINNED_VALUES.includes(item.value))
    : -1;
  activeIndex.value = first >= 0 ? first : items.findIndex((item) => item.kind === "option");
});

function select(value: string): void {
  emit("update:modelValue", value);
  emit("change", value);
  closePopover();
  buttonRef.value?.focus();
}

const MAX_LIST_HEIGHT = 320;

function updatePosition(): void {
  if (!buttonRef.value) return;
  const rect = buttonRef.value.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const spaceBelow = vh - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  const flipAbove = spaceBelow < Math.min(MAX_LIST_HEIGHT, 200) && spaceAbove > spaceBelow;
  const maxHeight = Math.max(200, Math.min(MAX_LIST_HEIGHT, flipAbove ? spaceAbove : spaceBelow));
  popoverStyle.value = {
    position: "fixed",
    left: `${rect.left}px`,
    minWidth: `${Math.max(220, rect.width)}px`,
    maxWidth: `${Math.max(220, vw - rect.left - 8)}px`,
    width: "max-content",
    maxHeight: `${maxHeight}px`,
    ...(flipAbove ? { bottom: `${vh - rect.top + 3}px` } : { top: `${rect.bottom + 3}px` }),
  };
}

function scrollActiveIntoView(): void {
  const el = listRef.value?.querySelector(".history-range-picker__row--active") as HTMLElement | null;
  if (el?.scrollIntoView) el.scrollIntoView({ block: "nearest" });
}

function openPopover(): void {
  if (props.disabled || open.value) return;
  updatePosition();
  open.value = true;
  activeIndex.value = visibleItems.value.findIndex((item) => item.kind === "option" && item.value === props.modelValue);
  nextTick(() => {
    searchRef.value?.focus();
    scrollActiveIntoView();
  });
}

function closePopover(): void {
  if (!open.value) return;
  open.value = false;
  activeIndex.value = -1;
  query.value = "";
}

function toggle(): void {
  if (open.value) closePopover();
  else openPopover();
}

function moveActive(dir: number): void {
  const list = visibleItems.value;
  const total = list.length;
  let next = activeIndex.value + dir;
  while (next >= 0 && next < total && list[next].kind === "section") next += dir;
  if (next < 0 || next >= total) return;
  activeIndex.value = next;
  nextTick(scrollActiveIntoView);
}

function commitActive(): void {
  const item = visibleItems.value[activeIndex.value];
  if (item?.kind === "option") select(item.value);
}

function onButtonKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!open.value) openPopover();
    else moveActive(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (!open.value) openPopover();
    else commitActive();
  } else if (e.key === "Escape") {
    if (open.value) {
      e.preventDefault();
      e.stopPropagation();
      closePopover();
      buttonRef.value?.focus();
    }
  } else if (e.key === "Tab") {
    closePopover();
  }
}

function onSearchKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    moveActive(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    commitActive();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closePopover();
    buttonRef.value?.focus();
  } else if (e.key === "Tab") {
    closePopover();
  }
}

useDismissable(open, [rootRef, listRef], { onDismiss: closePopover, eventName: "mousedown" });

function onReposition(): void {
  if (open.value) updatePosition();
}

onMounted(() => {
  window.addEventListener("blur", closePopover);
  window.addEventListener("resize", onReposition);
  window.addEventListener("scroll", onReposition, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("blur", closePopover);
  window.removeEventListener("resize", onReposition);
  window.removeEventListener("scroll", onReposition, true);
});
</script>

<style scoped>
.history-range-picker {
  position: relative;
  display: inline-block;
  min-width: 220px;
  max-width: 34vw;
}
.history-range-picker__button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
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
.history-range-picker__button:hover:not(:disabled) {
  background: rgba(var(--tint), 0.08);
}
.history-range-picker__button:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.history-range-picker__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.history-range-picker__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: inherit;
  text-transform: none;
  letter-spacing: normal;
  color: inherit;
}
.history-range-picker__arrow {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 10px;
  text-transform: none;
  letter-spacing: normal;
}
.history-range-picker__popover {
  z-index: 10050;
  display: flex;
  flex-direction: column;
  background: var(--panel-elevated);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  font-size: 13px;
  overflow: hidden;
}
.history-range-picker__search {
  flex-shrink: 0;
  padding: 6px 10px;
  background: rgba(var(--tint), 0.05);
  border: 0;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.history-range-picker__search:focus {
  background: rgba(var(--tint), 0.08);
}
.history-range-picker__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 4px 0;
  list-style: none;
}
.history-range-picker__row {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.history-range-picker__row--active:not(.history-range-picker__row--selected) {
  background: rgba(var(--tint), 0.12);
}
.history-range-picker__row--selected {
  background: var(--accent);
  color: #000;
  font-weight: 600;
}
.history-range-picker__row--selected.history-range-picker__row--active {
  filter: brightness(0.92);
}
.history-range-picker__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-range-picker__section {
  padding: 6px 8px;
  border-top: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.025);
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  font-weight: 700;
}
.history-range-picker__section:first-child {
  border-top: none;
}
</style>
