import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TTL_MS = 5 * 60_000;
const MAX_TICKETS = 16;

export interface RemoteBrowserTicketStore {
  issue(profileId: string, origin: string): string;
  consume(ticket: string, origin: string): { profileId: string } | null;
  clear(): void;
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
const normalizeOrigin = (value: string): string => {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return "";
  }
};

export function createRemoteBrowserTicketStore(now: () => number = () => Date.now()): RemoteBrowserTicketStore {
  const tickets = new Map<string, { hash: Buffer; profileId: string; origin: string; expiresAt: number }>();
  return {
    issue(profileId, origin) {
      const normalizedOrigin = normalizeOrigin(origin);
      if (!profileId || !normalizedOrigin) throw new Error("A profile and valid origin are required");
      for (const [id, entry] of tickets) if (entry.expiresAt <= now()) tickets.delete(id);
      while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
      const ticket = randomBytes(32).toString("base64url");
      const id = randomBytes(12).toString("base64url");
      tickets.set(id, { hash: digest(ticket), profileId, origin: normalizedOrigin, expiresAt: now() + TTL_MS });
      return `${id}.${ticket}`;
    },
    consume(ticket, origin) {
      const [id, secret, ...extra] = ticket.split(".");
      if (!id || !secret || extra.length) return null;
      const entry = tickets.get(id);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        tickets.delete(id);
        return null;
      }
      const provided = digest(secret);
      if (provided.length !== entry.hash.length || !timingSafeEqual(provided, entry.hash)) return null;
      tickets.delete(id);
      if (entry.origin !== normalizeOrigin(origin)) return null;
      return { profileId: entry.profileId };
    },
    clear() {
      tickets.clear();
    },
  };
}
