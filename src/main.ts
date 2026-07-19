import "@xterm/xterm/css/xterm.css";
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createTransport } from "./transport.js";
import { APP_CONFIG } from "../config/app-config.js";
import { useAppStore } from "./stores/app.js";
import { useTerminalStore } from "./stores/terminal.js";
import { useGitUiStore } from "./stores/git-ui.js";
import { useAzurePipelinesStore } from "./stores/azure-pipelines.js";
import { rlog } from "./lib/renderer-log.js";
import { apiKey } from "./types/keys.js";

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

// Monaco builds rich-format clipboard payloads via `new ClipboardItem({...})`.
// In non-secure contexts the constructor isn't a defined global at all (not
// just hidden behind navigator.clipboard), so Monaco throws ReferenceError
// when copying. Provide a minimal stand-in that captures the blobs so the
// later navigator.clipboard.write() polyfill below can drain them.
if (
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { ClipboardItem?: unknown }).ClipboardItem === "undefined"
) {
  class ClipboardItemPolyfill {
    private readonly items: Record<string, Blob | string>;
    readonly types: string[];
    constructor(items: Record<string, Blob | string>) {
      this.items = items;
      this.types = Object.keys(items);
    }
    async getType(type: string): Promise<Blob> {
      const v = this.items[type];
      if (v == null) throw new Error(`No data of type ${type}`);
      return v instanceof Blob ? v : new Blob([String(v)], { type });
    }
  }
  (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = ClipboardItemPolyfill;
}

// navigator.clipboard is also gated to secure contexts. Without it, Monaco's
// copy/cut handlers crash with "Cannot read properties of undefined (reading
// 'write')", and terminal-controller's Ctrl+C/right-click copy throws too.
// Use a textarea + execCommand fallback for writes; reads aren't recoverable
// without user gesture flows we don't want to wire up here.
if (typeof navigator !== "undefined" && !navigator.clipboard) {
  const writeViaTextarea = (text: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("Copy failed"));
      } catch (err) {
        document.body.removeChild(ta);
        reject(err as Error);
      }
    });
  };
  // Monaco passes ClipboardItem[] for rich content; pull the first text/plain.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const writeItems = async (items: any[]): Promise<void> => {
    for (const item of items || []) {
      const types: string[] = item?.types || [];
      if (types.includes("text/plain") && typeof item.getType === "function") {
        const blob = await item.getType("text/plain");
        const text = typeof blob.text === "function" ? await blob.text() : "";
        await writeViaTextarea(text);
        return;
      }
    }
  };
  const noop = () => {};
  const stub = {
    writeText: writeViaTextarea,
    readText: () => Promise.reject(new Error("Clipboard read not supported in non-secure context")),
    write: writeItems,
    read: () => Promise.reject(new Error("Clipboard read not supported in non-secure context")),
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => false,
  } as unknown as Clipboard;
  try {
    Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true });
  } catch {
    // Browser refuses redefinition — leave it; affected callers already have
    // try/catch around clipboard access, the only real loss is Monaco's copy.
  }
}

// Monaco rejects in-flight diff/format operations with `Canceled: Canceled`
// whenever the editor model is disposed mid-load (e.g. switching files in
// the review pane). The rejection bubbles up as an unhandled rejection but
// is benign — silence just this specific case so the console stays useful.
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { name?: string; message?: string } | null;
    const msg = reason?.message || String(reason || "");
    if (reason?.name === "Canceled" || msg === "Canceled" || msg === "Canceled: Canceled") {
      event.preventDefault();
    }
  });

  // Global crash diagnostics — forward uncaught errors and unhandled rejections
  // into the main-process log (strideterm.log, tagged [renderer]) WITH a stack.
  // A renderer crash preceded by a JS error otherwise only surfaces in DevTools;
  // this makes it diagnosable from the dev log. Logging only — does not
  // preventDefault, so existing handlers and console output are unaffected.
  window.addEventListener("error", (event) => {
    rlog("error", "[renderer] uncaught error", {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      col: event.colno,
      stack: (event.error as Error | undefined)?.stack || "",
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { message?: string; stack?: string } | undefined;
    const msg = reason?.message || String(event.reason ?? "");
    if (msg === "Canceled" || msg === "Canceled: Canceled") return; // benign Monaco churn
    rlog("error", "[renderer] unhandled rejection", { message: msg, stack: reason?.stack || "" });
  });
}

// Secondary "diff popout" window: a stripped-down Vue root that renders just
// MonacoDiffPanel for one payload. Skips appStore / terminalStore / gitUiStore
// init — the popout doesn't need workspaces, sessions, or git polling.
const popoutView = new URL(window.location.href).searchParams.get("view");
if (popoutView === "diff-popout") {
  import("./DiffPopoutApp.vue").then((mod) => {
    const popApp = createApp(mod.default);
    popApp.mount("#app");
  });
} else {
  const api = createTransport();

  const app = createApp(App);
  app.use(createPinia());
  app.provide(apiKey, api);
  app.mount("#app");

  // Init stores after Pinia is mounted
  const appStore = useAppStore();
  const terminalStore = useTerminalStore();
  const gitUiStore = useGitUiStore();
  const azurePipelinesStore = useAzurePipelinesStore();

  terminalStore.init(api, APP_CONFIG, {
    getActiveSessionId: () => appStore.activeSessionId,
    getOverlay: () => appStore.overlay,
    getPayload: () => appStore.payload,
  });

  appStore.init(api);
  gitUiStore.init(api);
  azurePipelinesStore.init(api);
}

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
