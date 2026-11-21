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
        :class="{ 'sidebar-notes__split--automatic': weights === null }"
        :style="splitStyle"
      >
        <template v-for="section in sections" :key="section.kind">
          <div
            v-if="section.resizeIndex > 0"
            class="sidebar-notes__divider"
            :class="{ 'sidebar-notes__divider--inactive': !dividerActive(section.resizeIndex - 1) }"
            role="separator"
            :tabindex="dividerActive(section.resizeIndex - 1) ? 0 : -1"
            :aria-label="section.dividerLabel"
            aria-orientation="horizontal"
            :aria-disabled="dividerActive(section.resizeIndex - 1) ? undefined : true"
            :aria-valuenow="dividerValue(section.resizeIndex - 1)"
            :aria-valuetext="weights === null ? 'Automatic' : undefined"
            :aria-valuemin="minimumPanelSize"
            :aria-valuemax="100 - minimumPanelSize"
            @keydown="resizeWithKeyboard($event, section.resizeIndex - 1)"
            @pointerdown="startResize($event, section.resizeIndex - 1)"
            @pointermove="moveResize($event, section.resizeIndex - 1)"
            @pointerup="endResize"
            @pointercancel="endResize"
            @lostpointercapture="endResize"
          ></div>
          <section
            class="sidebar-notes__section"
            :class="[
              'sidebar-notes__section--' + section.kind,
              {
                'sidebar-notes__section--flex': section.resizeIndex >= 0 && !isCollapsed(section.kind),
                'sidebar-notes__section--collapsed': isCollapsed(section.kind),
              },
            ]"
            :aria-label="section.label"
            :style="section.accent ? { '--notes-section-accent': section.accent } : undefined"
          >
            <header class="sidebar-notes__heading" @click="clickHeading(section.kind, $event)">
              <div class="sidebar-notes__heading-label">
                <h3 :title="section.title">{{ section.label }}</h3>
                <span v-if="section.context" class="sidebar-notes__context" :title="section.contextTitle">{{
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
                <template
                  v-if="section.kind === 'tab' && tabDraft && (tabDraft.editing || tabDraft.pending) && !tabDraft.error"
                >
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
              <div class="sidebar-notes__heading-actions">
                <button
                  v-if="section.kind === 'tab' && canPopout && tabNote"
                  type="button"
                  class="sidebar-notes__add sidebar-notes__popout"
                  aria-label="Open in a window"
                  title="Open in a window"
                  @click="popOutTabNote"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"
                    />
                  </svg>
                </button>
                <button
                  v-if="section.kind === 'workspace' || section.kind === 'global'"
                  type="button"
                  class="sidebar-notes__add"
                  :aria-label="section.addLabel"
                  :title="section.addTitle"
                  :disabled="!section.collection || loading"
                  @click="section.collection && createNote(section.collection)"
                >
                  <svg class="sidebar-notes__plus" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 3.5v9M3.5 8h9" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="sidebar-notes__add sidebar-notes__collapse"
                  :aria-expanded="!isCollapsed(section.kind)"
                  :aria-label="(isCollapsed(section.kind) ? 'Show the ' : 'Collapse the ') + section.noun"
                  :title="isCollapsed(section.kind) ? 'Show the ' + section.noun : 'Collapse to the heading'"
                  @click="toggleSection(section.kind)"
                >
                  <svg class="sidebar-notes__chevron" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                </button>
              </div>
            </header>
            <div v-if="!isCollapsed(section.kind)" class="sidebar-notes__scroll">
              <template v-if="section.kind === 'installation'">
                <template v-for="entry in globalEntries" :key="entry.key">
                  <div
                    v-if="entry.kind === 'card'"
                    class="sidebar-notes__tab-note sidebar-notes__installation"
                    :class="{ 'sidebar-notes__tab-note--editing': entry.card.editing }"
                    :data-host-note="entry.card.hostId || undefined"
                    @focusout="leaveCard(entry.card, $event)"
                  >
                    <div class="sidebar-notes__tab-heading">
                      <span class="sidebar-notes__tab-title" :title="cardOrigin(entry.card)">{{
                        cardOrigin(entry.card)
                      }}</span>
                      <span
                        v-if="entry.card.current && ageOf(entry.card.current.draft)"
                        class="sidebar-notes__age"
                        :title="editedTitle(entry.card.current.draft)"
                        >{{ ageOf(entry.card.current.draft) }}</span
                      >
                      <button
                        v-if="canPopout && entry.card.current"
                        type="button"
                        class="sidebar-notes__popout"
                        aria-label="Open in a window"
                        title="Open in a window"
                        @click="popOutCard(entry.card)"
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path
                            d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"
                          />
                        </svg>
                      </button>
                    </div>
                    <div v-if="entry.card.loadError" class="sidebar-notes__problem" role="alert">
                      <span class="sidebar-notes__error">{{ entry.card.loadError }}</span>
                      <div class="sidebar-notes__problem-actions">
                        <button type="button" @click="loadCard(entry.card)">Retry</button>
                      </div>
                    </div>
                    <p v-else-if="!entry.card.current" class="sidebar-notes__hint">Loading…</p>
                    <template v-if="entry.card.current">
                      <textarea
                        v-if="entry.card.editing"
                        data-installation-editor
                        aria-label="Global note text"
                        :value="entry.card.current.draft.text"
                        :maxlength="SIDEBAR_NOTE_MAX_LENGTH"
                        :readonly="entry.card.current.draft.pending === 'undo'"
                        placeholder="A note for every profile of this installation…"
                        :style="editorStyle('installation')"
                        @input="editCard(entry.card, ($event.target as HTMLTextAreaElement).value)"
                        @keydown.esc="escapeCard(entry.card, $event)"
                      />
                      <div
                        v-if="entry.card.editing"
                        class="sidebar-notes__grip"
                        role="separator"
                        tabindex="0"
                        aria-orientation="horizontal"
                        aria-label="Resize global note editor"
                        :aria-valuenow="editorHeight('installation') ?? undefined"
                        :aria-valuetext="editorHeight('installation') === null ? 'Automatic' : undefined"
                        title="Drag to resize, double-click to reset"
                        @mousedown.prevent
                        @pointerdown="startEditorResize"
                        @pointermove="moveEditorResize('installation', $event)"
                        @pointerup="endEditorResize('installation', $event)"
                        @pointercancel="endEditorResize('installation', $event)"
                        @lostpointercapture="endEditorResize('installation', $event)"
                        @dblclick="setEditorHeight('installation', null, true)"
                        @keydown="resizeEditorWithKeyboard('installation', $event)"
                      ></div>
                      <button
                        v-else
                        type="button"
                        class="sidebar-notes__tab-body"
                        :class="{ 'sidebar-notes__tab-body--empty': !entry.card.current.draft.text.trim() }"
                        title="Edit the global note, shared by every profile of this computer and readable by its phones, browser sessions and attached desktops. Esc closes the editor."
                        @click="openCard(entry.card, $event)"
                      >
                        <span class="sidebar-notes__tab-text">{{
                          entry.card.current.draft.text.trim() || "Add a note for every profile…"
                        }}</span>
                      </button>
                      <div v-if="entry.card.current.draft.failed" class="sidebar-notes__problem" role="alert">
                        <span class="sidebar-notes__error">{{ entry.card.current.draft.error }}</span>
                        <div class="sidebar-notes__problem-actions">
                          <button type="button" @click="retryCard(entry.card)">Retry</button>
                          <button
                            v-if="!entry.card.current.draft.latest"
                            type="button"
                            @click="reviewLatestCard(entry.card)"
                          >
                            Review latest
                          </button>
                        </div>
                      </div>
                      <div v-if="entry.card.current.draft.latest" class="sidebar-notes__recovery">
                        <p>Latest saved text</p>
                        <pre>{{ entry.card.current.draft.latest.text || "(Empty)" }}</pre>
                        <div class="sidebar-notes__problem-actions">
                          <button type="button" @click="resolveCard(entry.card, false)">Use latest</button>
                          <button
                            v-if="entry.card.current.draft.failed === 'save'"
                            type="button"
                            @click="resolveCard(entry.card, true)"
                          >
                            Save my draft
                          </button>
                        </div>
                      </div>
                      <div v-if="entry.card.editing" class="sidebar-notes__editor-actions">
                        <span
                          v-if="
                            noteStatus(entry.card.current.draft) === 'saving' ||
                            noteStatus(entry.card.current.draft) === 'undoing'
                          "
                          class="sidebar-notes__status"
                          role="status"
                          :aria-label="noteStatus(entry.card.current.draft) === 'undoing' ? 'Undoing…' : 'Saving…'"
                        >
                          <span class="sidebar-notes__spinner" aria-hidden="true"></span>
                          {{ noteStatus(entry.card.current.draft) === "undoing" ? "Undoing…" : "Saving…" }}
                        </span>
                        <span
                          v-else-if="noteStatus(entry.card.current.draft) === 'unsaved'"
                          class="sidebar-notes__status"
                          role="status"
                        >
                          Unsaved changes
                        </span>
                        <span
                          v-else-if="noteStatus(entry.card.current.draft) === 'saved'"
                          class="sidebar-notes__status sidebar-notes__status--saved"
                          role="status"
                        >
                          ✓ Saved
                        </span>
                        <span v-else-if="noteStatus(entry.card.current.draft) === 'new'" class="sidebar-notes__status">
                          Saves automatically as you type
                        </span>
                        <span v-else class="sidebar-notes__status"></span>
                        <button
                          v-if="entry.card.current.draft.canUndo && !entry.card.current.draft.failed"
                          type="button"
                          class="sidebar-notes__link"
                          :disabled="
                            !!entry.card.current.draft.pending ||
                            entry.card.current.draft.text !== entry.card.current.draft.storedText
                          "
                          title="Restore the text this note had before its last save."
                          @click="mutateCard(entry.card, 'undo')"
                        >
                          Undo last save
                        </button>
                      </div>
                    </template>
                  </div>
                  <p v-else-if="entry.kind === 'status'" class="sidebar-notes__hint sidebar-notes__host-status">
                    {{ entry.text }}
                    <button type="button" class="sidebar-notes__link" @click="openProfiles">Open Profiles</button>
                  </p>
                  <p v-else class="sidebar-notes__hint sidebar-notes__host-status">{{ entry.text }}</p>
                </template>
              </template>
              <div
                v-else-if="section.kind === 'tab' && tabNote"
                class="sidebar-notes__tab-note"
                :class="{ 'sidebar-notes__tab-note--editing': tabDraft?.editing }"
                @focusout="leaveTabNote"
              >
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
                  :title="
                    'Edit the note for the tab “' + tabNote.title + '” — only this tab has it. Esc closes the editor.'
                  "
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
              <p v-else-if="section.kind === 'tab'" class="sidebar-notes__hint">{{ section.emptyText }}</p>
              <div v-if="section.collection">
                <p v-if="loading && !section.collection.notes.length" class="sidebar-notes__hint">Loading…</p>
                <button
                  v-else-if="!loadError && !section.collection.notes.length"
                  type="button"
                  class="sidebar-notes__empty"
                  :title="section.addTitle"
                  @click="createNote(section.collection)"
                >
                  {{ section.emptyText }} <span>Add a note</span>
                </button>
                <article
                  v-for="note in section.collection.notes"
                  :key="note.id"
                  class="sidebar-notes__note"
                  :class="{
                    'sidebar-notes__note--open': isOpen(section.collection, note),
                    'sidebar-notes__note--popout': canPopout && note.revision > 0,
                    'sidebar-notes__note--deletable': note.revision > 0,
                    [`sidebar-notes__note--${note.color}`]: !!note.color,
                  }"
                >
                  <button
                    v-if="canPopout && note.revision > 0"
                    type="button"
                    class="sidebar-notes__popout sidebar-notes__popout--note"
                    aria-label="Open in a window"
                    title="Open in a window"
                    @click="popOutNote(section.collection, note)"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"
                      />
                    </svg>
                  </button>
                  <button
                    v-if="note.revision > 0"
                    type="button"
                    class="sidebar-notes__popout sidebar-notes__popout--note sidebar-notes__delete"
                    aria-label="Delete note"
                    title="Delete note"
                    @click="confirmDeleteNote(section.collection, note)"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8M7 7v4M9 7v4" />
                    </svg>
                  </button>
                  <button
                    class="sidebar-notes__note-title"
                    type="button"
                    :data-note-toggle="note.id"
                    :aria-expanded="isOpen(section.collection, note)"
                    :title="
                      isOpen(section.collection, note)
                        ? 'Collapse this note'
                        : 'Open this note to read or edit it. Changes save automatically.'
                    "
                    @click="toggleEditor(section.collection, note)"
                  >
                    <svg class="sidebar-notes__chevron" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span class="sidebar-notes__note-text">
                      <span class="sidebar-notes__note-name">{{ titleOf(note.text) }}</span>
                      <span
                        v-if="!isOpen(section.collection, note) && previewOf(note.text)"
                        class="sidebar-notes__note-preview"
                        >{{ previewOf(note.text) }}</span
                      >
                    </span>
                    <span v-if="ageOf(note)" class="sidebar-notes__age" :title="editedTitle(note)">{{
                      ageOf(note)
                    }}</span>
                    <span
                      v-if="note.failed || note.text !== note.storedText"
                      class="sidebar-notes__unsaved"
                      :class="{ 'sidebar-notes__unsaved--failed': note.failed }"
                      :title="
                        note.failed
                          ? 'Not saved — open the note to retry'
                          : 'Unsaved changes — they save automatically in a moment'
                      "
                    ></span>
                  </button>
                  <div v-if="isOpen(section.collection, note)" class="sidebar-notes__editor">
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
                        title="Restore the text this note had before its last save."
                        @click="undo(section.collection, note)"
                      >
                        Undo last save
                      </button>
                      <button
                        v-if="note.revision === 0 && !note.text.trim() && !note.pending"
                        type="button"
                        class="sidebar-notes__link"
                        title="Remove this empty note."
                        @click="discardEmpty(section.collection, note)"
                      >
                        Discard
                      </button>
                      <span
                        v-if="note.revision > 0"
                        class="sidebar-notes__colors"
                        role="group"
                        aria-label="Note colour"
                      >
                        <button
                          v-for="option in COLOR_OPTIONS"
                          :key="option.label"
                          type="button"
                          class="sidebar-notes__swatch"
                          :class="`sidebar-notes__swatch--${option.color ?? 'none'}`"
                          :aria-label="option.label"
                          :title="option.label"
                          :aria-pressed="(note.color ?? null) === option.color"
                          @click="setNoteColor(section.collection, note, option.color)"
                        ></button>
                      </span>
                    </div>
                  </div>
                </article>
              </div>
              <p v-else-if="section.kind === 'workspace'" class="sidebar-notes__hint">
                Select a workspace to write workspace notes.
              </p>
            </div>
          </section>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { PeerAttachedHost, PeerHostState } from "../../../electron/shared/peers.js";
import { SIDEBAR_NOTE_MAX_LENGTH } from "../../../electron/shared/sidebar-notes.js";
import type {
  InstallationNote,
  NotePopoutTarget,
  SaveInstallationNote,
  SidebarNote,
  SidebarNoteColor,
  SidebarNotesScope,
  UndoInstallationNote,
} from "../../../electron/shared/sidebar-notes.js";
import { formatRelativeAge } from "../../app/relative-age.js";
import type { getWorkspacePanelByViewId } from "../../app/selectors.js";
import { userFacingMessage } from "../../lib/error-message.js";
import { rlog } from "../../lib/renderer-log.js";
import { isPeerWindow } from "../../window-backend.js";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { usePeersStore } from "../../stores/peers.js";

const props = defineProps<{ host: HTMLElement | null; profileId: string; workspaceId?: string | null }>();
const appStore = useAppStore();
const injectedApi = inject(apiKey);
const getApi = () => injectedApi ?? appStore.getApi();
const split = ref<HTMLElement | null>(null);
type SectionKind = "tab" | "workspace" | "global" | "installation";
type ResizableKind = Exclude<SectionKind, "tab">;
type PanelWeights = Record<ResizableKind, number>;
const SECTION_KINDS: readonly SectionKind[] = ["tab", "workspace", "global", "installation"];
const RESIZABLE_KINDS: readonly ResizableKind[] = ["workspace", "global", "installation"];
const DEFAULT_WEIGHTS: PanelWeights = { workspace: 40, global: 30, installation: 30 };
const COLLAPSED_SECTIONS_KEY = "strideterm.sidebarNotes.collapsedSections";
const LEGACY_INSTALLATION_COLLAPSED_KEY = "strideterm.sidebarNotes.installationCollapsed";
const weights = ref<PanelWeights | null>(null);
const minimumPanelSize = ref(20);
const loading = ref(false);
const loadError = ref("");

const SAVE_DELAY_MS = 1000;

const canPopout = !getApi()?.isRemote && !isPeerWindow() && typeof getApi()?.openNotePopout === "function";

async function openPopout(target: NotePopoutTarget) {
  try {
    await getApi()?.openNotePopout?.(target);
  } catch (error) {
    useNotificationStore().showError("Couldn't open the note in a window", error);
  }
}

type Mutation = "save" | "undo";
interface Draft extends SidebarNote {
  storedText: string;
  colorPending: boolean;
  pending: Mutation | null;
  failed: Mutation | null;
  error: string;
  latest: SidebarNote | null;
}
interface Collection {
  scope: SidebarNotesScope;
  notes: Draft[];
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
    collection = reactive({ scope: { profileId, workspaceId }, notes: [] as Draft[] });
    collections.set(key, collection);
  }
  return collection;
}

const OPEN_NOTES_KEY = "strideterm.sidebarNotes.open";
const OPEN_NOTES_LIMIT = 200;

function readOpenNotes(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(OPEN_NOTES_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((key) => typeof key === "string").slice(-OPEN_NOTES_LIMIT) : [];
  } catch {
    return [];
  }
}

const openNotes = reactive(new Set<string>(readOpenNotes()));
const openKey = (collection: Collection, note: Draft) =>
  JSON.stringify([collection.scope.profileId, collection.scope.workspaceId, note.id]);
const isOpen = (collection: Collection, note: Draft) => openNotes.has(openKey(collection, note));

function setOpen(collection: Collection, note: Draft, open: boolean) {
  const key = openKey(collection, note);
  openNotes.delete(key);
  if (open) openNotes.add(key);
  while (openNotes.size > OPEN_NOTES_LIMIT) openNotes.delete(openNotes.values().next().value as string);
  try {
    localStorage.setItem(OPEN_NOTES_KEY, JSON.stringify([...openNotes]));
  } catch {
    // Remembering which notes are open is a convenience; the panel works without it.
  }
}

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
watch(
  () => props.host,
  (host) => {
    clearInterval(clock);
    clock = undefined;
    if (!host) return;
    now.value = Date.now();
    clock = setInterval(() => (now.value = Date.now()), 30_000);
  },
  { immediate: true },
);

const ageOf = (note: Draft) => formatRelativeAge(note.updatedAt, now.value);
const editedTitle = (note: Draft) => `Last edited ${new Date(note.updatedAt ?? "").toLocaleString()}`;

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
  const inProfile = profile ? `in the ${profile} profile` : "in this profile";
  const workspaceLabel = name ? `“${name}”` : "the selected workspace";
  const tab = tabNote.value;
  const accent = currentWorkspace.value?.color || "var(--accent, var(--text))";
  return [
    ...(props.workspaceId
      ? [
          {
            kind: "tab" as const,
            label: "Tab",
            noun: "tab note",
            resizeIndex: -1,
            dividerLabel: "",
            title:
              "A note for the active tab only. It is saved with the workspace and the tab shows a note marker while it has one.",
            context: tab?.title ?? "",
            contextTitle: tab?.title ?? "",
            accent,
            addLabel: "",
            addTitle: "",
            emptyText: `Select a tab of ${name || "this workspace"} to see or add its note.`,
            placeholder: "",
            collection: null,
          },
        ]
      : []),
    {
      kind: "workspace" as const,
      label: "Workspace",
      noun: "workspace notes",
      resizeIndex: 0,
      dividerLabel: "",
      title: `Notes that belong to ${workspaceLabel} only. They are shown while it is selected and stay with it whichever tab is open.`,
      context: name,
      contextTitle: `Only for the workspace ${workspaceLabel}`,
      accent,
      addLabel: name ? `New note for ${name}` : "New workspace note",
      addTitle: `New note for ${workspaceLabel} only. For a note you want in every workspace, use Profile below.`,
      emptyText: `No notes for ${name || "this workspace"} yet.`,
      placeholder: `Note for ${name || "this workspace"}… The first line is its title.`,
      collection: workspace.value,
    },
    {
      kind: "global" as const,
      label: "Profile",
      noun: "profile notes",
      resizeIndex: 1,
      dividerLabel: "Resize workspace and profile notes",
      title: `Notes shared by every workspace ${inProfile}, shown whichever workspace is selected. Other profiles keep their own.`,
      context: profile,
      contextTitle: `Shared by all workspaces ${inProfile}`,
      accent: "",
      addLabel: "New note for all workspaces",
      addTitle: `New note shared by every workspace ${inProfile}.`,
      emptyText: "No notes shared by all workspaces yet.",
      placeholder: `Note shared by all workspaces${profile ? " in " + profile : ""}… The first line is its title.`,
      collection: global.value,
    },
    {
      kind: "installation" as const,
      label: "Global",
      noun: "global note",
      resizeIndex: 2,
      dividerLabel: "Resize profile and global notes",
      title:
        "One note per computer, shared by all its profiles and workspaces, and readable and editable by its phones, browser sessions and attached desktops. The desktops attached to this one show their own below.",
      context: "",
      contextTitle: "",
      accent: "",
      addLabel: "",
      addTitle: "",
      emptyText: "",
      placeholder: "",
      collection: null,
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
    if (tabDraft.value !== draft || disposed || isCollapsed("tab"))
      useNotificationStore().showError("Tab note not saved", error);
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
  // Opening the editor replaces the focused button, and Chromium reports removing a focused element as a focusout.
  if ((event.target as Element).classList.contains("sidebar-notes__tab-body")) return;
  if (tabDraft.value?.editing) closeTabNote();
}

type EditorKind = "tab" | "note" | "installation";
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
    ["installation", readEditorHeight("installation")],
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
    colorPending: false,
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
  note.updatedAt = stored.updatedAt;
  if (!note.colorPending) note.color = stored.color;
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
    } else if (!note.colorPending) {
      note.color = record.color;
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

watch(
  [() => props.profileId, () => appStore.payload?.sidebarNotesRevisions?.[props.profileId] ?? 0],
  ([profileId, revision], [previousProfileId, previousRevision]) => {
    if (profileId === previousProfileId && revision !== previousRevision && props.host) void reload();
  },
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
  setOpen(collection, note, false);
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
  const kind = collection === workspace.value ? "workspace" : "global";
  if (isCollapsed(kind)) toggleSection(kind);
  let note = collection.notes.find((draft) => !draft.revision && !draft.text.trim());
  if (!note) {
    const id =
      crypto.randomUUID?.() ??
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    note = makeDraft({ id, text: "", revision: 0, canUndo: false });
    collection.notes.unshift(note);
  }
  setOpen(collection, note, true);
  focusEditor(note);
}

function discardEmpty(collection: Collection, note: Draft) {
  collection.notes = collection.notes.filter((draft) => draft !== note);
  setOpen(collection, note, false);
}

function confirmDeleteNote(collection: Collection, note: Draft) {
  appStore.openDialog("ConfirmDialog", {
    eyebrow: "Notes",
    title: "Delete note?",
    message: `“${titleOf(note.text)}” will be deleted. This cannot be undone.`,
    confirmLabel: "Delete",
    danger: true,
    onCancel: () => appStore.closeDialog(),
    onConfirm: () => {
      appStore.closeDialog();
      return deleteNote(collection, note);
    },
  });
}

async function deleteNote(collection: Collection, note: Draft) {
  clearSaveTimer(note);
  mutationGeneration++;
  try {
    const api = getApi();
    if (!api?.deleteSidebarNote) throw new Error("Notes are unavailable.");
    await api.deleteSidebarNote({ ...collection.scope, id: note.id, expectedRevision: note.revision });
    if (disposed) return;
    collection.notes = collection.notes.filter((draft) => draft !== note);
    setOpen(collection, note, false);
  } catch (error) {
    if (disposed) return;
    useNotificationStore().showError("Note not deleted", error);
    void reload();
  } finally {
    mutationGeneration++;
  }
}

const COLOR_OPTIONS: { color: SidebarNoteColor | null; label: string }[] = [
  { color: null, label: "No colour" },
  { color: "green", label: "Green" },
  { color: "orange", label: "Orange" },
  { color: "red", label: "Red" },
];

async function setNoteColor(collection: Collection, note: Draft, color: SidebarNoteColor | null) {
  if ((note.color ?? null) === color) return;
  const previous = note.color;
  note.color = color ?? undefined;
  note.colorPending = true;
  mutationGeneration++;
  try {
    const api = getApi();
    if (!api?.setSidebarNoteColor) throw new Error("Notes are unavailable.");
    const stored = await api.setSidebarNoteColor({ ...collection.scope, id: note.id, color });
    if (disposed) return;
    note.colorPending = false;
    note.color = stored.color;
  } catch (error) {
    note.colorPending = false;
    if (disposed) return;
    note.color = previous;
    useNotificationStore().showError("Note colour not changed", error);
  } finally {
    mutationGeneration++;
  }
}

function toggleEditor(collection: Collection, note: Draft) {
  const open = !isOpen(collection, note);
  setOpen(collection, note, open);
  if (open) focusEditor(note);
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
  flushCards();
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
    if (isCollapsed(collection === workspace.value ? "workspace" : "global"))
      useNotificationStore().showError(action === "save" ? "Note not saved" : "Note not restored", error);
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

const LOCAL_CARD = "local";
interface GlobalCard {
  key: string;
  hostId: string | null;
  online: boolean;
  current: { draft: Draft; name: string } | null;
  editing: boolean;
  loadError: string;
  loadGeneration: number;
  mutations: number;
}
const globalCards = reactive(new Map<string, GlobalCard>());
const hostNotesAvailable =
  !getApi()?.isRemote &&
  !isPeerWindow() &&
  typeof getApi()?.getPeerGlobalNote === "function" &&
  typeof getApi()?.savePeerGlobalNote === "function" &&
  typeof getApi()?.undoPeerGlobalNote === "function";
const peersStore = hostNotesAvailable ? usePeersStore() : null;
const hostState = ref<PeerHostState | null>(null);

function cardFor(key: string, hostId: string | null): GlobalCard {
  let card = globalCards.get(key);
  if (!card) {
    card = reactive({
      key,
      hostId,
      online: false,
      current: null,
      editing: false,
      loadError: "",
      loadGeneration: 0,
      mutations: 0,
    });
    globalCards.set(key, card);
  }
  return card;
}

const localCard = cardFor(LOCAL_CARD, null);

function readCollapsedSections(): SectionKind[] {
  const kinds: SectionKind[] = [];
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "[]");
    if (Array.isArray(stored)) kinds.push(...SECTION_KINDS.filter((kind) => stored.includes(kind)));
  } catch {
    // An unreadable value counts as nothing collapsed.
  }
  try {
    if (localStorage.getItem(LEGACY_INSTALLATION_COLLAPSED_KEY) === "1") {
      if (!kinds.includes("installation")) kinds.push("installation");
      localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(kinds));
    }
    localStorage.removeItem(LEGACY_INSTALLATION_COLLAPSED_KEY);
  } catch {
    // The old key is read again next time; the panel works without storage.
  }
  return kinds;
}

const collapsedSections = reactive(new Set<SectionKind>(readCollapsedSections()));
const isCollapsed = (kind: SectionKind) => collapsedSections.has(kind);

function popOutNote(collection: Collection, note: Draft) {
  flushSave(collection, note);
  void openPopout({
    kind: "note",
    profileId: collection.scope.profileId,
    workspaceId: collection.scope.workspaceId,
    noteId: note.id,
  });
}

function popOutCard(card: GlobalCard) {
  flushCard(card);
  void openPopout(card.hostId ? { kind: "host", hostId: card.hostId } : { kind: "installation" });
}

function popOutTabNote() {
  const note = tabNote.value;
  if (!note) return;
  if (tabDraft.value) void saveTabDraft(tabDraft.value);
  void openPopout({ kind: "tab", profileId: props.profileId, viewId: note.id });
}

function closeSection(kind: SectionKind) {
  if (kind === "tab") closeTabNote();
  else if (kind === "installation") {
    flushCards();
    for (const card of globalCards.values()) card.editing = false;
  } else {
    const collection = kind === "workspace" ? workspace.value : global.value;
    if (collection) for (const note of collection.notes) flushSave(collection, note);
  }
}

// The chevron stays the keyboard and screen-reader control; the rest of the heading is a larger mouse target.
function clickHeading(kind: SectionKind, event: MouseEvent) {
  if ((event.target as Element | null)?.closest("button, a, input, textarea, select")) return;
  toggleSection(kind);
}

function toggleSection(kind: SectionKind) {
  if (collapsedSections.has(kind)) {
    collapsedSections.delete(kind);
    if (kind === "installation") loadHostCards();
  } else {
    collapsedSections.add(kind);
    closeSection(kind);
  }
  try {
    if (collapsedSections.size) localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...collapsedSections]));
    else localStorage.removeItem(COLLAPSED_SECTIONS_KEY);
  } catch {
    // Remembering the fold is a convenience; the panel works without it.
  }
}

function cardCalls(card: GlobalCard) {
  const api = getApi();
  const hostId = card.hostId;
  if (hostId) {
    const get = api?.getPeerGlobalNote;
    const save = api?.savePeerGlobalNote;
    const undo = api?.undoPeerGlobalNote;
    if (!get || !save || !undo) throw new Error("Notes are unavailable.");
    return {
      get: () => get(hostId),
      save: (input: SaveInstallationNote) => save(hostId, input),
      undo: (input: UndoInstallationNote) => undo(hostId, input),
    };
  }
  const get = api?.getInstallationNote;
  const save = api?.saveInstallationNote;
  const undo = api?.undoInstallationNote;
  if (!get || !save || !undo) throw new Error("Notes are unavailable.");
  return { get, save, undo };
}

function cardOrigin(card: GlobalCard) {
  if (card.hostId) return hostById(card.hostId)?.label || "Another computer";
  const name = card.current?.name ?? "";
  if (getApi()?.isRemote || isPeerWindow()) return name || "This installation";
  return name ? `This computer (${name})` : "This computer";
}

function mergeCard(card: GlobalCard, { note, installationName }: InstallationNote) {
  const current = card.current;
  if (!current) {
    card.current = { draft: makeDraft(note), name: installationName };
    return;
  }
  current.name = installationName;
  const draft = current.draft;
  if (!draft.pending && !draft.failed && draft.text === draft.storedText) {
    updateStored(draft, note);
    draft.text = note.text;
  }
}

async function loadCard(card: GlobalCard) {
  const generation = ++card.loadGeneration;
  const startedAfterMutation = card.mutations;
  try {
    const result = await cardCalls(card).get();
    if (generation !== card.loadGeneration || disposed) return;
    if (startedAfterMutation !== card.mutations) {
      void loadCard(card);
      return;
    }
    card.loadError = "";
    mergeCard(card, result);
  } catch (error) {
    if (generation === card.loadGeneration && !disposed) {
      card.loadError = userFacingMessage(error, "Couldn't load the global note.");
    }
  }
}

function loadHostCards() {
  if (!props.host) return;
  for (const card of globalCards.values()) if (card.hostId && card.online) void loadCard(card);
}

const hostById = (hostId: string) => peersStore?.hosts.find((host) => host.id === hostId);

watch(
  () => props.host,
  (host) => {
    if (!host) return;
    void loadCard(localCard);
    loadHostCards();
  },
  { immediate: true },
);

watch(
  () => appStore.payload?.installationNoteRevision ?? 0,
  (revision, previous) => {
    if (revision !== previous && props.host) void loadCard(localCard);
  },
);

watch(
  () => peersStore?.hosts ?? [],
  (hosts) => {
    const listed = new Set(hosts.map((host) => host.id));
    for (const host of hosts) {
      const card = cardFor(host.id, host.id);
      const online = host.state === "online";
      const cameOnline = online && !card.online;
      card.online = online;
      if (cameOnline && props.host) void loadCard(card);
    }
    for (const [key, card] of [...globalCards]) {
      if (!card.hostId || listed.has(key)) continue;
      if (card.current) clearSaveTimer(card.current.draft);
      globalCards.delete(key);
    }
  },
  { immediate: true },
);

const hostStatusText = (host: PeerAttachedHost) => {
  switch (host.state) {
    case "offline":
      return `${host.label} is offline.`;
    case "not-paired":
      return `${host.label} no longer pairs with this desktop.`;
    case "version-mismatch":
      return `${host.label} runs a different version of strIDEterm.`;
    case "wrong-host":
      return `Another strIDEterm answers at the address of ${host.label}.`;
    default:
      return `Checking ${host.label}…`;
  }
};

const unseenDevices = computed(() => {
  const attached = new Set((peersStore?.hosts ?? []).map((host) => host.id));
  return [...(hostState.value?.devices ?? [])]
    .filter((device) => !attached.has(device.id))
    .sort((a, b) => a.name.localeCompare(b.name));
});

type GlobalEntry =
  { kind: "card"; key: string; card: GlobalCard } | { kind: "status" | "device"; key: string; text: string };

const globalEntries = computed<GlobalEntry[]>(() => {
  const hosts = [...(peersStore?.hosts ?? [])].sort((a, b) => a.label.localeCompare(b.label));
  return [
    { kind: "card", key: LOCAL_CARD, card: localCard },
    ...hosts.map((host): GlobalEntry => {
      const card = globalCards.get(host.id);
      return host.state === "online" && card
        ? { kind: "card", key: host.id, card }
        : { kind: "status", key: host.id, text: hostStatusText(host) };
    }),
    ...unseenDevices.value.map((device): GlobalEntry => ({
      kind: "device",
      key: "device:" + device.id,
      text: `${device.name} is connected to this computer. You will see its note here once you connect to it from here too.`,
    })),
  ];
});

async function loadHostState() {
  const load = getApi()?.getPeerHostState;
  if (!hostNotesAvailable || !load) return;
  try {
    hostState.value = await load();
  } catch (error) {
    rlog("warn", "paired desktops could not be loaded for the notes panel", { err: userFacingMessage(error) });
  }
}

function openProfiles() {
  appStore.openProfilesDialog();
}

function openCard(card: GlobalCard, event: Event) {
  card.editing = true;
  const element = (event.currentTarget as HTMLElement).closest<HTMLElement>(".sidebar-notes__installation");
  void nextTick(() => element?.querySelector<HTMLTextAreaElement>("[data-installation-editor]")?.focus());
}

function flushCard(card: GlobalCard) {
  const draft = card.current?.draft;
  if (!draft) return;
  clearSaveTimer(draft);
  if (shouldSave(draft)) void mutateCard(card, "save");
}

function flushCards() {
  for (const card of globalCards.values()) flushCard(card);
}

function scheduleCardSave(card: GlobalCard) {
  const draft = card.current?.draft;
  if (!draft) return;
  clearSaveTimer(draft);
  if (!shouldSave(draft)) return;
  saveTimers.set(
    draft,
    setTimeout(() => {
      saveTimers.delete(draft);
      void mutateCard(card, "save");
    }, SAVE_DELAY_MS),
  );
}

function editCard(card: GlobalCard, text: string) {
  const draft = card.current?.draft;
  if (!draft) return;
  draft.text = text;
  if (draft.failed === "undo") draft.failed = null;
  scheduleCardSave(card);
}

function closeCard(card: GlobalCard) {
  flushCard(card);
  card.editing = false;
}

function escapeCard(card: GlobalCard, event: KeyboardEvent) {
  event.stopPropagation();
  closeCard(card);
  const element = (event.currentTarget as HTMLElement).closest<HTMLElement>(".sidebar-notes__installation");
  void nextTick(() => element?.querySelector<HTMLElement>(".sidebar-notes__tab-body")?.focus());
}

function leaveCard(card: GlobalCard, event: FocusEvent) {
  const element = event.currentTarget as HTMLElement;
  if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
  if (!document.hasFocus()) return;
  if ((event.target as Element).classList.contains("sidebar-notes__tab-body")) return;
  if (card.editing) closeCard(card);
}

async function mutateCard(card: GlobalCard, action: Mutation) {
  const current = card.current;
  if (!current || current.draft.pending) return;
  const note = current.draft;
  const text = note.text;
  const expectedRevision = note.revision;
  note.pending = action;
  note.failed = null;
  note.latest = null;
  card.mutations++;
  try {
    const calls = cardCalls(card);
    const stored =
      action === "save" ? await calls.save({ text, expectedRevision }) : await calls.undo({ expectedRevision });
    if (disposed) return;
    updateStored(note, stored.note);
    current.name = stored.installationName;
    if (note.text === text) note.text = stored.note.text;
  } catch (error) {
    if (disposed) return;
    note.failed = action;
    note.error = userFacingMessage(error, action === "save" ? "Couldn't save note." : "Couldn't undo save.");
    if (isCollapsed("installation"))
      useNotificationStore().showError(action === "save" ? "Global note not saved" : "Global note not restored", error);
  } finally {
    card.mutations++;
    note.pending = null;
    if (!disposed) scheduleCardSave(card);
  }
}

function retryCard(card: GlobalCard) {
  const action = card.current?.draft.failed;
  if (action && !card.current?.draft.pending) void mutateCard(card, action);
}

async function reviewLatestCard(card: GlobalCard) {
  const note = card.current?.draft;
  const action = note?.failed;
  if (!note) return;
  try {
    const latest = await cardCalls(card).get();
    if (note.pending || !note.failed || action !== note.failed) return;
    note.latest = latest.note;
  } catch {
    if (note.failed === action) note.error = "Couldn't load the latest saved note.";
  }
}

function resolveCard(card: GlobalCard, saveDraft: boolean) {
  const note = card.current?.draft;
  if (!note || note.pending || !note.latest) return;
  updateStored(note, note.latest);
  note.latest = null;
  note.failed = null;
  if (saveDraft) flushCard(card);
  else note.text = note.storedText;
}

const expandedKinds = () => RESIZABLE_KINDS.filter((kind) => !collapsedSections.has(kind));

function boundaryAround(divider: number) {
  const expanded = expandedKinds();
  const above = expanded.filter((kind) => RESIZABLE_KINDS.indexOf(kind) <= divider).pop();
  const below = expanded.find((kind) => RESIZABLE_KINDS.indexOf(kind) > divider);
  return above && below ? { above, below } : null;
}

const dividerActive = (divider: number) => boundaryAround(divider) !== null;

function dividerValue(divider: number): number | undefined {
  const current = weights.value;
  const boundary = boundaryAround(divider);
  if (!current || !boundary) return undefined;
  const expanded = expandedKinds();
  const total = expanded.reduce((sum, kind) => sum + current[kind], 0);
  const above = expanded
    .filter((kind) => RESIZABLE_KINDS.indexOf(kind) <= RESIZABLE_KINDS.indexOf(boundary.above))
    .reduce((sum, kind) => sum + current[kind], 0);
  return Math.round((above * 100) / total);
}

const splitStyle = computed(() => {
  const rows: string[] = [];
  const current = weights.value;
  const expanded = expandedKinds();
  const filler = expanded.includes("global") ? "global" : expanded[expanded.length - 1];
  for (const section of sections.value) {
    if (section.resizeIndex > 0) rows.push("9px");
    const kind = section.kind;
    if (collapsedSections.has(kind)) rows.push("auto");
    else if (kind === "tab") rows.push("fit-content(30%)");
    else if (current) rows.push(`minmax(var(--notes-pane-minimum), ${current[kind]}fr)`);
    else if (kind === filler) rows.push("minmax(0, 1fr)");
    else rows.push(kind === "workspace" ? "fit-content(45%)" : "fit-content(35%)");
  }
  return { gridTemplateRows: rows.join(" ") };
});

function fixedHeight(before?: Element) {
  let height = 0;
  for (const child of Array.from(split.value?.children ?? [])) {
    if (child === before) break;
    if (!child.classList.contains("sidebar-notes__section--flex")) height += (child as HTMLElement).offsetHeight;
  }
  return height;
}

function flexibleHeight() {
  const bounds = split.value?.getBoundingClientRect();
  return bounds ? bounds.height - fixedHeight() : 0;
}

function measuredWeights(minimum: number): PanelWeights {
  const expanded = expandedKinds();
  const heights = expanded.map(
    (kind) => split.value?.querySelector<HTMLElement>(".sidebar-notes__section--" + kind)?.offsetHeight ?? 0,
  );
  const measured = heights.reduce((sum, height) => sum + height, 0);
  if (heights.some((height) => height <= 0)) return { ...DEFAULT_WEIGHTS };
  const total = expanded.reduce((sum, kind) => sum + DEFAULT_WEIGHTS[kind], 0);
  const next = { ...DEFAULT_WEIGHTS };
  expanded.forEach((kind, index) => {
    next[kind] = Math.round(Math.max((minimum * total) / 100, (heights[index] * total) / measured));
  });
  return next;
}

function ensureWeights(height: number): PanelWeights {
  minimumPanelSize.value = height > 0 ? Math.min(20, Math.ceil((44 * 100) / height)) : 20;
  weights.value ??= measuredWeights(minimumPanelSize.value);
  return weights.value;
}

function moveBoundary(index: number, height: number, percent: number) {
  const current = ensureWeights(height);
  const boundary = boundaryAround(index);
  if (!boundary) return;
  const expanded = expandedKinds();
  const total = expanded.reduce((sum, kind) => sum + current[kind], 0);
  const minimum = (minimumPanelSize.value * total) / 100;
  const pair = current[boundary.above] + current[boundary.below];
  const before = expanded
    .filter((kind) => RESIZABLE_KINDS.indexOf(kind) < RESIZABLE_KINDS.indexOf(boundary.above))
    .reduce((sum, kind) => sum + current[kind], 0);
  const above = Math.round(Math.max(minimum, Math.min(pair - minimum, (percent * total) / 100 - before)));
  weights.value = { ...current, [boundary.above]: above, [boundary.below]: pair - above };
}

function startResize(event: PointerEvent, index: number) {
  if (event.button !== 0 || dragPointer !== null || !dividerActive(index)) return;
  dragPointer = event.pointerId;
  const divider = event.currentTarget as HTMLElement;
  dragGrabOffset = event.clientY - divider.getBoundingClientRect().top;
  divider.focus();
  divider.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveResize(event: PointerEvent, index: number) {
  if (dragPointer !== event.pointerId) return;
  const bounds = split.value?.getBoundingClientRect();
  if (!bounds) return;
  const divider = event.currentTarget as HTMLElement;
  const height = flexibleHeight();
  if (height > 0) {
    moveBoundary(index, height, (100 * (event.clientY - bounds.top - dragGrabOffset - fixedHeight(divider))) / height);
  }
}

function endResize(event: PointerEvent) {
  if (event.pointerId === dragPointer) dragPointer = null;
}

function resizeWithKeyboard(event: KeyboardEvent, index: number) {
  if (!dividerActive(index)) return;
  const keys = ["ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const height = flexibleHeight();
  ensureWeights(height);
  const boundary = dividerValue(index) ?? 0;
  const target =
    event.key === "ArrowUp" ? boundary - 5 : event.key === "ArrowDown" ? boundary + 5 : event.key === "Home" ? 0 : 100;
  moveBoundary(index, height, target);
  event.preventDefault();
}

let releasePeers: (() => void) | null = null;
let offHostNoteChanged: (() => void) | null = null;
let offPeersUpdated: (() => void) | null = null;

// The panel is mounted in every window from the start; paired desktops are only worth asking about once
// the Notes tab is showing with the Global section open.
function startPeerWork() {
  if (!peersStore || releasePeers) return;
  releasePeers = peersStore.watch();
  void peersStore.open();
  void loadHostState();
  offPeersUpdated = getApi()?.onPeersUpdated?.(() => void loadHostState()) ?? null;
  offHostNoteChanged =
    getApi()?.onPeerHostNoteChanged?.((event) => {
      const card = globalCards.get(event.hostId);
      if (card?.online && props.host) void loadCard(card);
    }) ?? null;
}

watch(
  () => !!props.host && !collapsedSections.has("installation"),
  (shown) => {
    if (shown) startPeerWork();
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener("blur", flushVisibleNotes);
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onBeforeUnmount(() => {
  flushVisibleNotes();
  disposed = true;
  window.removeEventListener("blur", flushVisibleNotes);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  releasePeers?.();
  offPeersUpdated?.();
  offHostNoteChanged?.();
  for (const timer of saveTimers.values()) clearTimeout(timer);
  clearTimeout(tabSaveTimer);
  clearInterval(clock);
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
  align-content: start;
  min-height: 0;
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
.sidebar-notes__section--tab {
  border-bottom: 1px solid var(--border);
}
.sidebar-notes__section--collapsed .sidebar-notes__heading {
  margin-bottom: 0;
}
.sidebar-notes__heading-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
}
.sidebar-notes__section--tab .sidebar-notes__tab-note {
  padding-top: 6px;
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
  cursor: pointer;
  user-select: none;
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
.sidebar-notes__divider--inactive {
  cursor: default;
}
.sidebar-notes__divider--inactive::after,
.sidebar-notes__divider--inactive:hover::after {
  display: none;
}
.sidebar-notes__collapse .sidebar-notes__chevron {
  margin: 0;
}
.sidebar-notes__plus {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}
.sidebar-notes__collapse[aria-expanded="true"] .sidebar-notes__chevron {
  transform: rotate(90deg);
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
  font-size: 11px;
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
  position: relative;
  border-left: 2px solid transparent;
}
.sidebar-notes__note--popout .sidebar-notes__note-title {
  padding-right: 32px;
}
.sidebar-notes__popout {
  display: grid;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  place-items: center;
  padding: 0;
  border-color: transparent;
  color: var(--muted);
}
.sidebar-notes__popout:hover {
  color: var(--text);
}
.sidebar-notes__popout svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sidebar-notes__popout--note {
  position: absolute;
  top: 3px;
  right: 6px;
  z-index: 1;
}
.sidebar-notes__note--deletable .sidebar-notes__note-title {
  padding-right: 32px;
}
.sidebar-notes__note--popout.sidebar-notes__note--deletable .sidebar-notes__note-title {
  padding-right: 58px;
}
.sidebar-notes__note--popout .sidebar-notes__delete {
  right: 30px;
}
.sidebar-notes__delete:hover {
  color: var(--danger, var(--text));
}
.sidebar-notes__note--open {
  border-left-color: var(--notes-section-accent);
  background: rgba(var(--tint), 0.04);
}
.sidebar-notes__note--green {
  --note-color: var(--success);
}
.sidebar-notes__note--orange {
  --note-color: var(--status-running, #ffa424);
}
.sidebar-notes__note--red {
  --note-color: var(--danger);
}
.sidebar-notes__note--green,
.sidebar-notes__note--orange,
.sidebar-notes__note--red {
  border-left: 3px solid var(--note-color);
  background: color-mix(in srgb, var(--note-color) 12%, transparent);
}
.sidebar-notes__colors {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
}
.sidebar-notes__swatch {
  box-sizing: border-box;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1px solid var(--muted);
  border-radius: 50%;
  background: transparent;
}
.sidebar-notes__swatch--green {
  border-color: var(--success);
  background: var(--success);
}
.sidebar-notes__swatch--orange {
  border-color: var(--status-running, #ffa424);
  background: var(--status-running, #ffa424);
}
.sidebar-notes__swatch--red {
  border-color: var(--danger);
  background: var(--danger);
}
.sidebar-notes__swatch[aria-pressed="true"] {
  box-shadow:
    0 0 0 2px var(--base-fill, transparent),
    0 0 0 3.5px var(--text);
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
.sidebar-notes__age {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
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
