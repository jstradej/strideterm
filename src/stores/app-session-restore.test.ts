import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { adoptRestoredSession } from "./app-session-restore.js";

/**
 * The restored-session-or-clear block was byte-identically duplicated in
 * activateProfile (app-api-actions.ts) and the Profiles dialog's onActivate
 * handler (app-dialog-actions.ts). This is the shared implementation both
 * were migrated to.
 */
describe("adoptRestoredSession", () => {
  function makeCtx() {
    return {
      activeSessionId: ref<string | null>(null),
      activeViewId: ref<string | null>(null),
      splitGroup: ref<{ layout: string; viewIds: string[] } | null>({ layout: "split-2", viewIds: ["a", "b"] }),
    };
  }

  it("adopts the restored session as both active session and active view", () => {
    const ctx = makeCtx();
    adoptRestoredSession(ctx, "session-123");
    expect(ctx.activeSessionId.value).toBe("session-123");
    expect(ctx.activeViewId.value).toBe("session-123");
  });

  it("clears active session/view when no session was restored", () => {
    const ctx = makeCtx();
    ctx.activeSessionId.value = "stale-session";
    ctx.activeViewId.value = "stale-session";
    adoptRestoredSession(ctx, "");
    expect(ctx.activeSessionId.value).toBeNull();
    expect(ctx.activeViewId.value).toBeNull();
  });

  it("always resets the split group, restored or not", () => {
    const ctx = makeCtx();
    adoptRestoredSession(ctx, "session-123");
    expect(ctx.splitGroup.value).toBeNull();

    const ctx2 = makeCtx();
    adoptRestoredSession(ctx2, "");
    expect(ctx2.splitGroup.value).toBeNull();
  });
});
