import "@xterm/xterm/css/xterm.css";
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createTransport } from "./transport.js";
import { APP_CONFIG } from "../config/app-config.js";
import { useAppStore } from "./stores/app.js";
import { useTerminalStore } from "./stores/terminal.js";
import { useGitUiStore } from "./stores/git-ui.js";

// crypto.randomUUID is gated to secure contexts (HTTPS / localhost / file://).
// The remote web client served over LAN HTTP is not a secure context, so it
// crashes on UUID-using flows (template tab dialog, notifications, etc.).
// crypto.getRandomValues is available everywhere — polyfill randomUUID on top.
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  (crypto as Crypto & { randomUUID: () => string }).randomUUID = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
  };
}

const api = createTransport();

const app = createApp(App);
app.use(createPinia());
app.provide("api", api);
app.mount("#app");

// Init stores after Pinia is mounted
const appStore = useAppStore();
const terminalStore = useTerminalStore();
const gitUiStore = useGitUiStore();

terminalStore.init(api, APP_CONFIG, {
  getActiveSessionId: () => appStore.activeSessionId,
  getOverlay: () => appStore.overlay,
  getPayload: () => appStore.payload,
});

appStore.init(api);
gitUiStore.init(api);

// Pre-render noise texture to PNG once — replaces runtime SVG feTurbulence filter
// which otherwise forces the GPU to re-composite the overlay on every paint.
(window.requestIdleCallback || ((cb) => setTimeout(cb, 200)))(
  () => {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    document.documentElement.style.setProperty("--noise-texture", `url(${canvas.toDataURL("image/png")})`);
  },
  { timeout: 2000 },
);
