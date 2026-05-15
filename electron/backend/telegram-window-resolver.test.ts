import { describe, test, expect } from "vitest";
import { resolveWindowIdForTelegramCommand } from "./telegram-window-resolver.js";

describe("resolveWindowIdForTelegramCommand", () => {
  const slots = [
    { id: "win-personal", profileId: "profile-personal" },
    { id: "win-work", profileId: "profile-work" },
    { id: "win-default", profileId: "default" },
  ];

  test("explicit windowId wins over everything else (direct /screenshot N path)", () => {
    expect(resolveWindowIdForTelegramCommand({ windowId: "win-personal", profileId: "profile-work" }, slots)).toBe(
      "win-personal",
    );
  });

  test("explicit windowId is returned even when it is not in windowSlots (caller decides validity)", () => {
    // Caller falls back to getPrimaryWindow() if this windowId is stale; the
    // resolver itself does not validate against the registry.
    expect(resolveWindowIdForTelegramCommand({ windowId: "win-missing" }, slots)).toBe("win-missing");
  });

  test("resolves profileId to the slot owning that profile", () => {
    expect(resolveWindowIdForTelegramCommand({ profileId: "profile-work" }, slots)).toBe("win-work");
    expect(resolveWindowIdForTelegramCommand({ profileId: "profile-personal" }, slots)).toBe("win-personal");
  });

  test("'default' profileId matches slots with profileId='default' AND slots with no profileId", () => {
    expect(resolveWindowIdForTelegramCommand({ profileId: "default" }, slots)).toBe("win-default");

    // A slot without an explicit profileId is treated as the 'default' bucket —
    // same convention the rest of the codebase uses (windowSlots.profileId || "default").
    const slotsNoExplicitDefault = [{ id: "win-anon" }, { id: "win-work", profileId: "profile-work" }];
    expect(resolveWindowIdForTelegramCommand({ profileId: "default" }, slotsNoExplicitDefault)).toBe("win-anon");
  });

  test("returns undefined when profileId has no matching slot (profile not open in any window)", () => {
    expect(resolveWindowIdForTelegramCommand({ profileId: "profile-unknown" }, slots)).toBeUndefined();
  });

  test("returns undefined when neither windowId nor profileId is provided", () => {
    expect(resolveWindowIdForTelegramCommand({}, slots)).toBeUndefined();
  });

  test("returns undefined for empty windowSlots even with a profileId", () => {
    expect(resolveWindowIdForTelegramCommand({ profileId: "profile-work" }, [])).toBeUndefined();
  });

  test("empty-string profileId is treated as missing (not 'default')", () => {
    // The Telegram emit sites always supply either a real profileId or
    // omit the field; an empty string here would be a bug somewhere
    // upstream and should NOT silently route to the default slot.
    expect(resolveWindowIdForTelegramCommand({ profileId: "" }, slots)).toBeUndefined();
  });

  test("picks the FIRST matching slot when two slots share the same profileId", () => {
    // Should never happen in practice (windowSlots are unique per profile),
    // but lock in the precedence so a future regression is visible.
    const duplicates = [
      { id: "win-first", profileId: "profile-work" },
      { id: "win-second", profileId: "profile-work" },
    ];
    expect(resolveWindowIdForTelegramCommand({ profileId: "profile-work" }, duplicates)).toBe("win-first");
  });
});
