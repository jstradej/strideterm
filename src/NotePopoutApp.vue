<template>
  <div class="note-popout" :class="color && `note-popout--${color}`">
    <p v-if="initError" class="note-popout__message note-popout__message--error" role="alert">{{ initError }}</p>
    <p v-else-if="gone" class="note-popout__message" role="status">{{ gone }}</p>
    <div v-else-if="loadError" class="note-popout__message" role="alert">
      <span class="note-popout__error">{{ loadError }}</span>
      <button type="button" class="button button--ghost button--small" @click="reload()">Retry</button>
    </div>
    <p v-else-if="!loaded" class="note-popout__message" role="status">Loading note…</p>
    <template v-else>
      <textarea
        ref="editor"
        class="note-popout__editor"
        :aria-label="heading"
        :value="text"
        :maxlength="SIDEBAR_NOTE_MAX_LENGTH"
        :readonly="pending === 'undo'"
        :placeholder="placeholder"
        @input="edit(($event.target as HTMLTextAreaElement).value)"
        @blur="flush()"
      />
      <footer class="note-popout__footer">
        <div class="note-popout__row">
          <span v-if="pending" class="note-popout__status" role="status">{{
            pending === "undo" ? "Undoing…" : "Saving…"
          }}</span>
          <span v-else-if="!failed && dirty" class="note-popout__status" role="status">Unsaved</span>
          <span
            v-else-if="!failed && (stored.revision > 0 || target?.kind === 'tab')"
            class="note-popout__status"
            role="status"
            >Saved</span
          >
          <span v-else class="note-popout__status"></span>
          <button
            v-if="canUndo && !failed && !dirty && !pending"
            type="button"
            class="button button--ghost button--small"
            @click="undo()"
          >
            Undo last save
          </button>
        </div>
        <div v-if="failed" class="note-popout__problem" role="alert">
          <span class="note-popout__error">{{ error }}</span>
          <div v-if="conflict" class="note-popout__actions">
            <button type="button" class="button button--ghost button--small" :disabled="resolving" @click="loadSaved()">
              Load the saved version
            </button>
            <button type="button" class="button button--ghost button--small" :disabled="resolving" @click="keepMine()">
              Keep mine
            </button>
          </div>
          <div v-else class="note-popout__actions">
            <button type="button" class="button button--ghost button--small" @click="retry()">Retry</button>
            <button type="button" class="button button--ghost button--small" @click="discard()">
              Discard my changes
            </button>
          </div>
        </div>
      </footer>
    </template>
    <PersistentToastStack />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PanelState, WorkspaceState } from "../electron/shared/types/state.js";
import { SIDEBAR_NOTE_MAX_LENGTH, type NotePopoutTarget, type SidebarNote } from "../electron/shared/sidebar-notes.js";
import PersistentToastStack from "./components/layout/PersistentToastStack.vue";
import { userFacingMessage } from "./lib/error-message.js";
import { rlog } from "./lib/renderer-log.js";
import { useAppStore } from "./stores/app.js";
import { apiKey } from "./types/keys.js";

type Stored = Pick<SidebarNote, "text" | "revision" | "canUndo" | "color">;
interface Source {
  load: () => Promise<Stored | null>;
  save: (text: string, expectedRevision: number) => Promise<Stored>;
  undo?: (expectedRevision: number) => Promise<Stored>;
}

const SAVE_DELAY_MS = 1000;
const CONFLICT = /has changed/i;
const GONE =
  /unavailable in the active profile|outside the active profile|not found|unknown|no longer|not paired|not online/i;

const api = inject(apiKey);
const appStore = useAppStore();
const target = ref<NotePopoutTarget | null>(null);
const initError = ref("");
const loaded = ref(false);
const gone = ref("");
const loadError = ref("");
const text = ref("");
const stored = ref<Stored>({ text: "", revision: 0, canUndo: false });
const color = computed(() => (target.value?.kind === "note" ? stored.value.color : undefined));
const pending = ref<"save" | "undo" | null>(null);
const failed = ref<"save" | "undo" | null>(null);
const error = ref("");
const conflict = ref(false);
const resolving = ref(false);
const installationName = ref("");
const hostLabel = ref("");
const editor = ref<HTMLTextAreaElement | null>(null);

let source: Source | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> | null = null;
let loadGeneration = 0;
let closing = false;
let closeAllowed = false;
let offHostNote: (() => void) | undefined;

const isTab = () => target.value?.kind === "tab";
const same = (a: string, b: string) => (isTab() ? a.trim() === b.trim() : a === b);
const dirty = computed(
  () => !same(text.value, stored.value.text) && (isTab() || stored.value.revision > 0 || !!text.value.trim()),
);
const canUndo = computed(() => target.value?.kind !== "tab" && stored.value.canUndo);

const placeholder = computed(() =>
  target.value?.kind === "tab" ? "What to remember about this tab…" : "Write a note…",
);

function findTab(viewId: string, profileId: string): { workspace: WorkspaceState; panel: PanelState } | null {
  const workspaces = (appStore.payload?.appState?.workspaces ?? []) as WorkspaceState[];
  const workspace = workspaces.find((entry) => viewId.startsWith(entry.id + ":"));
  if (!workspace || (workspace.profileId || "default") !== profileId) return null;
  const panelId = viewId.slice(workspace.id.length + 1);
  const panel = workspace.panels?.find((entry) => entry.id === panelId);
  return panel ? { workspace, panel } : null;
}

const tabTitle = computed(() => {
  const t = target.value;
  return t?.kind === "tab" ? findTab(t.viewId, t.profileId)?.panel.title || "tab" : "";
});

const heading = computed(() => {
  const t = target.value;
  if (!t) return "Note";
  if (t.kind === "installation")
    return installationName.value ? `Global — This computer (${installationName.value})` : "Global — This computer";
  if (t.kind === "host") return `Global — ${hostLabel.value || "another computer"}`;
  if (t.kind === "tab") return `Tab note — ${tabTitle.value || "tab"}`;
  return stored.value.text.trim().split(/\r?\n/, 1)[0] || "Note";
});

watch(heading, (title) => (document.title = title), { immediate: true });

function buildSource(next: NotePopoutTarget): Source {
  const bridge = api;
  if (!bridge) throw new Error("Notes are unavailable.");
  if (next.kind === "note") {
    const scope = { profileId: next.profileId, workspaceId: next.workspaceId };
    return {
      load: async () => {
        if (!bridge.listSidebarNotes) throw new Error("Notes are unavailable.");
        const notes = await bridge.listSidebarNotes(scope);
        const record = (next.workspaceId ? notes.workspace : notes.global).find((entry) => entry.id === next.noteId);
        return record ?? null;
      },
      save: (value, expectedRevision) => {
        if (!bridge.saveSidebarNote) throw new Error("Notes are unavailable.");
        return bridge.saveSidebarNote({ ...scope, id: next.noteId, text: value, expectedRevision });
      },
      undo: (expectedRevision) => {
        if (!bridge.undoSidebarNote) throw new Error("Notes are unavailable.");
        return bridge.undoSidebarNote({ ...scope, id: next.noteId, expectedRevision });
      },
    };
  }
  if (next.kind === "tab") {
    return {
      load: async () => {
        const found = findTab(next.viewId, next.profileId);
        return found ? { text: (found.panel.notes as string | undefined) || "", revision: 0, canUndo: false } : null;
      },
      save: async (value) => {
        await appStore.saveTabNote(next.viewId, value);
        return { text: value.trim(), revision: 0, canUndo: false };
      },
    };
  }
  const calls =
    next.kind === "host"
      ? {
          get: () => bridge.getPeerGlobalNote?.(next.hostId),
          save: (input: { text: string; expectedRevision: number }) => bridge.savePeerGlobalNote?.(next.hostId, input),
          undo: (input: { expectedRevision: number }) => bridge.undoPeerGlobalNote?.(next.hostId, input),
        }
      : {
          get: () => bridge.getInstallationNote?.(),
          save: (input: { text: string; expectedRevision: number }) => bridge.saveInstallationNote?.(input),
          undo: (input: { expectedRevision: number }) => bridge.undoInstallationNote?.(input),
        };
  const unwrap = async (result: ReturnType<typeof calls.get>) => {
    const value = await result;
    if (!value) throw new Error("Notes are unavailable.");
    installationName.value = value.installationName;
    return value.note;
  };
  return {
    load: () => unwrap(calls.get()),
    save: (value, expectedRevision) => unwrap(calls.save({ text: value, expectedRevision })),
    undo: (expectedRevision) => unwrap(calls.undo({ expectedRevision })),
  };
}

async function loadHostLabel(hostId: string) {
  try {
    const hosts = await api?.listPeerHosts?.();
    hostLabel.value = hosts?.find((host) => host.id === hostId)?.label || "";
  } catch {
    hostLabel.value = "";
  }
}

function apply(next: Stored) {
  stored.value = { text: next.text, revision: next.revision, canUndo: next.canUndo, color: next.color };
  text.value = next.text;
}

async function reload() {
  if (!source) return;
  const generation = ++loadGeneration;
  try {
    const result = await source.load();
    if (generation !== loadGeneration) return;
    loadError.value = "";
    if (!result) {
      gone.value = "This note no longer exists.";
      return;
    }
    gone.value = "";
    loaded.value = true;
    if (!pending.value && !failed.value && !dirty.value) apply(result);
    else stored.value = { ...stored.value, color: result.color };
  } catch (cause) {
    if (generation !== loadGeneration) return;
    const message = userFacingMessage(cause, "Couldn't load the note.");
    if (GONE.test(message)) gone.value = "This note is no longer available.";
    else if (!loaded.value) loadError.value = message;
  }
}

function clearSaveTimer() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
}

function edit(value: string) {
  text.value = value;
  if (failed.value === "undo") failed.value = null;
  clearSaveTimer();
  if (dirty.value && !failed.value) saveTimer = setTimeout(() => void run("save"), SAVE_DELAY_MS);
}

function flush() {
  clearSaveTimer();
  if (dirty.value && !pending.value && !failed.value) void run("save");
}

function run(action: "save" | "undo"): Promise<void> {
  if (pending.value) return inflight ?? Promise.resolve();
  inflight = mutate(action).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function mutate(action: "save" | "undo") {
  if (!source) return;
  clearSaveTimer();
  const sent = text.value;
  const expectedRevision = stored.value.revision;
  pending.value = action;
  failed.value = null;
  conflict.value = false;
  try {
    const result =
      action === "save"
        ? await source.save(sent, expectedRevision)
        : await (source.undo ?? (() => Promise.reject(new Error("Undo is unavailable."))))(expectedRevision);
    stored.value = { text: result.text, revision: result.revision, canUndo: result.canUndo, color: result.color };
    if (action === "undo" || same(text.value, sent)) text.value = result.text;
  } catch (cause) {
    failed.value = action;
    error.value = userFacingMessage(cause, action === "save" ? "Couldn't save note." : "Couldn't undo save.");
    conflict.value = CONFLICT.test(error.value);
    rlog("warn", "[notes] note popout could not " + action, { message: error.value });
  } finally {
    pending.value = null;
    if (dirty.value && !failed.value) saveTimer = setTimeout(() => void run("save"), SAVE_DELAY_MS);
  }
}

const undo = () => void run("undo");

function retry() {
  const action = failed.value;
  if (action && !pending.value) void run(action);
}

function discard() {
  if (pending.value) return;
  text.value = stored.value.text;
  failed.value = null;
  conflict.value = false;
}

async function latestSaved(): Promise<Stored | null> {
  resolving.value = true;
  try {
    const latest = await source?.load();
    if (!latest) {
      gone.value = "This note no longer exists.";
      return null;
    }
    return latest;
  } catch (cause) {
    error.value = userFacingMessage(cause, "Couldn't load the latest saved note.");
    return null;
  } finally {
    resolving.value = false;
  }
}

async function loadSaved() {
  const latest = await latestSaved();
  if (!latest) return;
  apply(latest);
  failed.value = null;
  conflict.value = false;
}

async function keepMine() {
  const latest = await latestSaved();
  if (!latest) return;
  stored.value = { text: latest.text, revision: latest.revision, canUndo: latest.canUndo };
  failed.value = null;
  conflict.value = false;
  if (dirty.value) void run("save");
}

async function saveBeforeClose() {
  clearSaveTimer();
  if (inflight) await inflight;
  if (dirty.value) {
    failed.value = null;
    conflict.value = false;
    await run("save");
  }
  return !failed.value && !dirty.value;
}

async function closeAfterSave() {
  if (closing) return;
  closing = true;
  try {
    if (await saveBeforeClose()) {
      closeAllowed = true;
      window.close();
    }
  } finally {
    closing = false;
  }
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (closeAllowed || !loaded.value || (!dirty.value && !pending.value)) return;
  event.preventDefault();
  event.returnValue = "";
  void closeAfterSave();
}

watch(
  () => {
    const t = target.value;
    if (t?.kind === "note") return appStore.payload?.sidebarNotesRevisions?.[t.profileId] ?? 0;
    if (t?.kind === "installation") return appStore.payload?.installationNoteRevision ?? 0;
    if (t?.kind === "tab") return findTab(t.viewId, t.profileId)?.panel.notes ?? null;
    return 0;
  },
  (value, previous) => {
    if (value !== previous) void reload();
  },
);

onMounted(async () => {
  window.addEventListener("beforeunload", onBeforeUnload);
  try {
    const init = await api?.getNotePopoutInit?.();
    if (!init) throw new Error("This window has no note to show. Close it and pop the note out again.");
    target.value = init;
    source = buildSource(init);
    if (init.kind === "host") {
      void loadHostLabel(init.hostId);
      offHostNote = api?.onPeerHostNoteChanged?.((payload) => {
        if (payload.hostId === init.hostId) void reload();
      });
    }
    await reload();
    if (loaded.value) void nextTick(() => editor.value?.focus());
  } catch (cause) {
    rlog("error", "[notes] Could not start the note window", { message: (cause as Error)?.message || String(cause) });
    initError.value = userFacingMessage(cause, "Could not open the note.");
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
  offHostNote?.();
  clearSaveTimer();
});
</script>

<style scoped>
.note-popout {
  height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font-size: var(--font-size-body, 13px);
}
.note-popout--green {
  --note-color: var(--success);
}
.note-popout--orange {
  --note-color: var(--status-running, #ffa424);
}
.note-popout--red {
  --note-color: var(--danger);
}
.note-popout--green,
.note-popout--orange,
.note-popout--red {
  box-sizing: border-box;
  border-left: 3px solid var(--note-color);
  background:
    linear-gradient(
      color-mix(in srgb, var(--note-color) 12%, transparent),
      color-mix(in srgb, var(--note-color) 12%, transparent)
    ),
    var(--bg);
}
.note-popout__editor {
  flex: 1;
  min-height: 0;
  resize: none;
  padding: 12px 14px;
  border: 0;
  border-radius: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.5;
}
.note-popout__footer {
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  font-size: 11px;
}
.note-popout__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
}
.note-popout__status {
  flex: 1;
  color: var(--muted);
}
.note-popout__problem {
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px solid var(--danger);
  border-radius: 5px;
}
.note-popout__error {
  color: var(--danger);
  overflow-wrap: anywhere;
}
.note-popout__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 5px;
}
.note-popout__message {
  margin: auto;
  padding: 0 16px;
  color: var(--muted);
  text-align: center;
}
.note-popout__message--error {
  color: var(--danger);
}
</style>
