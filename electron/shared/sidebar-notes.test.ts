import { describe, expect, test } from "vitest";
import { notePopoutKey, notePopoutTargetSchema } from "./sidebar-notes.js";

describe("notePopoutTargetSchema", () => {
  test("accepts the four target shapes", () => {
    for (const target of [
      { kind: "note", profileId: "p", workspaceId: "w", noteId: "n" },
      { kind: "note", profileId: "p", workspaceId: null, noteId: "n" },
      { kind: "installation" },
      { kind: "host", hostId: "host-1" },
      { kind: "tab", profileId: "p", viewId: "w:t" },
    ]) {
      expect(notePopoutTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(true);
    }
  });

  test("refuses unknown kinds, extra keys, empty and oversized ids", () => {
    for (const target of [
      { kind: "other" },
      { kind: "installation", hostId: "x" },
      { kind: "note", profileId: "p", noteId: "n" },
      { kind: "note", profileId: "", workspaceId: null, noteId: "n" },
      { kind: "note", profileId: "p", workspaceId: null, noteId: "n".repeat(201) },
      { kind: "host", hostId: "h".repeat(65) },
      { kind: "tab", profileId: "p" },
      null,
    ]) {
      expect(notePopoutTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(false);
    }
  });

  test("keys one window per note and tells a profile note from a workspace note", () => {
    const a = notePopoutKey({ kind: "note", profileId: "p", workspaceId: "w", noteId: "n" });
    const b = notePopoutKey({ kind: "note", profileId: "p", workspaceId: null, noteId: "n" });
    expect(a).not.toBe(b);
    expect(notePopoutKey({ kind: "note", profileId: "p", workspaceId: "w", noteId: "n" })).toBe(a);
    expect(notePopoutKey({ kind: "installation" })).not.toBe(notePopoutKey({ kind: "host", hostId: "x" }));
  });
});
