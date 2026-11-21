<template>
  <section class="peer-attachments" :data-host-id="host.id" data-role="peer-attachments-host">
    <header class="peer-attachments__head">
      <button
        type="button"
        class="peer-attachments__toggle"
        data-role="peer-attachments-toggle"
        :aria-expanded="!collapsed"
        :title="collapsed ? 'Show the attachments of this desktop' : 'Hide the attachments of this desktop'"
        @click="copies.setCollapsed(host.id, !collapsed)"
      >
        <span
          :class="['disclosure-chevron', 'disclosure-chevron--down', !collapsed && 'disclosure-chevron--open']"
          aria-hidden="true"
        />
        <strong class="peer-attachments__label">{{ host.label }}</strong>
        <span class="peer-attachments__network" title="Another strIDEterm on your network">Network</span>
        <span v-if="online && listing && !collapsed && entries.length" class="peer-attachments__count">{{
          entries.length
        }}</span>
      </button>
      <button
        v-if="online && !collapsed"
        type="button"
        class="peer-attachments__icon-button"
        data-role="peer-attachments-refresh"
        :disabled="refreshing"
        :aria-busy="refreshing ? 'true' : undefined"
        :aria-label="`Refresh attachments of ${host.label}`"
        title="Reload the recent attachments of this desktop"
        @click="refreshManually"
      >
        <Spinner v-if="refreshing" size="sm" aria-hidden="true" />
        <template v-else>↻</template>
      </button>
    </header>
    <template v-if="!collapsed">
      <p v-if="!online" class="peer-attachments__status" data-role="peer-attachments-status">
        {{ statusText }}
        <button
          type="button"
          class="peer-attachments__link"
          data-role="peer-attachments-profiles"
          @click="openProfiles"
        >
          Open Profiles
        </button>
      </p>
      <template v-else>
        <p
          v-if="listing?.loading && !listing.loadedAt"
          class="peer-attachments__status peer-attachments__status--wait"
          role="status"
        >
          <Spinner size="sm" aria-hidden="true" />
          Loading attachments…
        </p>
        <p
          v-if="listing?.error"
          class="peer-attachments__status peer-attachments__status--error"
          role="alert"
          data-role="peer-attachments-error"
        >
          {{ listing.error }}
        </p>
        <p v-if="listing?.unsupported" class="peer-attachments__status" data-role="peer-attachments-unsupported">
          {{ listing.unsupported }}
        </p>
        <p
          v-if="listing && listing.loadedAt && !listing.error && !listing.unsupported && !entries.length"
          class="peer-attachments__status"
          data-role="peer-attachments-empty"
        >
          {{ filterQuery.trim() || selectedDay ? "No matching attachments." : "No recent attachments." }}
        </p>
        <ul v-if="shown.length" class="peer-attachments__list">
          <li
            v-for="row in shown"
            :key="`${row.item.workspaceId}:${row.item.transferId}`"
            class="peer-attachments__item"
            data-role="peer-attachment-row"
          >
            <div class="peer-attachments__row">
              <div class="peer-attachments__details">
                <time
                  class="peer-attachments__time"
                  :datetime="new Date(row.item.uploadedAt).toISOString()"
                  :title="new Date(row.item.uploadedAt).toLocaleString()"
                  >{{ timeLabel(row.item.uploadedAt) }}</time
                >
                <strong :title="row.item.name">{{ row.item.name }}</strong>
                <code :title="row.label" data-role="peer-attachment-label">{{ row.label }}</code>
              </div>
              <span v-if="row.copied" class="peer-attachments__badge" data-role="peer-attachment-copied">Copied</span>
              <small class="peer-attachments__size">{{ formatSize(row.item.size) }}</small>
            </div>
            <div class="peer-attachments__actions">
              <template v-if="row.running">
                <button
                  type="button"
                  class="peer-attachments__text-button"
                  data-role="peer-attachment-cancel"
                  :aria-label="`Cancel copying ${row.item.name}`"
                  @click="cancelCopy(row.running.copyId)"
                >
                  Cancel
                </button>
              </template>
              <template v-else>
                <button
                  v-if="row.local"
                  type="button"
                  class="peer-attachments__text-button"
                  data-role="peer-attachment-copy-path"
                  :aria-label="`Copy the path of ${row.item.name}`"
                  @click="emit('copy-path', row.local.path)"
                >
                  Copy path
                </button>
                <button
                  v-else
                  type="button"
                  class="peer-attachments__text-button"
                  data-role="peer-attachment-copy-here"
                  :disabled="row.busy || Boolean(unavailableReason)"
                  :title="unavailableReason || `Copy into ${targetName(row.retryTarget) || 'this workspace'}`"
                  :aria-label="`${row.failure ? 'Retry copying' : 'Copy'} ${row.item.name} ${row.retryTarget === workspaceId ? 'here' : `to ${targetName(row.retryTarget)}`}`"
                  @click="copyTo(row.item, row.retryTarget)"
                >
                  {{ row.failure ? "Retry" : "Copy here" }}
                </button>
                <button
                  v-if="row.failedRun"
                  type="button"
                  class="peer-attachments__text-button"
                  data-role="peer-attachment-discard"
                  :aria-label="`Discard the failed copy of ${row.item.name}`"
                  title="Remove what was copied so far and forget the failure"
                  @click="discardCopy(row.failedRun.copyId)"
                >
                  Discard
                </button>
                <button
                  v-if="canOpen"
                  type="button"
                  class="peer-attachments__icon-button"
                  data-role="peer-attachment-open"
                  :disabled="row.busy || Boolean(unavailableReason)"
                  :aria-label="`${row.local ? 'Open' : 'Copy here and open'} ${row.item.name}`"
                  :title="
                    unavailableReason ||
                    (row.local
                      ? `Open ${row.item.name} with the default app`
                      : `Copy into ${workspaceName || 'this workspace'} and open with the default app`)
                  "
                  @click="openCopy(row)"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                    <path d="M1.5 10s3.1-5.5 8.5-5.5 8.5 5.5 8.5 5.5-3.1 5.5-8.5 5.5S1.5 10 1.5 10Z" />
                    <circle cx="10" cy="10" r="2.5" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="peer-attachments__icon-button"
                  data-role="peer-attachment-menu-trigger"
                  aria-haspopup="menu"
                  :aria-expanded="menuId === row.item.transferId"
                  :aria-label="`Actions for ${row.item.name}`"
                  @click.stop="toggleMenu(row.item.transferId, $event)"
                >
                  ⋯
                </button>
              </template>
            </div>
            <div v-if="row.running" class="peer-attachments__progress">
              <small data-role="peer-attachment-progress">{{ progressLabel(row.running) }}</small>
              <div
                class="peer-attachments__bar"
                role="progressbar"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="percentOf(row.running)"
              >
                <span :style="{ width: `${percentOf(row.running)}%` }"></span>
              </div>
            </div>
            <p v-else-if="row.failure" class="peer-attachments__error" role="alert" data-role="peer-attachment-failure">
              {{ row.failure }}
            </p>
            <Teleport to="body">
              <div
                v-if="menuId === row.item.transferId"
                :ref="setMenuRef"
                class="peer-attachments__menu"
                role="menu"
                :aria-label="`Actions for ${row.item.name}`"
                :style="menuStyle"
                @click.stop
                @keydown.esc.stop.prevent="closeMenu"
                @keydown.tab.prevent="closeMenu"
              >
                <button
                  v-if="row.local"
                  type="button"
                  role="menuitem"
                  @click="
                    emit('copy-path', row.local.path);
                    closeMenu();
                  "
                >
                  Copy path
                </button>
                <button
                  v-else
                  type="button"
                  role="menuitem"
                  data-role="peer-attachment-menu-copy-here"
                  :disabled="Boolean(unavailableReason)"
                  :title="unavailableReason || `Copy into ${workspaceName || 'this workspace'}`"
                  @click="copyTo(row.item, workspaceId)"
                >
                  Copy here
                </button>
                <template v-if="otherTargets.length">
                  <span class="peer-attachments__menu-heading">Copy to</span>
                  <button
                    v-for="target in otherTargets"
                    :key="target.id"
                    type="button"
                    role="menuitem"
                    data-role="peer-attachment-copy-to"
                    :data-workspace-id="target.id"
                    @click="copyTo(row.item, target.id)"
                  >
                    {{ target.name }}
                  </button>
                </template>
              </div>
            </Teleport>
          </li>
        </ul>
        <button
          v-if="entries.length > PREVIEW_COUNT"
          type="button"
          class="peer-attachments__more"
          data-role="peer-attachments-show-all"
          @click="showAll = !showAll"
        >
          {{ showAll ? "Show fewer" : `Show all (${entries.length})` }}
        </button>
        <p v-if="listing?.truncated && showAll" class="peer-attachments__status">
          Only the most recent attachments are listed.
        </p>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch, type ComponentPublicInstance } from "vue";
import type { AttachmentRecord } from "../../attachments.js";
import type { PeerAttachedHost, PeerAttachmentItem } from "../../../electron/shared/peers.js";
import type { PeerAttachmentCopyRun } from "../../../electron/shared/peer-attachment-copy-events.js";
import { dayBandKey } from "../../app/helpers.js";
import { useDismissable } from "../../composables/useDismissable.js";
import { userFacingMessage } from "../../lib/error-message.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { usePeerAttachmentCopiesStore } from "../../stores/peer-attachment-copies.js";
import { usePeersStore } from "../../stores/peers.js";
import { formatBytes } from "../../stores/ssh-file-transfers.js";
import Spinner from "../common/Spinner.vue";

const PREVIEW_COUNT = 10;
const REFRESH_INTERVAL_MS = 30_000;

const props = defineProps<{
  host: PeerAttachedHost;
  workspaceId: string;
  workspaceName: string;
  unavailableReason: string;
  targets: Array<{ id: string; name: string }>;
  localAttachments: AttachmentRecord[];
  filterQuery: string;
  selectedDay: string;
  canOpen: boolean;
}>();
const emit = defineEmits<{
  "copy-path": [path: string];
  open: [attachment: { path: string; name: string }];
}>();

const copies = usePeerAttachmentCopiesStore();
const peers = usePeersStore();
const notifications = useNotificationStore();
const appStore = useAppStore();

const showAll = ref(false);
const refreshing = ref(false);
const busy = ref<Record<string, boolean>>({});
const startErrors = ref<Record<string, { message: string; workspaceId: string }>>({});
const menuId = ref<string | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const lastTrigger = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

const online = computed(() => props.host.state === "online");
const collapsed = computed(() => copies.isCollapsed(props.host.id));
const listing = computed(() => copies.listings[props.host.id]);
const otherTargets = computed(() => props.targets.filter((target) => target.id !== props.workspaceId));

const statusText = computed(() => {
  const label = props.host.label;
  switch (props.host.state) {
    case "offline":
      return `${label} is offline.`;
    case "not-paired":
      return `${label} no longer pairs with this desktop.`;
    case "version-mismatch":
      return `${label} runs a different version of strIDEterm.`;
    case "wrong-host":
      return `Another strIDEterm answers at the address of ${label}.`;
    default:
      return `Checking ${label}…`;
  }
});

function labelOf(item: PeerAttachmentItem): string {
  return `${item.profileName || item.profileId} / ${item.workspaceName || item.workspaceId}`;
}

interface Row {
  item: PeerAttachmentItem;
  label: string;
  local: AttachmentRecord | undefined;
  copied: boolean;
  running: PeerAttachmentCopyRun | undefined;
  failure: string;
  /** The failed run Discard acts on; absent when the failure is a start that was refused. */
  failedRun: PeerAttachmentCopyRun | undefined;
  /** Where Retry copies to: the workspace the failure was for, else this panel's. */
  retryTarget: string;
  busy: boolean;
}

const entries = computed(() => {
  const query = props.filterQuery.trim().toLowerCase();
  return (listing.value?.items ?? []).filter(
    (item) =>
      (!props.selectedDay || dayBandKey(new Date(item.uploadedAt)) === props.selectedDay) &&
      (!query || item.name.toLowerCase().includes(query) || labelOf(item).toLowerCase().includes(query)),
  );
});

const shown = computed<Row[]>(() =>
  (showAll.value ? entries.value : entries.value.slice(0, PREVIEW_COUNT)).map((item) => {
    const latest = copies.runFor(props.host.id, item.transferId);
    const running = latest && (latest.state === "queued" || latest.state === "running") ? latest : undefined;
    const local = props.localAttachments.find((attachment) => attachment.sha256 === item.sha256);
    const startError = startErrors.value[item.transferId];
    const failedRun = !startError && latest?.state === "failed" ? latest : undefined;
    const retryTarget = startError?.workspaceId ?? failedRun?.workspaceId ?? props.workspaceId;
    const message = startError?.message ?? (failedRun ? failedRun.error?.message || "The copy failed." : "");
    return {
      item,
      label: labelOf(item),
      local,
      copied: Boolean(local),
      running,
      failure:
        message && retryTarget !== props.workspaceId
          ? `Copy to ${targetName(retryTarget)} failed: ${message}`
          : message,
      failedRun,
      retryTarget,
      busy: busy.value[item.transferId] === true,
    };
  }),
);

function formatSize(size: number): string {
  return formatBytes(size);
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function percentOf(run: PeerAttachmentCopyRun): number {
  return run.bytesTotal > 0 ? Math.min(100, Math.floor((run.bytesDone / run.bytesTotal) * 100)) : 0;
}

function targetName(targetWorkspaceId: string): string {
  if (targetWorkspaceId === props.workspaceId) return props.workspaceName;
  return props.targets.find((candidate) => candidate.id === targetWorkspaceId)?.name ?? "another workspace";
}

function progressLabel(run: PeerAttachmentCopyRun): string {
  const target = props.targets.find((candidate) => candidate.id === run.workspaceId);
  const where = run.workspaceId === props.workspaceId || !target ? "" : ` to ${target.name}`;
  if (run.state === "queued") return `Waiting${where}…`;
  return `Copying${where}: ${percentOf(run)} % of ${formatSize(run.bytesTotal)}`;
}

function setBusy(transferId: string, value: boolean): void {
  const next = { ...busy.value };
  if (value) next[transferId] = true;
  else delete next[transferId];
  busy.value = next;
}

function setStartError(transferId: string, failure: { message: string; workspaceId: string } | null): void {
  const next = { ...startErrors.value };
  if (failure) next[transferId] = failure;
  else delete next[transferId];
  startErrors.value = next;
}

async function copyTo(item: PeerAttachmentItem, targetWorkspaceId: string, thenOpen = false): Promise<void> {
  closeMenu();
  if (!targetWorkspaceId || busy.value[item.transferId]) return;
  setStartError(item.transferId, null);
  setBusy(item.transferId, true);
  try {
    const copyId = await copies.start({
      hostId: props.host.id,
      source: {
        workspaceId: item.workspaceId,
        transferId: item.transferId,
        name: item.name,
        size: item.size,
        sha256: item.sha256,
      },
      targetWorkspaceId,
    });
    if (!thenOpen) return;
    const run = await copies.awaitFinished(copyId);
    if (run.state === "succeeded" && run.result && targetWorkspaceId === props.workspaceId) {
      emit("open", { path: run.result.path, name: run.result.name });
    }
  } catch (error) {
    setStartError(item.transferId, {
      message: userFacingMessage(error, "The copy could not be started."),
      workspaceId: targetWorkspaceId,
    });
    notifications.showError(`Could not copy ${item.name}`, error, { workspaceId: targetWorkspaceId });
  } finally {
    setBusy(item.transferId, false);
  }
}

function openCopy(row: Row): Promise<void> {
  if (row.local) {
    emit("open", { path: row.local.path, name: row.local.name });
    return Promise.resolve();
  }
  return copyTo(row.item, props.workspaceId, true);
}

async function cancelCopy(copyId: string): Promise<void> {
  try {
    await copies.cancel(copyId);
  } catch (error) {
    notifications.showError("Could not cancel the copy", error);
  }
}

async function discardCopy(copyId: string): Promise<void> {
  try {
    await copies.cancel(copyId);
  } catch (error) {
    notifications.showError("Could not discard the copy", error);
  }
}

function openProfiles(): void {
  appStore.openProfilesDialog();
}

async function refresh(manual = false): Promise<void> {
  if (!online.value || collapsed.value) return;
  try {
    await copies.loadListing(props.host.id);
  } catch (error) {
    if (manual) notifications.showError(`Could not load the attachments of ${props.host.label}`, error);
  }
}

async function refreshManually(): Promise<void> {
  refreshing.value = true;
  try {
    await peers.refresh(props.host.id);
    await refresh(true);
  } finally {
    refreshing.value = false;
  }
}

const polling = computed(() => online.value && !collapsed.value);

function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

watch(
  polling,
  (active) => {
    stopPolling();
    if (!active) return;
    void refresh();
    timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_INTERVAL_MS);
  },
  { immediate: true },
);

watch(
  () => props.selectedDay + props.filterQuery,
  () => (showAll.value = false),
);

function toggleMenu(transferId: string, event: MouseEvent): void {
  lastTrigger.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  menuId.value = menuId.value === transferId ? null : transferId;
  if (!menuId.value) return;
  menuStyle.value = {};
  void nextTick(() => {
    placeMenu();
    menuRef.value?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
  });
}

function placeMenu(): void {
  const menu = menuRef.value;
  const trigger = lastTrigger.value;
  if (!menu || !trigger) return;
  const anchor = trigger.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - 12;
  const above = anchor.top - 12;
  const upwards = menu.offsetHeight > below && above > below;
  menuStyle.value = {
    right: `${Math.max(8, window.innerWidth - anchor.right)}px`,
    ...(upwards ? { bottom: `${window.innerHeight - anchor.top + 4}px` } : { top: `${anchor.bottom + 4}px` }),
    maxHeight: `${Math.max(0, upwards ? above : below)}px`,
  };
}

function closeMenuOnViewportChange(event: Event): void {
  if (event.target instanceof Node && menuRef.value?.contains(event.target)) return;
  closeMenu();
}

watch(menuId, (id) => {
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
  menuId.value = null;
  const trigger = lastTrigger.value;
  if (trigger) void nextTick(() => trigger.focus());
}

useDismissable(
  computed(() => menuId.value !== null),
  menuRef,
  {
    onDismiss: closeMenu,
    eventName: "pointerdown",
    ignoreSelector: "[data-role='peer-attachment-menu-trigger']",
  },
);

onUnmounted(() => {
  stopPolling();
  window.removeEventListener("scroll", closeMenuOnViewportChange, true);
  window.removeEventListener("resize", closeMenuOnViewportChange);
});
</script>

<style scoped>
.peer-attachments {
  border-top: 1px solid rgba(var(--tint), 0.08);
  margin-top: 8px;
}
.peer-attachments__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 0;
}
.peer-attachments__toggle {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 14px;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 11px;
}
.peer-attachments__label {
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.peer-attachments__network {
  padding: 0 5px;
  border: 1px solid rgba(var(--tint), 0.16);
  border-radius: 8px;
  color: var(--muted);
  font-size: 10px;
}
.peer-attachments__count {
  min-width: 1.4em;
  padding: 1px 5px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--success-fg) 16%, transparent);
  color: var(--success-fg);
  text-align: center;
}
.peer-attachments__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 4px 14px 8px;
  color: var(--muted);
  font-size: 11px;
}
.peer-attachments__status--error {
  color: var(--danger-fg);
}
.peer-attachments__link,
.peer-attachments__more {
  padding: 0;
  border: 0;
  color: var(--accent, #78a9ff);
  background: transparent;
  font-size: 11px;
  cursor: pointer;
}
.peer-attachments__more {
  margin: 4px 14px 8px;
}
.peer-attachments__link:hover,
.peer-attachments__more:hover {
  text-decoration: underline;
}
.peer-attachments__list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
.peer-attachments__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 7px 10px 7px 14px;
  border-bottom: 1px solid rgba(var(--tint), 0.06);
  font-size: 11px;
}
.peer-attachments__item:hover,
.peer-attachments__item:focus-within {
  background: rgba(var(--tint), 0.05);
}
.peer-attachments__row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}
.peer-attachments__details {
  display: grid;
  min-width: 0;
  flex: 1;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: 4px 10px;
}
.peer-attachments__time {
  color: var(--muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.peer-attachments__details strong,
.peer-attachments__details code {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.peer-attachments__details strong {
  font-weight: 600;
}
.peer-attachments__details code {
  grid-column: 1 / -1;
  color: var(--muted);
  font-family: var(--mono, ui-monospace, monospace);
}
.peer-attachments__badge {
  padding: 0 5px;
  border-radius: 8px;
  color: var(--success-fg);
  background: color-mix(in srgb, var(--success-fg) 16%, transparent);
  font-size: 10px;
  white-space: nowrap;
}
.peer-attachments__size {
  min-width: 44px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.peer-attachments__actions {
  display: flex;
  align-items: center;
  gap: 3px;
}
.peer-attachments__progress {
  display: grid;
  grid-column: 1 / -1;
  gap: 4px;
  color: var(--muted);
}
.peer-attachments__bar {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(var(--tint), 0.12);
}
.peer-attachments__bar span {
  display: block;
  height: 100%;
  background: var(--accent, #78a9ff);
}
.peer-attachments__error {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--danger-fg);
}
.peer-attachments__text-button {
  padding: 2px 7px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.18));
  border-radius: 4px;
  color: inherit;
  background: transparent;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.peer-attachments__text-button:hover:not(:disabled),
.peer-attachments__text-button:focus-visible {
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.peer-attachments__text-button:disabled,
.peer-attachments__icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.peer-attachments__icon-button {
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
.peer-attachments__icon-button:hover:not(:disabled),
.peer-attachments__icon-button:focus-visible {
  border-color: var(--border-color, rgba(255, 255, 255, 0.18));
  color: inherit;
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.peer-attachments__icon-button svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.peer-attachments__menu {
  position: fixed;
  /* Above the notification dock (9000). */
  z-index: 9100;
  display: grid;
  width: max-content;
  min-width: 180px;
  max-width: 280px;
  overflow-y: auto;
  padding: 4px;
  color: var(--text);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.18));
  border-radius: 5px;
  background: var(--panel-elevated, var(--panel));
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.3);
}
.peer-attachments__menu button {
  padding: 6px 8px;
  overflow: hidden;
  border: 0;
  border-radius: 3px;
  color: inherit;
  background: transparent;
  font-size: 11px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.peer-attachments__menu button:hover,
.peer-attachments__menu button:focus-visible {
  background: color-mix(in srgb, var(--text) 10%, transparent);
  outline: none;
}
.peer-attachments__menu button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.peer-attachments__menu-heading {
  padding: 6px 8px 2px;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
}
/* A narrow dock (the container is the attachments panel): the actions take their own line under the row
   instead of squeezing the name, time and size into each other. */
@container attachments (max-width: 360px) {
  .peer-attachments__item {
    grid-template-columns: minmax(0, 1fr);
  }
  .peer-attachments__actions {
    justify-content: flex-end;
  }
}
</style>
