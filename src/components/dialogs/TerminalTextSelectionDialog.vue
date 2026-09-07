<template>
  <!-- "Select text" panel. Deliberately a text panel ABOVE the terminal, not
       custom drag handles over the live xterm cells: the phone's own selection
       handles and Copy callout already do the hard part, and the snapshot text
       stays put while the PTY keeps writing and a TUI keeps repainting — which
       is exactly what makes an xterm selection unusable on touch.

       data-no-autofocus keeps DialogOverlay from focusing the first button on
       open: focus here would fight the selection, and on a phone it can pop the
       on-screen keyboard over the text the user is trying to select. -->
  <div class="dialog termsel" data-no-autofocus role="dialog" aria-labelledby="termsel-title">
    <div class="dialog__header termsel__header">
      <div class="termsel__heading">
        <p class="eyebrow">Select text</p>
        <h2 id="termsel-title">{{ title }}</h2>
        <p class="termsel__subtitle">Snapshot — terminal continues running</p>
      </div>
      <button type="button" class="termsel__icon-close" title="Close (Esc)" aria-label="Close" @click="close">×</button>
    </div>

    <p v-if="notices.length" class="termsel__notices">
      <span v-for="notice in notices" :key="notice" class="termsel__notice">{{ notice }}</span>
    </p>

    <!-- The text is a plain interpolated text node inside <pre> — never
         v-html. Rows are NOT virtualised: a selection that scrolls out of a
         recycled row would be destroyed mid-drag. -->
    <pre ref="textRef" class="termsel__text" data-role="terminal-selection-text" tabindex="-1">{{ text }}</pre>

    <p class="termsel__status" role="status" aria-live="polite" :class="statusClass">{{ status }}</p>

    <div v-if="confirmEarlier" class="termsel__confirm" role="alertdialog" aria-label="Replace snapshot">
      <p class="termsel__confirm-text">
        Taking a longer snapshot <strong>replaces the text below and clears your current selection.</strong> Up to
        {{ MAX_SNAPSHOT_SCROLLBACK_LINES }} lines from before the visible screen are added.
      </p>
      <div class="termsel__confirm-actions">
        <button type="button" class="button button--ghost termsel__button" @click="confirmEarlier = false">
          Cancel
        </button>
        <button type="button" class="button termsel__button" @click="includeEarlierOutput">Replace text</button>
      </div>
    </div>

    <footer class="dialog__footer termsel__footer">
      <button
        type="button"
        class="button button--ghost termsel__button"
        title="Select the whole snapshot, then use Copy selection or the system Copy menu."
        @mousedown.prevent
        @click="selectAll"
      >
        Select all
      </button>
      <button
        v-if="!earlierIncluded"
        type="button"
        class="button button--ghost termsel__button"
        :disabled="confirmEarlier"
        title="Take a new, longer snapshot that also covers output above the visible screen. Replaces the text and clears the selection."
        @mousedown.prevent
        @click="confirmEarlier = true"
      >
        Include earlier output
      </button>
      <span class="termsel__spacer"></span>
      <button
        type="button"
        class="button button--ghost termsel__button"
        title="Copy only the highlighted text."
        @mousedown.prevent
        @click="copySelection"
      >
        Copy selection
      </button>
      <button
        type="button"
        class="button termsel__button"
        title="Copy the whole snapshot shown above."
        @mousedown.prevent
        @click="copyAll"
      >
        Copy all
      </button>
      <!-- Hidden on mobile: the × in the header is the same action, and a row
           of its own is ~52px the snapshot could have had instead. -->
      <button
        type="button"
        class="button button--ghost termsel__button termsel__button--close"
        @mousedown.prevent
        @click="close"
      >
        Close
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { MAX_SNAPSHOT_CHARS, MAX_SNAPSHOT_SCROLLBACK_LINES } from "../../app/terminal-text-snapshot.js";
import type { TerminalTextSnapshot } from "../../app/terminal-text-snapshot.js";

const MAX_SNAPSHOT_CHARS_LABEL = MAX_SNAPSHOT_CHARS.toLocaleString("en-US");

const props = defineProps<{
  sessionId: string;
  workspaceId: string;
  panelId: string;
  title: string;
  onClose?: () => void;
}>();

const store = useAppStore();
const termStore = useTerminalStore();

const textRef = ref<HTMLElement | null>(null);
// Taken synchronously in setup, not in onMounted: the panel must paint with
// the text already in it. A one-frame empty <pre> is a flash of "nothing to
// select" on exactly the gesture that asked to select something.
const initialSnapshot = termStore.getTerminalTextSnapshot(props.sessionId, { scrollbackLines: 0 });
const snapshot = ref<TerminalTextSnapshot | null>(initialSnapshot);
const text = ref(initialSnapshot?.text ?? "");
const status = ref("Long-press the text to select a word, then drag the handles.");
const statusKind = ref<"idle" | "ok" | "error">("idle");
const confirmEarlier = ref(false);
const earlierIncluded = ref(false);

/**
 * Text of the last selection that was genuinely inside the snapshot.
 *
 * Copy is a button, and pressing a button can collapse the document selection
 * before the click handler ever runs — on some mobile browsers it does. So the
 * selection is captured the moment it FORMS and the button copies the captured
 * value. It is a cache of a real, still-current selection, never a fallback:
 * every path that ends the selection (a deliberate tap in the text, a
 * selection made somewhere else, a replaced snapshot) clears it, so Copy
 * selection can only ever copy something the user can still see highlighted.
 */
const capturedSelection = ref("");

const statusClass = computed(() => ({
  "termsel__status--ok": statusKind.value === "ok",
  "termsel__status--error": statusKind.value === "error",
}));

const notices = computed<string[]>(() => {
  const snap = snapshot.value;
  if (!snap) return [];
  const out: string[] = [];
  if (snap.truncated) out.push(`Trimmed to the most recent ${MAX_SNAPSHOT_CHARS_LABEL} characters.`);
  if (snap.startsMidLine) out.push("The first line continues from output above this snapshot.");
  if (snap.endsMidLine) out.push("The last line continues below this snapshot.");
  if (snap.alternateBuffer) out.push("Full-screen app — only the visible screen exists, there is no scrollback.");
  else if (snap.scrollbackRows > 0) out.push(`Includes ${snap.scrollbackRows} lines from before the visible screen.`);
  return out;
});

function setStatus(message: string, kind: "idle" | "ok" | "error" = "idle"): void {
  status.value = message;
  statusKind.value = kind;
}

/**
 * Closing follows the convention TerminalSearchOverlay already set: hand the
 * keyboard back to the terminal so the user can keep typing. NOT on a touch
 * device — the only thing focusing an xterm does there is throw the on-screen
 * keyboard over the output the user came back to look at. Keyed on the PRIMARY
 * pointer, so a desktop with a touchscreen still gets its focus back.
 */
function close(): void {
  const pointerIsFine = typeof window.matchMedia === "function" ? window.matchMedia("(pointer: fine)").matches : true;
  props.onClose?.();
  if (pointerIsFine) termStore.focusActiveTerminal();
}

function loadSnapshot(scrollbackLines: number): boolean {
  const snap = termStore.getTerminalTextSnapshot(props.sessionId, { scrollbackLines });
  if (!snap) return false;
  snapshot.value = snap;
  text.value = snap.text;
  return true;
}

// --- Selection tracking ----------------------------------------------------

function selectionIsInsideText(selection: Selection | null): boolean {
  const host = textRef.value;
  if (!host || !selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  return host.contains(range.startContainer) && host.contains(range.endContainer);
}

/**
 * The rule, in order:
 *  - a non-empty selection inside the snapshot → capture it
 *  - a non-empty selection somewhere else in the UI → the user moved on, drop
 *    what we had (it is not ours to copy any more)
 *  - a collapsed selection whose caret sits inside the snapshot → a deliberate
 *    tap in the text cancelled the selection, drop it
 *  - anything else (a collapsed selection on a button, or none at all) → this
 *    is focus moving to Copy, so keep what we captured
 */
function handleSelectionChange(): void {
  const selection = document.getSelection();
  const value = selection ? selection.toString() : "";
  const host = textRef.value;
  if (value) {
    if (selectionIsInsideText(selection)) {
      // Only a genuinely DIFFERENT selection is news. Browsers re-fire
      // selectionchange around a button press with the same range still in
      // place, and that must not wipe the "Copied …" the user just earned.
      const changed = value !== capturedSelection.value;
      capturedSelection.value = value;
      if (changed) setStatus(`${value.length} characters selected.`);
    } else {
      capturedSelection.value = "";
    }
    return;
  }
  const anchor = selection?.anchorNode ?? null;
  if (host && anchor && host.contains(anchor)) capturedSelection.value = "";
}

function selectAll(): void {
  const host = textRef.value;
  const selection = document.getSelection();
  if (!host || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(host);
  selection.removeAllRanges();
  selection.addRange(range);
  capturedSelection.value = selection.toString();
  setStatus(`${capturedSelection.value.length} characters selected.`);
}

function clearSelection(): void {
  document.getSelection()?.removeAllRanges();
  capturedSelection.value = "";
}

// --- Copy ------------------------------------------------------------------

/**
 * `navigator.clipboard.writeText` is called FIRST, straight out of the click
 * handler with nothing awaited before it: on the remote web client the write
 * is only permitted inside the gesture's transient activation, and an await
 * ahead of it throws that away. Success is reported only once the promise
 * resolves — the API is also unavailable on an insecure origin (plain HTTP on
 * the LAN) and can be refused by the webview host, and in that case the text
 * and the selection are both left alone so the system Copy callout still
 * works.
 */
function copyText(value: string, okMessage: string): void {
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) {
    setStatus("This browser blocks clipboard access here — use the system Copy from the long-press menu.", "error");
    return;
  }
  const written = clipboard.writeText(value);
  // Announced only after the write is under way, and only as "in progress":
  // a permission prompt can hold this open for as long as the user looks at
  // it, and a screen reader user needs to hear that something is happening.
  setStatus("Copying…");
  written.then(
    () => setStatus(okMessage, "ok"),
    () => setStatus("Copy was blocked — use the system Copy from the long-press menu instead.", "error"),
  );
}

function copySelection(): void {
  const value = capturedSelection.value;
  if (!value) {
    setStatus("Nothing selected — long-press a word in the text first, or use Select all.", "error");
    return;
  }
  copyText(value, `Copied ${value.length} characters.`);
}

function copyAll(): void {
  if (!text.value) {
    setStatus("This snapshot is empty.", "error");
    return;
  }
  copyText(text.value, "Copied the whole snapshot.");
}

function includeEarlierOutput(): void {
  confirmEarlier.value = false;
  clearSelection();
  if (!loadSnapshot(MAX_SNAPSHOT_SCROLLBACK_LINES)) {
    setStatus("That terminal is gone — nothing left to snapshot.", "error");
    close();
    return;
  }
  earlierIncluded.value = true;
  setStatus("Snapshot replaced. Earlier output is included; your previous selection was cleared.");
}

// --- Lifecycle -------------------------------------------------------------

onMounted(() => {
  if (!snapshot.value) {
    close();
    return;
  }
  // Only while this panel is up: a global selectionchange listener left behind
  // would keep reading selections made in the composer or anywhere else.
  document.addEventListener("selectionchange", handleSelectionChange);
});

onBeforeUnmount(() => {
  document.removeEventListener("selectionchange", handleSelectionChange);
  // Release the snapshot with the panel — nothing should hold a screenful of
  // another session's output after it closes.
  snapshot.value = null;
  text.value = "";
  capturedSelection.value = "";
});

/**
 * Close on any change that makes this snapshot the wrong thing to be showing:
 * the viewer switched profile, the workspace left the profile or was deleted,
 * or the panel this session belongs to is gone. Leaving a foreign session's
 * output on screen after a profile switch is exactly what the profile boundary
 * is for.
 */
const stillValid = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workspaces = (store.payload?.appState?.workspaces as any[]) || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workspace = workspaces.find((ws: any) => ws?.id === props.workspaceId);
  if (!workspace) return false;
  if ((workspace.profileId || "default") !== (store.myActiveProfileId || "default")) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (workspace.panels || []).some((panel: any) => panel?.id === props.panelId);
});

watch(stillValid, (valid) => {
  if (!valid) close();
});
</script>

<style scoped>
.termsel {
  /* Wider than a form dialog: terminal lines are long, and every extra column
     is one less soft wrap the reader has to follow. */
  width: min(900px, 100%);
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* The TEXT scrolls, not the panel. `.dialog` defaults to overflow: auto,
     which on a short screen scrolls the footer — and the Copy buttons with
     it — out of reach. */
  overflow: hidden;
  /* The overlay already pads, but a phone in landscape puts the home
     indicator / rounded corner right under the footer. */
  padding-bottom: max(20px, env(safe-area-inset-bottom));
}

.termsel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.termsel__heading {
  min-width: 0;
}

.termsel__heading h2 {
  overflow-wrap: anywhere;
}

.termsel__subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
}

.termsel__icon-close {
  flex: 0 0 auto;
  /* 44 x 44 minimum touch target (WCAG 2.5.5 / platform HIG). */
  min-width: 44px;
  min-height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.04);
  color: var(--text);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.termsel__icon-close:hover {
  background: rgba(var(--tint), 0.12);
}

.termsel__notices {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.termsel__text {
  flex: 1 1 auto;
  /* min-height: 0 is what lets a flex item shrink below its content and
     scroll instead of pushing the footer off the screen. */
  min-height: 0;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.04);
  color: var(--text);
  font-family: var(--mono, "Cascadia Mono", "JetBrains Mono", "Consolas", monospace);
  font-size: 13px;
  line-height: 1.45;
  /* Keep every space and newline the snapshot captured, and wrap long lines
     instead of forcing a horizontal scroll on a phone. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 8;
  /* The whole point of the panel: native selection. The terminal host sets
     touch-action: none and blocks the callout; this element must do neither. */
  user-select: text;
  -webkit-user-select: text;
  touch-action: auto;
  -webkit-touch-callout: default;
}

.termsel__status {
  margin: 0;
  min-height: 16px;
  font-size: 12px;
  color: var(--muted);
}

.termsel__status--ok {
  color: var(--accent);
}

.termsel__status--error {
  color: var(--danger);
}

.termsel__confirm {
  padding: 10px 12px;
  border: 1px solid rgba(255, 164, 36, 0.35);
  border-radius: 4px;
  background: rgba(255, 164, 36, 0.1);
}

.termsel__confirm-text {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.45;
}

.termsel__confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.termsel__footer {
  display: flex;
  /* Explicit, not inherited: overlay.css turns every .dialog__footer into a
     column below 820px, which here stacked five buttons down the screen and
     left the snapshot a third of the panel. */
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.termsel__spacer {
  flex: 1 1 auto;
}

/* Every action is a touch target first: 44 x 44 CSS px minimum, whatever the
   button styling elsewhere in the app happens to be. */
.termsel__button {
  min-height: 44px;
  min-width: 44px;
  padding-inline: 14px;
}

@media (max-width: 768px), (max-height: 500px) {
  .termsel {
    /* Take the height the phone actually has (dvh accounts for the browser
       chrome collapsing) so the text area, not the chrome, gets the space. */
    height: calc(100dvh - 16px);
    max-height: calc(100dvh - 16px);
    width: 100%;
    gap: 8px;
  }

  /* The chrome shrinks so the snapshot grows: on a phone the panel is here to
     be read and selected, and every row spent on titling is a row of output
     the user has to scroll for. Nothing is dropped — the terminal name is
     ellipsised on one line rather than wrapped over three. */
  .termsel__heading .eyebrow {
    font-size: 10px;
  }

  .termsel__heading h2 {
    font-size: 15px;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .termsel__subtitle {
    font-size: 11px;
  }

  .termsel__notices {
    font-size: 11px;
  }

  /* Two buttons per row. `flex: 1 1 140px` and not a fixed grid so that the
     last row fills the width when "Include earlier output" is gone — a lone
     half-width button beside a hole is the layout a grid would give. */
  .termsel__footer .termsel__button,
  .termsel__confirm-actions .termsel__button {
    flex: 1 1 140px;
    padding-inline: 10px;
    font-size: 12px;
    line-height: 1.2;
  }

  .termsel__button--close {
    display: none;
  }

  .termsel__spacer {
    display: none;
  }
}
</style>
