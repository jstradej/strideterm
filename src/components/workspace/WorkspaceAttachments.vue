<template>
  <section
    class="workspace-attachments"
    :class="{ 'workspace-attachments--panel': panel }"
    data-role="workspace-attachments"
    @keydown="onMenuKeydown"
  >
    <button type="button" class="workspace-attachments__toggle" :aria-expanded="open" @click="toggle">
      <span>Attachments</span>
      <span v-if="open || attachments.length" class="workspace-attachments__count">{{ attachments.length }}</span>
      <span aria-hidden="true">{{ open ? "▴" : "▾" }}</span>
    </button>
    <div v-if="open" class="workspace-attachments__body">
      <div class="workspace-attachments__toolbar approvals__toolbar">
        <label class="workspace-attachments__filter">
          <span class="sr-only">Filter attachments</span>
          <input
            v-model="filterQuery"
            class="approvals__search"
            type="search"
            placeholder="Filter attachments…"
            autocomplete="off"
            aria-label="Filter attachments"
          />
        </label>
        <select v-model="selectedDay" class="workspace-attachments__day-filter" aria-label="Filter by upload day">
          <option value="">All days</option>
          <option v-for="day in availableDays" :key="day.key" :value="day.key">{{ day.label }}</option>
        </select>
        <button
          type="button"
          class="workspace-attachments__refresh"
          :disabled="loading"
          title="Refresh attachments"
          aria-label="Refresh attachments"
          @click="load(true)"
        >
          ↻
        </button>
      </div>
      <p
        v-if="feedback"
        class="workspace-attachments__feedback"
        :class="{ 'workspace-attachments__feedback--error': feedback.error }"
        role="status"
      >
        {{ feedback.message }}
      </p>
      <p v-if="loading && !attachments.length" class="workspace-attachments__status">Loading attachments…</p>
      <p v-if="error" class="workspace-attachments__status workspace-attachments__status--error" role="alert">
        {{ error }}
      </p>
      <p v-if="!loading && !error && !filteredAttachments.length" class="workspace-attachments__status">
        {{ filterQuery.trim() || selectedDay ? "No matching attachments." : "No attachments yet." }}
      </p>
      <ul v-if="filteredAttachments.length" class="workspace-attachments__list">
        <template v-for="group in dayGroups" :key="group.key">
          <li class="notif-day-separator">
            <span class="notif-day-separator__line"></span>
            <span class="notif-day-separator__label">{{ group.label }}</span>
            <span class="notif-day-separator__line"></span>
          </li>
          <li v-for="attachment in group.files" :key="attachment.transferId" class="workspace-attachments__item">
            <div
              class="workspace-attachments__row"
              role="button"
              tabindex="0"
              :aria-label="`Copy relative path for ${attachment.name}`"
              @click="copyRelativePath(attachment.path)"
              @keydown="onRowKeydown($event, attachment.path)"
            >
              <div class="workspace-attachments__details">
                <time
                  class="workspace-attachments__time"
                  :title="uploadDate(attachment)?.toLocaleString()"
                  :datetime="uploadDate(attachment)?.toISOString()"
                  >{{
                    uploadDate(attachment)?.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) ?? "—"
                  }}</time
                >
                <strong :title="attachment.name">{{ attachment.name }}</strong>
                <code :title="attachment.path">{{ attachment.path }}</code>
              </div>
              <small class="workspace-attachments__size">{{ formatSize(attachment.size) }}</small>
            </div>
            <div class="workspace-attachments__actions" @click.stop>
              <button
                type="button"
                class="workspace-attachments__menu-trigger"
                data-role="attachment-menu-trigger"
                :aria-expanded="openMenuId === attachment.transferId"
                aria-haspopup="menu"
                :aria-label="`Actions for ${attachment.name}`"
                @click.stop="toggleMenu(attachment.transferId, $event)"
              >
                ⋯
              </button>
            </div>
            <div
              v-if="openMenuId === attachment.transferId"
              :ref="setMenuRef"
              class="workspace-attachments__menu"
              role="menu"
              :aria-label="`Actions for ${attachment.name}`"
              @click.stop
              @keydown.esc.stop.prevent="closeMenu"
            >
              <button
                type="button"
                role="menuitem"
                :disabled="!props.workspaceRoot"
                title="Copy the path on the desktop workspace"
                @click="copyAbsolutePath(attachment.path)"
              >
                Copy absolute path
              </button>
              <button
                type="button"
                role="menuitem"
                @click="
                  copyRelativePath(attachment.path);
                  closeMenu();
                "
              >
                Copy path
              </button>
              <button
                type="button"
                role="menuitem"
                :disabled="!nativeClipboardAvailable"
                :title="
                  nativeClipboardAvailable
                    ? 'Copy the file so it can be pasted in Explorer or Finder'
                    : 'Available on the desktop only'
                "
                @click="copyFileIntoClipboard(attachment.path)"
              >
                Copy into clipboard
              </button>
              <button
                type="button"
                role="menuitem"
                class="workspace-attachments__menu-delete"
                :disabled="deletingId === attachment.transferId"
                @click="deleteAttachment(attachment)"
              >
                {{ deletingId === attachment.transferId ? "Deleting…" : "Delete" }}
              </button>
            </div>
          </li>
        </template>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch, type ComponentPublicInstance } from "vue";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import type { AttachmentRecord } from "../../attachments.js";
import { useDismissable } from "../../composables/useDismissable.js";
import { dayBandKey, dayBandLabel } from "../../app/helpers.js";

const props = withDefaults(
  defineProps<{ workspaceId: string; workspaceRoot?: string; openByDefault?: boolean; panel?: boolean }>(),
  { workspaceRoot: "", openByDefault: false, panel: false },
);
const api = inject<Transport | null>(apiKey, null);
const open = ref(props.openByDefault);
const loading = ref(false);
const error = ref("");
const attachments = ref<AttachmentRecord[]>([]);
const filterQuery = ref("");
const selectedDay = ref("");
const deletingId = ref<string | null>(null);
const openMenuId = ref<string | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const lastTrigger = ref<HTMLElement | null>(null);
const feedback = ref<{ message: string; error?: boolean } | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
let requestEpoch = 0;
let mounted = false;

const nativeClipboardAvailable = computed(
  () => api?.isRemote === false && typeof api.fileClipboardCopy === "function" && Boolean(props.workspaceRoot),
);
function uploadDate(attachment: AttachmentRecord): Date | null {
  const timestamp = attachment.uploadedAt;
  return typeof timestamp === "number" &&
    Number.isFinite(timestamp) &&
    timestamp > 0 &&
    !Number.isNaN(new Date(timestamp).getTime())
    ? new Date(timestamp)
    : null;
}
function uploadDay(attachment: AttachmentRecord): { key: string; label: string } {
  const date = uploadDate(attachment);
  return date ? { key: dayBandKey(date), label: dayBandLabel(date) } : { key: "unknown", label: "Unknown date" };
}
const chronologicalAttachments = computed(() =>
  [...attachments.value].sort(
    (a, b) => (uploadDate(b)?.getTime() ?? 0) - (uploadDate(a)?.getTime() ?? 0) || a.name.localeCompare(b.name),
  ),
);
const availableDays = computed(() => [
  ...new Map(
    chronologicalAttachments.value.map((file) => {
      const day = uploadDay(file);
      return [day.key, day] as const;
    }),
  ).values(),
]);
const filteredAttachments = computed(() => {
  const query = filterQuery.value.trim().toLowerCase();
  return chronologicalAttachments.value.filter(
    (attachment) =>
      (!selectedDay.value || uploadDay(attachment).key === selectedDay.value) &&
      (!query || attachment.name.toLowerCase().includes(query) || attachment.path.toLowerCase().includes(query)),
  );
});
const dayGroups = computed(() => {
  const groups: Array<{ key: string; label: string; files: AttachmentRecord[] }> = [];
  for (const attachment of filteredAttachments.value) {
    const day = uploadDay(attachment);
    const previous = groups.at(-1);
    if (previous?.key === day.key) previous.files.push(attachment);
    else groups.push({ ...day, files: [attachment] });
  }
  return groups;
});

function showFeedback(message: string, isError = false): void {
  feedback.value = { message, error: isError };
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => (feedback.value = null), 1600);
}

async function load(force = false): Promise<void> {
  if (!api?.attachmentList || !props.workspaceId || (loading.value && !force)) return;
  const targetWorkspaceId = props.workspaceId;
  const epoch = ++requestEpoch;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.attachmentList({ workspaceId: targetWorkspaceId });
    if (mounted && open.value && epoch === requestEpoch && props.workspaceId === targetWorkspaceId)
      attachments.value = result;
  } catch (cause) {
    if (mounted && epoch === requestEpoch && props.workspaceId === targetWorkspaceId)
      error.value = cause instanceof Error ? cause.message : "Unable to load attachments";
  } finally {
    if (epoch === requestEpoch) loading.value = false;
  }
}

async function copyText(path: string, label: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(path);
    showFeedback(`${label} copied`);
  } catch {
    showFeedback("Unable to copy attachment path", true);
  }
}

function copyRelativePath(path: string): Promise<void> {
  return copyText(path, "Relative path");
}

function absolutePath(path: string): string {
  const root = props.workspaceRoot.replace(/[\\/]+$/, "");
  const relative = path.replace(/^[\\/]+/, "");
  const separator = props.workspaceRoot.includes("\\") ? "\\" : "/";
  return `${root}${separator}${relative.replace(/[\\/]/g, separator)}`;
}

function copyAbsolutePath(path: string): Promise<void> {
  closeMenu();
  if (!props.workspaceRoot) {
    showFeedback("Absolute path is unavailable for this workspace", true);
    return Promise.resolve();
  }
  return copyText(absolutePath(path), "Absolute path");
}

async function copyFileIntoClipboard(path: string): Promise<void> {
  closeMenu();
  if (!nativeClipboardAvailable.value || !api?.fileClipboardCopy) {
    showFeedback("Native file clipboard is available on the desktop only", true);
    return;
  }
  try {
    await api.fileClipboardCopy({ rootPath: props.workspaceRoot, relativePath: path });
    showFeedback("File copied into clipboard");
  } catch {
    showFeedback("Unable to copy file into clipboard", true);
  }
}

function onRowKeydown(event: KeyboardEvent, path: string): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  void copyRelativePath(path);
}

function toggleMenu(transferId: string, event: MouseEvent): void {
  lastTrigger.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  openMenuId.value = openMenuId.value === transferId ? null : transferId;
  if (openMenuId.value)
    void nextTick(() => menuRef.value?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus());
}

function setMenuRef(element: Element | ComponentPublicInstance | null): void {
  menuRef.value = element instanceof HTMLElement ? element : null;
}

function closeMenu(): void {
  openMenuId.value = null;
  const trigger = lastTrigger.value;
  if (trigger) void nextTick(() => trigger.focus());
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !openMenuId.value) return;
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
}

useDismissable(
  computed(() => openMenuId.value !== null),
  menuRef,
  {
    onDismiss: closeMenu,
    eventName: "pointerdown",
    ignoreSelector: "[data-role='attachment-menu-trigger']",
  },
);

async function deleteAttachment(attachment: AttachmentRecord): Promise<void> {
  closeMenu();
  if (!api?.attachmentDelete) return;
  const targetWorkspaceId = props.workspaceId;
  if (!window.confirm(`Delete “${attachment.name}”? This removes the attachment for every tab in this workspace.`))
    return;
  deletingId.value = attachment.transferId;
  error.value = "";
  try {
    await api.attachmentDelete({
      workspaceId: targetWorkspaceId,
      transferId: attachment.transferId,
      name: attachment.name,
    });
    if (mounted && open.value && props.workspaceId === targetWorkspaceId) await load(true);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Unable to delete attachment";
  } finally {
    deletingId.value = null;
  }
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling(): void {
  stopPolling();
  void load();
  pollTimer = setInterval(() => void load(), 5000);
}

function toggle(): void {
  open.value = !open.value;
  if (open.value) startPolling();
  else stopPolling();
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

watch(
  () => [props.workspaceId, props.workspaceRoot],
  () => {
    requestEpoch += 1;
    attachments.value = [];
    filterQuery.value = "";
    selectedDay.value = "";
    closeMenu();
    feedback.value = null;
    if (open.value) void load(true);
  },
);

onMounted(() => {
  mounted = true;
  if (open.value) startPolling();
});
onUnmounted(() => {
  mounted = false;
  requestEpoch += 1;
  stopPolling();
  if (feedbackTimer) clearTimeout(feedbackTimer);
});
</script>

<style scoped>
.workspace-attachments {
  margin: 0 12px 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  background: rgba(12, 16, 24, 0.45);
}
.workspace-attachments--panel {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.workspace-attachments--panel .workspace-attachments__toggle {
  display: none;
}
.workspace-attachments--panel .workspace-attachments__body {
  max-height: none;
  padding: 0;
}
.workspace-attachments__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.workspace-attachments__count {
  min-width: 1.4em;
  padding: 1px 5px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--success-fg) 16%, transparent);
  color: var(--success-fg);
  text-align: center;
}
.workspace-attachments__toggle > :last-child {
  margin-left: auto;
}
.workspace-attachments__body {
  max-height: min(34vh, 360px);
  overflow-y: auto;
  padding: 0 10px 10px;
}
.workspace-attachments__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 0;
}
.workspace-attachments__filter {
  min-width: 0;
  flex: 1;
}
.workspace-attachments__filter input {
  width: 100%;
  font-size: 11px;
  padding: 4px 6px;
}
.workspace-attachments__day-filter {
  max-width: 100px;
  min-width: 0;
  font-size: 11px;
  padding: 3px 4px;
  color: var(--muted);
  border: 1px solid rgba(var(--tint), 0.12);
  border-radius: 3px;
  background: var(--panel);
}
.workspace-attachments__refresh,
.workspace-attachments__menu-trigger {
  display: inline-grid;
  width: 24px;
  height: 24px;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
}
.workspace-attachments__refresh:hover,
.workspace-attachments__refresh:focus-visible,
.workspace-attachments__menu-trigger:hover,
.workspace-attachments__menu-trigger:focus-visible {
  border-color: var(--border-color, rgba(255, 255, 255, 0.18));
  color: inherit;
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.workspace-attachments__notice,
.workspace-attachments__status,
.workspace-attachments__feedback {
  margin: 8px 14px;
  color: var(--muted);
  font-size: 11px;
}
.workspace-attachments__feedback {
  color: var(--success-fg, #7bd88f);
}
.workspace-attachments__feedback--error,
.workspace-attachments__status--error {
  color: var(--danger-fg);
}
.workspace-attachments__list {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.workspace-attachments__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 7px 10px 7px 14px;
  border-bottom: 1px solid rgba(var(--tint), 0.06);
  background: transparent;
  font-size: 11px;
}
.workspace-attachments__item:hover,
.workspace-attachments__item:focus-within {
  background: rgba(var(--tint), 0.05);
}
.workspace-attachments__row {
  display: grid;
  min-width: 0;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 0;
  border-radius: 3px;
  cursor: pointer;
}
.workspace-attachments__row:focus-visible {
  outline: 2px solid var(--accent, #78a9ff);
  outline-offset: 2px;
}
.workspace-attachments__details {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  min-width: 0;
  gap: 4px 10px;
}
.workspace-attachments__time {
  color: var(--muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.workspace-attachments__details strong {
  font-size: 11px;
  font-weight: 600;
}
.workspace-attachments__details code {
  grid-column: 1 / -1;
  font-family: var(--mono, ui-monospace, monospace);
}
.workspace-attachments__details strong,
.workspace-attachments__details code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-attachments__details code,
.workspace-attachments__size {
  color: var(--muted);
  font-size: 11px;
}
.workspace-attachments__size {
  min-width: 44px;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.workspace-attachments__actions {
  position: relative;
  flex: 0 0 auto;
}
.workspace-attachments__menu {
  z-index: 5;
  display: grid;
  grid-column: 1 / -1;
  justify-self: end;
  width: max-content;
  min-width: 180px;
  margin: 4px 0 0 auto;
  padding: 4px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.18));
  border-radius: 5px;
  background: var(--panel-elevated, var(--panel));
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.3);
}
.workspace-attachments__menu button {
  font-size: 11px;
  padding: 6px 8px;
  border: 0;
  border-radius: 3px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
.workspace-attachments__menu button:hover,
.workspace-attachments__menu button:focus-visible {
  background: color-mix(in srgb, var(--text) 10%, transparent);
  outline: none;
}
.workspace-attachments__menu button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.workspace-attachments__menu-delete {
  color: var(--danger-fg) !important;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 600px) {
  .workspace-attachments__body {
    padding-inline: 0;
  }
  .workspace-attachments__row {
    gap: 6px;
  }
  .workspace-attachments__size {
    min-width: 46px;
  }
}
</style>
