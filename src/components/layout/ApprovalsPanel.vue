<template>
  <div class="approvals">
    <div class="approvals__toolbar">
      <input
        v-model="search"
        class="approvals__search"
        type="search"
        placeholder="Search workspace, panel, tool, command…"
        title="Filter the trail. Matches the workspace and panel names, the tool name and the command."
        @keyup.enter="reload"
      />
      <button
        v-if="canDelete && total > 0"
        type="button"
        class="approvals__clear"
        title="Delete every approval recorded for this profile. The rows are gone for good — only the count and time still go to strideterm.log."
        :disabled="busy"
        @click="clearAll"
      >
        Clear all
      </button>
    </div>

    <p v-if="error" class="approvals__error">{{ error }}</p>

    <div v-else-if="!loading && rows.length === 0" class="approvals__empty">
      <template v-if="search">Nothing matches “{{ search }}”. Clear the search to see the whole trail.</template>
      <template v-else>
        No approvals recorded yet. With auto-approve on, every permission prompt strIDEterm answers for you lands here.
      </template>
    </div>

    <div v-else class="approvals__list">
      <template v-for="row in timeline" :key="row.key">
        <div v-if="row.kind === 'separator'" class="notif-day-separator">
          <span class="notif-day-separator__line"></span>
          <span class="notif-day-separator__label">{{ row.label }}</span>
          <span class="notif-day-separator__line"></span>
        </div>

        <div v-else class="approval-row" :class="{ 'approval-row--open': openId === row.entry.id }">
          <button
            type="button"
            class="approval-row__main"
            :aria-expanded="openId === row.entry.id ? 'true' : 'false'"
            :title="row.entry.summary || row.entry.toolName || 'Approval'"
            @click="toggle(row.entry)"
          >
            <time class="approval-row__time" :title="absoluteTime(row.entry.timestamp)">{{
              clockTime(row.entry.timestamp)
            }}</time>
            <span class="approval-row__where" :title="where(row.entry)">{{ where(row.entry) }}</span>
            <span class="approval-row__tool">{{ row.entry.toolName || "—" }}</span>
            <span class="approval-row__summary">{{ row.entry.summary || "—" }}</span>
          </button>

          <div v-if="openId === row.entry.id" class="approval-detail">
            <pre class="approval-detail__command">{{ row.entry.summary || "(no command recorded)" }}</pre>
            <dl class="approval-detail__fields">
              <div>
                <dt>When</dt>
                <dd>{{ absoluteTime(row.entry.timestamp) }}</dd>
              </div>
              <div>
                <dt>Tool</dt>
                <dd>{{ row.entry.toolName || "—" }}</dd>
              </div>
              <div>
                <dt>Where</dt>
                <dd>{{ where(row.entry) }}</dd>
              </div>
              <div v-if="row.entry.decisionReason">
                <dt>Reason</dt>
                <dd>{{ row.entry.decisionReason }}</dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>{{ row.entry.outcome || "decision-issued" }}</dd>
              </div>
              <div v-if="row.entry.claudeSessionId">
                <dt>Claude session</dt>
                <dd class="approval-detail__mono" :title="TRANSCRIPT_HINT">{{ row.entry.claudeSessionId }}</dd>
              </div>
            </dl>
            <p class="approval-detail__caveat">
              strIDEterm issued this decision on the hook's stdout. Whether Claude Code acted on it is not something
              this side of the hook can observe — the row is evidence that strIDEterm answered, not that the tool ran.
            </p>
            <div class="approval-detail__actions">
              <button
                type="button"
                class="quick-action"
                title="Copy the whole row — when, where, tool, outcome, reason, Claude session id and the full command — as plain text, ready to paste into an issue."
                @click="copyDetails(row.entry)"
              >
                {{ copiedId === `details-${row.entry.id}` ? "Copied" : "Copy details" }}
              </button>
              <button
                type="button"
                class="quick-action"
                title="Copy just the command, with nothing around it."
                @click="copyCommand(row.entry)"
              >
                {{ copiedId === `command-${row.entry.id}` ? "Copied" : "Copy command" }}
              </button>
              <button
                v-if="canJump(row.entry)"
                type="button"
                class="quick-action"
                title="Open the workspace and panel this approval was issued for."
                @click="jump(row.entry)"
              >
                Jump
              </button>
              <button
                v-if="canDelete"
                type="button"
                class="quick-action quick-action--danger"
                title="Delete this row from the trail. It does not come back."
                :disabled="busy"
                @click="remove(row.entry)"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      </template>

      <button v-if="hasMore" type="button" class="approvals__more" :disabled="loading" @click="loadMore">
        {{ loading ? "Loading…" : `Load older (${shownLabel})` }}
      </button>
      <p v-else-if="rows.length > 0" class="approvals__end">{{ shownLabel }} · kept for 30 days</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { Transport } from "../../transport.js";
import { dayBandKey, dayBandLabel } from "../../app/helpers.js";

/**
 * The permission auto-approval trail, as a dock tab.
 *
 * It used to sit behind a `<details>` in Settings, which is the wrong shape
 * for it twice over: a modal with Cancel/Save is where you go to CHANGE
 * something, not to watch what happened while you were away, and at the dock's
 * width a five-column `<table>` truncates every column that matters. Rows here
 * are a grid that collapses to two lines when the dock is narrow, grouped by
 * the same day bands the Alerts tab uses.
 */

// Rows come from the shared audit-log store, whose formatter is untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApprovalEntry = Record<string, any>;

const TRANSCRIPT_HINT = "Cross-reference with ~/.claude/projects/<project>/<session_id>.jsonl";

const props = withDefaults(
  defineProps<{
    api?: Transport | null;
    /** Active profile — the trail is scoped to it, like every other dock tab. */
    profileId?: string;
    /** Page size, and the batch each "Load older" adds. */
    pageSize?: number;
    /**
     * The newest `approval:recorded` payload, and a counter that changes with
     * every one of them.
     *
     * The subscription itself lives in the dock, which is mounted for the life
     * of the renderer. This component is behind a `v-if` on its tab, and
     * neither transport's `onApprovalRecorded` hands back an unsubscribe — so
     * subscribing here would add a listener per tab switch and never drop one.
     */
    liveApproval?: unknown;
    liveSignal?: number;
  }>(),
  { api: null, profileId: "", pageSize: 40, liveSignal: 0 },
);

const emit = defineEmits<{
  (_e: "jump", _target: { workspaceId: string; viewId: string }): void;
  /** The trail's size changed — the dock decides whether to show this tab at all. */
  (_e: "count", _total: number): void;
}>();

const rows = ref<ApprovalEntry[]>([]);
const total = ref(0);
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const search = ref("");
const openId = ref<unknown>(null);
/** Which copy button last fired, as `<kind>-<row id>` — both buttons flash. */
const copiedId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/** Deleting is desktop-only — the remote transport does not define the call. */
const canDelete = computed(() => typeof props.api?.deleteApprovalAuditEntries === "function");
const hasMore = computed(() => rows.value.length < total.value);
const shownLabel = computed(() =>
  rows.value.length < total.value
    ? `${rows.value.length} of ${total.value}`
    : `${total.value} approval${total.value === 1 ? "" : "s"}`,
);

type Row =
  | { kind: "separator"; key: string; label: string; entry?: undefined }
  | { kind: "entry"; key: string; entry: ApprovalEntry };

/** Interleave the rows with day-band headings, newest band first. */
const timeline = computed((): Row[] => {
  const out: Row[] = [];
  let lastBand = "";
  for (const entry of rows.value) {
    const at = new Date(String(entry.timestamp || ""));
    if (Number.isNaN(at.getTime())) {
      out.push({ kind: "entry", key: `e-${entry.id}`, entry });
      continue;
    }
    const band = dayBandKey(at);
    if (band !== lastBand) {
      out.push({ kind: "separator", key: `sep-${band}`, label: dayBandLabel(at) });
      lastBand = band;
    }
    out.push({ kind: "entry", key: `e-${entry.id}`, entry });
  }
  return out;
});

/**
 * One page. `beforeId` is the store's own keyset cursor — the column it orders
 * by — so paging cannot lose or repeat a row the way a timestamp window does
 * when a burst of approvals inside one turn shares a millisecond.
 */
async function fetchPage(beforeId = 0): Promise<ApprovalEntry[]> {
  const query = props.api?.queryApprovalAuditLog;
  if (!query) {
    error.value = "The approval log is not available on this transport.";
    return [];
  }
  const result = (await query({
    limit: props.pageSize,
    ...(beforeId > 0 ? { beforeId } : {}),
    ...(search.value.trim() ? { search: search.value.trim() } : {}),
    ...(props.profileId ? { profileId: props.profileId } : {}),
  })) as { entries?: ApprovalEntry[]; total?: number };
  total.value = Number(result?.total) || 0;
  return Array.isArray(result?.entries) ? result.entries : [];
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await fetchPage(0);
    openId.value = null;
    emit("count", total.value);
  } catch (err) {
    error.value = (err instanceof Error ? err.message : "") || "Failed to read the approval log.";
  } finally {
    loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  const oldest = rows.value[rows.value.length - 1];
  const cursor = Math.floor(Number(oldest?.id) || 0);
  if (cursor <= 0) return;
  loading.value = true;
  try {
    rows.value = [...rows.value, ...(await fetchPage(cursor))];
  } catch (err) {
    error.value = (err instanceof Error ? err.message : "") || "Failed to read the approval log.";
  } finally {
    loading.value = false;
  }
}

async function deleteRows(payload: { ids?: number[]; all?: boolean }): Promise<boolean> {
  const call = props.api?.deleteApprovalAuditEntries;
  if (!call) return false;
  busy.value = true;
  error.value = "";
  try {
    await call({ ...payload, ...(props.profileId ? { profileId: props.profileId } : {}) });
    return true;
  } catch (err) {
    error.value = (err instanceof Error ? err.message : "") || "Failed to delete from the approval log.";
    return false;
  } finally {
    busy.value = false;
  }
}

async function remove(entry: ApprovalEntry): Promise<void> {
  const id = Math.floor(Number(entry?.id) || 0);
  if (id <= 0) return;
  if (!(await deleteRows({ ids: [id] }))) return;
  // Drop it locally rather than re-reading: a reload would also pull in
  // everything that arrived since, which is not what "delete this row" asked
  // for — the list would jump under the cursor.
  rows.value = rows.value.filter((row) => row.id !== entry.id);
  total.value = Math.max(0, total.value - 1);
  if (openId.value === entry.id) openId.value = null;
  emit("count", total.value);
}

async function clearAll(): Promise<void> {
  if (!(await deleteRows({ all: true }))) return;
  rows.value = [];
  total.value = 0;
  openId.value = null;
  emit("count", 0);
}

function toggle(entry: ApprovalEntry): void {
  openId.value = openId.value === entry.id ? null : entry.id;
}

function flash(key: string): void {
  copiedId.value = key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copiedId.value = null), 1200);
}

/**
 * The whole row as plain text, the way it would be pasted into an issue.
 *
 * Ids ride along even though the list keeps them in a tooltip: on screen a
 * column of uuids is noise, but in a bug report they are the only thing that
 * ties this approval to a log line. The command goes LAST, after a blank
 * line, so a multi-line one cannot break up the header block.
 */
function detailText(entry: ApprovalEntry): string {
  const lines = [
    `Approval sent · ${entry?.toolName || "unknown tool"} · ${absoluteTime(entry?.timestamp)}`,
    `Where: ${where(entry)} (workspace ${entry?.workspaceId || "—"}, panel ${entry?.sessionId || "—"})`,
    `Outcome: ${entry?.outcome || "decision-issued"} — strIDEterm answered the hook; this is not proof the tool ran.`,
  ];
  if (entry?.decisionReason) lines.push(`Reason: ${entry.decisionReason}`);
  if (entry?.claudeSessionId) lines.push(`Claude session: ${entry.claudeSessionId}`);
  lines.push("", String(entry?.summary || "(no command recorded)"));
  return lines.join("\n");
}

function copyDetails(entry: ApprovalEntry): void {
  void navigator.clipboard?.writeText(detailText(entry));
  flash(`details-${entry.id}`);
}

function copyCommand(entry: ApprovalEntry): void {
  const text = String(entry?.summary || entry?.toolName || "");
  if (!text) return;
  void navigator.clipboard?.writeText(text);
  flash(`command-${entry.id}`);
}

function canJump(entry: ApprovalEntry): boolean {
  return Boolean(String(entry?.workspaceId || ""));
}

function jump(entry: ApprovalEntry): void {
  emit("jump", {
    workspaceId: String(entry?.workspaceId || ""),
    viewId: String(entry?.sessionId || ""),
  });
}

/** "workspace › panel", in the names captured when the approval was issued. */
function where(entry: ApprovalEntry): string {
  const workspace = String(entry?.workspaceName || entry?.workspaceId || "");
  const panel = String(entry?.panelTitle || "");
  if (workspace && panel) return `${workspace} › ${panel}`;
  return workspace || panel || "—";
}

function clockTime(value: unknown): string {
  const at = new Date(String(value || ""));
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function absoluteTime(value: unknown): string {
  const at = new Date(String(value || ""));
  if (Number.isNaN(at.getTime())) return String(value || "—");
  return at.toLocaleString();
}

// Debounced search: typing must not run a SQLite query per keystroke, and
// Enter still runs it at once.
watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void reload(), 250);
});

// A profile switch is a different trail entirely.
watch(
  () => props.profileId,
  () => void reload(),
);

/**
 * A live approval shows up without the user reaching for Refresh.
 *
 * The event does not carry the row id the store assigned, and that id is what
 * paging and deleting key on, so this re-reads the newest page rather than
 * synthesising a row that could not then be acted on. A row that arrives while
 * a search is active is ignored unless it matches, so the list never
 * contradicts its own filter.
 */
watch(
  () => props.liveSignal,
  () => {
    const event = (props.liveApproval || {}) as ApprovalEntry;
    if (props.profileId && String(event.profileId || "") !== props.profileId) return;
    const term = search.value.trim().toLowerCase();
    if (term) {
      const haystack = [event.workspaceName, event.workspaceId, event.panelTitle, event.toolName, event.summary]
        .map((part) => String(part || "").toLowerCase())
        .join(" ");
      if (!haystack.includes(term)) return;
    }
    void reload();
  },
);

onMounted(() => {
  void reload();
});

onUnmounted(() => {
  clearTimeout(copiedTimer);
  clearTimeout(searchTimer);
});

defineExpose({ reload });
</script>
