/**
 * Plan §9.2 steps 4-6: a Flutter WebView opens this remote client with a one-time mobile
 * WebView session ticket in the URL *fragment* (`#mobileTicket=...&mobileSecret=...`) rather
 * than a query parameter or header — a fragment is never transmitted to the server, Cloudflare,
 * or any intermediate proxy on the request that loads this page, so it can't end up in access
 * logs. This module reads that fragment client-side, exchanges it for the same HttpOnly session
 * cookie the existing `?token=` bootstrap mints (via `POST /api/mobile/session/bootstrap`,
 * remote-server.ts), strips the fragment from the URL/history immediately, and reloads only after
 * the exchange succeeds. A failed exchange is reported to the native host and never mounts the
 * unauthenticated remote app.
 *
 * A page with no `#mobileTicket=` fragment is a complete no-op — this never affects the existing
 * `?token=` browser or Telegram `/tunnel` bootstrap paths.
 */
/**
 * Returns `true` when this is a ticketed mobile bootstrap. The caller (`main.ts`) must skip mounting
 * on both success (this document is reloading) and failure (the native host is recovering it).
 */
export async function bootstrapMobileSessionFromFragment(): Promise<boolean> {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return false;

  const params = new URLSearchParams(hash.slice(1));
  const ticketId = params.get("mobileTicket");
  const secret = params.get("mobileSecret");
  const openAttempt = parseOpenAttempt(params.get("mobileOpenAttempt"));
  if (!ticketId && !secret) return false;

  window.history.replaceState(null, "", window.location.pathname + window.location.search);

  if (!ticketId || !secret) {
    reportBootstrapFailure(0, openAttempt);
    return true;
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), MOBILE_BOOTSTRAP_TIMEOUT_MS);
  try {
    const response = await fetch("/api/mobile/session/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ticketId, secret }),
      signal: controller.signal,
    });
    if (response.ok) {
      // Cookie is now set by the response above. Reload so the whole app — including the
      // transport's very first request — runs authenticated, instead of racing it.
      window.location.replace(window.location.pathname + window.location.search);
      return true;
    }
    reportBootstrapFailure(response.status, openAttempt);
  } catch {
    reportBootstrapFailure(0, openAttempt);
  } finally {
    window.clearTimeout(timeout);
  }
  return true;
}

const MOBILE_BOOTSTRAP_TIMEOUT_MS = 30_000;

function parseOpenAttempt(value: string | null): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const attempt = Number(value);
  return Number.isSafeInteger(attempt) ? attempt : undefined;
}

function reportBootstrapFailure(status: number, attempt?: number): void {
  const host = window.StridetermHost;
  let delivered = false;
  try {
    if (typeof host?.postMessage === "function") {
      host.postMessage(
        JSON.stringify({ type: "bootstrap-result", ok: false, status, ...(attempt ? { attempt } : {}) }),
      );
      delivered = true;
    }
  } catch {
    // Keep the page safe if the native channel is unavailable.
  }
  if (delivered) return;

  const root = document.getElementById("app");
  if (root) root.textContent = "This remote session could not be started. Reopen it from the strIDEterm app.";
}
