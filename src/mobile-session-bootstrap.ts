/**
 * Plan §9.2 steps 4-6: a Flutter WebView opens this remote client with a one-time mobile
 * WebView session ticket in the URL *fragment* (`#mobileTicket=...&mobileSecret=...`) rather
 * than a query parameter or header — a fragment is never transmitted to the server, Cloudflare,
 * or any intermediate proxy on the request that loads this page, so it can't end up in access
 * logs. This module reads that fragment client-side, exchanges it for the same HttpOnly session
 * cookie the existing `?token=` bootstrap mints (via `POST /api/mobile/session/bootstrap`,
 * remote-server.ts), strips the fragment from the URL/history immediately (so it never lingers
 * even if the exchange fails), and reloads so the rest of the app boots with the cookie already
 * set.
 *
 * A page with no `#mobileTicket=` fragment is a complete no-op — this never affects the existing
 * `?token=` browser or Telegram `/tunnel` bootstrap paths.
 */
/**
 * Returns `true` when it has triggered (or is about to trigger) a page reload, so the caller
 * (`main.ts`) knows to skip mounting the app on this now-stale page load rather than doing
 * wasted/racy work right before navigation away.
 */
export async function bootstrapMobileSessionFromFragment(): Promise<boolean> {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return false;

  const params = new URLSearchParams(hash.slice(1));
  const ticketId = params.get("mobileTicket");
  const secret = params.get("mobileSecret");
  if (!ticketId || !secret) return false;

  // Strip the fragment from the visible URL/history before the network round trip — it must
  // never linger in browser history even if the exchange below fails.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);

  try {
    const response = await fetch("/api/mobile/session/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ticketId, secret }),
    });
    if (response.ok) {
      // Cookie is now set by the response above. Reload so the whole app — including the
      // transport's very first request — runs authenticated, instead of racing it.
      window.location.replace(window.location.pathname + window.location.search);
      return true;
    }
  } catch {
    // Network failure — fall through to the normal (unauthenticated) boot path rather than
    // blocking the app entirely; whatever the existing no-session UX is takes over from here.
  }
  return false;
}
