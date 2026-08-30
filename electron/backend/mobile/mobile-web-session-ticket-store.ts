/// <reference types="node" />
/**
 * Single-use, in-memory WebView session ticket store (plan §9.2/§10.6).
 *
 * `remote.webSession.issue` needs somewhere to mint the short-lived ticket
 * that lets a mobile WebView bootstrap a remote-server session cookie
 * without ever seeing the permanent `remoteAccess.token`. This module is
 * that "somewhere" — deliberately its own file (not living inside
 * remote-server.ts or mobile-command-dispatch.ts) so a single shared
 * instance can be constructed once in runtime.ts and handed to BOTH the
 * command dispatcher (issues tickets) and remote-server.ts (consumes them)
 * without mobile-command-dispatch.ts ever importing remote-server.ts (which
 * would cycle back through runtime.ts, which constructs the dispatcher).
 *
 * Properties required by the plan:
 *   - desktop-memory-only: never Firebase, never Flutter secure storage,
 *     never written to the persisted state JSON. A restart invalidates
 *     every outstanding ticket — by design, not a bug.
 *   - minimum 256-bit secret entropy.
 *   - TTL exactly 60 seconds from issuance (server clock).
 *   - atomically single-use: a ticket is deleted the moment it is
 *     successfully consumed, so a second redemption attempt — even with the
 *     correct secret — always fails.
 *   - "Ticket se ukládá pouze hashovaný" (plan §10.6): the secret itself is
 *     never retained. Only its SHA-256 hash is stored; `consumeTicket`
 *     hashes the caller-supplied secret and compares digests.
 *
 * BOUND TO ONE SERVER AND ONE ORIGIN (production hardening §5 "Ticket" 1-2). A desktop can be
 * running two servers at once: its own LAN/Cloudflare listener and the managed relay's loopback
 * origin. Both consume tickets from THIS store, so a ticket that named only a secret could be
 * redeemed at whichever of them received it first — "which origin did you mean" would be answered by
 * the network rather than by the issuer. Each ticket therefore records the transport it was minted
 * for and the exact normalized origin, and `consumeTicket` takes the redeeming server's own context
 * and compares both. A mismatch SPENDS the ticket and answers the same generic nothing as a wrong
 * secret: a ticket that has been presented at the wrong door is a ticket whose secret has been seen
 * by something unexpected, and letting it stay valid for a second attempt elsewhere is the hole.
 *
 * Deliberately NOT done here (over-engineering for a store that holds at
 * most a handful of entries — MAX_PAIRED_MOBILE_DEVICES_PER_DESKTOP is 3):
 *   - no periodic sweep timer. Expired entries are evicted lazily, on the
 *     next lookup that touches them (`issueTicket` prunes before inserting;
 *     `consumeTicket` evicts-and-fails an expired hit). A store this small
 *     never accumulates enough dead entries between lookups to matter.
 *   - no persistence layer of any kind (see above — this is the point).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** plan §12.6: "WebView ticket: 60 sekund a pouze v desktop paměti". */
const TICKET_TTL_MS = 60_000;
/** 256 bits of entropy, base64url-encoded (matches remote-server.ts's session id encoding). */
const SECRET_BYTES = 32;

/**
 * Which of this installation's two possible servers a ticket belongs to.
 *
 * `relay` is the managed relay's loopback origin; `legacy` is the user's own LAN/Cloudflare
 * listener. The names are the protocol's — the phone reads the same value out of the ticket.
 */
export type MobileWebSessionTransport = "relay" | "legacy";

/**
 * The one capability the remote UI is the authority for.
 *
 * A constant rather than a field copied from the device record. The record's `capabilities` list
 * described what the DEVICE holds, and putting it in the ticket made it look like a statement about
 * what the SESSION may do — an ambiguous security-shaped field that nothing consumed (production
 * hardening §5 "Ticket" 6). What the remote UI actually requires is this one grant, checked at
 * issuance and re-checked at consumption.
 */
export const REMOTE_WEB_SESSION_CAPABILITY = "remote.webSession" as const;

const IssueTicketInputSchema = z.object({
  deviceId: z.string().min(1),
  pairId: z.string().min(1),
  profileId: z.string().min(1),
  allowedOrigin: z.string().min(1),
  transport: z.enum(["relay", "legacy"]),
});
export type IssueTicketInput = z.infer<typeof IssueTicketInputSchema>;

export interface IssuedTicket {
  ticketId: string;
  secret: string;
  expiresAt: number;
}

/**
 * The context a REDEEMING server presents about itself.
 *
 * Supplied by the server, never by the request: `remote-server.ts` knows which kind of instance it is
 * and which origin it is reachable at, and a ticket is only redeemable at the one it was minted for.
 * Deriving either from a `Host`, `Origin` or `X-Forwarded-*` header would hand the decision back to
 * the client (production hardening §5 "Ticket" 3).
 */
export interface TicketRedemptionContext {
  transport: MobileWebSessionTransport;
  /**
   * The origins this server currently answers on, normalized.
   *
   * A LIST rather than one value because the legacy server genuinely has several — a LAN address, a
   * quick-tunnel URL, a custom public URL — and they change while it runs. A ticket is redeemable
   * only while its own origin is still in the list, which is what makes a ticket minted for a dead
   * quick tunnel unredeemable on the new one (production hardening §5 "Ticket" 4).
   */
  origins: readonly string[];
}

/**
 * What a successful `consumeTicket` hands back to the caller (the
 * remote-server bootstrap route). Deliberately the FULL authoritative
 * record — the route must read `profileId`/`allowedOrigin` from here, never
 * trust the same-named fields in the client's request body
 * (plan §10.6: "Ticket endpoint nesmí přijímat profile/capabilities z
 * klienta jako autoritativní; načte je z ticket recordu").
 */
export interface TicketRecord {
  deviceId: string;
  pairId: string;
  profileId: string;
  allowedOrigin: string;
  transport: MobileWebSessionTransport;
  /** Always `remote.webSession`. Kept on the record so the consuming route re-checks it by name. */
  requiredCapability: typeof REMOTE_WEB_SESSION_CAPABILITY;
  expiresAt: number;
}

interface StoredTicket extends TicketRecord {
  secretHash: Buffer;
}

export interface MobileWebSessionTicketStore {
  issueTicket(input: IssueTicketInput): IssuedTicket;
  /**
   * Redeems a ticket at [context], or returns null.
   *
   * Null for every failure and for the same reason in every case: an unknown id, an expired ticket, a
   * wrong secret, the wrong server, an origin this server no longer answers on. The caller answers a
   * generic 401, so none of those are distinguishable from outside.
   */
  consumeTicket(ticketId: string, secret: string, context: TicketRedemptionContext): TicketRecord | null;
  /** Invalidates any outstanding (unconsumed) ticket(s) for `deviceId` — called on device revoke. */
  revokeForDevice(deviceId: string): void;
}

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * The comparable form of an origin.
 *
 * Case-folded scheme and host, no trailing slash, default port dropped. Both sides of every
 * comparison in this module go through it, so `https://Example.Trycloudflare.com/` and
 * `https://example.trycloudflare.com` are the same origin — and `http://127.0.0.1:8787` and
 * `http://127.0.0.1:8788` are not. A non-URL string is returned trimmed rather than rejected: the
 * comparison is then exact-string, which is stricter, not looser.
 */
export function normalizeRemoteOrigin(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const port =
      (url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")
        ? ""
        : url.port;
    return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port ? `:${port}` : ""}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function toRecord(stored: StoredTicket): TicketRecord {
  return {
    deviceId: stored.deviceId,
    pairId: stored.pairId,
    profileId: stored.profileId,
    allowedOrigin: stored.allowedOrigin,
    transport: stored.transport,
    requiredCapability: stored.requiredCapability,
    expiresAt: stored.expiresAt,
  };
}

export function createMobileWebSessionTicketStore(now: () => number = () => Date.now()): MobileWebSessionTicketStore {
  const tickets = new Map<string, StoredTicket>();

  function pruneExpired(): void {
    const nowMs = now();
    for (const [id, ticket] of tickets) {
      if (ticket.expiresAt <= nowMs) tickets.delete(id);
    }
  }

  return {
    issueTicket(input) {
      const validated = IssueTicketInputSchema.parse(input);
      pruneExpired();
      const ticketId = randomUUID();
      const secret = randomBytes(SECRET_BYTES).toString("base64url");
      const expiresAt = now() + TICKET_TTL_MS;
      tickets.set(ticketId, {
        deviceId: validated.deviceId,
        pairId: validated.pairId,
        profileId: validated.profileId,
        // Stored normalized so a comparison at redemption time is a string equality rather than a
        // second chance to disagree about what an origin is.
        allowedOrigin: normalizeRemoteOrigin(validated.allowedOrigin),
        transport: validated.transport,
        requiredCapability: REMOTE_WEB_SESSION_CAPABILITY,
        expiresAt,
        secretHash: hashSecret(secret),
      });
      return { ticketId, secret, expiresAt };
    },

    consumeTicket(ticketId, secret, context) {
      const stored = tickets.get(ticketId);
      if (!stored) return null;
      if (stored.expiresAt <= now()) {
        // Expired — evict lazily and refuse. Never resurrect.
        tickets.delete(ticketId);
        return null;
      }
      const providedHash = hashSecret(secret);
      if (providedHash.length !== stored.secretHash.length || !timingSafeEqual(providedHash, stored.secretHash)) {
        // Wrong secret: leave the ticket outstanding. A 256-bit secret makes
        // brute-forcing it within the 60s TTL infeasible regardless, so
        // burning the ticket on one bad guess would only cost the
        // legitimate device its one shot for no real security benefit.
        return null;
      }
      // THE SECRET WAS RIGHT AND THE DOOR WAS WRONG. From here on the ticket is spent whatever
      // happens, because the presenter demonstrably holds it: leaving it outstanding would let the
      // same credential be tried at the other server, or at the same server after its origins
      // change, which is exactly the cross-transport redemption this binding exists to stop
      // (production hardening §5 "Ticket" 2 — "a wrong-instance/origin attempt consumes the ticket
      // and returns a generic 401; it must not be redeemable a second time elsewhere").
      tickets.delete(ticketId);
      if (stored.transport !== context.transport) return null;
      if (!context.origins.some((origin) => normalizeRemoteOrigin(origin) === stored.allowedOrigin)) return null;
      return toRecord(stored);
    },

    revokeForDevice(deviceId) {
      for (const [id, ticket] of tickets) {
        if (ticket.deviceId === deviceId) tickets.delete(id);
      }
    },
  };
}
