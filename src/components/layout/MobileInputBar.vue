<template>
  <!-- Mobile composer input bar. xterm.js on Android/iOS suffers from a
       long-standing upstream bug (xtermjs/xterm.js#3600): predictive
       keyboards (GBoard, Samsung) drive input through IME composition
       events that xterm's hidden textarea mishandles, producing duplicated
       and corrupted characters. Instead of fighting the IME, this bar
       side-steps it: the user types into a plain <input> where predictive
       text behaves correctly, and the finished line is pushed to the PTY
       over the same channel xterm's onData uses. The accessory key row
       covers the control keys mobile keyboards lack (Esc, Tab, arrows,
       Ctrl+C) so TUI apps stay drivable without the hardware keyboard.
       Rendered only for remote (web/mobile) transports; desktop viewports
       hide it via the mobile.css media query. Direct typing into the
       terminal still works — the bar is additive, not a replacement. -->
  <div
    v-if="api?.isRemote && targetSessionId"
    class="mobile-input-bar"
    :class="{
      'mobile-input-bar--collapsed': panelCollapsed,
      'mobile-input-bar--landscape': landscape,
      'mobile-input-bar--system': landscape && systemKeyboard && !panelCollapsed,
    }"
    data-role="mobile-input-bar"
  >
    <button
      v-if="panelCollapsed"
      type="button"
      class="mobile-input-bar__expand"
      title="Expand the terminal input bar — a plain text field where mobile autocorrect works correctly, plus Esc / Tab / arrow / Ctrl+C keys. Lines you type are sent to the active terminal on ⏎."
      @click="expand"
    >
      {{ landscape ? "⌨" : "⌨ Input bar ▴" }}
    </button>
    <template v-else>
      <button
        v-if="landscape"
        type="button"
        class="mobile-input-bar__keyboard-mode"
        :title="systemKeyboard ? 'Use compact keyboard' : 'Use system keyboard'"
        :aria-label="systemKeyboard ? 'Use compact keyboard' : 'Use system keyboard'"
        @click="toggleKeyboardMode"
      >
        {{ systemKeyboard ? "⌨" : "System keyboard" }}
      </button>
      <CompactTerminalKeyboard v-if="compactKeyboard" @insert="insertCompact" @backspace="insertCompact('', true)" />
      <div class="mobile-input-bar__keys">
        <button
          v-for="key in accessoryKeys"
          :key="key.label"
          type="button"
          class="mobile-input-bar__key"
          :title="key.title"
          :aria-label="key.label"
          @mousedown.prevent
          @click="sendKey(key)"
        >
          {{ landscape && key.label === "⇧Tab" ? "⇤" : key.label }}
        </button>
        <button
          type="button"
          class="mobile-input-bar__key mobile-input-bar__key--slash"
          title="Insert / into the field to start an agent slash command, then finish typing and send with ⏎."
          @mousedown.prevent
          @click="insertSlash"
        >
          /
        </button>
        <button
          type="button"
          class="mobile-input-bar__key mobile-input-bar__key--paste"
          title="Paste the clipboard into the field — review or edit the text, then send it with ⏎. If the browser blocks clipboard access, long-press the field and paste from its menu instead."
          @mousedown.prevent
          @click="pasteFromClipboard"
        >
          📋
        </button>
        <button
          v-if="hostAvailable"
          type="button"
          class="mobile-input-bar__key mobile-input-bar__key--attachment"
          title="Attach a file and insert its path into this draft"
          aria-label="Attach a file"
          :disabled="composing || !!attachmentPending"
          @mousedown.prevent
          @click="requestAttachmentCompose"
        >
          📎
        </button>
        <div class="mobile-input-bar__more">
          <button
            type="button"
            class="mobile-input-bar__key mobile-input-bar__key--more"
            :class="{ 'mobile-input-bar__key--active': menuOpen }"
            title="More keys and actions — arrows, Home/End, Ctrl+Home/Ctrl+End, Ctrl+C, Ctrl+R, Ctrl+L, slash commands, copy the visible screen, and select text by hand."
            aria-haspopup="true"
            :aria-expanded="menuOpen"
            @mousedown.prevent
            @click="toggleMenu"
          >
            ⋯
          </button>
          <template v-if="menuOpen">
            <div class="mobile-input-bar__menu-backdrop" @mousedown.prevent @click="menuOpen = false"></div>
            <div class="mobile-input-bar__menu" @mousedown.prevent>
              <button
                type="button"
                class="mobile-input-bar__menu-item"
                role="menuitemcheckbox"
                :aria-checked="hideAfterSend"
                @click="toggleHideAfterSend"
              >
                {{ hideAfterSend ? "✓ " : "" }}Hide keyboard after sending
              </button>
              <button
                type="button"
                class="mobile-input-bar__menu-item"
                title="Insert / into the field to start an agent slash command, then finish typing and send with ⏎."
                @click="insertSlash"
              >
                /&nbsp;&nbsp;Slash command
              </button>
              <button
                v-for="cmd in slashCommands"
                :key="cmd"
                type="button"
                class="mobile-input-bar__menu-item mobile-input-bar__menu-item--cmd"
                :title="`Put ${cmd} in the field, ready to send with ⏎ (or add arguments first).`"
                @click="setSlashCommand(cmd)"
              >
                {{ cmd }}
              </button>
              <div class="mobile-input-bar__menu-sep" role="separator"></div>
              <button
                type="button"
                class="mobile-input-bar__menu-item"
                title="Copy the text currently visible in the terminal to the clipboard — usually the agent's latest answer."
                @click="copyScreen"
              >
                📄&nbsp;&nbsp;Copy screen
              </button>
              <button
                type="button"
                class="mobile-input-bar__menu-item"
                data-role="mobile-input-bar-select-text"
                title="Open a snapshot of the visible screen you can select by hand — long-press a word, drag the handles, then copy just that part. The terminal keeps running behind it."
                @click="selectText"
              >
                ✂️&nbsp;&nbsp;Select text
              </button>
              <button
                v-for="key in landscape && systemKeyboard ? [...accessoryKeys, ...menuKeys] : menuKeys"
                :key="key.label"
                type="button"
                class="mobile-input-bar__menu-item"
                :title="key.title"
                @click="sendMenuKey(key)"
              >
                {{ key.menuLabel || key.label }}
              </button>
            </div>
          </template>
        </div>
        <button
          type="button"
          class="mobile-input-bar__key mobile-input-bar__key--collapse"
          title="Collapse the input bar to a slim handle so the terminal gets the vertical space back. Tap the handle to bring it back."
          @mousedown.prevent
          @click="collapse"
        >
          {{ landscape ? "×" : "▾" }}
        </button>
      </div>
      <!-- Chromium maps autocomplete="off" on the input to Android NO_SUGGESTIONS.
           Keep prediction enabled, with form/vendor password-manager opt-outs and
           dropAutofilledValue() guarding unsolicited values. -->
      <form class="mobile-input-bar__row" autocomplete="off" @submit.prevent="sendComposed">
        <input
          ref="inputRef"
          v-model="draft"
          type="text"
          :inputmode="compactKeyboard ? 'none' : 'text'"
          class="mobile-input-bar__input"
          placeholder="Type a command — ⏎ sends it"
          name="strideterm-terminal-line"
          autocomplete="on"
          autocorrect="on"
          spellcheck="true"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          autocapitalize="none"
          enterkeyhint="send"
          title="Compose a line for the active terminal. Mobile predictive text and autocorrect work normally here — what you see is exactly what gets sent when you press ⏎."
          data-role="mobile-input-bar-input"
          @focus="touched = true"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
        />
        <button
          type="submit"
          class="mobile-input-bar__send"
          title="Send the composed line (plus Enter) to the active terminal. With an empty field this sends a bare Enter — handy for confirming prompts."
          @mousedown.prevent
        >
          ⏎
        </button>
      </form>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import CompactTerminalKeyboard from "./CompactTerminalKeyboard.vue";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import { useAppStore } from "../../stores/app.js";
import { resolveInputOriginWorkspaceId } from "../../app/selectors.js";
import type { CompanionPrimaryTaskRunner } from "../../../electron/shared/companion-primary.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { useNotificationStore } from "../../stores/notifications.js";
import {
  readMobileInputBarCollapsed,
  readMobileInputDraft,
  writeMobileInputBarCollapsed,
  writeMobileInputDraft,
} from "../../app/helpers.js";

const api = inject<Transport>(apiKey);
const store = useAppStore();
const termStore = useTerminalStore();
const notifications = useNotificationStore();

function toast(title: string, body: string, kind: "info" | "error" = "info"): void {
  notifications.pushEphemeralToast({ title, body, kind, durationMs: 3000 });
}

// The session list is authoritative: virtual panes can use arbitrary view ID
// formats, while every writable terminal has a matching runtime session.
const targetSessionId = computed<string | null>(() => {
  if (store.isGridVisible) return null;
  const candidate = store.activeViewId || store.activeSessionId;
  if (!candidate) return null;
  // A borrowed Companion Primary writes to the SOURCE session, which is not in
  // this workspace's session list. The projected tab is the validation: it
  // only exists while the relocation is live, and it disappears atomically
  // with it — so a completed loop can never leave a stale write target here.
  const projected = (
    store.workspaceTabs as Array<{ id: string; type: string; sessionId?: string; borrowed?: boolean }>
  ).find((tab) => tab.id === candidate);
  if (projected?.borrowed) return projected.type === "terminal" ? projected.sessionId || null : null;
  const workspacePayload = store.payload?.workspace as unknown as {
    sessions?: Array<{ sessionId: string }>;
  } | null;
  const sessions = workspacePayload?.sessions || [];
  return sessions.some((session) => session.sessionId === candidate) ? candidate : null;
});

const draft = ref("");
const collapsed = ref(readMobileInputBarCollapsed());
const inputRef = ref<HTMLInputElement | null>(null);
const { isMobile, isPortrait, hasCoarsePointer } = useIsNarrow();
const devicePortrait = ref(readDevicePortrait());
const orientationPortrait = computed(() =>
  hasCoarsePointer.value && devicePortrait.value !== null ? devicePortrait.value : isPortrait.value,
);
const landscape = computed(() => isMobile.value && !orientationPortrait.value);

function readDevicePortrait(): boolean | null {
  const orientationType = window.screen.orientation?.type;
  if (orientationType?.startsWith("portrait")) return true;
  if (orientationType?.startsWith("landscape")) return false;

  const { width, height } = window.screen;
  if (width > 0 && height > 0 && width !== height) return height > width;
  return null;
}

function updateDeviceOrientation(): void {
  devicePortrait.value = readDevicePortrait();
}
const landscapeExpanded = ref(false);
const panelCollapsed = computed(() => (landscape.value ? !landscapeExpanded.value : collapsed.value));
const systemKeyboard = ref(true);
const hideAfterSend = ref(readHideAfterSend());
function readHideAfterSend(): boolean {
  try {
    return localStorage.getItem("strideterm.mobile.hideKeyboardAfterSend") === "true";
  } catch {
    return false;
  }
}
function toggleHideAfterSend() {
  menuOpen.value = false;
  hideAfterSend.value = !hideAfterSend.value;
  try {
    localStorage.setItem("strideterm.mobile.hideKeyboardAfterSend", String(hideAfterSend.value));
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
}
function finishSending() {
  if (hideAfterSend.value) collapse();
}
const compactKeyboard = computed(() => landscape.value && !systemKeyboard.value);
watch(landscape, () => {
  landscapeExpanded.value = false;
  systemKeyboard.value = true;
  inputRef.value?.blur();
});
async function toggleKeyboardMode() {
  inputRef.value?.blur();
  systemKeyboard.value = !systemKeyboard.value;
  await nextTick();
  inputRef.value?.focus({ preventScroll: true });
}
function insertCompact(text: string, backspace = false) {
  const input = inputRef.value;
  const value = composing.value ? (input?.value ?? draft.value) : draft.value;
  ignoreCompositionEnd.value = composing.value;
  composing.value = false;
  submitAfterComposition.value = false;
  let start = input?.selectionStart ?? value.length;
  const end = input?.selectionEnd ?? start;
  if (backspace && start === end) {
    const previous = Array.from(value.slice(0, start)).at(-1);
    start -= previous?.length ?? 0;
  }
  draft.value = value.slice(0, start) + text + value.slice(end);
  valueAfterIgnoredComposition = draft.value;
  if (input) input.value = draft.value;
  touched.value = true;
  const caret = start + text.length;
  void nextTick(() => {
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(caret, caret);
  });
}

const composing = ref(false);
const submitAfterComposition = ref(false);
const ignoreCompositionEnd = ref(false);
// What the field must contain after an ignored compositionend: "" for cancel/
// flush keys and session switches, the merged draft after paste. Vue's v-model
// commits the IME echo into `draft` on the same compositionend event (in
// listener order we don't control), so the ignore branch can't trust `draft` —
// it restores from this instead.
let valueAfterIgnoredComposition = "";

// Whether the field's content is explained: the user focused it (typing needs
// focus on both touch and desktop) or the bar itself wrote the draft. A
// password manager autofills without either, so this separates "we know where
// this text came from" from "something else put it here". The write paths set
// it directly rather than relying on their inputRef.focus() to emit a focus
// event — focus() is a no-op on an already-focused element, and iOS Safari can
// refuse programmatic focus outright.
const touched = ref(false);

// How long after mount an unexplained value still counts as autofill. Managers
// fill during or right after page load; 600ms covers the slow ones without
// leaving a window where a real draft could be dropped.
const AUTOFILL_SETTLE_MS = 600;

// The composer always starts empty, so any content in an untouched field came
// from a password manager that ignored the opt-out attributes on the input.
// Drop it: an autofilled value sitting in the bar is one ⏎ away from being
// written to the PTY.
function dropAutofilledValue(): void {
  if (touched.value) return;
  if (!draft.value && !inputRef.value?.value) return;
  draft.value = "";
  if (inputRef.value) inputRef.value.value = "";
}

/**
 * Puts back what this client was typing at [sessionId], if anything.
 *
 * `touched` is set with it, and that is deliberate rather than incidental: the autofill guard drops
 * unexplained text because an autofilled value is one ⏎ away from the PTY, and this text IS
 * explained — it is the draft this same browsing context wrote and stored. Nothing here sends
 * anything; the user still has to press enter (production hardening §5 "Session" 6).
 */
function restoreDraft(sessionId: string | null): void {
  const stored = sessionId ? readMobileInputDraft(sessionId) : "";
  if (!stored) return;
  rewritingDraft = true;
  draft.value = stored;
  if (inputRef.value) inputRef.value.value = stored;
  touched.value = true;
  rewritingDraft = false;
}

// The input is created by Vue, so a manager can only reach it after mount —
// one check once the fill window has passed is enough.
async function focusComposer() {
  if (!targetSessionId.value) return;
  expand();
  await nextTick();
  inputRef.value?.focus({ preventScroll: true });
}
onUnmounted(() => {
  window.screen.orientation?.removeEventListener("change", updateDeviceOrientation);
  window.removeEventListener("orientationchange", updateDeviceOrientation);
  postKeyboardAvailability(false);
  window.removeEventListener("strideterm:focus-composer", focusComposer);
  window.removeEventListener("strideterm:attachment-compose-open", requestAttachmentCompose);
  window.removeEventListener("strideterm:attachment-compose-result", handleAttachmentCompose);
  window.removeEventListener("strideterm:attachment-compose-cancel", handleAttachmentComposeCancel);
});
onMounted(() => {
  window.screen.orientation?.addEventListener("change", updateDeviceOrientation);
  window.addEventListener("orientationchange", updateDeviceOrientation);
  postKeyboardAvailability(!!api?.isRemote && !!targetSessionId.value);
  window.addEventListener("strideterm:focus-composer", focusComposer);
  window.addEventListener("strideterm:attachment-compose-open", requestAttachmentCompose);
  window.addEventListener("strideterm:attachment-compose-result", handleAttachmentCompose);
  window.addEventListener("strideterm:attachment-compose-cancel", handleAttachmentComposeCancel);
  // Before the autofill sweep, so a restored draft is already "touched" when it runs. This is the
  // path a background teardown and re-bootstrap comes back through: the page is new, the draft is
  // not.
  restoreDraft(targetSessionId.value);
  setTimeout(dropAutofilledValue, AUTOFILL_SETTLE_MS);
});

function postKeyboardAvailability(available: boolean) {
  try {
    window.StridetermViewport?.postMessage?.(JSON.stringify({ type: "keyboard-available", available }));
  } catch {
    // The browser has no native host.
  }
}

// Which session the CURRENT field contents belong to. A plain variable rather than a computed,
// because it has to change at an exact point inside the session-switch handler below: between
// clearing the outgoing session's text and restoring the incoming session's.
let draftOwner: string | null = targetSessionId.value;
// Set while the switch handler is rewriting the field, so its own clear/restore writes are not
// mistaken for the user typing.
let rewritingDraft = false;

// Every keystroke, stored against the session it belongs to. `flush: "sync"` matters: the default
// deferred flush would run these callbacks after the switch handler had finished, by which point
// "which session was this text typed at" is no longer answerable.
watch(
  draft,
  (value) => {
    if (rewritingDraft || !draftOwner) return;
    writeMobileInputDraft(draftOwner, value);
  },
  { flush: "sync" },
);

watch(targetSessionId, (sessionId, previousSessionId) => {
  postKeyboardAvailability(!!api?.isRemote && !!sessionId);
  if (sessionId !== previousSessionId) {
    rewritingDraft = true;
    ignoreCompositionEnd.value = composing.value;
    valueAfterIgnoredComposition = "";
    draft.value = "";
    if (inputRef.value) inputRef.value.value = "";
    composing.value = false;
    submitAfterComposition.value = false;
    draftOwner = sessionId;
    rewritingDraft = false;
    // The new session's own draft, if it has one. Empty is the ordinary case and leaves the field as
    // the lines above just left it.
    restoreDraft(sessionId);
  }
});

// Arrow keys use the normal-mode CSI sequences, matching the touch-scroll
// handler in terminal-controller.ts (alternate-buffer scroll emits the same
// "\x1b[A"/"\x1b[B"). Application-cursor-mode apps (vim, less, Claude Code)
// accept the CSI variants too, so no DECCKM tracking is needed here.
interface AccessoryKey {
  label: string;
  /** Longer label used when the key is rendered inside the ⋯ menu. */
  menuLabel?: string;
  seq: string;
  flushDraft: boolean;
  title: string;
}

const accessoryKeys: AccessoryKey[] = [
  {
    label: "Esc",
    seq: "\x1b",
    flushDraft: false,
    title: "Send Escape — cancels menus, prompts, and modes in TUI apps (vim, Claude Code, fzf…).",
  },
  {
    label: "Tab",
    seq: "\t",
    flushDraft: true,
    title: "Send Tab — shell completion, or next field in TUI apps.",
  },
  {
    label: "⇧Tab",
    seq: "\x1b[Z",
    flushDraft: true,
    title: "Send Shift+Tab — previous field in TUI apps; cycles permission modes in Claude Code.",
  },
  {
    label: "↑",
    seq: "\x1b[A",
    flushDraft: true,
    title: "Send Arrow Up — previous shell history entry, or move up in TUI menus.",
  },
  {
    label: "↓",
    seq: "\x1b[B",
    flushDraft: true,
    title: "Send Arrow Down — next shell history entry, or move down in TUI menus.",
  },
];

// Secondary keys live in the ⋯ menu — the left/right arrows moved here to free
// space on the top row, alongside less-frequent line-editing and control keys.
const menuKeys: AccessoryKey[] = [
  {
    label: "⌥↑",
    menuLabel: "⌥↑  Alt+Arrow Up (Codex)",
    seq: "\x1b[1;3A",
    flushDraft: true,
    title: "Send Alt+Arrow Up to the terminal.",
  },
  {
    label: "←",
    menuLabel: "←  Left",
    seq: "\x1b[D",
    flushDraft: true,
    title: "Send Arrow Left — move the cursor left on the command line.",
  },
  {
    label: "→",
    menuLabel: "→  Right",
    seq: "\x1b[C",
    flushDraft: true,
    title: "Send Arrow Right — move the cursor right on the command line.",
  },
  {
    label: "Home",
    menuLabel: "⇤  Home",
    seq: "\x1b[H",
    flushDraft: true,
    title: "Send Home — jump to the start of the line.",
  },
  {
    label: "End",
    menuLabel: "⇥  End",
    seq: "\x1b[F",
    flushDraft: true,
    title: "Send End — jump to the end of the line.",
  },
  {
    label: "^⇤",
    menuLabel: "^⇤  Ctrl+Home",
    seq: "\x1b[1;5H",
    flushDraft: true,
    title: "Send Ctrl+Home — jump to the top of the buffer or list in TUI apps.",
  },
  {
    label: "^⇥",
    menuLabel: "^⇥  Ctrl+End",
    seq: "\x1b[1;5F",
    flushDraft: true,
    title: "Send Ctrl+End — jump to the bottom of the buffer or list in TUI apps.",
  },
  {
    label: "^C",
    menuLabel: "^C  Ctrl+C  (interrupt)",
    seq: "\x03",
    flushDraft: false,
    title: "Send Ctrl+C — interrupt the running command or cancel the current input line.",
  },
  {
    label: "^U",
    menuLabel: "^U  Ctrl+U  (clear line)",
    seq: "\x15",
    flushDraft: false,
    title: "Send Ctrl+U — clear the current input line (deletes from the cursor back to the start).",
  },
  {
    label: "^R",
    menuLabel: "⌕  Ctrl+R  (history search)",
    seq: "\x12",
    flushDraft: false,
    title: "Send Ctrl+R — reverse history search in the shell.",
  },
  {
    label: "^L",
    menuLabel: "␌  Ctrl+L  (clear)",
    seq: "\x0c",
    flushDraft: false,
    title: "Send Ctrl+L — clear the screen.",
  },
];

const menuOpen = ref(false);

type AttachmentComposeRequest = {
  requestId: string;
  profileId: string;
  workspaceId: string;
  sessionId: string;
  draft: string;
  selectionStart: number;
  selectionEnd: number;
  sessionLabel?: string;
  workspaceLabel?: string;
};
type AttachmentComposeResult = AttachmentComposeRequest & {
  path: string;
  prompt: string;
  action: "insert" | "send";
};
type HostBridge = { postMessage?: (message: string) => void };
const hostAvailable = computed(() => typeof getHost()?.postMessage === "function");
const attachmentPending = ref<AttachmentComposeRequest | null>(null);
const completedAttachmentRequests = new Map<string, { ok: boolean; fingerprint: string }>();
function rememberAttachmentResult(requestId: string, result: { ok: boolean; fingerprint: string }): void {
  completedAttachmentRequests.set(requestId, result);
  if (completedAttachmentRequests.size > 100)
    completedAttachmentRequests.delete(completedAttachmentRequests.keys().next().value!);
}
function attachmentFingerprint(result: Partial<AttachmentComposeResult>): string {
  return JSON.stringify([
    result.profileId,
    result.workspaceId,
    result.sessionId,
    result.path,
    result.prompt,
    result.action,
  ]);
}
function getHost(): HostBridge | undefined {
  return (window as unknown as Record<string, unknown>).StridetermHost as HostBridge | undefined;
}
function postAttachmentAck(requestId: string, ok: boolean, error?: string): void {
  try {
    getHost()?.postMessage?.(
      JSON.stringify({ type: "attachment-compose-ack", requestId, ok, ...(error ? { error } : {}) }),
    );
  } catch {
    // The native host may disappear while its picker is open.
  }
}
function requestId(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes]
    .map(
      (byte, index) =>
        `${index === 4 || index === 6 || index === 8 || index === 10 ? "-" : ""}${byte.toString(16).padStart(2, "0")}`,
    )
    .join("");
}
function currentProfileId(): string {
  return store.myActiveProfileId || "default";
}
function requestAttachmentCompose(): void {
  if (composing.value || attachmentPending.value) return;
  const sessionId = targetSessionId.value;
  const host = getHost();
  if (!sessionId || typeof host?.postMessage !== "function") return;
  const workspaceId = originWorkspaceIdFor(sessionId);
  const sessionWorkspaceId = sessionId.slice(0, sessionId.indexOf(":"));
  if (workspaceId !== sessionWorkspaceId) {
    toast("Attachment unavailable", "Attachments are unavailable for a borrowed terminal tab.", "error");
    return;
  }
  const workspace = (
    store.payload?.appState?.workspaces as Array<{ id: string; name?: string; profileId?: string }> | undefined
  )?.find((entry) => entry.id === workspaceId && (entry.profileId || "default") === currentProfileId());
  const input = inputRef.value;
  const value = draft.value;
  const start = Math.max(0, Math.min(input?.selectionStart ?? value.length, value.length));
  const end = Math.max(start, Math.min(input?.selectionEnd ?? start, value.length));
  const request: AttachmentComposeRequest = {
    requestId: requestId(),
    profileId: currentProfileId(),
    workspaceId,
    sessionId,
    draft: value,
    selectionStart: start,
    selectionEnd: end,
    sessionLabel: (store.workspaceTabs as Array<{ id: string; title?: string }>).find((tab) => tab.id === sessionId)
      ?.title,
    workspaceLabel: workspace?.name,
  };
  attachmentPending.value = request;
  try {
    host.postMessage(JSON.stringify({ type: "attachment-compose", ...request }));
  } catch {
    attachmentPending.value = null;
    toast("Attachment unavailable", "The native file picker could not be opened.", "error");
  }
}
function validAttachmentPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const match = path.match(
    /^\.strideterm\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/([^/\\\x00-\x1f\x7f]+)$/i,
  );
  return !!match && match[1] !== "." && match[1] !== "..";
}
function normalizeAttachmentPrompt(prompt: string): string | null {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) return null;
  return prompt.replace(/[\r\n]+/g, " ");
}
function quotedAttachment(path: string): string {
  return JSON.stringify(path);
}
function mergeAttachment(value: string, start: number, end: number, path: string): string {
  const quoted = quotedAttachment(path);
  const before = value.slice(0, start);
  const after = value.slice(end);
  return `${before}${before && !/\s$/.test(before) ? " " : ""}${quoted}${after && !/^\s/.test(after) ? " " : ""}${after}`;
}
function setDraftFromAttachment(value: string): void {
  ignoreCompositionEnd.value = composing.value;
  composing.value = false;
  submitAfterComposition.value = false;
  draft.value = value;
  valueAfterIgnoredComposition = value;
  if (inputRef.value) inputRef.value.value = value;
  touched.value = true;
}
function handleAttachmentCompose(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return;
  const result = detail as Partial<AttachmentComposeResult>;
  const requestIdValue = result.requestId;
  if (typeof requestIdValue !== "string") return;
  const completed = completedAttachmentRequests.get(requestIdValue);
  if (completed !== undefined) {
    postAttachmentAck(requestIdValue, completed.fingerprint === attachmentFingerprint(result) && completed.ok);
    return;
  }
  const pending = attachmentPending.value;
  if (!pending || requestIdValue !== pending.requestId) return;
  const current = draft.value;
  const resultTargetMatches =
    result.profileId === pending.profileId &&
    result.workspaceId === pending.workspaceId &&
    result.sessionId === pending.sessionId;
  const targetStillCurrent =
    resultTargetMatches &&
    targetSessionId.value === pending.sessionId &&
    current === pending.draft &&
    currentProfileId() === pending.profileId &&
    originWorkspaceIdFor(pending.sessionId) === pending.workspaceId;
  const normalizedPrompt = typeof result.prompt === "string" ? normalizeAttachmentPrompt(result.prompt) : null;
  const ok =
    targetStillCurrent &&
    validAttachmentPath(result.path) &&
    normalizedPrompt !== null &&
    (result.action === "insert" || result.action === "send");
  if (!ok) {
    rememberAttachmentResult(requestIdValue, { ok: false, fingerprint: attachmentFingerprint(result) });
    attachmentPending.value = null;
    postAttachmentAck(requestIdValue, false, "Attachment target or draft changed");
    return;
  }
  const prompt = normalizedPrompt!;
  const value =
    prompt === pending.draft
      ? mergeAttachment(prompt, pending.selectionStart, pending.selectionEnd, result.path!)
      : `${prompt}${prompt && !/\s$/.test(prompt) ? " " : ""}${quotedAttachment(result.path!)}`;
  attachmentPending.value = null;
  setDraftFromAttachment(value);
  try {
    if (result.action === "send") sendComposed();
    rememberAttachmentResult(requestIdValue, { ok: true, fingerprint: attachmentFingerprint(result) });
    postAttachmentAck(requestIdValue, true);
    if (result.action === "insert") void focusComposer();
  } catch {
    rememberAttachmentResult(requestIdValue, { ok: false, fingerprint: attachmentFingerprint(result) });
    postAttachmentAck(requestIdValue, false, "Unable to apply attachment");
  }
}
function handleAttachmentComposeCancel(event: Event): void {
  const detail = (event as CustomEvent<{ requestId?: unknown }>).detail;
  if (detail?.requestId === attachmentPending.value?.requestId) attachmentPending.value = null;
}
function toggleMenu(): void {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value && landscape.value && systemKeyboard.value) inputRef.value?.blur();
}

/**
 * Workspace whose UI this write came from — the backend credits it with
 * `lastWorkedAt` after validating the claim. Same rule as the desktop
 * terminal store: an attached task's Primary tab belongs to the task
 * workspace, not to the source workspace that owns the session.
 */
function originWorkspaceIdFor(sessionId: string): string {
  const payload = store.payload;
  return resolveInputOriginWorkspaceId(
    payload?.appState?.workspaces,
    (payload?.taskRunner as CompanionPrimaryTaskRunner) || null,
    sessionId,
  );
}

function writeTerminal(sessionId: string, data: string): void {
  api?.writeTerminal(sessionId, data, originWorkspaceIdFor(sessionId));
}

function sendData(data: string): void {
  if (!targetSessionId.value) return;
  // The composer writes straight to the transport (no xterm instance on
  // mobile), so it has to report engagement itself.
  notifications.resolveByEngagement(targetSessionId.value, data);
  writeTerminal(targetSessionId.value, data);
}

// Accessory keys use @mousedown.prevent so tapping them never steals focus:
// if the composer input is focused the on-screen keyboard stays open, and if
// it isn't, pressing Esc/arrows doesn't pop the keyboard up.
function sendKey(key: AccessoryKey): void {
  const currentDraft = composing.value ? (inputRef.value?.value ?? draft.value) : draft.value;
  ignoreCompositionEnd.value = composing.value;
  valueAfterIgnoredComposition = "";
  composing.value = false;
  submitAfterComposition.value = false;
  sendData((key.flushDraft ? currentDraft : "") + key.seq);
  draft.value = "";
  if (inputRef.value) inputRef.value.value = "";
}

function sendMenuKey(key: AccessoryKey): void {
  menuOpen.value = false;
  sendKey(key);
}

// Insert "/" into the draft so the user can build an agent slash command
// (e.g. "/help") in the field and send it with ⏎. Mirrors the paste dance so
// an in-flight IME composition can't clobber the inserted character. Deliberately
// does not focus the field: on a phone only a direct tap in the editor may open
// the software keyboard.
function insertSlash(): void {
  const current = composing.value ? (inputRef.value?.value ?? draft.value) : draft.value;
  ignoreCompositionEnd.value = composing.value;
  composing.value = false;
  submitAfterComposition.value = false;
  draft.value = current + "/";
  valueAfterIgnoredComposition = draft.value;
  if (inputRef.value) inputRef.value.value = draft.value;
  menuOpen.value = false;
  touched.value = true;
}

// Quick full slash commands. Unlike the "/" insert, these REPLACE the draft with
// the complete command, ready to send with ⏎ (or to extend first, e.g.
// "/model opus"). Replacing avoids producing an invalid "text/clear" — a
// deliberate command tap wins over a stray draft.
const slashCommands = ["/clear", "/model", "/usage", "/status"];
function setSlashCommand(cmd: string): void {
  ignoreCompositionEnd.value = composing.value;
  composing.value = false;
  submitAfterComposition.value = false;
  draft.value = cmd;
  valueAfterIgnoredComposition = draft.value;
  if (inputRef.value) inputRef.value.value = draft.value;
  menuOpen.value = false;
  touched.value = true;
}

// Copy the visible terminal screen to the clipboard. Selecting text by hand is
// painful on touch, and what's on screen is almost always the agent's latest
// answer. The clipboard write runs synchronously inside the click gesture so
// the browser's transient-activation requirement is met on the remote web
// client (same constraint as copy-on-select in terminal-controller.ts).
async function copyScreen(): Promise<void> {
  menuOpen.value = false;
  const sessionId = targetSessionId.value;
  if (!sessionId) return;
  const text = termStore.getVisibleTerminalText(sessionId);
  if (!text) {
    toast("Nothing to copy", "The terminal screen is empty.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied", "The visible terminal screen is on the clipboard.");
  } catch {
    toast("Copy failed", "The browser blocked clipboard access.", "error");
  }
}

// Open the "Select text" panel for the terminal this bar writes to. Uses the
// SAME target derivation as every other action here (a borrowed Companion
// Primary writes to another workspace's session, and the snapshot has to come
// from that one), and lets the store do the profile check.
function selectText(): void {
  menuOpen.value = false;
  const sessionId = targetSessionId.value;
  if (!sessionId) return;
  if (!termStore.requestTextSelection(sessionId)) {
    toast("Can't select text", "That terminal isn't available right now.", "error");
  }
}

function sendComposed(): void {
  if (composing.value) {
    submitAfterComposition.value = true;
    return;
  }
  const sessionId = targetSessionId.value;
  if (!sessionId) return;
  const text = draft.value;
  notifications.resolveByEngagement(sessionId, text || "\r");
  // Keep whitespace intact. The backend queues text and Enter as one submit
  // operation so a closed session cannot receive a delayed ghost Enter.
  api?.submitTerminal(sessionId, text, originWorkspaceIdFor(sessionId));
  draft.value = "";
  finishSending();
}

function handleCompositionStart(): void {
  ignoreCompositionEnd.value = false;
  composing.value = true;
}

// Paste never writes to the PTY directly — the clipboard text lands in the
// draft so the user can review and edit it before sending. An active IME
// composition is force-committed first (same dance as sendKey), so the late
// compositionend can't clobber the merged draft.
async function pasteFromClipboard(): Promise<void> {
  let text = "";
  try {
    text = (await navigator.clipboard?.readText()) ?? "";
  } catch {
    // Insecure origin or permission denied — the field still accepts the
    // platform's long-press paste menu.
  }
  const current = composing.value ? (inputRef.value?.value ?? draft.value) : draft.value;
  ignoreCompositionEnd.value = composing.value;
  composing.value = false;
  submitAfterComposition.value = false;
  // A single-line <input> can't render line breaks — flatten them so the
  // field shows exactly what would be sent.
  draft.value = current + text.replace(/\r?\n/g, " ");
  valueAfterIgnoredComposition = draft.value;
  // Set the element directly: Vue's v-model skips view updates while the
  // browser still considers the composition active.
  if (inputRef.value) inputRef.value.value = draft.value;
  touched.value = true;
}

function handleCompositionEnd(event: CompositionEvent): void {
  if (ignoreCompositionEnd.value) {
    ignoreCompositionEnd.value = false;
    (event.target as HTMLInputElement).value = valueAfterIgnoredComposition;
    draft.value = valueAfterIgnoredComposition;
    return;
  }
  composing.value = false;
  draft.value = (event.target as HTMLInputElement).value;
  if (!submitAfterComposition.value) return;
  submitAfterComposition.value = false;
  nextTick(sendComposed);
}

function collapse(): void {
  inputRef.value?.blur();
  menuOpen.value = false;
  if (landscape.value) {
    landscapeExpanded.value = false;
    return;
  }
  collapsed.value = true;
  writeMobileInputBarCollapsed(true);
}

async function expand(): Promise<void> {
  if (landscape.value) {
    if (document.documentElement.classList.contains("native-session-rail")) systemKeyboard.value = false;
    landscapeExpanded.value = true;
    await nextTick();
    if (systemKeyboard.value) inputRef.value?.focus({ preventScroll: true });
    return;
  }
  collapsed.value = false;
  writeMobileInputBarCollapsed(false);
  // Expanding is a layout action, not an intent to type. Leaving focus alone
  // prevents Android/iOS from opening the keyboard until the user taps the
  // editor itself.
}
</script>
