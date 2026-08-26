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
    :class="{ 'mobile-input-bar--collapsed': collapsed }"
    data-role="mobile-input-bar"
  >
    <button
      v-if="collapsed"
      type="button"
      class="mobile-input-bar__expand"
      title="Expand the terminal input bar — a plain text field where mobile autocorrect works correctly, plus Esc / Tab / arrow / Ctrl+C keys. Lines you type are sent to the active terminal on ⏎."
      @click="expand"
    >
      ⌨ Input bar ▴
    </button>
    <template v-else>
      <div class="mobile-input-bar__keys">
        <button
          v-for="key in accessoryKeys"
          :key="key.label"
          type="button"
          class="mobile-input-bar__key"
          :title="key.title"
          @mousedown.prevent
          @click="sendKey(key)"
        >
          {{ key.label }}
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
        <div class="mobile-input-bar__more">
          <button
            type="button"
            class="mobile-input-bar__key mobile-input-bar__key--more"
            :class="{ 'mobile-input-bar__key--active': menuOpen }"
            title="More keys and actions — arrows, Home/End, Ctrl+Home/Ctrl+End, Ctrl+C, Ctrl+R, Ctrl+L, slash commands, and copy the visible screen."
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
                v-for="key in menuKeys"
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
          ▾
        </button>
      </div>
      <!-- This is not a credential form, but a single text field plus a submit
           button is exactly what mobile password managers (Google Password
           Manager, iCloud Keychain, Samsung Pass, 1Password, Bitwarden…)
           heuristically classify as a login: they offer to "save the password"
           on ⏎ and then autofill the remembered value back into the field on
           the next page load — the bar would open pre-filled with a word the
           user never typed, one ⏎ away from the shell. The autocomplete and
           vendor opt-out attributes below tell every manager we know of to stay
           out; dropAutofilledValue() is the backstop for the ones that ignore
           them (Chrome's autofill routinely ignores autocomplete="off"). -->
      <form class="mobile-input-bar__row" autocomplete="off" @submit.prevent="sendComposed">
        <input
          ref="inputRef"
          v-model="draft"
          type="text"
          class="mobile-input-bar__input"
          placeholder="Type a command — ⏎ sends it"
          name="strideterm-terminal-line"
          autocomplete="off"
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
import { computed, inject, nextTick, onMounted, ref, watch } from "vue";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { readMobileInputBarCollapsed, writeMobileInputBarCollapsed } from "../../app/helpers.js";

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

// The input is created by Vue, so a manager can only reach it after mount —
// one check once the fill window has passed is enough.
onMounted(() => {
  setTimeout(dropAutofilledValue, AUTOFILL_SETTLE_MS);
});

watch(targetSessionId, (sessionId, previousSessionId) => {
  if (sessionId !== previousSessionId) {
    ignoreCompositionEnd.value = composing.value;
    valueAfterIgnoredComposition = "";
    draft.value = "";
    if (inputRef.value) inputRef.value.value = "";
    composing.value = false;
    submitAfterComposition.value = false;
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
function toggleMenu(): void {
  menuOpen.value = !menuOpen.value;
}

function sendData(data: string): void {
  if (!targetSessionId.value) return;
  // The composer writes straight to the transport (no xterm instance on
  // mobile), so it has to report engagement itself.
  notifications.resolveByEngagement(targetSessionId.value, data);
  api?.writeTerminal(targetSessionId.value, data);
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
// an in-flight IME composition can't clobber the inserted character.
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
  inputRef.value?.focus();
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
  inputRef.value?.focus();
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

// Delay between the composed text and its Enter, matching #writeAndSubmit in
// agent-task-runner.ts. Agent TUIs (Claude Code, Copilot…) classify a fast
// multi-char chunk as a paste, and a \r inside a paste inserts a newline
// instead of submitting — so the Enter must arrive as its own write, late
// enough not to be coalesced with the text. Plain shells don't care.
const SUBMIT_DELAY_MS = 200;

function sendComposed(): void {
  if (composing.value) {
    submitAfterComposition.value = true;
    return;
  }
  const sessionId = targetSessionId.value;
  if (!sessionId) return;
  notifications.resolveByEngagement(sessionId, draft.value || "\r");
  // Empty draft sends a bare Enter — confirming TUI prompts without typing.
  if (!draft.value) {
    api?.writeTerminal(sessionId, "\r");
    return;
  }
  // No trimming: predictive-text picks leave a trailing space, which is
  // harmless, and intentional leading/trailing spaces must survive.
  api?.writeTerminal(sessionId, draft.value);
  draft.value = "";
  // The session id is captured above so switching tabs mid-delay can't route
  // the pending Enter to a different terminal than the one that got the text.
  setTimeout(() => api?.writeTerminal(sessionId, "\r"), SUBMIT_DELAY_MS);
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
  inputRef.value?.focus();
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
  collapsed.value = true;
  writeMobileInputBarCollapsed(true);
}

function expand(): void {
  collapsed.value = false;
  writeMobileInputBarCollapsed(false);
  // The input doesn't exist until the v-if re-renders, so focus has to wait
  // for nextTick. Unlike showMobileKeyboard in App.vue (which focuses
  // synchronously inside the click handler), a microtask-delayed focus is
  // not guaranteed to keep the user-gesture context on iOS Safari — the
  // on-screen keyboard may not auto-open there; tapping the field still works.
  nextTick(() => inputRef.value?.focus());
}
</script>
