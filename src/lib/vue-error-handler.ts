import type { App } from "vue";
import { rlog } from "./renderer-log.js";

// Vue says where an error came from in `info`: a readable label in dev builds,
// an error-reference URL ending in the ErrorCodes number in production
// (5 = native event handler, 6 = component event handler).
const EVENT_HANDLER_INFO = /event handler$|#runtime-[56]$/;

/**
 * Safety net for buttons. A click (or emitted) handler that throws or rejects
 * with nothing catching it reaches app.config.errorHandler; without one, Vue
 * only console.errors it, so the click looks ignored and strideterm.log has
 * nothing. Every error Vue routes here is logged with its stack, and one from
 * an event handler is also shown to the user. Handlers that report their own
 * failures (runWithToast, an inline banner) never get here.
 */
export function installVueErrorHandler(app: App, showError: (title: string, body: string) => void): void {
  app.config.errorHandler = (err, _instance, info) => {
    // A custom handler replaces Vue's own console output; keep it for DevTools.
    console.error(err);
    const message = (err as Error)?.message || String(err);
    rlog("error", "[renderer] unhandled Vue error", { message, info, stack: (err as Error)?.stack || "" });
    if (EVENT_HANDLER_INFO.test(String(info))) showError("Action failed", message);
  };
}
