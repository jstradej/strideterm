// Entry of the Jira issue popout window (jira-popout.html): the issue detail only, none of the app shell.
import { createApp } from "vue";
import { createPinia } from "pinia";
import JiraIssuePopoutApp from "./JiraIssuePopoutApp.vue";
import { createTransport } from "./transport.js";
import { apiKey } from "./types/keys.js";
import { useAppStore } from "./stores/app.js";
import { useNotificationStore } from "./stores/notifications.js";
import { installVueErrorHandler } from "./lib/vue-error-handler.js";
import { rlog } from "./lib/renderer-log.js";

window.addEventListener("error", (event) => {
  rlog("error", "[renderer] [jira-popout] uncaught error", {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    col: event.colno,
    stack: (event.error as Error | undefined)?.stack || "",
  });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { message?: string; stack?: string } | undefined;
  rlog("error", "[renderer] [jira-popout] unhandled rejection", {
    message: reason?.message || String(event.reason ?? ""),
    stack: reason?.stack || "",
  });
});

const api = createTransport();
const app = createApp(JiraIssuePopoutApp);
app.use(createPinia());
installVueErrorHandler(app, (title, body) => useNotificationStore().showError(title, body));
app.provide(apiKey, api);
useAppStore().init(api);
app.mount("#app");
