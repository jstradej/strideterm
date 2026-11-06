// Entry of the diff and file popout windows (popout.html; `#file` selects the file editor). Deliberately separate from
// main.ts so the popout loads only Vue + Monaco, not the whole app.
import { createApp } from "vue";
import DiffPopoutApp from "./DiffPopoutApp.vue";
import FilePopoutApp from "./FilePopoutApp.vue";
import { rlog } from "./lib/renderer-log.js";

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { name?: string; message?: string; stack?: string } | null;
  const msg = reason?.message || String(reason ?? "");
  if (reason?.name === "Canceled" || msg === "Canceled" || msg === "Canceled: Canceled") {
    event.preventDefault();
    return;
  }
  rlog("error", "[renderer] [popout] unhandled rejection", { message: msg, stack: reason?.stack || "" });
});
window.addEventListener("error", (event) => {
  rlog("error", "[renderer] [popout] uncaught error", {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    col: event.colno,
    stack: (event.error as Error | undefined)?.stack || "",
  });
});

createApp(window.location.hash === "#file" ? FilePopoutApp : DiffPopoutApp).mount("#app");
