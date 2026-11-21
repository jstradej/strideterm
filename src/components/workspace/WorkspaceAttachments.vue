<template>
  <section
    class="workspace-attachments"
    :class="{ 'workspace-attachments--panel': panel, 'workspace-attachments--dragging': dragging }"
    data-role="workspace-attachments"
    tabindex="-1"
    @keydown="onMenuKeydown"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @paste="onPaste"
  >
    <button type="button" class="workspace-attachments__toggle" :aria-expanded="open" @click="toggle">
      <span>Attachments</span>
      <span v-if="open || rows.length" class="workspace-attachments__count">{{ rows.length }}</span>
      <span
        :class="['disclosure-chevron', 'disclosure-chevron--down', open && 'disclosure-chevron--open']"
        aria-hidden="true"
      />
    </button>
    <div v-if="open" class="workspace-attachments__body">
      <nav
        v-if="canListAll"
        class="subtabs workspace-attachments__scope"
        role="tablist"
        aria-label="Which attachments to show"
        data-role="attachment-scope"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="showAll ? 'false' : 'true'"
          :class="['subtabs__tab', !showAll && 'subtabs__tab--active']"
          title="Attachments of the active workspace"
          @click="setScope('workspace')"
        >
          This workspace
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="showAll ? 'true' : 'false'"
          :class="['subtabs__tab', showAll && 'subtabs__tab--active']"
          :title="`Attachments of every workspace on this computer, in every profile, from the last ${RECENT_DAYS} days`"
          @click="setScope('all')"
        >
          All workspaces
        </button>
        <small v-if="showAll" class="workspace-attachments__scope-hint"
          >every profile · last {{ RECENT_DAYS }} days</small
        >
      </nav>
      <!-- Under the section tabs, the content is the panel the selected tab opens into (as in the Git pane). -->
      <div class="workspace-attachments__content" :class="{ 'subtabs-panel': canListAll }">
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
          <CustomSelect
            v-model="selectedDay"
            class="workspace-attachments__day-filter"
            aria-label="Filter by upload day"
            :options="dayOptions"
          />
          <template v-if="canUpload">
            <input
              ref="fileInput"
              class="sr-only"
              type="file"
              multiple
              tabindex="-1"
              data-role="attachment-file-input"
              aria-label="Choose files to attach"
              @change="onFilesPicked"
            />
            <button
              type="button"
              class="workspace-attachments__add"
              data-role="attachment-add"
              :disabled="Boolean(unavailableReason)"
              :title="unavailableReason || addTitle"
              @click="fileInput?.click()"
            >
              Add file
            </button>
          </template>
          <button
            type="button"
            class="workspace-attachments__refresh"
            :disabled="loading"
            :aria-busy="refreshing ? 'true' : undefined"
            :title="
              showAll ? 'Reload the attachment list of this computer' : 'Reload the attachment list for this workspace'
            "
            aria-label="Refresh attachments"
            @click="reload"
          >
            <Spinner v-if="refreshing" size="sm" aria-hidden="true" />
            <template v-else>↻</template>
          </button>
          <!-- Hangs below the sticky toolbar: it floats over the list instead of pushing it down and back. -->
          <p
            v-if="feedback"
            class="workspace-attachments__feedback"
            :class="{ 'workspace-attachments__feedback--error': feedback.error }"
            role="status"
          >
            {{ feedback.message }}
          </p>
        </div>
        <p v-if="dragging" class="workspace-attachments__dropzone" data-role="attachment-dropzone">
          Drop files to add them to this workspace
        </p>
        <ul v-if="transfers.length" class="workspace-attachments__transfers" data-role="attachment-transfers">
          <li
            v-for="item in transfers"
            :key="item.id"
            class="workspace-attachments__transfer"
            :class="{ 'workspace-attachments__transfer--failed': item.state === 'failed' }"
          >
            <div class="workspace-attachments__transfer-head">
              <strong :title="item.name">{{ item.name }}</strong>
              <small>{{ transferLabel(item) }}</small>
              <button
                v-if="item.active"
                type="button"
                class="workspace-attachments__transfer-button"
                :aria-label="`Cancel ${item.verb} of ${item.name}`"
                :disabled="item.finishing"
                @click="item.cancel()"
              >
                Cancel
              </button>
              <button
                v-else
                type="button"
                class="workspace-attachments__transfer-button"
                :aria-label="`Dismiss ${item.name}`"
                @click="item.dismiss()"
              >
                Dismiss
              </button>
            </div>
            <div
              v-if="item.active"
              class="workspace-attachments__bar"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="item.percent"
            >
              <span :style="{ width: `${item.percent}%` }"></span>
            </div>
            <p v-else-if="item.error" class="workspace-attachments__transfer-error" role="alert">{{ item.error }}</p>
          </li>
        </ul>
        <p
          v-if="loading && !loaded && !rows.length"
          class="workspace-attachments__status workspace-attachments__status--wait"
          role="status"
        >
          <Spinner size="sm" aria-hidden="true" />
          Loading attachments…
        </p>
        <p v-if="error" class="workspace-attachments__status workspace-attachments__status--error" role="alert">
          {{ error }}
        </p>
        <p v-if="(loaded || !loading) && !error && !filteredAttachments.length" class="workspace-attachments__status">
          {{
            filterQuery.trim() || selectedDay
              ? "No matching attachments."
              : showAll
                ? `No attachments on this computer from the last ${RECENT_DAYS} days.`
                : "No attachments yet."
          }}
        </p>
        <p v-if="showAll && allTruncated" class="workspace-attachments__status" data-role="attachment-all-truncated">
          Showing the {{ allItems.length }} newest attachments.
        </p>
        <p
          v-if="canUpload && !showAll && !unavailableReason && (loaded || !loading) && !error && !rows.length"
          class="workspace-attachments__status workspace-attachments__hint"
          data-role="attachment-drop-hint"
        >
          Drop files here, paste them, or use Add file.
        </p>
        <ul v-if="filteredAttachments.length" class="workspace-attachments__list">
          <template v-for="group in dayGroups" :key="group.key">
            <li class="notif-day-separator">
              <span class="notif-day-separator__line"></span>
              <span class="notif-day-separator__label">{{ group.label }}</span>
              <span class="notif-day-separator__line"></span>
            </li>
            <li
              v-for="attachment in group.files"
              :key="attachment.transferId"
              class="workspace-attachments__item"
              :aria-busy="deletingId === attachment.transferId ? 'true' : undefined"
            >
              <div
                class="workspace-attachments__row"
                role="button"
                tabindex="0"
                :title="attachment.root ? absoluteAttachmentPath(attachment.root, attachment.path) : attachment.path"
                :aria-label="`Copy ${attachment.root ? 'absolute' : 'relative'} path for ${attachment.name}`"
                @click="copyClickedPath(attachment)"
                @keydown="onRowKeydown($event, attachment)"
              >
                <div class="workspace-attachments__details">
                  <time
                    class="workspace-attachments__time"
                    :title="uploadDate(attachment)?.toLocaleString()"
                    :datetime="uploadDate(attachment)?.toISOString()"
                    >{{
                      uploadDate(attachment)?.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) ??
                      "—"
                    }}</time
                  >
                  <strong :title="attachment.name">{{ attachment.name }}</strong>
                  <span v-if="showAll" class="workspace-attachments__owner" data-role="attachment-owner">{{
                    ownerLabel(attachment)
                  }}</span>
                  <code v-else :title="attachment.path">{{ attachment.path }}</code>
                </div>
                <small class="workspace-attachments__size">{{ formatSize(attachment.size) }}</small>
              </div>
              <div class="workspace-attachments__actions" @click.stop>
                <Spinner
                  v-if="deletingId === attachment.transferId"
                  size="sm"
                  label="Deleting attachment"
                  data-role="attachment-deleting"
                />
                <button
                  v-if="canOpen(attachment)"
                  type="button"
                  class="workspace-attachments__open"
                  :aria-label="`Open attachment ${attachment.name}`"
                  :title="`Open ${attachment.name} with the default app`"
                  @click.stop="openAttachment(attachment)"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                    <path d="M1.5 10s3.1-5.5 8.5-5.5 8.5 5.5 8.5 5.5-3.1 5.5-8.5 5.5S1.5 10 1.5 10Z" />
                    <circle cx="10" cy="10" r="2.5" />
                  </svg>
                </button>
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
              <Teleport to="body">
                <div
                  v-if="openMenuId === attachment.transferId"
                  :ref="setMenuRef"
                  class="workspace-attachments__menu"
                  role="menu"
                  :aria-label="`Actions for ${attachment.name}`"
                  :style="menuStyle"
                  @click.stop
                  @keydown.esc.stop.prevent="closeMenu"
                  @keydown.tab.prevent="closeMenu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    :disabled="!attachment.root"
                    :title="`Copy the path on ${pathOwner}`"
                    @click="copyAbsolutePath(attachment)"
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
                    :disabled="!canNativeClipboard(attachment)"
                    :title="
                      canNativeClipboard(attachment)
                        ? 'Copy the file so it can be pasted in Explorer or Finder'
                        : 'Available on the desktop only'
                    "
                    @click="copyFileIntoClipboard(attachment)"
                  >
                    Copy into clipboard
                  </button>
                  <button
                    v-if="canSave"
                    type="button"
                    role="menuitem"
                    data-role="attachment-save"
                    title="Download the file to this computer"
                    @click="saveAttachment(attachment)"
                  >
                    Save to this computer
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    class="workspace-attachments__menu-delete"
                    :disabled="deletingId === attachment.transferId || !canDelete(attachment)"
                    :title="
                      canDelete(attachment)
                        ? undefined
                        : `Switch to the ${attachment.profileName} profile to delete this attachment`
                    "
                    @click="deleteAttachment(attachment)"
                  >
                    {{ deletingId === attachment.transferId ? "Deleting…" : "Delete" }}
                  </button>
                </div>
              </Teleport>
            </li>
          </template>
        </ul>
        <PeerAttachmentsSection
          v-for="host in peerHosts"
          :key="host.id"
          :host="host"
          :workspace-id="workspaceId"
          :workspace-name="workspaceName"
          :unavailable-reason="unavailableReason"
          :targets="copyTargets"
          :local-attachments="attachments"
          :filter-query="filterQuery"
          :selected-day="selectedDay"
          :can-open="nativeOpenAvailable"
          @copy-path="(path: string) => copyClickedPath({ path, root: props.workspaceRoot })"
          @open="openAttachment"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import type { AttachmentRecord } from "../../attachments.js";
import { useDismissable } from "../../composables/useDismissable.js";
import { dayBandKey, dayBandLabel } from "../../app/helpers.js";
import { hasAttachmentUpload, useAttachmentUpload, type UploadItem } from "../../composables/useAttachmentUpload.js";
import { AttachmentDownloadCancelled, readAttachment, saveBlobAsDownload } from "../../lib/attachment-download.js";
import { pastedImageName } from "../../lib/terminal-attachment-upload.js";
import { useNotificationStore } from "../../stores/notifications.js";
import Spinner from "../common/Spinner.vue";
import { isPeerWindow, windowBackend } from "../../window-backend.js";
import { absoluteAttachmentPath } from "../../lib/attachment-path.js";
import { hasPeerAttachmentCopy, usePeerAttachmentCopiesStore } from "../../stores/peer-attachment-copies.js";
import { usePeersStore } from "../../stores/peers.js";
import PeerAttachmentsSection from "./PeerAttachmentsSection.vue";
import CustomSelect from "../common/CustomSelect.vue";
import type { LocalAttachmentItem } from "../../../electron/shared/attachment-upload.js";
import { PEER_ATTACHMENT_LIST_DAYS as RECENT_DAYS } from "../../../electron/shared/peers.js";

const props = withDefaults(
  defineProps<{
    workspaceId: string;
    workspaceRoot?: string;
    openByDefault?: boolean;
    panel?: boolean;
    unavailableReason?: string;
    workspaceName?: string;
    /** The active profile: an attachment of another profile is listed but not deleted from here. */
    profileId?: string;
    copyTargets?: Array<{ id: string; name: string }>;
  }>(),
  {
    workspaceRoot: "",
    openByDefault: false,
    panel: false,
    unavailableReason: "",
    workspaceName: "",
    profileId: "default",
    copyTargets: () => [],
  },
);

/** A listed attachment with the workspace that owns it; `root` is empty where this client cannot know it. */
type AttachmentRow = AttachmentRecord &
  Pick<LocalAttachmentItem, "workspaceId" | "root"> &
  Partial<Pick<LocalAttachmentItem, "workspaceName" | "profileId" | "profileName">>;
const api = inject<Transport | null>(apiKey, null);
const open = ref(props.openByDefault);
const loading = ref(false);
const loaded = ref(false);
const refreshing = ref(false);
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

const canUpload = hasAttachmentUpload(api);
// Every profile's attachments on this machine: a local desktop window only. A phone or web client stays confined
// to its profile, and a window attached to another desktop would list this machine instead of the host.
const canListAll = typeof api?.attachmentListAll === "function" && api.isRemote !== true && !isPeerWindow();
const SCOPE_STORAGE_KEY = "strideterm.attachments.scope";
const scope = ref<"workspace" | "all">(readScope());
const showAll = computed(() => canListAll && scope.value === "all");
const allItems = ref<LocalAttachmentItem[]>([]);
const allTruncated = ref(false);
const rows = computed<AttachmentRow[]>(() =>
  showAll.value
    ? allItems.value
    : attachments.value.map((attachment) => ({
        ...attachment,
        workspaceId: props.workspaceId,
        root: props.workspaceRoot,
      })),
);

function readScope(): "workspace" | "all" {
  if (!canListAll) return "workspace";
  try {
    return localStorage.getItem(SCOPE_STORAGE_KEY) === "all" ? "all" : "workspace";
  } catch {
    return "workspace";
  }
}

function setScope(next: "workspace" | "all"): void {
  if (scope.value === next) return;
  scope.value = next;
  try {
    localStorage.setItem(SCOPE_STORAGE_KEY, next);
  } catch {
    // Storage can be unavailable; the choice then lasts for this panel only.
  }
  requestEpoch += 1;
  loading.value = false;
  loaded.value = false;
  error.value = "";
  selectedDay.value = "";
  closeMenu();
  if (open.value) startPolling();
}

function ownerLabel(row: AttachmentRow): string {
  const workspace = row.workspaceName || row.workspaceId;
  return row.profileId && row.profileId !== props.profileId ? `${workspace} · ${row.profileName}` : workspace;
}
const peerAttachments = hasPeerAttachmentCopy(api) && !isPeerWindow();
const peerCopies = peerAttachments ? usePeerAttachmentCopiesStore() : null;
const peers = peerAttachments ? usePeersStore() : null;
const peerHosts = computed(() => peers?.hosts ?? []);
let releasePeers: (() => void) | null = null;
const canSave = computed(() => api?.isRemote === true && typeof api.attachmentRead === "function");
const addTitle = "Upload files into this workspace's attachments. You can also drop or paste them here.";
const pathOwner = computed(() => {
  if (api?.isRemote !== true) return "this computer";
  const backend = windowBackend.value;
  return backend.kind === "peer" ? backend.hostLabel || "the other computer" : "the desktop workspace";
});
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
let dragDepth = 0;
const uploader = useAttachmentUpload({ onSettled: onUploadSettled });
const downloads = reactive<
  Array<{ id: string; name: string; size: number; read: number; error: string; controller: AbortController }>
>([]);

interface TransferRow {
  id: string;
  name: string;
  verb: "upload" | "download";
  active: boolean;
  finishing: boolean;
  percent: number;
  error: string;
  state: string;
  size: number;
  cancel: () => void;
  dismiss: () => void;
}

function percentOf(sent: number, size: number): number {
  return size > 0 ? Math.min(100, Math.floor((sent / size) * 100)) : 0;
}

const transfers = computed<TransferRow[]>(() => [
  ...uploader.items
    .filter((item) => item.state !== "cancelled")
    .map((item) => ({
      id: item.id,
      name: item.name,
      verb: "upload" as const,
      active: item.state === "queued" || item.state === "uploading",
      finishing: item.finishing,
      percent: percentOf(item.sent, item.size),
      error: item.error,
      state: item.state,
      size: item.size,
      cancel: () => uploader.cancel(item),
      dismiss: () => uploader.dismiss(item),
    })),
  ...downloads.map((item) => ({
    id: item.id,
    name: item.name,
    verb: "download" as const,
    active: !item.error,
    finishing: false,
    percent: percentOf(item.read, item.size),
    error: item.error,
    state: item.error ? "failed" : "downloading",
    size: item.size,
    cancel: () => item.controller.abort(),
    dismiss: () => downloads.splice(downloads.indexOf(item), 1),
  })),
]);

function transferLabel(row: TransferRow): string {
  if (row.state === "queued") return "Waiting…";
  if (row.finishing) return "Finishing…";
  if (row.state === "failed") return row.verb === "upload" ? "Upload failed" : "Download failed";
  return `${row.percent} % of ${formatSize(row.size)}`;
}

const nativeOpenAvailable = computed(
  () => api?.isRemote === false && typeof api.openTerminalPath === "function" && Boolean(props.workspaceRoot),
);
function canOpen(row: AttachmentRow): boolean {
  return api?.isRemote === false && typeof api.openTerminalPath === "function" && Boolean(row.root);
}
function canNativeClipboard(row: AttachmentRow): boolean {
  return api?.isRemote === false && typeof api.fileClipboardCopy === "function" && Boolean(row.root);
}
// Deleting goes through the calling window's profile, so another profile's attachment is only listed.
function canDelete(row: AttachmentRow): boolean {
  return !row.profileId || row.profileId === props.profileId;
}
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
  [...rows.value].sort(
    (a, b) => (uploadDate(b)?.getTime() ?? 0) - (uploadDate(a)?.getTime() ?? 0) || a.name.localeCompare(b.name),
  ),
);
const hostUploadTimes = computed(() => {
  if (!peerCopies) return [];
  return peerHosts.value
    .filter((host) => host.state === "online" && !peerCopies.isCollapsed(host.id))
    .flatMap((host) => peerCopies.listings[host.id]?.items.map((item) => item.uploadedAt) ?? []);
});
const availableDays = computed(() => {
  const days: Array<{ at: number; key: string; label: string }> = [
    ...chronologicalAttachments.value.map((file) => ({ at: uploadDate(file)?.getTime() ?? 0, ...uploadDay(file) })),
    ...hostUploadTimes.value.map((at) => {
      const date = new Date(at);
      return { at, key: dayBandKey(date), label: dayBandLabel(date) };
    }),
  ];
  if (hostUploadTimes.value.length) days.sort((a, b) => b.at - a.at);
  return [...new Map(days.map(({ key, label }) => [key, { key, label }] as const)).values()];
});
const dayOptions = computed(() => [
  { value: "", label: "All days" },
  ...availableDays.value.map((day) => ({ value: day.key, label: day.label })),
]);
const filteredAttachments = computed(() => {
  const query = filterQuery.value.trim().toLowerCase();
  return chronologicalAttachments.value.filter(
    (attachment) =>
      (!selectedDay.value || uploadDay(attachment).key === selectedDay.value) &&
      (!query ||
        attachment.name.toLowerCase().includes(query) ||
        attachment.path.toLowerCase().includes(query) ||
        (showAll.value && ownerLabel(attachment).toLowerCase().includes(query))),
  );
});
const dayGroups = computed(() => {
  const groups: Array<{ key: string; label: string; files: AttachmentRow[] }> = [];
  for (const attachment of filteredAttachments.value) {
    const day = uploadDay(attachment);
    const previous = groups.at(-1);
    if (previous?.key === day.key) previous.files.push(attachment);
    else groups.push({ ...day, files: [attachment] });
  }
  return groups;
});

function carriesFiles(event: DragEvent): boolean {
  return canUpload && Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function onDragEnter(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dragging.value = true;
}

function onDragOver(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = props.unavailableReason ? "none" : "copy";
}

function onDragLeave(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}

async function onDrop(event: DragEvent): Promise<void> {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dragging.value = false;
  await startUpload(Array.from(event.dataTransfer?.files ?? []));
}

async function onPaste(event: ClipboardEvent): Promise<void> {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (!canUpload || !files.length) return;
  event.preventDefault();
  await startUpload(files.map((file) => new File([file], pastedImageName(file), { type: file.type })));
}

async function onFilesPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  await startUpload(files);
}

async function startUpload(files: File[]): Promise<void> {
  if (!files.length) return;
  if (props.unavailableReason) {
    showFeedback(props.unavailableReason, true);
    return;
  }
  const targetWorkspaceId = props.workspaceId;
  await uploader.upload(files, targetWorkspaceId);
  if (mounted && open.value && props.workspaceId === targetWorkspaceId) await load(true);
}

function onUploadSettled(item: UploadItem): void {
  if (item.state === "failed") {
    useNotificationStore().showError("Upload failed", item.error, { workspaceId: item.workspaceId });
    return;
  }
  const record = item.record;
  if (!record) return;
  uploader.dismiss(item);
  if (!mounted) {
    useNotificationStore().pushEphemeralToast({ title: "Attachment uploaded", body: item.name });
    return;
  }
  if (showAll.value) {
    if (open.value) void load(true);
    return;
  }
  if (
    props.workspaceId === item.workspaceId &&
    !attachments.value.some((entry) => entry.transferId === record.transferId)
  )
    attachments.value = [...attachments.value, record];
}

async function saveAttachment(attachment: AttachmentRow): Promise<void> {
  closeMenu();
  if (!api) return;
  const entry = reactive({
    id: crypto.randomUUID(),
    name: attachment.name,
    size: attachment.size,
    read: 0,
    error: "",
    controller: new AbortController(),
  });
  downloads.push(entry);
  try {
    const blob = await readAttachment(api, {
      workspaceId: attachment.workspaceId,
      attachment,
      signal: entry.controller.signal,
      onProgress: (read) => (entry.read = read),
    });
    saveBlobAsDownload(blob, attachment.name);
    downloads.splice(downloads.indexOf(entry), 1);
    showFeedback(`Saving ${attachment.name}`);
  } catch (cause) {
    if (cause instanceof AttachmentDownloadCancelled) {
      downloads.splice(downloads.indexOf(entry), 1);
      return;
    }
    entry.error = cause instanceof Error ? cause.message : "The download failed.";
    useNotificationStore().showError("Download failed", cause, { workspaceId: attachment.workspaceId });
  }
}

function showFeedback(message: string, isError = false): void {
  feedback.value = { message, error: isError };
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => (feedback.value = null), 1600);
}

async function load(force = false): Promise<void> {
  if (showAll.value) return loadAll(force);
  if (!api?.attachmentList || !props.workspaceId || (loading.value && !force)) return;
  const targetWorkspaceId = props.workspaceId;
  const epoch = ++requestEpoch;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.attachmentList({ workspaceId: targetWorkspaceId });
    if (mounted && open.value && epoch === requestEpoch && props.workspaceId === targetWorkspaceId) {
      attachments.value = result;
      loaded.value = true;
    }
  } catch (cause) {
    if (mounted && epoch === requestEpoch && props.workspaceId === targetWorkspaceId) {
      error.value = cause instanceof Error ? cause.message : "Unable to load attachments";
      loaded.value = true;
    }
  } finally {
    if (epoch === requestEpoch) loading.value = false;
  }
}

async function loadAll(force: boolean): Promise<void> {
  if (!api?.attachmentListAll || (loading.value && !force)) return;
  const epoch = ++requestEpoch;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.attachmentListAll();
    if (mounted && open.value && epoch === requestEpoch && showAll.value) {
      allItems.value = result.items;
      allTruncated.value = result.truncated;
      loaded.value = true;
    }
  } catch (cause) {
    if (mounted && epoch === requestEpoch && showAll.value) {
      error.value = cause instanceof Error ? cause.message : "Unable to load attachments";
      loaded.value = true;
    }
  } finally {
    if (epoch === requestEpoch) loading.value = false;
  }
}

async function reload(): Promise<void> {
  refreshing.value = true;
  try {
    await load(true);
  } finally {
    refreshing.value = false;
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

// A click copies the absolute path, which works from any terminal or app; the relative one only from the
// workspace's own folder. Without a known root (a client that cannot see it) the relative path is all there is.
function copyClickedPath(row: Pick<AttachmentRow, "path" | "root">): Promise<void> {
  return row.root ? copyText(absoluteAttachmentPath(row.root, row.path), "Absolute path") : copyRelativePath(row.path);
}

function copyAbsolutePath(row: AttachmentRow): Promise<void> {
  closeMenu();
  if (!row.root) {
    showFeedback("Absolute path is unavailable for this workspace", true);
    return Promise.resolve();
  }
  return copyText(absoluteAttachmentPath(row.root, row.path), "Absolute path");
}

async function copyFileIntoClipboard(row: AttachmentRow): Promise<void> {
  closeMenu();
  if (!canNativeClipboard(row) || !api?.fileClipboardCopy) {
    showFeedback("Native file clipboard is available on the desktop only", true);
    return;
  }
  try {
    await api.fileClipboardCopy({ rootPath: row.root, relativePath: row.path });
    showFeedback("File copied into clipboard");
  } catch {
    showFeedback("Unable to copy file into clipboard", true);
  }
}

async function openAttachment(attachment: Pick<AttachmentRecord, "path" | "name"> & { root?: string }): Promise<void> {
  const root = attachment.root ?? props.workspaceRoot;
  if (!api?.openTerminalPath || !canOpen({ ...attachment, root } as AttachmentRow)) {
    showFeedback("Opening attachments is available on the desktop only", true);
    return;
  }
  try {
    const result = await api.openTerminalPath({
      path: attachment.path,
      workspaceCwd: root,
      forceSystem: true,
    });
    if (!result?.ok) {
      showFeedback(result?.error || "Unable to open attachment", true);
      return;
    }
    showFeedback(`Opened ${attachment.name}`);
  } catch {
    showFeedback("Unable to open attachment", true);
  }
}

function onRowKeydown(event: KeyboardEvent, row: AttachmentRow): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  void copyClickedPath(row);
}

function toggleMenu(transferId: string, event: MouseEvent): void {
  lastTrigger.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  openMenuId.value = openMenuId.value === transferId ? null : transferId;
  if (!openMenuId.value) return;
  menuStyle.value = {};
  void nextTick(() => {
    placeMenu();
    menuRef.value?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
  });
}

const MENU_GAP = 4;
const MENU_MARGIN = 8;
const menuStyle = ref<Record<string, string>>({});

// The menu is teleported to the body: inside the list it either pushed the row apart or was clipped by the
// scrolling list and the dock. It opens below its button, or above when there is more room there.
function placeMenu(): void {
  const menu = menuRef.value;
  const trigger = lastTrigger.value;
  if (!menu || !trigger) return;
  const anchor = trigger.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - MENU_GAP - MENU_MARGIN;
  const above = anchor.top - MENU_GAP - MENU_MARGIN;
  const upwards = menu.offsetHeight > below && above > below;
  menuStyle.value = {
    right: `${Math.max(MENU_MARGIN, window.innerWidth - anchor.right)}px`,
    ...(upwards
      ? { bottom: `${window.innerHeight - anchor.top + MENU_GAP}px` }
      : { top: `${anchor.bottom + MENU_GAP}px` }),
    maxHeight: `${Math.max(0, upwards ? above : below)}px`,
  };
}

// A fixed menu does not follow its row, so scrolling the list or resizing the window closes it.
function closeMenuOnViewportChange(event: Event): void {
  if (event.target instanceof Node && menuRef.value?.contains(event.target)) return;
  closeMenu();
}

watch(openMenuId, (id) => {
  if (id) {
    window.addEventListener("scroll", closeMenuOnViewportChange, true);
    window.addEventListener("resize", closeMenuOnViewportChange);
  } else {
    window.removeEventListener("scroll", closeMenuOnViewportChange, true);
    window.removeEventListener("resize", closeMenuOnViewportChange);
  }
});

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

async function deleteAttachment(attachment: AttachmentRow): Promise<void> {
  closeMenu();
  if (!api?.attachmentDelete || deletingId.value === attachment.transferId || !canDelete(attachment)) return;
  const targetWorkspaceId = attachment.workspaceId;
  const where = showAll.value ? `in ${attachment.workspaceName || "its workspace"}` : "in this workspace";
  if (!window.confirm(`Delete “${attachment.name}”? This removes the attachment for every tab ${where}.`)) return;
  deletingId.value = attachment.transferId;
  error.value = "";
  try {
    await api.attachmentDelete({
      workspaceId: targetWorkspaceId,
      transferId: attachment.transferId,
      name: attachment.name,
    });
    if (mounted && open.value && (showAll.value || props.workspaceId === targetWorkspaceId)) await load(true);
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
  // Listing every workspace of the machine reads every one of them; it does not need the 5 s of one workspace.
  pollTimer = setInterval(() => void load(), showAll.value ? 15_000 : 5000);
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
    attachments.value = [];
    // The machine-wide list does not depend on the active workspace.
    if (showAll.value) return;
    requestEpoch += 1;
    loading.value = false;
    loaded.value = false;
    filterQuery.value = "";
    selectedDay.value = "";
    closeMenu();
    feedback.value = null;
    if (open.value) void load(true);
  },
);

// A copy into this workspace that just succeeded: reload the list now, so its row shows "Copied" without waiting for the poll.
const reloadedCopies = new Set<string>(
  Object.values(peerCopies?.runs ?? {})
    .filter((run) => run.state === "succeeded")
    .map((run) => run.copyId),
);
watch(
  () => peerCopies?.runs,
  (runs) => {
    let arrived = false;
    for (const run of Object.values(runs ?? {})) {
      if (run.state !== "succeeded" || reloadedCopies.has(run.copyId)) continue;
      reloadedCopies.add(run.copyId);
      if (showAll.value || run.workspaceId === props.workspaceId) arrived = true;
    }
    if (arrived && open.value) void load(true);
  },
);

onMounted(() => {
  mounted = true;
  if (open.value) startPolling();
  if (peers) {
    releasePeers = peers.watch();
    void peers.open();
  }
});
onUnmounted(() => {
  mounted = false;
  requestEpoch += 1;
  stopPolling();
  releasePeers?.();
  if (feedbackTimer) clearTimeout(feedbackTimer);
  window.removeEventListener("scroll", closeMenuOnViewportChange, true);
  window.removeEventListener("resize", closeMenuOnViewportChange);
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
  flex: 1 0 auto;
  min-height: 100%;
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.workspace-attachments--panel .workspace-attachments__toggle {
  display: none;
}
.workspace-attachments--panel .workspace-attachments__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  max-height: none;
  padding: 0;
}
.workspace-attachments--panel {
  display: flex;
  flex-direction: column;
}
/* The framed panel reaches the bottom of the dock even with a short list. */
.workspace-attachments__content {
  flex: 1;
  min-width: 0;
}
.workspace-attachments__content.subtabs-panel {
  padding-top: 0;
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
  --cs-width: 96px;
  flex: 0 0 auto;
}
.workspace-attachments__day-filter :deep(.custom-select__button) {
  height: 24px;
  padding: 3px 6px;
  border-color: rgba(var(--tint), 0.12);
  background: var(--panel);
  color: var(--muted);
  font-size: 11px;
  line-height: 1;
}
.workspace-attachments--dragging {
  outline: 2px dashed var(--accent, #78a9ff);
  outline-offset: -2px;
}
.workspace-attachments__dropzone {
  margin: 8px 0;
  padding: 10px;
  border: 1px dashed var(--accent, #78a9ff);
  border-radius: 4px;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}
.workspace-attachments__add {
  padding: 3px 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.18));
  border-radius: 4px;
  color: inherit;
  background: transparent;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.workspace-attachments__add:hover:not(:disabled),
.workspace-attachments__add:focus-visible {
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.workspace-attachments__add:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.workspace-attachments__transfers {
  display: grid;
  gap: 6px;
  margin: 8px 0;
  padding: 0;
  list-style: none;
}
.workspace-attachments__transfer {
  display: grid;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid rgba(var(--tint), 0.12);
  border-radius: 4px;
  font-size: 11px;
}
.workspace-attachments__transfer--failed {
  border-color: var(--danger-fg);
}
.workspace-attachments__transfer-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.workspace-attachments__transfer-head strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-attachments__transfer-head small {
  color: var(--muted);
  white-space: nowrap;
}
.workspace-attachments__transfer-button {
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: 3px;
  color: var(--muted);
  background: transparent;
  font-size: 11px;
  cursor: pointer;
}
.workspace-attachments__transfer-button:hover,
.workspace-attachments__transfer-button:focus-visible {
  border-color: var(--border-color, rgba(255, 255, 255, 0.18));
  color: inherit;
}
.workspace-attachments__bar {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(var(--tint), 0.12);
}
.workspace-attachments__bar span {
  display: block;
  height: 100%;
  background: var(--accent, #78a9ff);
}
.workspace-attachments__transfer-error {
  margin: 0;
  color: var(--danger-fg);
}
.workspace-attachments__refresh,
.workspace-attachments__menu-trigger,
.workspace-attachments__open {
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
.workspace-attachments__open:hover,
.workspace-attachments__open:focus-visible,
.workspace-attachments__menu-trigger:hover,
.workspace-attachments__menu-trigger:focus-visible {
  border-color: var(--border-color, rgba(255, 255, 255, 0.18));
  color: inherit;
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.workspace-attachments__notice,
.workspace-attachments__status,
.workspace-attachments__feedback {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  max-width: calc(100% - 24px);
  margin: 0;
  padding: 4px 10px;
  overflow: hidden;
  transform: translateX(-50%);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-elevated, var(--panel));
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  color: var(--success-fg, #7bd88f);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
.workspace-attachments__status--wait {
  display: flex;
  align-items: center;
  gap: 8px;
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
.workspace-attachments {
  container: attachments / inline-size;
}
/* The tabs give way before the panel scrolls sideways. */
.workspace-attachments__scope .subtabs__tab {
  display: block;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.workspace-attachments__scope-hint {
  align-self: center;
  min-width: 0;
  margin-left: auto;
  padding-left: 8px;
  overflow: hidden;
  color: var(--muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-attachments__owner {
  grid-column: 1 / -1;
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
}
.workspace-attachments__open svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.workspace-attachments__menu {
  position: fixed;
  /* Above the notification dock (9000). */
  z-index: 9100;
  display: grid;
  width: max-content;
  min-width: 180px;
  overflow-y: auto;
  padding: 4px;
  color: var(--text);
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
@container attachments (max-width: 420px) {
  .workspace-attachments__scope-hint {
    display: none;
  }
}
/* A narrow dock: the filter takes its own line above the day filter and buttons. */
@container attachments (max-width: 360px) {
  .workspace-attachments__toolbar {
    flex-wrap: wrap;
  }
  .workspace-attachments__filter {
    flex-basis: 100%;
  }
  .workspace-attachments__day-filter {
    margin-right: auto;
  }
}
</style>
