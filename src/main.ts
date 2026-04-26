import "@xterm/xterm/css/xterm.css";
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createTransport } from "./transport.js";
import { APP_CONFIG } from "../config/app-config.js";
import { useAppStore } from "./stores/app.js";
import { useTerminalStore } from "./stores/terminal.js";
import { useGitUiStore } from "./stores/git-ui.js";

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
