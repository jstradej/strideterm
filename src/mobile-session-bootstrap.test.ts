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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.location.hash = "";
    delete window.StridetermHost;
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

  test("strips fragment, exchanges ticket, and signals reload on success", async () => {
    window.location.hash = "#mobileTicket=abc123&mobileSecret=s3cr3t";
    const replaceStateSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const locationReplaceSpy = stubLocationReplace();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await bootstrapMobileSessionFromFragment();

    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/mobile/session/bootstrap",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ ticketId: "abc123", secret: "s3cr3t" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(replaceStateSpy.mock.invocationCallOrder[0]).toBeLessThan(fetchSpy.mock.invocationCallOrder[0]);
    expect(locationReplaceSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  test.each([401, 502])(
    "reports HTTP %i exchange failure with the open attempt and skips app mount",
    async (status) => {
      window.location.hash = "#mobileTicket=abc&mobileSecret=bad&mobileOpenAttempt=12";
      vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
      const locationReplaceSpy = stubLocationReplace();
      const postMessage = vi.fn();
      window.StridetermHost = { postMessage };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status } as Response));

      const result = await bootstrapMobileSessionFromFragment();

      expect(locationReplaceSpy).not.toHaveBeenCalled();
      expect(result).toBe(true);
      expect(postMessage).toHaveBeenCalledWith(
        JSON.stringify({ type: "bootstrap-result", ok: false, status, attempt: 12 }),
      );
      expect(postMessage.mock.calls[0][0]).not.toContain("abc");
      expect(postMessage.mock.calls[0][0]).not.toContain("bad");
    },
  );

  test("does not echo an invalid open attempt", async () => {
    window.location.hash = "#mobileTicket=abc&mobileSecret=bad&mobileOpenAttempt=0";
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const postMessage = vi.fn();
    window.StridetermHost = { postMessage };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response));

    await bootstrapMobileSessionFromFragment();

    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: "bootstrap-result", ok: false, status: 401 }));
  });

  test("reports network failure to native without mounting the app", async () => {
    window.location.hash = "#mobileTicket=abc&mobileSecret=bad&mobileOpenAttempt=5";
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const locationReplaceSpy = stubLocationReplace();
    const postMessage = vi.fn();
    window.StridetermHost = { postMessage };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await bootstrapMobileSessionFromFragment();

    expect(locationReplaceSpy).not.toHaveBeenCalled();
    expect(result).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ type: "bootstrap-result", ok: false, status: 0, attempt: 5 }),
    );
  });

  test("times out a stalled exchange and reports the native recovery event", async () => {
    vi.useFakeTimers();
    window.location.hash = "#mobileTicket=abc&mobileSecret=bad&mobileOpenAttempt=5";
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const postMessage = vi.fn();
    window.StridetermHost = { postMessage };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    );

    const result = bootstrapMobileSessionFromFragment();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await result).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ type: "bootstrap-result", ok: false, status: 0, attempt: 5 }),
    );
  });

  test("malformed ticket fragments recover through native without sending a request", async () => {
    window.location.hash = "#mobileTicket=abc&mobileOpenAttempt=5";
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const postMessage = vi.fn();
    window.StridetermHost = { postMessage };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await bootstrapMobileSessionFromFragment();

    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ type: "bootstrap-result", ok: false, status: 0, attempt: 5 }),
    );
  });

  test("without a native host, failure leaves a safe message instead of mounting the app", async () => {
    window.location.hash = "#mobileTicket=abc&mobileSecret=bad";
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    document.body.innerHTML = '<div id="app"></div>';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response));

    const result = await bootstrapMobileSessionFromFragment();

    expect(result).toBe(true);
    expect(document.getElementById("app")?.textContent).toContain("Reopen it from the strIDEterm app");
  });

  test("shows the safe message when native delivery throws", async () => {
    window.location.hash = "#mobileTicket=abc&mobileSecret=bad";
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    document.body.innerHTML = '<div id="app"></div>';
    window.StridetermHost = {
      postMessage: () => {
        throw new Error("channel unavailable");
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response));

    const result = await bootstrapMobileSessionFromFragment();

    expect(result).toBe(true);
    expect(document.getElementById("app")?.textContent).toContain("Reopen it from the strIDEterm app");
  });
});
