import { describe, expect, test } from "vitest";
import { createRemoteBrowserTicketStore } from "./remote-browser-ticket-store.js";

describe("remote browser tickets", () => {
  test("redeems once for its exact profile and origin", () => {
    const tickets = createRemoteBrowserTicketStore();
    const ticket = tickets.issue("profile-a", "https://example.test/path");
    expect(tickets.consume(ticket, "https://example.test")).toEqual({ profileId: "profile-a" });
    expect(tickets.consume(ticket, "https://example.test")).toBeNull();
  });

  test("wrong secret does not spend the ticket, but wrong origin with its secret does", () => {
    const tickets = createRemoteBrowserTicketStore();
    const ticket = tickets.issue("profile-a", "https://example.test");
    const wrong = `${ticket.slice(0, ticket.lastIndexOf(".") + 1)}wrong`;
    expect(tickets.consume(wrong, "https://example.test")).toBeNull();
    expect(tickets.consume(ticket, "https://other.test")).toBeNull();
    expect(tickets.consume(ticket, "https://example.test")).toBeNull();
  });

  test("expires after five minutes and clears outstanding entries", () => {
    let now = 1_800_000_000_000;
    const tickets = createRemoteBrowserTicketStore(() => now);
    const expired = tickets.issue("profile-a", "http://example.test");
    now += 5 * 60_000;
    expect(tickets.consume(expired, "http://example.test")).toBeNull();
    const cleared = tickets.issue("profile-a", "http://example.test");
    tickets.clear();
    expect(tickets.consume(cleared, "http://example.test")).toBeNull();
  });

  test("keeps only the newest sixteen outstanding tickets", () => {
    const tickets = createRemoteBrowserTicketStore();
    const issued = Array.from({ length: 17 }, () => tickets.issue("profile-a", "http://example.test"));
    expect(tickets.consume(issued[0]!, "http://example.test")).toBeNull();
    expect(tickets.consume(issued[16]!, "http://example.test")).toEqual({ profileId: "profile-a" });
  });
});
