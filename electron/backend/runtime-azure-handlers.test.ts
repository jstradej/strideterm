import { describe, expect, test, vi } from "vitest";
import { createAzureHandlers } from "./runtime-azure-handlers.js";

// refreshAzureState coalesces concurrent refreshes into a single in-flight
// poll. The desktop IPC path dedups via withOperationPromise, but the remote
// /api/azure/refresh route calls refreshAzureState directly — so without this,
// several viewers (or a misbehaving auto-refresh) stacked full git+Azure polls
// that serialized and timed out at the gateway (524). These tests pin the
// coalescing behaviour.
describe("refreshAzureState — concurrent refresh coalescing", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeHandlers(overrides: any = {}) {
    const refreshAzure = overrides.refreshAzure ?? vi.fn(async () => {});
    const refreshGit = overrides.refreshGit ?? vi.fn(async () => {});
    const payload = overrides.payload ?? { ok: true };
    const getPayload = overrides.getPayload ?? vi.fn(() => payload);
    const handlers = createAzureHandlers({
      getState: () => ({ activeWorkspaceId: "ws-1" }),
      refreshAzure,
      refreshGit,
      getPayload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return { handlers, refreshAzure, refreshGit, getPayload, payload };
  }

  test("overlapping calls share one in-flight refresh and all get the same payload", async () => {
    let resolveAzure: () => void = () => {};
    const azureGate = new Promise<void>((resolve) => {
      resolveAzure = resolve;
    });
    const refreshAzure = vi.fn(() => azureGate);
    const { handlers, refreshGit, payload } = makeHandlers({ refreshAzure });

    // Fire three concurrent refreshes while the Azure poll is still pending.
    const p1 = handlers.refreshAzureState();
    const p2 = handlers.refreshAzureState();
    const p3 = handlers.refreshAzureState();

    resolveAzure();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // One shared poll, not three.
    expect(refreshAzure).toHaveBeenCalledTimes(1);
    expect(refreshGit).toHaveBeenCalledTimes(1);
    // Every caller resolves to the same fresh payload.
    expect(r1).toBe(payload);
    expect(r2).toBe(payload);
    expect(r3).toBe(payload);
  });

  test("a refresh issued after the previous one settles runs a fresh poll", async () => {
    const { handlers, refreshAzure, refreshGit } = makeHandlers();

    await handlers.refreshAzureState();
    await handlers.refreshAzureState();

    // The in-flight promise is cleared once settled, so the second call is not
    // wrongly deduped against the first.
    expect(refreshAzure).toHaveBeenCalledTimes(2);
    expect(refreshGit).toHaveBeenCalledTimes(2);
  });

  test("a failed refresh clears the in-flight slot so the next call retries", async () => {
    const refreshAzure = vi.fn().mockRejectedValueOnce(new Error("azure boom")).mockResolvedValueOnce(undefined);
    const { handlers } = makeHandlers({ refreshAzure });

    await expect(handlers.refreshAzureState()).rejects.toThrow("azure boom");
    // Slot cleared in finally → a retry actually re-polls instead of returning
    // the rejected promise forever.
    await expect(handlers.refreshAzureState()).resolves.toBeDefined();
    expect(refreshAzure).toHaveBeenCalledTimes(2);
  });
});
