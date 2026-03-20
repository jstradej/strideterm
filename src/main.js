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
