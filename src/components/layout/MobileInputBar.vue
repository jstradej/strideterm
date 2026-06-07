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
          class="mobile-input-bar__key mobile-input-bar__key--collapse"
          title="Collapse the input bar to a slim handle so the terminal gets the vertical space back. Tap the handle to bring it back."
          @mousedown.prevent
          @click="collapse"
        >
          ▾
        </button>
      </div>
      <form class="mobile-input-bar__row" @submit.prevent="sendComposed">
        <input
          ref="inputRef"
          v-model="draft"
          type="text"
          class="mobile-input-bar__input"
          placeholder="Type a command — ⏎ sends it"
          autocomplete="off"
          autocapitalize="none"
          enterkeyhint="send"
          title="Compose a line for the active terminal. Mobile predictive text and autocorrect work normally here — what you see is exactly what gets sent when you press ⏎."
          data-role="mobile-input-bar-input"
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
import { computed, inject, nextTick, ref, watch } from "vue";
import type { Transport } from "../../transport.js";
import { useAppStore } from "../../stores/app.js";
import { readMobileInputBarCollapsed, writeMobileInputBarCollapsed } from "../../app/helpers.js";

const api = inject<Transport>("api");
const store = useAppStore();

// The session list is authoritative: virtual panes can use arbitrary view ID
// formats, while every writable terminal has a matching runtime session.
const targetSessionId = computed<string | null>(() => {
  if (store.isGridVisible) return null;
  const workspacePayload = store.payload?.workspace as unknown as {
    sessions?: Array<{ sessionId: string }>;
  } | null;
  const sessions = workspacePayload?.sessions || [];
  const candidate = store.activeViewId || store.activeSessionId;
  if (!candidate) return null;
  return sessions.some((session) => session.sessionId === candidate) ? candidate : null;
});

const draft = ref("");
const collapsed = ref(readMobileInputBarCollapsed());
const inputRef = ref<HTMLInputElement | null>(null);
const composing = ref(false);
const submitAfterComposition = ref(false);
const ignoreCompositionEnd = ref(false);

watch(targetSessionId, (sessionId, previousSessionId) => {
  if (sessionId !== previousSessionId) {
    ignoreCompositionEnd.value = composing.value;
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
  {
    label: "←",
    seq: "\x1b[D",
    flushDraft: true,
    title: "Send Arrow Left — move the cursor left on the command line.",
  },
  {
    label: "→",
    seq: "\x1b[C",
    flushDraft: true,
    title: "Send Arrow Right — move the cursor right on the command line.",
  },
  {
    label: "^C",
    seq: "\x03",
    flushDraft: false,
    title: "Send Ctrl+C — interrupt the running command or cancel the current input line.",
  },
];

function sendData(data: string): void {
  if (!targetSessionId.value) return;
  api?.writeTerminal(targetSessionId.value, data);
}

// Accessory keys use @mousedown.prevent so tapping them never steals focus:
// if the composer input is focused the on-screen keyboard stays open, and if
// it isn't, pressing Esc/arrows doesn't pop the keyboard up.
function sendKey(key: AccessoryKey): void {
  const currentDraft = composing.value ? (inputRef.value?.value ?? draft.value) : draft.value;
  ignoreCompositionEnd.value = composing.value;
  composing.value = false;
  submitAfterComposition.value = false;
  sendData((key.flushDraft ? currentDraft : "") + key.seq);
  draft.value = "";
  if (inputRef.value) inputRef.value.value = "";
}

function sendComposed(): void {
  if (composing.value) {
    submitAfterComposition.value = true;
    return;
  }
  // Empty draft sends a bare Enter — confirming TUI prompts without typing.
  // No trimming: predictive-text picks leave a trailing space, which is
  // harmless, and intentional leading/trailing spaces must survive.
  sendData(draft.value + "\r");
  draft.value = "";
}

function handleCompositionStart(): void {
  ignoreCompositionEnd.value = false;
  composing.value = true;
}

function handleCompositionEnd(event: CompositionEvent): void {
  if (ignoreCompositionEnd.value) {
    ignoreCompositionEnd.value = false;
    (event.target as HTMLInputElement).value = "";
    draft.value = "";
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
