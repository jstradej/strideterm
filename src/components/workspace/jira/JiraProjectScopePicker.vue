<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Spinner from "../../common/Spinner.vue";
import { useDismissable } from "../../../composables/useDismissable.js";

type Project = { id: string | number; key: string; name: string };
const MAX_LISTED_PROJECTS = 40;
const props = defineProps<{
  modelValue: string[] | null;
  projects: Project[];
  defaultProjectKeys?: string[];
  /** The project catalog is still being fetched. The controls stay usable. */
  loading?: boolean;
  truncated?: boolean;
  error?: string;
  /** The last save of the scope failed and was rolled back; shown on the summary, which stays visible when closed. */
  saveError?: string;
  /** The picker cannot be changed right now. */
  disabled?: boolean;
  /** Older spelling of `disabled`. */
  busy?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string[] | null]; open: [] }>();
const isDisabled = computed(() => !!props.disabled || !!props.busy);
const lockedTitle = "The project scope cannot be changed right now.";
const query = ref("");
const detailsRef = ref<HTMLDetailsElement | null>(null);
const summaryRef = ref<HTMLElement | null>(null);
const isOpen = ref(false);
const mode = ref<"defaults" | "all" | "custom">("defaults");
const draftKeys = ref<string[]>([]);
const pinnedKeys = ref<string[]>([]);
const popoverStyle = ref<Record<string, string>>({});
const selectedKeys = computed(() => (mode.value === "defaults" ? props.defaultProjectKeys || [] : draftKeys.value));
function isFixedPickerSheet() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 600px), (max-height: 480px), (max-width: 820px) and (any-pointer: coarse)").matches
  );
}
function pickerFocusableTargets(content: HTMLElement) {
  return [
    ...content.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element instanceof HTMLElement);
}
const allMatches = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  const matches = props.projects.filter(
    (project) => !search || `${project.key} ${project.name}`.toLocaleLowerCase().includes(search),
  );
  const pinned = new Set(pinnedKeys.value);
  if (!pinned.size) return matches;
  return [
    ...matches.filter((project) => pinned.has(project.key)),
    ...matches.filter((project) => !pinned.has(project.key)),
  ];
});
const matchingProjects = computed(() => allMatches.value.slice(0, MAX_LISTED_PROJECTS));
const selectionLabel = computed(() => {
  const keys = props.modelValue === null ? props.defaultProjectKeys || [] : props.modelValue;
  if (props.modelValue === null)
    return keys.length
      ? `Default · ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ` +${keys.length - 3}` : ""}`
      : "All projects";
  if (!keys.length) return "All projects";
  return `${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ` +${keys.length - 3}` : ""}`;
});
function restoreDraft() {
  mode.value = props.modelValue === null ? "defaults" : props.modelValue.length ? "custom" : "all";
  draftKeys.value = props.modelValue === null ? [...(props.defaultProjectKeys || [])] : [...props.modelValue];
}
function focusPickerPanel() {
  if (!isFixedPickerSheet()) return;
  void nextTick(() => {
    const details = detailsRef.value;
    const content = details?.querySelector<HTMLElement>(".jira-project-scope-picker__content");
    if (details?.open && content) pickerFocusableTargets(content)[0]?.focus({ preventScroll: true });
  });
}
function updatePopoverPosition() {
  const summary = summaryRef.value;
  if (!summary || !detailsRef.value?.open || isFixedPickerSheet()) {
    popoverStyle.value = {};
    return;
  }
  const rect = summary.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(Math.max(rect.width, 320), Math.max(0, vw - 16));
  const left = Math.max(8, Math.min(rect.left, vw - 8 - width));
  const spaceBelow = Math.max(0, vh - rect.bottom - 8);
  const spaceAbove = Math.max(0, rect.top - 8);
  const flipAbove = spaceBelow < 320 && spaceAbove > spaceBelow;
  popoverStyle.value = {
    position: "fixed",
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(160, flipAbove ? spaceAbove : spaceBelow)}px`,
    top: flipAbove ? "auto" : `${rect.bottom + 4}px`,
    bottom: flipAbove ? `${vh - rect.top + 4}px` : "auto",
  };
}
function useDefaults() {
  mode.value = "defaults";
  draftKeys.value = [...(props.defaultProjectKeys || [])];
}
watch(() => [props.modelValue, props.defaultProjectKeys], restoreDraft, { immediate: true, deep: true });
function onToggle(event: Event) {
  isOpen.value = (event.currentTarget as HTMLDetailsElement).open;
  if (isOpen.value) {
    pinnedKeys.value = [...selectedKeys.value];
    emit("open");
    void nextTick(updatePopoverPosition);
    focusPickerPanel();
  } else {
    query.value = "";
    popoverStyle.value = {};
    restoreDraft();
  }
}
function toggleProject(key: string, checked: boolean) {
  mode.value = "custom";
  draftKeys.value = checked ? [...new Set([...draftKeys.value, key])] : draftKeys.value.filter((item) => item !== key);
}
function apply() {
  emit("update:modelValue", mode.value === "defaults" ? null : mode.value === "all" ? [] : [...draftKeys.value]);
  closePicker();
}
function closePicker(restoreFocus = true) {
  query.value = "";
  if (detailsRef.value) detailsRef.value.open = false;
  if (restoreFocus) nextTick(() => summaryRef.value?.focus());
}
function onKeydown(event: KeyboardEvent) {
  const details = detailsRef.value;
  if (!details?.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePicker();
    return;
  }
  if (event.key !== "Tab" || !isFixedPickerSheet()) return;
  const content = details.querySelector<HTMLElement>(".jira-project-scope-picker__content");
  if (!content) return;
  const focusable = pickerFocusableTargets(content);
  const first = focusable[0];
  const last = focusable.at(-1);
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !content.contains(active))) {
    event.preventDefault();
    last?.focus({ preventScroll: true });
  } else if (!event.shiftKey && (active === last || !content.contains(active))) {
    event.preventDefault();
    first?.focus({ preventScroll: true });
  }
}
useDismissable(isOpen, [detailsRef], { onDismiss: () => closePicker(false), eventName: "mousedown" });
function onReposition() {
  if (isOpen.value) updatePopoverPosition();
}
onMounted(() => {
  window.addEventListener("resize", onReposition);
  window.addEventListener("scroll", onReposition, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", onReposition);
  window.removeEventListener("scroll", onReposition, true);
});
</script>

<template>
  <details ref="detailsRef" class="jira-project-scope-picker" @toggle="onToggle" @keydown.capture="onKeydown">
    <summary
      ref="summaryRef"
      :aria-label="`Project scope: ${selectionLabel}`"
      title="Choose which Jira projects this view searches. The choice is saved with the view."
      @click="focusPickerPanel"
    >
      <span>Projects</span><span class="jira-project-scope-picker__selection">{{ selectionLabel }}</span
      ><span v-if="saveError" class="jira-project-scope-picker__save-error" role="alert" :title="saveError">{{
        saveError
      }}</span>
    </summary>
    <div
      class="jira-project-scope-picker__content"
      :style="popoverStyle"
      role="group"
      aria-label="Project scope options"
      tabindex="0"
    >
      <p class="jira-project-scope-picker__help">Limit this view to selected Jira projects.</p>
      <div class="jira-project-scope-picker__modes" role="group" aria-label="Scope presets">
        <button
          type="button"
          :aria-pressed="mode === 'defaults'"
          :disabled="isDisabled"
          :title="
            isDisabled
              ? lockedTitle
              : defaultProjectKeys?.length
                ? `Use the connection's default projects: ${defaultProjectKeys.join(', ')}.`
                : 'The connection has no default projects, so this searches all projects.'
          "
          @click="useDefaults"
        >
          Use defaults
        </button>
        <button
          type="button"
          :aria-pressed="mode === 'all'"
          :disabled="isDisabled"
          :title="isDisabled ? lockedTitle : 'Search every project this connection can see, ignoring the defaults.'"
          @click="
            mode = 'all';
            draftKeys = [];
          "
        >
          All projects
        </button>
      </div>
      <label class="jira-project-scope-picker__search">
        Find projects
        <input
          v-model="query"
          type="search"
          autocomplete="off"
          placeholder="Key or project name"
          :disabled="isDisabled"
        />
      </label>
      <p
        v-if="loading"
        class="jira-project-scope-picker__message jira-project-scope-picker__loading"
        role="status"
        aria-live="polite"
      >
        <Spinner size="sm" label="Loading projects" /> Loading projects…
      </p>
      <p
        v-else-if="error"
        class="jira-project-scope-picker__message jira-project-scope-picker__message--error"
        role="status"
      >
        {{ error }}
      </p>
      <p v-else-if="!projects.length" class="jira-project-scope-picker__message" role="status">
        No project list is available.
      </p>
      <div v-else class="jira-project-scope-picker__list" role="group" aria-label="Jira projects">
        <label v-for="project in matchingProjects" :key="project.key" class="jira-project-scope-picker__project">
          <input
            type="checkbox"
            :checked="selectedKeys.includes(project.key)"
            :disabled="isDisabled"
            @change="toggleProject(project.key, ($event.target as HTMLInputElement).checked)"
          />
          <span
            ><strong>{{ project.key }}</strong> · {{ project.name }}</span
          >
        </label>
        <p v-if="!matchingProjects.length" class="jira-project-scope-picker__message">No matching projects.</p>
      </div>
      <p v-if="!loading && allMatches.length > MAX_LISTED_PROJECTS" class="jira-project-scope-picker__message">
        Showing {{ MAX_LISTED_PROJECTS }} of {{ allMatches.length }} — refine the search.
      </p>
      <p v-if="truncated" class="jira-project-scope-picker__message">
        Showing the first 500 projects. Search by key or name; enter a project key to add it manually.
      </p>
      <button
        v-if="
          /^[A-Z][A-Z0-9_]{0,19}$/i.test(query.trim()) &&
          !projects.some((project) => project.key === query.trim().toUpperCase())
        "
        class="jira-project-scope-picker__manual"
        type="button"
        :disabled="isDisabled"
        :aria-pressed="draftKeys.includes(query.trim().toUpperCase())"
        :title="
          isDisabled
            ? lockedTitle
            : draftKeys.includes(query.trim().toUpperCase())
              ? `Take ${query.trim().toUpperCase()} out of the selection.`
              : `Add ${query.trim().toUpperCase()} by its key, although it is not in the loaded project list.`
        "
        @click="toggleProject(query.trim().toUpperCase(), !draftKeys.includes(query.trim().toUpperCase()))"
      >
        {{ draftKeys.includes(query.trim().toUpperCase()) ? "Remove" : "Add" }} project {{ query.trim().toUpperCase() }}
      </button>
      <div class="jira-project-scope-picker__actions" role="group" aria-label="Project scope actions">
        <button
          class="button button--ghost jira-project-scope-picker__cancel"
          type="button"
          title="Close without changing the project scope."
          @click="closePicker()"
        >
          Cancel
        </button>
        <button
          class="button jira-project-scope-picker__apply"
          type="button"
          :disabled="isDisabled"
          :title="isDisabled ? lockedTitle : 'Save this project scope for the view and reload its issues.'"
          @click="apply"
        >
          Apply project scope
        </button>
      </div>
    </div>
  </details>
</template>

<style scoped>
.jira-project-scope-picker {
  position: relative;
  min-width: 0;
}
.jira-project-scope-picker > summary {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-control);
  font-size: var(--font-size-body);
  cursor: pointer;
}
.jira-project-scope-picker > summary:hover {
  background: rgba(var(--tint), 0.08);
}
.jira-project-scope-picker__selection {
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jira-project-scope-picker__content {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 10px;
  border: 1px solid rgba(var(--tint), 0.16);
  border-radius: 6px;
  background: var(--menu-bg);
  box-shadow: var(--menu-shadow);
}
.jira-project-scope-picker[open] > .jira-project-scope-picker__content {
  z-index: 1200;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.jira-project-scope-picker__help,
.jira-project-scope-picker__message {
  margin: 0;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.jira-project-scope-picker__message--error {
  color: var(--danger-fg);
}
.jira-project-scope-picker__loading {
  display: flex;
  min-height: 160px;
  align-items: flex-start;
  gap: 8px;
}
.jira-project-scope-picker__modes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.jira-project-scope-picker__modes button {
  min-height: 30px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-control);
  color: var(--text);
}
.jira-project-scope-picker__modes button[aria-pressed="true"] {
  border-color: var(--accent);
  background: rgba(var(--tint), 0.08);
}
.jira-project-scope-picker__search {
  display: grid;
  gap: 4px;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.jira-project-scope-picker__search input {
  min-width: 0;
  min-height: 30px;
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-control);
  color: var(--text);
}
.jira-project-scope-picker__list {
  display: grid;
  max-height: min(32vh, 240px);
  overflow: auto;
  overscroll-behavior: contain;
}
.jira-project-scope-picker__project {
  display: flex;
  min-height: 28px;
  align-items: center;
  gap: 9px;
  padding: 3px 7px;
  border-radius: 4px;
  color: var(--text);
  font-size: var(--font-size-body);
}
.jira-project-scope-picker__project:hover {
  background: rgba(var(--tint), 0.08);
}
.jira-project-scope-picker__manual {
  min-height: 30px;
  padding: 5px 7px;
  border: 1px dashed var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  text-align: left;
}
.jira-project-scope-picker__project input {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}
.jira-project-scope-picker__project span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.jira-project-scope-picker__actions {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  gap: 8px;
  padding-top: 6px;
  background: var(--menu-bg);
  box-shadow: 0 -6px 10px var(--menu-bg);
}
.jira-project-scope-picker__cancel {
  flex: 0 0 auto;
}
.jira-project-scope-picker__apply {
  flex: 1 1 auto;
}
@media (pointer: coarse), (any-pointer: coarse), (max-width: 768px), (max-height: 500px) {
  .jira-project-scope-picker > summary,
  .jira-project-scope-picker__modes button,
  .jira-project-scope-picker__search input,
  .jira-project-scope-picker__project,
  .jira-project-scope-picker__manual,
  .jira-project-scope-picker__actions > .button {
    min-height: 44px;
  }
  .jira-project-scope-picker__project input {
    width: 18px;
    height: 18px;
  }
}
@media (max-width: 600px), (max-height: 480px), (max-width: 820px) and (any-pointer: coarse) {
  .jira-project-scope-picker[open] > .jira-project-scope-picker__content {
    position: fixed;
    z-index: 1200;
    inset-inline: max(8px, env(safe-area-inset-left));
    inset-block-end: max(8px, env(safe-area-inset-bottom));
    max-height: calc(100dvh - 16px);
    overflow-y: auto;
    overscroll-behavior: contain;
    box-shadow: 0 8px 32px rgb(0 0 0 / 24%);
    -webkit-overflow-scrolling: touch;
  }
  .jira-project-scope-picker[open] .jira-project-scope-picker__list {
    max-height: min(22dvh, 140px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .jira-project-scope-picker__loading :deep(.spinner) {
    animation-duration: 2s;
  }
}
</style>
