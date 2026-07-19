import type { Ref } from "vue";

interface SessionRestoreCtx {
  activeSessionId: Ref<string | null>;
  activeViewId: Ref<string | null>;
  splitGroup: Ref<{ layout: string; viewIds: string[] } | null>;
}

/**
 * Adopts (or clears) the active session/view after a profile activation
 * returns a backend-chosen restore target, and always resets any split view.
 * Shared by activateProfile (app-api-actions.ts) and the Profiles dialog's
 * onActivate handler (app-dialog-actions.ts).
 */
export function adoptRestoredSession(ctx: SessionRestoreCtx, restoredSession: string): void {
  if (restoredSession) {
    ctx.activeSessionId.value = restoredSession;
    ctx.activeViewId.value = restoredSession;
  } else {
    ctx.activeViewId.value = null;
    ctx.activeSessionId.value = null;
  }
  ctx.splitGroup.value = null;
}
