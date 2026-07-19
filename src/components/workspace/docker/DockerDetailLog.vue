<template>
  <div class="detail-log" ref="rootEl">
    <DockerLogToolbar
      ref="toolbarEl"
      :paused="paused"
      :timestamps="timestamps"
      :tail="tail"
      :line-count="lineCount"
      :byte-count="byteCount"
      :search-index="searchIndex"
      :search-total="searchMatches.length"
      :copied="copied"
      @toggle-pause="togglePause"
      @clear="clearScreen"
      @copy="copyAll"
      @download="downloadAll"
      @search="onSearch"
      @search-next="searchNext"
      @search-prev="searchPrev"
      @tail-change="onTailChange"
      @toggle-timestamps="toggleTimestamps"
    />

    <div class="detail-log__stage">
      <!-- Connecting overlay -->
      <div v-if="connecting" class="detail-log__overlay">
        <Spinner size="md" />
        <span>Attaching to {{ containerName }} logs…</span>
      </div>
      <!-- Reattaching overlay -->
      <div v-if="reattaching" class="detail-log__overlay">
        <Spinner size="md" />
        <span>Container restarted, reattaching…</span>
      </div>

      <!-- Stopped: container isn't running, we've shown the tail and parked. -->
      <div v-if="stopped && !connecting && !reattaching" class="detail-log__stopped" role="status">
        <span class="detail-log__stopped-dot" aria-hidden="true" />
        <span>Container is stopped — showing last logs.</span>
        <span class="detail-log__stopped-hint">Stream will resume when it starts again.</span>
      </div>

      <div ref="termEl" class="detail-log__term" />

      <!-- Floating "jump to bottom" when user has scrolled up -->
      <button
        v-show="!autoScroll && lineCount > 0"
        type="button"
        class="detail-log__jump"
        title="Jump back to the live tail"
        @click="resumeAutoScroll"
      >
        ↓
        <span v-if="pendingLines > 0" class="detail-log__jump-badge">+{{ formatNum(pendingLines) }}</span>
        <span class="detail-log__jump-label">live</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onActivated, onBeforeUnmount, watch } from "vue";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import Spinner from "../../common/Spinner.vue";
import DockerLogToolbar from "./DockerLogToolbar.vue";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

/**
 * Compose the xterm theme. `searchActive` swaps the selection palette for a
 * high-contrast highlight so the active search hit is unmistakable against
 * coloured JSON output where the default 15% white wash disappears entirely.
 */
function resolveLogTheme(searchActive = false): ITheme {
  const isLight = document.documentElement.dataset.theme === "light";
  const base: ITheme = isLight
    ? { background: "#f7f7f9", foreground: "#18181b", cursor: "#18181b", selectionBackground: "rgba(0,0,0,0.15)" }
    : {
        background: "#141416",
        foreground: "#d8e4f5",
        cursor: "#ffa424",
        selectionBackground: "rgba(255,255,255,0.15)",
      };
  if (!searchActive) return base;
  // Strong amber wash with dark text — readable on any underlying SGR colour.
  return { ...base, selectionBackground: "#ffa424", selectionForeground: "#141416" };
}

const TERMINAL_FONT_STACK =
  '"JetBrainsMono NFM", "CaskaydiaCove NFM", "MesloLGS NF", "FiraCode NFM", "Cascadia Mono NF", "Cascadia Code PL", "Cascadia Mono", "JetBrains Mono", "Fira Code", "Consolas", monospace';

const SCROLLBACK = 50_000;

// Ctrl/Cmd+wheel zoom shares the same per-transport settings keys as the main
// terminal so a single user preference applies everywhere logs/terminals render.
const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("mac");
const FONT_MIN = 8;
const FONT_MAX = 32;
const FONT_DEFAULT = 13;

const props = defineProps<{
  sessionId: string;
  containerId: string;
  containerName: string;
  backendId: string;
  contextName: string;
  removed?: boolean;
}>();

const appStore = useAppStore();
const notifications = useNotificationStore();

const rootEl = ref<HTMLElement | null>(null);
const termEl = ref<HTMLElement | null>(null);
const toolbarEl = ref<InstanceType<typeof DockerLogToolbar> | null>(null);

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame = 0;
let scrollDisposer: { dispose(): void } | null = null;

// Connection state
const connecting = ref(true);
const reattaching = ref(false);
const stopped = ref(false);
let currentSessionId = props.sessionId;

/**
 * Reattach scheduling. `docker logs -f` on a stopped container dumps the tail
 * and exits immediately — without state-aware gating we'd reopen forever and
 * replay 1000 lines a second (the flicker the user saw). We instead:
 *   1. skip reattach entirely while the docker snapshot reports the container
 *      as not running — re-arm via a watcher when it comes back; and
 *   2. apply exponential backoff for streams that close within a couple of
 *      seconds without emitting data (snapshot is up to 30 s stale, so the
 *      container may have died between polls and we need a runtime fallback).
 */
let streamStartedAt = 0;
let streamGotData = false;
let reattachAttempts = 0;
let reattachTimer: ReturnType<typeof setTimeout> | null = null;
const SHORT_LIVED_MS = 2000;
const FIRST_REATTACH_MS = 1000;
const MAX_REATTACH_MS = 30_000;

const containerStateLower = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = appStore.dockerState();
  if (!docker?.containers) return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = docker.containers.find((c: AnyApi) => c.ID === props.containerId);
  return String(found?.State || "").toLowerCase();
});
const containerRunning = computed(() => containerStateLower.value === "running");

// User-configurable stream + display options. Defaults match the previous
// behaviour (1000 tail, no timestamps).
const paused = ref(false);
const timestamps = ref(false);
const tail = ref<number | "all">(1000);
const autoScroll = ref(true);
const pendingLines = ref(0);

// Stats
const lineCount = ref(0);
const byteCount = ref(0);
const copied = ref(false);

// Search state — indices reference xterm.buffer.active line numbers.
interface Match {
  row: number;
  col: number;
  length: number;
}
const searchQuery = ref("");
const searchMatches = ref<Match[]>([]);
const searchIndex = ref(0);

/**
 * Pending bytes while paused. We don't tell the backend to pause — the docker
 * subprocess keeps streaming so we don't miss bursts — instead we buffer the
 * incoming chunks here. Flushed in order on resume. Capped so a runaway
 * container can't OOM us while the user takes a coffee break.
 */
const PAUSE_BUFFER_CAP = 16 * 1024 * 1024;
let pauseBuffer = "";
let pauseBufferOverflowed = false;

/**
 * Schedule a fit() on next paint. Guards against KeepAlive cache rendering
 * the host at 0×0 (xterm would size itself to a single row).
 */
function scheduleFit(): void {
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    if (!term || !fitAddon || !rootEl.value) return;
    const rect = rootEl.value.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    try {
      fitAddon.fit();
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      // not ready — try again on next ResizeObserver tick
    }
  });
}

function fontSizeKey(): "terminalFontSizeLocal" | "terminalFontSizeRemote" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (appStore as AnyApi).isRemoteTransport ? "terminalFontSizeRemote" : "terminalFontSizeLocal";
}

function clampFontSize(n: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
}

function readFontSize(): number {
  const s = (appStore.payload as AnyApi)?.appState?.settings as Record<string, unknown> | undefined;
  const raw = s?.[fontSizeKey()];
  return typeof raw === "number" ? clampFontSize(raw) : FONT_DEFAULT;
}

// Source of truth for the current font size — xterm's term.options.fontSize
// read-back is unreliable right after a write (the renderer applies it
// asynchronously), so we track the intended value here.
let currentFontSize = FONT_DEFAULT;
let persistFontTimer: ReturnType<typeof setTimeout> | null = null;
function applyFontSize(size: number): void {
  if (!term) return;
  const clamped = clampFontSize(size);
  if (clamped === currentFontSize) return;
  currentFontSize = clamped;
  term.options.fontSize = clamped;
  // Force the renderer to pick up the new metrics; fit() alone is a no-op when
  // the host size hasn't changed, so the canvas wouldn't redraw at the new size.
  scheduleFit();
  if (persistFontTimer) clearTimeout(persistFontTimer);
  persistFontTimer = setTimeout(() => {
    persistFontTimer = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (appStore as AnyApi).updateSettings?.({ [fontSizeKey()]: clamped })?.catch?.(() => {});
  }, 200);
}

function formatNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function writeData(payload: { sessionId: string; data: Buffer | ArrayBuffer | Uint8Array | string }): void {
  if (payload.sessionId !== currentSessionId) return;
  if (connecting.value) connecting.value = false;
  if (reattaching.value) reattaching.value = false;
  if (stopped.value) stopped.value = false;
  streamGotData = true;
  // Live data means the previous backoff (if any) was a false alarm.
  reattachAttempts = 0;

  const buf = payload.data;
  const str = typeof buf === "string" ? buf : new TextDecoder().decode(buf as ArrayBuffer);
  byteCount.value += str.length;
  // Approx — we count actual LF terminators emitted by the stream.
  const newlines = (str.match(/\n/g) || []).length;
  lineCount.value += newlines;

  if (paused.value) {
    if (pauseBuffer.length + str.length > PAUSE_BUFFER_CAP) {
      // Buffer cap reached — keep the tail, mark overflow for the user.
      const room = Math.max(0, PAUSE_BUFFER_CAP - str.length);
      pauseBuffer = pauseBuffer.slice(pauseBuffer.length - room) + str;
      pauseBufferOverflowed = true;
    } else {
      pauseBuffer += str;
    }
    return;
  }

  if (!autoScroll.value) {
    // User has scrolled up — emit normally but count "new since I looked away".
    pendingLines.value += newlines;
  }
  term?.write(str);
}

function onClose(payload: { sessionId: string; code: number | null }): void {
  if (payload.sessionId !== currentSessionId) return;
  if (props.removed) return;

  connecting.value = false;
  reattaching.value = false;

  const lifetime = Date.now() - streamStartedAt;
  const shortLived = lifetime < SHORT_LIVED_MS;

  // Snapshot says the container is stopped — park the stream and let the
  // watcher restart us when it transitions back to running. This is the main
  // fix for the reattach storm: a `docker logs -f` against a stopped container
  // exits immediately after the --tail dump, and re-running it just replays
  // the same lines forever.
  if (!containerRunning.value) {
    stopped.value = true;
    reattachAttempts = 0;
    return;
  }

  // Container is supposedly running but the stream died fast and produced no
  // data — most likely the snapshot is stale (poll runs every 30 s) and the
  // container actually exited. Back off instead of busy-looping.
  if (shortLived && !streamGotData) {
    reattachAttempts++;
  } else {
    reattachAttempts = 0;
  }
  scheduleReattach();
}

function scheduleReattach(): void {
  if (reattachTimer) {
    clearTimeout(reattachTimer);
    reattachTimer = null;
  }
  // 0 → 1s, 1 → 2s, 2 → 4s, 3 → 8s, 4 → 16s, 5+ → 30s (cap).
  const delayMs =
    reattachAttempts === 0
      ? FIRST_REATTACH_MS
      : Math.min(MAX_REATTACH_MS, FIRST_REATTACH_MS * Math.pow(2, reattachAttempts));
  reattachTimer = setTimeout(() => {
    reattachTimer = null;
    if (props.removed) return;
    // Snapshot may have flipped to stopped while we were waiting; park if so.
    if (!containerRunning.value) {
      stopped.value = true;
      return;
    }
    reattaching.value = true;
    currentSessionId = crypto.randomUUID();
    lineCount.value = 0;
    byteCount.value = 0;
    openLogSession();
  }, delayMs);
}

function openLogSession(): void {
  streamStartedAt = Date.now();
  streamGotData = false;
  appStore
    .dockerLogsOpen(currentSessionId, props.containerId, props.backendId, props.contextName, {
      timestamps: timestamps.value,
      tail: tail.value,
    })
    .catch((e) => {
      const msg = (e as Error)?.message || String(e);
      connecting.value = false;
      reattaching.value = false;
      notifications.showError("Log stream failed", `${props.containerName}: ${msg}`);
    });
}

function closeLogSession(): void {
  appStore.dockerLogsClose(currentSessionId).catch(() => {
    // Backend is allowed to no-op if session already gone; nothing to surface.
  });
}

// ----- Toolbar handlers -----

function togglePause(): void {
  paused.value = !paused.value;
  if (!paused.value) flushPauseBuffer();
}

function flushPauseBuffer(): void {
  if (!pauseBuffer || !term) {
    pauseBuffer = "";
    return;
  }
  if (pauseBufferOverflowed) {
    term.write(
      `\r\n\x1b[33m--- log stream resumed; ${formatNum(PAUSE_BUFFER_CAP)} byte buffer was full, oldest data was dropped ---\x1b[0m\r\n`,
    );
    pauseBufferOverflowed = false;
  }
  term.write(pauseBuffer);
  pauseBuffer = "";
}

function clearScreen(): void {
  term?.clear();
  lineCount.value = 0;
  byteCount.value = 0;
  pendingLines.value = 0;
  clearSearch();
}

async function copyAll(): Promise<void> {
  const text = collectScrollback();
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch (e) {
    notifications.showError("Copy failed", (e as Error)?.message || String(e));
  }
}

function downloadAll(): void {
  const text = collectScrollback();
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = props.containerName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `${safeName}-${ts}.log`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function collectScrollback(): string {
  if (!term) return "";
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  // Trim trailing empty rows (xterm keeps blank lines past the last write).
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

// ----- Search -----

function onSearch(q: string): void {
  searchQuery.value = q;
  runSearch();
}

function runSearch(): void {
  if (!term) {
    searchMatches.value = [];
    return;
  }
  const q = searchQuery.value;
  if (!q) {
    searchMatches.value = [];
    searchIndex.value = 0;
    term.clearSelection();
    // Restore the default (subtle) selection so manual copy-selection isn't
    // jarringly amber any more.
    term.options.theme = resolveLogTheme(false);
    return;
  }
  // Swap to the high-contrast selection palette so the active hit pops out
  // even when sitting on coloured JSON output.
  term.options.theme = resolveLogTheme(true);
  const lq = q.toLowerCase();
  const buf = term.buffer.active;
  const matches: Match[] = [];
  for (let i = 0; i < buf.length && matches.length < 5000; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(false);
    const lower = text.toLowerCase();
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(lq, from);
      if (idx < 0) break;
      matches.push({ row: i, col: idx, length: q.length });
      from = idx + q.length;
    }
  }
  searchMatches.value = matches;
  if (matches.length > 0) {
    searchIndex.value = 0;
    highlightMatch(0);
  } else {
    searchIndex.value = 0;
    term.clearSelection();
  }
}

function highlightMatch(idx: number): void {
  if (!term) return;
  const m = searchMatches.value[idx];
  if (!m) return;
  // xterm select() expects (column, row, length) where row is buffer-absolute.
  term.select(m.col, m.row, m.length);
  term.scrollToLine(m.row);
  // Once we explicitly scroll for search, treat as user-initiated; the auto-
  // scroll badge will pop up so the user can jump back to live.
  autoScroll.value = false;
}

function searchNext(): void {
  if (searchMatches.value.length === 0) return;
  searchIndex.value = (searchIndex.value + 1) % searchMatches.value.length;
  highlightMatch(searchIndex.value);
}

function searchPrev(): void {
  if (searchMatches.value.length === 0) return;
  searchIndex.value = (searchIndex.value - 1 + searchMatches.value.length) % searchMatches.value.length;
  highlightMatch(searchIndex.value);
}

function clearSearch(): void {
  searchQuery.value = "";
  searchMatches.value = [];
  searchIndex.value = 0;
  term?.clearSelection();
  if (term) term.options.theme = resolveLogTheme(false);
}

// ----- Stream option toggles (these restart the backend stream) -----

async function toggleTimestamps(): Promise<void> {
  timestamps.value = !timestamps.value;
  await restartStream();
}

async function onTailChange(newTail: number | "all"): Promise<void> {
  tail.value = newTail;
  await restartStream();
}

async function restartStream(): Promise<void> {
  if (!term) return;
  // Try in-place restart first — keeps the same sessionId on the backend
  // and is cheaper. If the session no longer exists (race with auto-reattach),
  // fall back to a fresh open.
  try {
    const ok = await appStore.dockerLogsUpdate(currentSessionId, {
      timestamps: timestamps.value,
      tail: tail.value,
    });
    if (ok) {
      term.clear();
      lineCount.value = 0;
      byteCount.value = 0;
      pendingLines.value = 0;
      reattaching.value = true;
      return;
    }
  } catch (e) {
    // Fall through to a full re-open. Surface the underlying error only if
    // re-open also fails (otherwise the user sees a spurious toast).
    notifications.showError(
      "Log stream restart failed",
      `${props.containerName}: ${(e as Error)?.message || String(e)}`,
    );
  }
  // Hard re-open
  closeLogSession();
  currentSessionId = crypto.randomUUID();
  term.clear();
  lineCount.value = 0;
  byteCount.value = 0;
  pendingLines.value = 0;
  connecting.value = true;
  openLogSession();
}

// ----- Auto-scroll detection -----

function resumeAutoScroll(): void {
  autoScroll.value = true;
  pendingLines.value = 0;
  term?.scrollToBottom();
}

function attachScrollWatcher(t: Terminal): void {
  scrollDisposer?.dispose();
  scrollDisposer = t.onScroll(() => {
    if (!term) return;
    const viewportEnd = term.buffer.active.viewportY + term.rows;
    const bottom = term.buffer.active.length;
    // xterm reports viewportY in scrollback-absolute units. We consider the
    // user "at the live tail" if they're within one screen of the bottom.
    const atBottom = bottom - viewportEnd <= 1;
    if (atBottom) {
      autoScroll.value = true;
      pendingLines.value = 0;
    } else {
      autoScroll.value = false;
    }
  });
}

// -----------------------------------------------------------------------------
// Touch scrolling on mobile (1-finger swipe) + pinch-zoom (2-finger).
//
// Mirrors terminal-controller.ts's handlers so the docker log pane behaves like
// the main terminal when touched. Read-only stream → no arrow-key forwarding
// to a PTY, no alternate-buffer case; we always scrollLines() the local xterm
// viewport. preventDefault() in touchstart/touchmove suppresses the browser's
// default rubber-band scroll on the page so the gesture stays "inside" the
// log pane.
// -----------------------------------------------------------------------------
const touch = {
  mode: "none" as "none" | "scroll" | "pinch",
  lastY: 0,
  scrollAccum: 0,
  startDist: 0,
  startFont: 0,
};

function getTouchDist(e: TouchEvent): number {
  const t0 = e.touches[0];
  const t1 = e.touches[1];
  return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
}

function onTouchStart(e: TouchEvent): void {
  e.preventDefault();
  if (e.touches.length === 1) {
    touch.mode = "scroll";
    touch.lastY = e.touches[0].clientY;
    touch.scrollAccum = 0;
  } else if (e.touches.length === 2) {
    const dist = getTouchDist(e);
    if (dist < 40) {
      // Two fingers held close together: treat as a midpoint scroll, same as
      // the main terminal — accidental two-finger contact shouldn't trigger
      // a tiny pinch-zoom.
      touch.mode = "scroll";
      touch.lastY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      touch.scrollAccum = 0;
    } else {
      touch.mode = "pinch";
      touch.startDist = dist;
      touch.startFont = currentFontSize;
    }
  } else {
    touch.mode = "none";
  }
}

function onTouchMove(e: TouchEvent): void {
  if (!term) return;
  e.preventDefault();
  if (touch.mode === "scroll" && e.touches.length >= 1) {
    const currentY = e.touches[0].clientY;
    const dy = touch.lastY - currentY;
    touch.lastY = currentY;
    touch.scrollAccum += dy;
    const fontSize = (term.options.fontSize ?? 13) as number;
    const lineHeight = Math.max(8, fontSize * ((term.options.lineHeight as number) || 1));
    const lines = Math.floor(Math.abs(touch.scrollAccum) / lineHeight);
    if (lines > 0) {
      const dir = touch.scrollAccum > 0 ? 1 : -1;
      touch.scrollAccum -= dir * lines * lineHeight;
      term.scrollLines(dir * lines);
    }
  } else if (touch.mode === "pinch" && e.touches.length >= 2) {
    const dist = getTouchDist(e);
    if (dist < 40 || touch.startDist < 40) return;
    applyFontSize(Math.round(touch.startFont * (dist / touch.startDist)));
  }
}

function onTouchEnd(): void {
  touch.mode = "none";
}

// ----- Keyboard: Ctrl/Cmd+F to focus search -----

function onKeyDown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    toolbarEl.value?.focusSearch();
    return;
  }
  // Ctrl/Cmd+0 → reset font size to the default (matches main terminal).
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === "Digit0" || e.code === "Numpad0")) {
    e.preventDefault();
    applyFontSize(FONT_DEFAULT);
  }
}

function onTermWheel(e: WheelEvent): void {
  const zoomMod = IS_MAC ? e.ctrlKey || e.metaKey : e.ctrlKey;
  if (!zoomMod) return;
  e.preventDefault();
  e.stopPropagation();
  applyFontSize(currentFontSize + (e.deltaY < 0 ? 1 : -1));
}

// ----- Lifecycle -----

onMounted(() => {
  term = new Terminal({
    theme: resolveLogTheme(),
    scrollback: SCROLLBACK,
    convertEol: true,
    fontSize: readFontSize(),
    fontFamily: TERMINAL_FONT_STACK,
    cursorBlink: false,
    allowTransparency: false,
    scrollSensitivity: 1.15,
    // Disable cursor entirely for logs (it's read-only output).
    cursorStyle: "underline",
    cursorInactiveStyle: "none",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());

  if (termEl.value) {
    term.open(termEl.value);
    // Ctrl/Cmd+wheel → zoom in/out. Listen in the capture phase on the host so
    // we preempt xterm's internal viewport scroll handler; `passive: false` is
    // required to call preventDefault() in some browsers' new wheel defaults.
    currentFontSize = readFontSize();
    termEl.value.addEventListener("wheel", onTermWheel, { capture: true, passive: false });
    // Touch gestures: 1-finger swipe scrolls the viewport, 2-finger pinch
    // zooms. `passive: false` is required because the handlers call
    // preventDefault() to claim the gesture; touchend can stay passive.
    termEl.value.addEventListener("touchstart", onTouchStart, { passive: false });
    termEl.value.addEventListener("touchmove", onTouchMove, { passive: false });
    termEl.value.addEventListener("touchend", onTouchEnd, { passive: true });
    termEl.value.addEventListener("touchcancel", onTouchEnd, { passive: true });
  }
  scheduleFit();
  attachScrollWatcher(term);

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => scheduleFit());
    if (rootEl.value) resizeObserver.observe(rootEl.value);
  }

  // Subscribe via the active transport, not directly via window.strideterm:
  // the latter only exists in Electron, so the remote/mobile client used to
  // silently drop every "docker:logs:write" event and the log stage stayed
  // stuck on "Attaching…". The transport's onDockerLogsWrite routes both the
  // IPC channel (Electron) and the WebSocket message (remote) into the same
  // listener registry.
  const transportApi = appStore.getApi() as AnyApi;
  if (transportApi?.onDockerLogsWrite) transportApi.onDockerLogsWrite(writeData);
  if (transportApi?.onDockerLogsClose) transportApi.onDockerLogsClose(onClose);

  rootEl.value?.addEventListener("keydown", onKeyDown);

  if (!props.removed) {
    openLogSession();
  }
});

onActivated(() => {
  scheduleFit();
});

onBeforeUnmount(() => {
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  if (reattachTimer) {
    clearTimeout(reattachTimer);
    reattachTimer = null;
  }
  if (persistFontTimer) {
    clearTimeout(persistFontTimer);
    persistFontTimer = null;
  }
  scrollDisposer?.dispose();
  scrollDisposer = null;
  closeLogSession();
  resizeObserver?.disconnect();
  rootEl.value?.removeEventListener("keydown", onKeyDown);
  termEl.value?.removeEventListener("wheel", onTermWheel, { capture: true } as AddEventListenerOptions);
  termEl.value?.removeEventListener("touchstart", onTouchStart);
  termEl.value?.removeEventListener("touchmove", onTouchMove);
  termEl.value?.removeEventListener("touchend", onTouchEnd);
  termEl.value?.removeEventListener("touchcancel", onTouchEnd);
  term?.dispose();
  term = null;
  fitAddon = null;
});

// Keep this view's font size in sync with the shared per-transport setting so
// changes from the main terminal (Ctrl+wheel, Ctrl+0) or the Settings dialog
// apply here too without requiring a remount.
watch(
  () => {
    const s = (appStore.payload as AnyApi)?.appState?.settings as Record<string, unknown> | undefined;
    return s?.[fontSizeKey()];
  },
  (raw) => {
    if (typeof raw !== "number" || !term) return;
    const clamped = clampFontSize(raw);
    if (clamped === currentFontSize) return;
    currentFontSize = clamped;
    term.options.fontSize = clamped;
    scheduleFit();
  },
);

// Auto-resume when the container transitions stopped → running. The docker
// snapshot is on a 30 s poll, so this is the natural event that brings us out
// of the "stopped" parking state without any polling of our own.
watch(containerRunning, (running, wasRunning) => {
  if (running && !wasRunning && stopped.value && !props.removed) {
    stopped.value = false;
    reattachAttempts = 0;
    if (reattachTimer) {
      clearTimeout(reattachTimer);
      reattachTimer = null;
    }
    reattaching.value = true;
    currentSessionId = crypto.randomUUID();
    lineCount.value = 0;
    byteCount.value = 0;
    openLogSession();
  }
});

watch(
  () => props.sessionId,
  (newId) => {
    if (newId !== currentSessionId && !props.removed) {
      closeLogSession();
      currentSessionId = newId;
      connecting.value = true;
      term?.clear();
      lineCount.value = 0;
      byteCount.value = 0;
      pendingLines.value = 0;
      openLogSession();
    }
  },
);

watch(
  () => props.removed,
  (isRemoved) => {
    if (isRemoved) closeLogSession();
  },
);
</script>

<style scoped>
.detail-log {
  position: relative;
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: #141416;
  outline: none;
}

.detail-log__stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.detail-log__term {
  position: absolute;
  inset: 0;
  padding: 4px 6px;
  overflow: hidden;
}

.detail-log__term :deep(.xterm),
.detail-log__term :deep(.xterm-viewport),
.detail-log__term :deep(.xterm-screen) {
  width: 100% !important;
  height: 100% !important;
}

.detail-log__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(0, 0, 0, 0.55);
  z-index: 10;
  font-size: 13px;
  color: #d8e4f5;
}

/* Non-blocking banner that sits above the xterm host but lets the user keep
   reading the last-fetched tail underneath. */
.detail-log__stopped {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  background: rgba(20, 20, 22, 0.92);
  border: 1px solid rgba(246, 173, 85, 0.45);
  border-radius: 14px;
  font-size: 11px;
  color: #d8e4f5;
  z-index: 6;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}

.detail-log__stopped-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-warn, #f6ad55);
  box-shadow: 0 0 6px rgba(246, 173, 85, 0.55);
  flex-shrink: 0;
}

.detail-log__stopped-hint {
  color: var(--text-dim, #888);
  font-size: 10px;
}

.detail-log__jump {
  position: absolute;
  bottom: 14px;
  right: 18px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--accent, #63b3ed);
  color: #000;
  border: 0;
  border-radius: 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  z-index: 5;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
}

.detail-log__jump:hover {
  background: color-mix(in srgb, var(--accent, #63b3ed) 85%, white);
}

.detail-log__jump-badge {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  padding: 1px 6px;
  font-size: 11px;
}

.detail-log__jump-label {
  text-transform: uppercase;
  letter-spacing: 0.3px;
  font-size: 10px;
}
</style>
