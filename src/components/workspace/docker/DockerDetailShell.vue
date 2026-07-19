<template>
  <div class="detail-shell" ref="rootEl">
    <div v-if="!alive && !connecting" class="detail-shell__overlay detail-shell__overlay--exit">
      <div class="detail-shell__exit-card">
        <p>Shell session ended.</p>
        <small v-if="exitCode !== null">Exit code: {{ exitCode }}</small>
        <button type="button" class="button button--ghost button--sm" @click="restart">Restart shell</button>
      </div>
    </div>
    <div v-else-if="connecting" class="detail-shell__overlay">
      <Spinner size="md" />
      <span>Starting shell in {{ containerName }}…</span>
    </div>
    <div ref="termEl" class="detail-shell__term" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onActivated, onBeforeUnmount, watch } from "vue";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import Spinner from "../../common/Spinner.vue";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function resolveShellTheme(): ITheme {
  const isLight = document.documentElement.dataset.theme === "light";
  return isLight
    ? { background: "#f7f7f9", foreground: "#18181b", cursor: "#18181b", selectionBackground: "rgba(0,0,0,0.15)" }
    : {
        background: "#141416",
        foreground: "#d8e4f5",
        cursor: "#ffa424",
        selectionBackground: "rgba(255,255,255,0.15)",
      };
}

const TERMINAL_FONT_STACK =
  '"JetBrainsMono NFM", "CaskaydiaCove NFM", "MesloLGS NF", "FiraCode NFM", "Cascadia Mono NF", "Cascadia Code PL", "Cascadia Mono", "JetBrains Mono", "Fira Code", "Consolas", monospace';

const props = defineProps<{
  sessionId: string;
  containerId: string;
  containerName: string;
  backendId: string;
  contextName: string;
}>();

const appStore = useAppStore();
const notifications = useNotificationStore();

const rootEl = ref<HTMLElement | null>(null);
const termEl = ref<HTMLElement | null>(null);
const connecting = ref(true);
const alive = ref(true);
const exitCode = ref<number | null>(null);

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame = 0;
let onDataDisposer: { dispose(): void } | null = null;
let currentSessionId = props.sessionId;

function scheduleFit(opts?: { sendResize?: boolean }): void {
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    if (!term || !fitAddon || !rootEl.value) return;
    const rect = rootEl.value.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    try {
      fitAddon.fit();
      term.refresh(0, Math.max(0, term.rows - 1));
      if (opts?.sendResize !== false) {
        sendResize();
      }
    } catch {
      // DOM not ready yet
    }
  });
}

function sendResize(): void {
  if (!term) return;
  const api = appStore.getApi() as AnyApi;
  if (api?.dockerShellResize) {
    api
      .dockerShellResize({
        sessionId: currentSessionId,
        cols: term.cols,
        rows: term.rows,
      })
      .catch(() => {});
  }
}

function onShellData(payload: { sessionId: string; data: string }): void {
  if (payload.sessionId !== currentSessionId) return;
  if (connecting.value) connecting.value = false;
  term?.write(payload.data);
}

function onShellClose(payload: { sessionId: string; code: number | null }): void {
  if (payload.sessionId !== currentSessionId) return;
  alive.value = false;
  exitCode.value = payload.code;
  connecting.value = false;
}

function openSession(): void {
  const api = appStore.getApi() as AnyApi;
  if (!api?.dockerShellOpen) {
    connecting.value = false;
    return;
  }
  alive.value = true;
  exitCode.value = null;
  connecting.value = true;
  api
    .dockerShellOpen({
      sessionId: currentSessionId,
      containerId: props.containerId,
      backendId: props.backendId,
      contextName: props.contextName,
      cols: term?.cols ?? 80,
      rows: term?.rows ?? 24,
    })
    .catch((e: unknown) => {
      connecting.value = false;
      alive.value = false;
      const msg = (e as Error)?.message || String(e);
      notifications.showError("Shell session failed", `${props.containerName}: ${msg}`);
    });
}

function closeSession(): void {
  const api = appStore.getApi() as AnyApi;
  if (api?.dockerShellClose) {
    api.dockerShellClose({ sessionId: currentSessionId }).catch(() => {});
  }
}

function restart(): void {
  closeSession();
  currentSessionId = crypto.randomUUID();
  term?.clear();
  openSession();
}

onMounted(() => {
  term = new Terminal({
    theme: resolveShellTheme(),
    scrollback: 5000,
    convertEol: false,
    fontSize: 13,
    fontFamily: TERMINAL_FONT_STACK,
    cursorBlink: true,
    allowTransparency: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());

  if (termEl.value) {
    term.open(termEl.value);
  }
  scheduleFit({ sendResize: false });

  // Forward keystrokes to the PTY.
  onDataDisposer = term.onData((data) => {
    const api = appStore.getApi() as AnyApi;
    if (!api?.dockerShellWrite) return;
    api.dockerShellWrite({ sessionId: currentSessionId, data }).catch(() => {});
  });

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => scheduleFit());
    if (rootEl.value) resizeObserver.observe(rootEl.value);
  }

  const api = appStore.getApi() as AnyApi;
  if (api?.onDockerShellData) api.onDockerShellData(onShellData);
  if (api?.onDockerShellClose) api.onDockerShellClose(onShellClose);

  openSession();
});

onActivated(() => {
  scheduleFit();
});

onBeforeUnmount(() => {
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  onDataDisposer?.dispose();
  onDataDisposer = null;
  closeSession();
  resizeObserver?.disconnect();
  term?.dispose();
  term = null;
  fitAddon = null;
});

watch(
  () => props.sessionId,
  (newId) => {
    if (newId === currentSessionId) return;
    closeSession();
    currentSessionId = newId;
    term?.clear();
    openSession();
  },
);
</script>

<style scoped>
.detail-shell {
  position: relative;
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: #141416;
}

.detail-shell__term {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  padding: 4px 6px;
}

.detail-shell__term :deep(.xterm),
.detail-shell__term :deep(.xterm-viewport),
.detail-shell__term :deep(.xterm-screen) {
  width: 100% !important;
  height: 100% !important;
}

.detail-shell__overlay {
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

.detail-shell__overlay--exit {
  background: rgba(0, 0, 0, 0.75);
}

.detail-shell__exit-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 24px 32px;
  background: var(--bg-secondary, #1a1a1d);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  text-align: center;
}

.detail-shell__exit-card p {
  margin: 0;
  font-size: 14px;
}

.detail-shell__exit-card small {
  color: var(--text-dim, #888);
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 11px;
}

.button--sm {
  font-size: 12px;
  padding: 4px 10px;
}
</style>
