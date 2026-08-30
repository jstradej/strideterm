import { describe, expect, test } from "vitest";
import {
  createMobileWebSessionTicketStore,
  normalizeRemoteOrigin,
  REMOTE_WEB_SESSION_CAPABILITY,
  type TicketRedemptionContext,
} from "./mobile-web-session-ticket-store.js";

const TUNNEL_ORIGIN = "https://example.trycloudflare.com";
const RELAY_ORIGIN = "https://relay.strideterm.dev";

const INPUT = {
  deviceId: "dev-1",
  pairId: "pair-1",
  profileId: "default",
  allowedOrigin: TUNNEL_ORIGIN,
  transport: "legacy" as const,
};

/** The legacy server's own context: it answers on the tunnel origin. */
const LEGACY: TicketRedemptionContext = { transport: "legacy", origins: [TUNNEL_ORIGIN] };
/** The relay's loopback instance, which answers on the public relay origin. */
const RELAY: TicketRedemptionContext = { transport: "relay", origins: [RELAY_ORIGIN] };

describe("mobile-web-session-ticket-store", () => {
  test("issue then consume with the correct secret returns the ticket data round-tripped exactly", () => {
    const store = createMobileWebSessionTicketStore();
    const issued = store.issueTicket(INPUT);
    expect(issued.ticketId).toBeTruthy();
    expect(issued.secret).toBeTruthy();
    // 256-bit secret, base64url-encoded: 32 bytes -> 43 chars (no padding).
    expect(issued.secret.length).toBeGreaterThanOrEqual(43);

    const record = store.consumeTicket(issued.ticketId, issued.secret, LEGACY);
    expect(record).toEqual({
      deviceId: INPUT.deviceId,
      pairId: INPUT.pairId,
      profileId: INPUT.profileId,
      allowedOrigin: INPUT.allowedOrigin,
      transport: "legacy",
      requiredCapability: REMOTE_WEB_SESSION_CAPABILITY,
      expiresAt: issued.expiresAt,
    });
  });

  test("expiresAt is exactly 60 seconds from issuance", () => {
    const clock = 1_000_000;
    const store = createMobileWebSessionTicketStore(() => clock);
    const issued = store.issueTicket(INPUT);
    expect(issued.expiresAt).toBe(clock + 60_000);
  });

  test("a second consume of an already-consumed ticket fails — single-use", () => {
    const store = createMobileWebSessionTicketStore();
    const issued = store.issueTicket(INPUT);
    const first = store.consumeTicket(issued.ticketId, issued.secret, LEGACY);
    const second = store.consumeTicket(issued.ticketId, issued.secret, LEGACY);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("consume after expiry fails", () => {
    let clock = 0;
    const store = createMobileWebSessionTicketStore(() => clock);
    const issued = store.issueTicket(INPUT);
    clock = issued.expiresAt; // exactly at expiry — expiresAt is exclusive
    const result = store.consumeTicket(issued.ticketId, issued.secret, LEGACY);
    expect(result).toBeNull();
  });

  test("consume with the wrong secret fails, and a later attempt with the correct secret still succeeds", () => {
    const store = createMobileWebSessionTicketStore();
    const issued = store.issueTicket(INPUT);
    const wrongAttempt = store.consumeTicket(issued.ticketId, "not-the-real-secret", LEGACY);
    expect(wrongAttempt).toBeNull();
    // The ticket is still redeemable afterwards with the correct secret —
    // a single bad guess must not burn a legitimate device's one shot.
    const rightAttempt = store.consumeTicket(issued.ticketId, issued.secret, LEGACY);
    expect(rightAttempt).not.toBeNull();
  });

  test("consume with an unknown ticketId fails", () => {
    const store = createMobileWebSessionTicketStore();
    store.issueTicket(INPUT);
    const result = store.consumeTicket("not-a-real-ticket-id", "whatever", LEGACY);
    expect(result).toBeNull();
  });

  test("revokeForDevice invalidates an outstanding ticket for that device", () => {
    const store = createMobileWebSessionTicketStore();
    const issued = store.issueTicket(INPUT);
    store.revokeForDevice(INPUT.deviceId);
    const result = store.consumeTicket(issued.ticketId, issued.secret, LEGACY);
    expect(result).toBeNull();
  });

  test("revokeForDevice does not affect another device's outstanding ticket", () => {
    const store = createMobileWebSessionTicketStore();
    const otherIssued = store.issueTicket({ ...INPUT, deviceId: "dev-other" });
    const issued = store.issueTicket(INPUT);
    store.revokeForDevice(INPUT.deviceId);
    expect(store.consumeTicket(issued.ticketId, issued.secret, LEGACY)).toBeNull();
    expect(store.consumeTicket(otherIssued.ticketId, otherIssued.secret, LEGACY)).not.toBeNull();
  });

  test("two tickets issued for the same device get distinct ticketId/secret", () => {
    const store = createMobileWebSessionTicketStore();
    const a = store.issueTicket(INPUT);
    const b = store.issueTicket(INPUT);
    expect(a.ticketId).not.toBe(b.ticketId);
    expect(a.secret).not.toBe(b.secret);
  });

  // -------------------------------------------------------------------------
  // Transport and origin binding (production hardening §5 "Ticket" 1-4)
  // -------------------------------------------------------------------------

  test("a relay ticket cannot be redeemed at the legacy server, and is not redeemable afterwards either", () => {
    const store = createMobileWebSessionTicketStore();
    const issued = store.issueTicket({ ...INPUT, transport: "relay", allowedOrigin: RELAY_ORIGIN });

    // Wrong server. The secret was right, so the ticket is SPENT: a credential that has been
    // presented at the wrong door has been seen by something unexpected, and a second attempt
    // elsewhere is exactly the cross-transport redemption this binding exists to stop.
    expect(store.consumeTicket(issued.ticketId, issued.secret, LEGACY)).toBeNull();
    expect(store.consumeTicket(issued.ticketId, issued.secret, RELAY)).toBeNull();
  });

  test("a legacy ticket cannot be redeemed at the relay either — the refusal is symmetric", () => {
    const store = createMobileWebSessionTicketStore();
    const issued = store.issueTicket(INPUT);
    expect(store.consumeTicket(issued.ticketId, issued.secret, RELAY)).toBeNull();
    expect(store.consumeTicket(issued.ticketId, issued.secret, LEGACY)).toBeNull();
  });

  test("a ticket for an origin this server no longer answers on is refused and spent", () => {
    // The quick-tunnel case: a ticket is minted for `old.trycloudflare.com`, the tunnel is replaced,
    // and the WebView presents it against the new one. The server is the same server, and the origin
    // is not.
    const store = createMobileWebSessionTicketStore();
    const issued = store.issueTicket({ ...INPUT, allowedOrigin: "https://old.trycloudflare.com" });
    const afterRotation: TicketRedemptionContext = {
      transport: "legacy",
      origins: ["https://new.trycloudflare.com"],
    };
    expect(store.consumeTicket(issued.ticketId, issued.secret, afterRotation)).toBeNull();
    // And it is gone, so it cannot be held until the old tunnel happens to come back.
    expect(
      store.consumeTicket(issued.ticketId, issued.secret, {
        transport: "legacy",
        origins: ["https://old.trycloudflare.com"],
      }),
    ).toBeNull();
  });

  test("a server answering on several origins redeems a ticket for any one of them", () => {
    // The legitimate multi-origin case: a LAN address and a tunnel URL at the same time.
    const store = createMobileWebSessionTicketStore();
    const issued = store.issueTicket({ ...INPUT, allowedOrigin: "http://192.168.1.10:8765" });
    const record = store.consumeTicket(issued.ticketId, issued.secret, {
      transport: "legacy",
      origins: [TUNNEL_ORIGIN, "http://192.168.1.10:8765"],
    });
    expect(record?.allowedOrigin).toBe("http://192.168.1.10:8765");
  });

  test("origins are compared normalized, so spelling differences are not a refusal", () => {
    const store = createMobileWebSessionTicketStore();
    const issued = store.issueTicket({ ...INPUT, allowedOrigin: "https://Example.Trycloudflare.com/" });
    expect(store.consumeTicket(issued.ticketId, issued.secret, LEGACY)).not.toBeNull();

    // …and a different PORT is still a different origin, which is the half that has to keep holding.
    const other = store.issueTicket({ ...INPUT, allowedOrigin: "http://127.0.0.1:8787" });
    expect(
      store.consumeTicket(other.ticketId, other.secret, { transport: "legacy", origins: ["http://127.0.0.1:8788"] }),
    ).toBeNull();
  });

  test("normalizeRemoteOrigin folds case, drops a default port and a trailing slash — and nothing else", () => {
    expect(normalizeRemoteOrigin("HTTPS://Relay.Example.COM:443/")).toBe("https://relay.example.com");
    expect(normalizeRemoteOrigin("http://Example.com:80")).toBe("http://example.com");
    expect(normalizeRemoteOrigin("http://127.0.0.1:8787/anything?x=1")).toBe("http://127.0.0.1:8787");
    // A non-URL is compared as an exact string rather than being reinterpreted — stricter, not looser.
    expect(normalizeRemoteOrigin("  not-a-url/  ")).toBe("not-a-url");
  });

  test("the ticket carries one required capability, not a copy of the device's grants", () => {
    const store = createMobileWebSessionTicketStore();
    const issued = store.issueTicket(INPUT);
    const record = store.consumeTicket(issued.ticketId, issued.secret, LEGACY);
    expect(record?.requiredCapability).toBe("remote.webSession");
    expect(Object.keys(record ?? {})).not.toContain("capabilities");
  });
});
