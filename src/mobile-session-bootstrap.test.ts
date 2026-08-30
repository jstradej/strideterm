import { describe, test, expect, vi, afterEach } from "vitest";
import { bootstrapMobileSessionFromFragment } from "./mobile-session-bootstrap.js";

// jsdom's `window.location.replace` lives on a non-configurable prototype property, so neither
// `vi.spyOn` nor `Object.defineProperty` on the existing `location` object can override it.
// Replace the whole `window.location` object with a plain stub instead (delete + reassign is the
// standard jsdom workaround for this).
function stubLocationReplace() {
  const spy = vi.fn();
  const original = window.location;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).location;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).location = {
    ...original,
    hash: original.hash,
    pathname: original.pathname,
    search: original.search,
    replace: spy,
  };
  return spy;
}

describe("bootstrapMobileSessionFromFragment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.location.hash = "";
  });

  test("no-op when there is no fragment at all", async () => {
    window.location.hash = "";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await bootstrapMobileSessionFromFragment();

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("no-op when the fragment doesn't carry a mobile ticket (existing ?token=/Telegram flows unaffected)", async () => {
    window.location.hash = "#something-unrelated";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await bootstrapMobileSessionFromFragment();

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("no-op when only one of ticketId/secret is present", async () => {
    window.location.hash = "#mobileTicket=abc123";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await bootstrapMobileSessionFromFragment();

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("strips the fragment before the network call, exchanges it, and signals reload on success", async () => {
    window.location.hash = "#mobileTicket=abc123&mobileSecret=s3cr3t";
    const replaceStateSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const locationReplaceSpy = stubLocationReplace();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await bootstrapMobileSessionFromFragment();

    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/mobile/session/bootstrap",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ ticketId: "abc123", secret: "s3cr3t" }),
      }),
    );
    // The fragment must be stripped BEFORE the exchange is attempted, so it never lingers in
    // history even if the network call below were to fail.
    const fetchCallOrder = fetchSpy.mock.invocationCallOrder[0];
    const replaceStateCallOrder = replaceStateSpy.mock.invocationCallOrder[0];
    expect(replaceStateCallOrder).toBeLessThan(fetchCallOrder);
    expect(locationReplaceSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  test("does not reload and returns false when the exchange is rejected (expired/wrong secret/unknown)", async () => {
    window.location.hash = "#mobileTicket=abc&mobileSecret=bad";
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const locationReplaceSpy = stubLocationReplace();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false } as Response));

    const result = await bootstrapMobileSessionFromFragment();

    expect(locationReplaceSpy).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  test("does not reload and returns false when fetch itself throws", async () => {
    window.location.hash = "#mobileTicket=abc&mobileSecret=bad";
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const locationReplaceSpy = stubLocationReplace();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await bootstrapMobileSessionFromFragment();

    expect(locationReplaceSpy).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });
});
