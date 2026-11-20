<template>
  <Teleport v-if="host" :to="host">
    <div class="sidebar-notes">
      <div v-if="loadError" class="sidebar-notes__load-error">
        <span role="alert" :title="loadError">{{ loadError }}</span>
        <button type="button" @click="reload">Retry</button>
      </div>
      <div
        ref="split"
        class="sidebar-notes__split"
        :class="{ 'sidebar-notes__split--automatic': workspaceSize === null }"
        :style="
          workspaceSize === null
            ? undefined
            : { '--notes-workspace-size': workspaceSize + 'fr', '--notes-global-size': 100 - workspaceSize + 'fr' }
        "
      >
        <template v-for="(section, index) in sections" :key="section.kind">
          <div
            v-if="index === 1"
            class="sidebar-notes__divider"
            role="separator"
            tabindex="0"
            aria-label="Resize workspace and all-workspaces notes"
            aria-orientation="horizontal"
            :aria-valuenow="workspaceSize ?? undefined"
            :aria-valuetext="workspaceSize === null ? 'Automatic' : undefined"
            :aria-valuemin="minimumWorkspaceSize"
            :aria-valuemax="80"
            @keydown="resizeWithKeyboard"
            @pointerdown="startResize"
            @pointermove="moveResize"
            @pointerup="endResize"
            @pointercancel="endResize"
            @lostpointercapture="endResize"
          ></div>
          <section
            class="sidebar-notes__section"
            :class="'sidebar-notes__section--' + section.kind"
            :aria-label="section.label"
            :style="section.accent ? { '--notes-section-accent': section.accent } : undefined"
          >
            <header class="sidebar-notes__heading">
              <div class="sidebar-notes__heading-label">
                <h3>{{ section.label }}</h3>
                <span v-if="section.context" class="sidebar-notes__context" :title="section.context">{{
                  section.context
                }}</span>
                <span
                  v-if="section.collection?.notes.length"
                  class="sidebar-notes__count"
                  :aria-label="
                    section.collection.notes.length === 1 ? '1 note' : section.collection.notes.length + ' notes'
                  "
                  >{{ section.collection.notes.length }}</span
                >
              </div>
              <button
                type="button"
                class="sidebar-notes__add"
                :aria-label="section.addLabel"
                :title="section.addLabel"
                :disabled="!section.collection || loading"
                @click="section.collection && createNote(section.collection)"
              >
                <span aria-hidden="true">+</span>
              </button>
            </header>
            <div class="sidebar-notes__scroll">
              <div
                v-if="section.kind === 'workspace' && tabNote"
                class="sidebar-notes__tab-note"
                :class="{ 'sidebar-notes__tab-note--editing': tabDraft?.editing }"
                @focusout="leaveTabNote"
              >
                <div class="sidebar-notes__tab-heading">
                  <span class="sidebar-notes__tab-label">Tab</span>
                  <span class="sidebar-notes__tab-title" :title="tabNote.title">{{ tabNote.title }}</span>
                  <template v-if="tabDraft && (tabDraft.editing || tabDraft.pending) && !tabDraft.error">
                    <span
                      v-if="tabDraft.pending"
                      class="sidebar-notes__tab-status"
                      role="status"
                      aria-label="Saving tab note…"
                    >
                      <span class="sidebar-notes__spinner" aria-hidden="true"></span>
                      Saving…
                    </span>
                    <span v-else-if="tabDraftDirty(tabDraft)" class="sidebar-notes__tab-status" role="status">
                      Unsaved changes
                    </span>
                    <span v-else class="sidebar-notes__tab-status sidebar-notes__status--saved" role="status">
                      ✓ Saved
                    </span>
                  </template>
                </div>
                <textarea
                  v-if="tabDraft?.editing"
                  data-tab-note-editor
                  :aria-label="'Note for tab ' + tabNote.title"
                  :value="tabDraft.text"
                  :maxlength="SIDEBAR_NOTE_MAX_LENGTH"
                  placeholder="What to remember about this tab…"
                  :style="editorStyle('tab')"
                  @input="editTabNote(($event.target as HTMLTextAreaElement).value)"
                  @keydown.esc="escapeTabNote"
                />
                <div
                  v-if="tabDraft?.editing"
                  class="sidebar-notes__grip"
                  role="separator"
                  tabindex="0"
                  aria-orientation="horizontal"
                  aria-label="Resize tab note editor"
                  :aria-valuenow="editorHeight('tab') ?? undefined"
                  :aria-valuetext="editorHeight('tab') === null ? 'Automatic' : undefined"
                  title="Drag to resize, double-click to reset"
                  @mousedown.prevent
                  @pointerdown="startEditorResize"
                  @pointermove="moveEditorResize('tab', $event)"
                  @pointerup="endEditorResize('tab', $event)"
                  @pointercancel="endEditorResize('tab', $event)"
                  @lostpointercapture="endEditorResize('tab', $event)"
                  @dblclick="setEditorHeight('tab', null, true)"
                  @keydown="resizeEditorWithKeyboard('tab', $event)"
                ></div>
                <button
                  v-else
                  type="button"
                  class="sidebar-notes__tab-body"
                  :class="{ 'sidebar-notes__tab-body--empty': !tabNoteText }"
                  :title="'Edit note for tab ' + tabNote.title"
                  @click="openTabNote"
                >
                  <span class="sidebar-notes__tab-text">{{ tabNoteText || "Add a note for this tab…" }}</span>
                </button>
                <div v-if="tabDraft?.error" class="sidebar-notes__problem" role="alert">
                  <span class="sidebar-notes__error">{{ tabDraft.error }}</span>
                  <div class="sidebar-notes__problem-actions">
                    <button type="button" @click="tabDraft && saveTabDraft(tabDraft)">Retry</button>
                  </div>
                </div>
              </div>
              <div v-if="section.collection">
                <p v-if="loading && !section.collection.notes.length" class="sidebar-notes__hint">Loading…</p>
                <button
                  v-else-if="!loadError && !section.collection.notes.length"
                  type="button"
                  class="sidebar-notes__empty"
                  @click="createNote(section.collection)"
                >
                  {{ section.emptyText }} <span>Add a note</span>
                </button>
                <article
                  v-for="note in section.collection.notes"
                  :key="note.id"
                  class="sidebar-notes__note"
                  :class="{ 'sidebar-notes__note--open': section.collection.activeId === note.id }"
                >
                  <button
                    class="sidebar-notes__note-title"
                    type="button"
                    :data-note-toggle="note.id"
                    :aria-expanded="section.collection.activeId === note.id"
                    @click="toggleEditor(section.collection, note)"
                  >
                    <svg class="sidebar-notes__chevron" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span class="sidebar-notes__note-text">
                      <span class="sidebar-notes__note-name">{{ titleOf(note.text) }}</span>
                      <span
                        v-if="section.collection.activeId !== note.id && previewOf(note.text)"
                        class="sidebar-notes__note-preview"
                        >{{ previewOf(note.text) }}</span
                      >
                    </span>
                    <span
                      v-if="note.failed || note.text !== note.storedText"
                      class="sidebar-notes__unsaved"
                      :class="{ 'sidebar-notes__unsaved--failed': note.failed }"
                      :title="note.failed ? 'Not saved' : 'Unsaved changes'"
                    ></span>
                  </button>
                  <div v-if="section.collection.activeId === note.id" class="sidebar-notes__editor">
                    <textarea
                      :data-note-editor="note.id"
                      :aria-label="section.label + ' note text'"
                      :value="note.text"
                      :maxlength="SIDEBAR_NOTE_MAX_LENGTH"
                      :readonly="note.pending === 'undo'"
                      :placeholder="section.placeholder"
                      :style="editorStyle('note')"
                      @input="editNote(section.collection, note, ($event.target as HTMLTextAreaElement).value)"
                      @blur="flushSave(section.collection, note)"
                      @keydown.esc="closeEditor(section.collection, note, $event)"
                    />
                    <div
                      class="sidebar-notes__grip"
                      role="separator"
                      tabindex="0"
                      aria-orientation="horizontal"
                      aria-label="Resize note editor"
                      :aria-valuenow="editorHeight('note') ?? undefined"
                      :aria-valuetext="editorHeight('note') === null ? 'Automatic' : undefined"
                      title="Drag to resize, double-click to reset"
                      @mousedown.prevent
                      @pointerdown="startEditorResize"
                      @pointermove="moveEditorResize('note', $event)"
                      @pointerup="endEditorResize('note', $event)"
                      @pointercancel="endEditorResize('note', $event)"
                      @lostpointercapture="endEditorResize('note', $event)"
                      @dblclick="setEditorHeight('note', null, true)"
                      @keydown="resizeEditorWithKeyboard('note', $event)"
                    ></div>
                    <div v-if="note.failed" class="sidebar-notes__problem" role="alert">
                      <span class="sidebar-notes__error">{{ note.error }}</span>
                      <div class="sidebar-notes__problem-actions">
                        <button type="button" @click="retry(section.collection, note)">Retry</button>
                        <button v-if="!note.latest" type="button" @click="reviewLatest(section.collection, note)">
                          Review latest
                        </button>
                      </div>
                    </div>
                    <div v-if="note.latest" class="sidebar-notes__recovery">
                      <p>Latest saved text</p>
                      <pre>{{ note.latest.text || "(Empty)" }}</pre>
                      <div class="sidebar-notes__problem-actions">
                        <button type="button" @click="resolveDraft(section.collection, note, false)">Use latest</button>
                        <button
                          v-if="note.failed === 'save'"
                          type="button"
                          @click="resolveDraft(section.collection, note, true)"
                        >
                          Save my draft
                        </button>
                      </div>
                    </div>
                    <div class="sidebar-notes__editor-actions">
                      <span
                        v-if="noteStatus(note) === 'saving' || noteStatus(note) === 'undoing'"
                        class="sidebar-notes__status"
                        role="status"
                        :aria-label="noteStatus(note) === 'undoing' ? 'Undoing…' : 'Saving…'"
                      >
                        <span class="sidebar-notes__spinner" aria-hidden="true"></span>
                        {{ noteStatus(note) === "undoing" ? "Undoing…" : "Saving…" }}
                      </span>
                      <span v-else-if="noteStatus(note) === 'unsaved'" class="sidebar-notes__status" role="status">
                        Unsaved changes
                      </span>
                      <span
                        v-else-if="noteStatus(note) === 'saved'"
                        class="sidebar-notes__status sidebar-notes__status--saved"
                        role="status"
                      >
                        ✓ Saved
                      </span>
                      <span v-else-if="noteStatus(note) === 'new'" class="sidebar-notes__status">
                        Saves automatically as you type
                      </span>
                      <span v-else class="sidebar-notes__status"></span>
                      <button
                        v-if="note.canUndo && !note.failed"
                        type="button"
                        class="sidebar-notes__link"
                        :disabled="!!note.pending || note.text !== note.storedText"
                        @click="undo(section.collection, note)"
                      >
                        Undo last save
                      </button>
                      <button
                        v-if="note.revision === 0 && !note.text.trim() && !note.pending"
                        type="button"
                        class="sidebar-notes__link"
                        @click="discardEmpty(section.collection, note)"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                </article>
              </div>
              <p v-else class="sidebar-notes__hint">Select a workspace to write workspace notes.</p>
            </div>
          </section>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { SIDEBAR_NOTE_MAX_LENGTH } from "../../../electron/shared/sidebar-notes.js";
import type { SidebarNote, SidebarNotesScope } from "../../../electron/shared/sidebar-notes.js";
import type { getWorkspacePanelByViewId } from "../../app/selectors.js";
import { userFacingMessage } from "../../lib/error-message.js";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";

const props = defineProps<{ host: HTMLElement | null; profileId: string; workspaceId?: string | null }>();
const appStore = useAppStore();
const injectedApi = inject(apiKey);
const getApi = () => injectedApi ?? appStore.getApi();
const split = ref<HTMLElement | null>(null);
const workspaceSize = ref<number | null>(null);
const minimumWorkspaceSize = ref(20);
const loading = ref(false);
const loadError = ref("");

const SAVE_DELAY_MS = 1000;

type Mutation = "save" | "undo";
interface Draft extends SidebarNote {
  storedText: string;
  pending: Mutation | null;
  failed: Mutation | null;
  error: string;
  latest: SidebarNote | null;
}
interface Collection {
  scope: SidebarNotesScope;
  notes: Draft[];
  activeId: string;
}

const collections = reactive(new Map<string, Collection>());
const saveTimers = new Map<Draft, ReturnType<typeof setTimeout>>();
let refreshGeneration = 0;
let mutationGeneration = 0;
let disposed = false;
let dragPointer: number | null = null;
let dragGrabOffset = 0;

function collectionFor(profileId: string, workspaceId: string | null): Collection {
  const key = JSON.stringify([profileId, workspaceId]);
  let collection = collections.get(key);
  if (!collection) {
    collection = reactive({ scope: { profileId, workspaceId }, notes: [] as Draft[], activeId: "" });
    collections.set(key, collection);
  }
  return collection;
}

const workspace = computed(() => (props.workspaceId ? collectionFor(props.profileId, props.workspaceId) : null));
const global = computed(() => collectionFor(props.profileId, null));
const currentWorkspace = computed(() =>
  appStore.payload?.appState?.workspaces?.find(
    (candidate) => candidate.id === props.workspaceId && (candidate.profileId || "default") === props.profileId,
  ),
);
const profileName = computed(() => {
  const profiles = appStore.payload?.appState?.profiles ?? [];
  if (profiles.length < 2) return "";
  return profiles.find((profile) => profile.id === props.profileId)?.name ?? "";
});
const sections = computed(() => {
  const name = currentWorkspace.value?.name ?? "";
  const profile = profileName.value;
  return [
    {
      kind: "workspace",
      label: "Workspace",
      context: name,
      accent: currentWorkspace.value?.color || "var(--accent, var(--text))",
      addLabel: name ? `New note for ${name}` : "New workspace note",
      emptyText: `No notes for ${name || "this workspace"} yet.`,
      placeholder: `Note for ${name || "this workspace"}… The first line is its title.`,
      collection: workspace.value,
    },
    {
      kind: "global",
      label: "All workspaces",
      context: profile,
      accent: "",
      addLabel: "New note for all workspaces",
      emptyText: "No notes shared by all workspaces yet.",
      placeholder: `Note shared by all workspaces${profile ? " in " + profile : ""}… The first line is its title.`,
      collection: global.value,
    },
  ];
});

const tabNote = computed(() => {
  const id = appStore.activeViewId;
  if (!props.workspaceId || !id?.startsWith(props.workspaceId + ":")) return null;
  const target = appStore.getPanelByViewId(id) as ReturnType<typeof getWorkspacePanelByViewId>;
  if (target?.workspace.id !== props.workspaceId || (target.workspace.profileId || "default") !== props.profileId) {
    return null;
  }
  return { id, title: target.panel.title || "Active tab", notes: (target.panel.notes as string | undefined) || "" };
});

interface TabDraft {
  viewId: string;
  text: string;
  editing: boolean;
  pending: boolean;
  error: string;
}
const tabDraft = ref<TabDraft | null>(null);
let tabSaveTimer: ReturnType<typeof setTimeout> | undefined;

const tabNoteText = computed(() => {
  const draft = tabDraft.value;
  if (draft && draft.viewId === tabNote.value?.id && (draft.pending || draft.error)) return draft.text.trim();
  return tabNote.value?.notes.trim() ?? "";
});

function storedTabNote(viewId: string) {
  const target = appStore.getPanelByViewId(viewId) as ReturnType<typeof getWorkspacePanelByViewId>;
  return ((target?.panel.notes as string | undefined) || "").trim();
}

const tabDraftDirty = (draft: TabDraft) => draft.text.trim() !== storedTabNote(draft.viewId);

function settleTabDraft(draft: TabDraft) {
  if (tabDraft.value === draft && !draft.editing && !draft.pending && !draft.error) tabDraft.value = null;
}

function openTabNote() {
  const note = tabNote.value;
  if (!note) return;
  if (tabDraft.value?.viewId === note.id) tabDraft.value.editing = true;
  else {
    tabDraft.value = reactive({
      viewId: note.id,
      text: note.notes,
      editing: true,
      pending: false,
      error: "",
    });
  }
  void nextTick(() => split.value?.querySelector<HTMLTextAreaElement>("[data-tab-note-editor]")?.focus());
}

function editTabNote(text: string) {
  const draft = tabDraft.value;
  if (!draft) return;
  draft.text = text;
  draft.error = "";
  clearTimeout(tabSaveTimer);
  tabSaveTimer = setTimeout(() => void saveTabDraft(draft), SAVE_DELAY_MS);
}

async function saveTabDraft(draft: TabDraft) {
  clearTimeout(tabSaveTimer);
  if (draft.pending) return;
  const text = draft.text;
  if (text.trim() === storedTabNote(draft.viewId)) {
    draft.error = "";
    settleTabDraft(draft);
    return;
  }
  draft.pending = true;
  draft.error = "";
  try {
    await appStore.saveTabNote(draft.viewId, text);
  } catch (error) {
    draft.error = userFacingMessage(error, "Couldn't save the tab note.");
    if (tabDraft.value !== draft || disposed) useNotificationStore().showError("Tab note not saved", error);
  } finally {
    draft.pending = false;
    if (draft.error || draft.text.trim() === text.trim()) settleTabDraft(draft);
    else if (draft.editing && tabDraft.value === draft)
      tabSaveTimer = setTimeout(() => void saveTabDraft(draft), SAVE_DELAY_MS);
    else void saveTabDraft(draft);
  }
}

function closeTabNote() {
  const draft = tabDraft.value;
  if (!draft) return;
  draft.editing = false;
  void saveTabDraft(draft);
}

function leaveTabNote(event: FocusEvent) {
  const card = event.currentTarget as HTMLElement;
  if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
  if (!document.hasFocus()) return;
  if (tabDraft.value?.editing) closeTabNote();
}

type EditorKind = "tab" | "note";
const EDITOR_HEIGHT_KEY = "strideterm.sidebarNotes.editorHeight.";
const EDITOR_MIN_HEIGHT = 60;
const EDITOR_MAX_HEIGHT = 2000;

function readEditorHeight(kind: EditorKind): number | null {
  try {
    const stored = Number(localStorage.getItem(EDITOR_HEIGHT_KEY + kind));
    return Number.isFinite(stored) && stored >= EDITOR_MIN_HEIGHT ? Math.min(stored, EDITOR_MAX_HEIGHT) : null;
  } catch {
    return null;
  }
}

const editorHeights = reactive(
  new Map<EditorKind, number | null>([
    ["tab", readEditorHeight("tab")],
    ["note", readEditorHeight("note")],
  ]),
);
const editorHeight = (kind: EditorKind) => editorHeights.get(kind) ?? null;
const editorStyle = (kind: EditorKind) => {
  const height = editorHeight(kind);
  return height === null ? undefined : { height: `${height}px`, maxHeight: "none" };
};

function setEditorHeight(kind: EditorKind, height: number | null, persist = false) {
  const value = height === null ? null : Math.round(Math.max(EDITOR_MIN_HEIGHT, Math.min(EDITOR_MAX_HEIGHT, height)));
  editorHeights.set(kind, value);
  if (!persist) return;
  try {
    if (value === null) localStorage.removeItem(EDITOR_HEIGHT_KEY + kind);
    else localStorage.setItem(EDITOR_HEIGHT_KEY + kind, String(value));
  } catch {
    // Remembering the size is a convenience; the editor works without it.
  }
}

let editorDrag: { pointerId: number; startY: number; startHeight: number } | null = null;

function startEditorResize(event: PointerEvent) {
  const grip = event.currentTarget as HTMLElement;
  const editor = grip.previousElementSibling as HTMLElement | null;
  if (event.button !== 0 || editorDrag || !editor) return;
  editorDrag = { pointerId: event.pointerId, startY: event.clientY, startHeight: editor.offsetHeight };
  grip.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveEditorResize(kind: EditorKind, event: PointerEvent) {
  if (editorDrag?.pointerId !== event.pointerId) return;
  setEditorHeight(kind, editorDrag.startHeight + event.clientY - editorDrag.startY);
}

function endEditorResize(kind: EditorKind, event: PointerEvent) {
  if (editorDrag?.pointerId !== event.pointerId) return;
  editorDrag = null;
  setEditorHeight(kind, editorHeight(kind), true);
}

function resizeEditorWithKeyboard(kind: EditorKind, event: KeyboardEvent) {
  const editor = (event.currentTarget as HTMLElement).previousElementSibling as HTMLElement | null;
  const current = editorHeight(kind) ?? editor?.offsetHeight ?? EDITOR_MIN_HEIGHT;
  if (event.key === "ArrowUp") setEditorHeight(kind, current - 20, true);
  else if (event.key === "ArrowDown") setEditorHeight(kind, current + 20, true);
  else if (event.key === "Home") setEditorHeight(kind, null, true);
  else return;
  event.preventDefault();
}

function escapeTabNote(event: KeyboardEvent) {
  event.stopPropagation();
  closeTabNote();
  void nextTick(() => split.value?.querySelector<HTMLElement>(".sidebar-notes__tab-body")?.focus());
}

watch(
  () => tabNote.value?.id,
  () => {
    const draft = tabDraft.value;
    if (!draft || draft.viewId === tabNote.value?.id) return;
    tabDraft.value = null;
    draft.editing = false;
    void saveTabDraft(draft);
  },
);

function makeDraft(note: SidebarNote): Draft {
  return reactive({
    ...note,
    storedText: note.text,
    pending: null,
    failed: null,
    error: "",
    latest: null,
  });
}

function noteStatus(note: Draft): "saving" | "undoing" | "unsaved" | "saved" | "new" | "" {
  if (note.pending === "undo") return "undoing";
  if (note.pending) return "saving";
  if (note.failed) return "";
  const empty = note.revision === 0 && !note.text.trim();
  if (note.text !== note.storedText && !empty) return "unsaved";
  return note.revision === 0 ? "new" : "saved";
}

function updateStored(note: Draft, stored: SidebarNote) {
  note.storedText = stored.text;
  note.revision = stored.revision;
  note.canUndo = stored.canUndo;
}

function merge(collection: Collection, stored: SidebarNote[]) {
  const byId = new Map(collection.notes.map((note) => [note.id, note]));
  const merged = stored.map((record) => {
    const note = byId.get(record.id);
    byId.delete(record.id);
    if (!note) return makeDraft(record);
    if (!note.pending && !note.failed && note.text === note.storedText) {
      updateStored(note, record);
      note.text = record.text;
    }
    return note;
  });
  collection.notes = [
    ...[...byId.values()].filter((note) => !note.revision || note.pending || note.text !== note.storedText),
    ...merged,
  ];
}

async function reload() {
  const generation = ++refreshGeneration;
  if (!props.host) return;
  const startedAfterMutation = mutationGeneration;
  const workspaceCollection = workspace.value;
  const globalCollection = global.value;
  loading.value = true;
  loadError.value = "";
  try {
    const scope = workspaceCollection?.scope ?? globalCollection.scope;
    const result = await fetchNotes(scope);
    if (generation !== refreshGeneration || disposed) return;
    if (startedAfterMutation !== mutationGeneration) {
      void reload();
      return;
    }
    merge(globalCollection, result.global);
    if (workspaceCollection) merge(workspaceCollection, result.workspace);
  } catch (error) {
    if (generation === refreshGeneration && !disposed) {
      loadError.value = userFacingMessage(error, "Couldn't load notes.");
    }
  } finally {
    if (generation === refreshGeneration) loading.value = false;
  }
}

watch(
  () => ({ host: props.host, profileId: props.profileId, workspaceId: props.workspaceId }),
  (_, previous) => {
    dragPointer = null;
    if (previous?.host) {
      const previousGlobal = collectionFor(previous.profileId, null);
      const previousWorkspace = previous.workspaceId ? collectionFor(previous.profileId, previous.workspaceId) : null;
      for (const collection of [previousGlobal, previousWorkspace]) {
        if (collection) for (const note of collection.notes) flushSave(collection, note);
      }
    }
    void reload();
  },
  { immediate: true },
);

function fetchNotes(scope: SidebarNotesScope) {
  const api = getApi();
  if (!api?.listSidebarNotes) throw new Error("Notes are unavailable.");
  return api.listSidebarNotes(scope);
}

const titleOf = (text: string) => text.trim().split(/\r?\n/, 1)[0] || "Untitled note";
const previewOf = (text: string) =>
  text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("\n")
    .slice(0, 400);

function closeEditor(collection: Collection, note: Draft, event: KeyboardEvent) {
  event.stopPropagation();
  flushSave(collection, note);
  collection.activeId = "";
  void nextTick(() => {
    const toggles = split.value?.querySelectorAll<HTMLElement>("[data-note-toggle]") || [];
    Array.from(toggles)
      .find((toggle) => toggle.dataset.noteToggle === note.id)
      ?.focus();
  });
}

function focusEditor(note: Draft) {
  void nextTick(() => {
    const editors = split.value?.querySelectorAll<HTMLTextAreaElement>("[data-note-editor]") || [];
    Array.from(editors)
      .find((editor) => editor.dataset.noteEditor === note.id)
      ?.focus();
  });
}

function createNote(collection: Collection) {
  let note = collection.notes.find((draft) => !draft.revision && !draft.text.trim());
  if (!note) {
    const id =
      crypto.randomUUID?.() ??
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    note = makeDraft({ id, text: "", revision: 0, canUndo: false });
    collection.notes.unshift(note);
  }
  collection.activeId = note.id;
  focusEditor(note);
}

function discardEmpty(collection: Collection, note: Draft) {
  collection.notes = collection.notes.filter((draft) => draft !== note);
  collection.activeId = "";
}

function toggleEditor(collection: Collection, note: Draft) {
  collection.activeId = collection.activeId === note.id ? "" : note.id;
  if (collection.activeId) focusEditor(note);
}

function editNote(collection: Collection, note: Draft, text: string) {
  note.text = text;
  if (note.failed === "undo") note.failed = null;
  scheduleSave(collection, note);
}

function clearSaveTimer(note: Draft) {
  clearTimeout(saveTimers.get(note));
  saveTimers.delete(note);
}

function shouldSave(note: Draft) {
  return !note.pending && !note.failed && note.text !== note.storedText && (note.revision > 0 || !!note.text.trim());
}

function flushSave(collection: Collection, note: Draft) {
  clearSaveTimer(note);
  if (shouldSave(note)) void mutate(collection, note, "save");
}

function flushVisibleNotes() {
  if (!props.host) return;
  if (tabDraft.value) void saveTabDraft(tabDraft.value);
  for (const collection of [global.value, workspace.value]) {
    if (collection) for (const note of collection.notes) flushSave(collection, note);
  }
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden") flushVisibleNotes();
}

function scheduleSave(collection: Collection, note: Draft) {
  clearSaveTimer(note);
  if (!shouldSave(note)) return;
  saveTimers.set(
    note,
    setTimeout(() => {
      saveTimers.delete(note);
      void mutate(collection, note, "save");
    }, SAVE_DELAY_MS),
  );
}

async function mutate(collection: Collection, note: Draft, action: Mutation) {
  if (note.pending) return;
  const text = note.text;
  const input = { ...collection.scope, id: note.id, expectedRevision: note.revision };
  note.pending = action;
  note.failed = null;
  note.latest = null;
  mutationGeneration++;
  try {
    const api = getApi();
    if (!api?.saveSidebarNote || !api?.undoSidebarNote) throw new Error("Notes are unavailable.");
    const stored = action === "save" ? await api.saveSidebarNote({ ...input, text }) : await api.undoSidebarNote(input);
    if (disposed) return;
    updateStored(note, stored);
    if (note.text === text) note.text = stored.text;
  } catch (error) {
    if (disposed) return;
    note.failed = action;
    note.error =
      error instanceof Error ? error.message : action === "save" ? "Couldn't save note." : "Couldn't undo save.";
  } finally {
    mutationGeneration++;
    note.pending = null;
    if (!disposed) scheduleSave(collection, note);
  }
}

function undo(collection: Collection, note: Draft) {
  void mutate(collection, note, "undo");
}

async function retry(collection: Collection, note: Draft) {
  const action = note.failed;
  if (!action || note.pending) return;
  if (action === "save" && !note.revision && !note.text.trim()) {
    note.failed = null;
    return;
  }
  await mutate(collection, note, action);
}

async function reviewLatest(collection: Collection, note: Draft) {
  const action = note.failed;
  try {
    const latest = await fetchNotes(collection.scope);
    if (note.pending || !note.failed || action !== note.failed) return;
    const records = collection.scope.workspaceId ? latest.workspace : latest.global;
    const stored = records.find((record) => record.id === note.id);
    if (stored) note.latest = stored;
    else note.error = "This note has no saved version.";
  } catch {
    if (note.failed === action) note.error = "Couldn't load the latest saved note.";
  }
}

function resolveDraft(collection: Collection, note: Draft, saveDraft: boolean) {
  if (note.pending || !note.latest) return;
  updateStored(note, note.latest);
  note.latest = null;
  note.failed = null;
  if (saveDraft) flushSave(collection, note);
  else note.text = note.storedText;
}

function setWorkspaceSize(percent: number, height: number) {
  minimumWorkspaceSize.value = height > 0 ? Math.min(20, Math.ceil((44 * 100) / height)) : 20;
  workspaceSize.value = Math.max(minimumWorkspaceSize.value, Math.min(80, Math.round(percent)));
}

function startResize(event: PointerEvent) {
  if (event.button !== 0 || dragPointer !== null) return;
  dragPointer = event.pointerId;
  const divider = event.currentTarget as HTMLElement;
  dragGrabOffset = event.clientY - divider.getBoundingClientRect().top;
  divider.focus();
  divider.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveResize(event: PointerEvent) {
  if (dragPointer !== event.pointerId) return;
  const bounds = split.value?.getBoundingClientRect();
  if (!bounds) return;
  const divider = event.currentTarget as HTMLElement;
  const height = bounds.height - divider.offsetHeight;
  if (height > 0) setWorkspaceSize((100 * (event.clientY - bounds.top - dragGrabOffset)) / height, height);
}

function endResize(event: PointerEvent) {
  if (event.pointerId === dragPointer) dragPointer = null;
}

function resizeWithKeyboard(event: KeyboardEvent) {
  const divider = event.currentTarget as HTMLElement;
  const height = (split.value?.clientHeight ?? 0) - divider.offsetHeight;
  const currentSize = workspaceSize.value ?? (height > 0 ? (100 * divider.offsetTop) / height : 55);
  if (event.key === "ArrowUp") setWorkspaceSize(currentSize - 5, height);
  else if (event.key === "ArrowDown") setWorkspaceSize(currentSize + 5, height);
  else if (event.key === "Home") setWorkspaceSize(0, height);
  else if (event.key === "End") setWorkspaceSize(80, height);
  else return;
  event.preventDefault();
}

onMounted(() => {
  window.addEventListener("blur", flushVisibleNotes);
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onBeforeUnmount(() => {
  flushVisibleNotes();
  disposed = true;
  window.removeEventListener("blur", flushVisibleNotes);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  for (const timer of saveTimers.values()) clearTimeout(timer);
  clearTimeout(tabSaveTimer);
});
</script>

<style scoped>
.sidebar-notes {
  --notes-editor-max: min(300px, 45vh);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.sidebar-notes__split {
  --notes-pane-minimum: min(44px, 20%);
  position: relative;
  display: grid;
  flex: 1;
  grid-template-rows:
    minmax(var(--notes-pane-minimum), var(--notes-workspace-size, 55fr)) 9px
    minmax(var(--notes-pane-minimum), var(--notes-global-size, 45fr));
  min-height: 0;
}
.sidebar-notes__split--automatic {
  grid-template-rows: fit-content(55%) 9px minmax(0, 1fr);
}
.sidebar-notes__section {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.sidebar-notes__section {
  --notes-section-accent: var(--muted);
}
.sidebar-notes__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  padding: 6px 8px 6px 11px;
  border-bottom: 1px solid var(--border);
  border-left: 3px solid var(--notes-section-accent);
  background: rgba(var(--tint), 0.06);
}
.sidebar-notes__heading h3 {
  flex: 0 0 auto;
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.sidebar-notes__heading-label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.sidebar-notes__context {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-notes__count {
  flex: 0 0 auto;
  min-width: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: rgba(var(--tint), 0.1);
  color: var(--muted);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
button {
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:not(:disabled):hover {
  background: rgba(var(--tint), 0.08);
}
.sidebar-notes__add {
  display: grid;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  place-items: center;
  padding: 0;
  border-color: transparent;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
}
.sidebar-notes__load-error {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px 6px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--danger-fg);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.sidebar-notes__load-error > span {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.sidebar-notes__scroll {
  min-height: 0;
  padding-bottom: 6px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.sidebar-notes__divider {
  position: relative;
  cursor: row-resize;
  touch-action: none;
}
.sidebar-notes__divider::before,
.sidebar-notes__divider::after {
  position: absolute;
  content: "";
}
.sidebar-notes__divider::before {
  inset: 4px 0;
  background: var(--border);
}
.sidebar-notes__divider::after {
  inset: 3px calc(50% - 13px);
  border-radius: 2px;
  background: var(--muted);
}
.sidebar-notes__divider:hover::after,
.sidebar-notes__divider:focus-visible::after {
  background: var(--accent, var(--text));
}
.sidebar-notes__tab-note {
  margin: 2px 8px 8px 14px;
  padding: 0 8px 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: rgba(var(--tint), 0.03);
}
.sidebar-notes__tab-note--editing,
.sidebar-notes__tab-note--editing .sidebar-notes__tab-heading {
  border-color: var(--accent, var(--text));
}
.sidebar-notes__tab-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 18px;
  margin: 0 -8px 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  background: rgba(var(--tint), 0.07);
  font-size: 11px;
}
.sidebar-notes__tab-label {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 3px;
  background: rgba(var(--tint), 0.08);
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.sidebar-notes__tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-notes__tab-status {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-weight: 400;
}
.sidebar-notes__tab-body {
  display: block;
  width: 100%;
  padding: 2px 0;
  border: 0;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  cursor: text;
}
.sidebar-notes__tab-text {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 12;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.sidebar-notes__tab-body:not(:disabled):hover {
  background: transparent;
}
.sidebar-notes__tab-body--empty {
  color: var(--muted);
  font-style: italic;
}
.sidebar-notes__tab-note textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 72px;
  max-height: var(--notes-editor-max);
  resize: none;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  outline: none;
  scrollbar-width: thin;
}
.sidebar-notes__grip {
  position: relative;
  height: 10px;
  margin-bottom: -4px;
  cursor: row-resize;
  touch-action: none;
}
.sidebar-notes__grip::after {
  position: absolute;
  top: 4px;
  left: calc(50% - 12px);
  width: 24px;
  height: 2px;
  border-radius: 2px;
  background: var(--border);
  content: "";
}
.sidebar-notes__grip:hover::after,
.sidebar-notes__grip:focus-visible::after {
  background: var(--accent, var(--text));
}
.sidebar-notes__grip:focus-visible {
  outline: none;
}
.sidebar-notes__note {
  border-left: 2px solid transparent;
}
.sidebar-notes__note--open {
  border-left-color: var(--notes-section-accent);
  background: rgba(var(--tint), 0.04);
}
.sidebar-notes__note-title {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: 6px 10px 6px 6px;
  border: 0;
  border-radius: 0;
  font-size: 12px;
  text-align: left;
}
.sidebar-notes__note + .sidebar-notes__note .sidebar-notes__note-title {
  border-top: 1px solid rgba(var(--tint), 0.06);
}
.sidebar-notes__chevron {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  margin-top: 2px;
  fill: none;
  stroke: var(--muted);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.12s ease;
}
.sidebar-notes__note-title[aria-expanded="true"] .sidebar-notes__chevron {
  transform: rotate(90deg);
}
.sidebar-notes__note-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.sidebar-notes__note-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-notes__note-preview {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: pre-line;
}
.sidebar-notes__note-name {
  font-weight: 500;
}
.sidebar-notes__note-title[aria-expanded="true"] .sidebar-notes__note-name {
  color: var(--muted);
  font-weight: 400;
}
.sidebar-notes__note-preview {
  color: var(--muted);
  font-size: 11px;
}
.sidebar-notes__unsaved {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--muted);
}
.sidebar-notes__unsaved--failed {
  background: var(--danger);
}
.sidebar-notes__editor {
  padding: 0 10px 8px 24px;
}
.sidebar-notes__editor textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 110px;
  max-height: var(--notes-editor-max);
  resize: none;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--base-fill);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  scrollbar-width: thin;
}
@supports (field-sizing: content) {
  .sidebar-notes__editor textarea,
  .sidebar-notes__tab-note textarea {
    field-sizing: content;
  }
}
.sidebar-notes__editor textarea:focus {
  border-color: var(--accent, var(--text));
  outline: none;
}
.sidebar-notes__editor-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 20px;
  margin-top: 4px;
  font-size: 11px;
}
.sidebar-notes__status {
  display: inline-flex;
  flex: 1;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.sidebar-notes__hint,
.sidebar-notes__status {
  color: var(--muted);
}
.sidebar-notes__status--saved {
  color: var(--success, var(--muted));
}
.sidebar-notes__link {
  flex: 0 0 auto;
  padding: 2px 5px;
  border-color: transparent;
  color: var(--muted);
  font-size: 11px;
}
.sidebar-notes__link:not(:disabled):hover {
  color: var(--text);
}
.sidebar-notes__hint {
  margin: 6px 14px;
  font-size: 11px;
}
.sidebar-notes__empty {
  display: block;
  width: calc(100% - 22px);
  margin: 4px 8px 4px 14px;
  padding: 10px;
  border-style: dashed;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}
.sidebar-notes__empty span {
  color: var(--text);
  text-decoration: underline;
}
.sidebar-notes__problem,
.sidebar-notes__recovery {
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  font-size: 11px;
}
.sidebar-notes__problem {
  border-color: var(--danger);
}
.sidebar-notes__problem-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 5px;
}
.sidebar-notes__problem-actions button {
  padding: 2px 8px;
  font-size: 11px;
}
.sidebar-notes__error {
  color: var(--danger);
  overflow-wrap: anywhere;
}
.sidebar-notes__recovery p {
  margin: 0 0 4px;
  color: var(--muted);
}
.sidebar-notes__recovery pre {
  max-height: 130px;
  margin: 0;
  overflow: auto;
  font: inherit;
  white-space: pre-wrap;
}
.sidebar-notes__spinner {
  display: inline-block;
  width: 8px;
  height: 8px;
  border: 1px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: sidebar-notes-spin 0.65s linear infinite;
}
@keyframes sidebar-notes-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sidebar-notes__spinner {
    animation: none;
  }
  .sidebar-notes__chevron {
    transition: none;
  }
}
</style>
