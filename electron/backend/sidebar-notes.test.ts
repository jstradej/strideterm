import { describe, expect, test } from "vitest";
import { setSidebarNoteColorSchema } from "../shared/sidebar-notes.js";
import type { Profile, WorkspaceState } from "../shared/types/state.js";
import { normalizeSidebarNotes, toSidebarNote } from "./sidebar-notes.js";

const profiles = [{ id: "default" }] as Profile[];
const workspaces = [{ id: "ws" }] as WorkspaceState[];
const base = { id: "n", text: "Text", revision: 1 };

describe("normalizeSidebarNotes colour", () => {
  test("keeps a valid colour and drops anything else without dropping the note", () => {
    const notes = normalizeSidebarNotes(
      [
        { ...base, id: "a", owner: "profile", ownerId: "default", color: "green" },
        { ...base, id: "b", owner: "workspace", ownerId: "ws", color: "purple" },
        { ...base, id: "c", owner: "workspace", ownerId: "ws", color: 3 },
        { ...base, id: "d", owner: "profile", ownerId: "default" },
      ],
      profiles,
      workspaces,
    );
    expect(notes.map(({ id, color }) => [id, color])).toEqual([
      ["a", "green"],
      ["b", undefined],
      ["c", undefined],
      ["d", undefined],
    ]);
    expect(notes[1]).not.toHaveProperty("color");
  });

  test("the installation note never carries a colour", () => {
    const [note] = normalizeSidebarNotes(
      [{ ...base, id: "global", owner: "installation", ownerId: "local", color: "red" }],
      profiles,
      workspaces,
    );
    expect(note).toMatchObject({ id: "global", text: "Text" });
    expect(note).not.toHaveProperty("color");
  });

  test("toSidebarNote exposes the colour only when set", () => {
    expect(toSidebarNote({ ...base, owner: "profile", ownerId: "default", color: "red" })).toMatchObject({
      color: "red",
    });
    expect(toSidebarNote({ ...base, owner: "profile", ownerId: "default" })).not.toHaveProperty("color");
  });
});

describe("setSidebarNoteColorSchema", () => {
  const scope = { profileId: "default", workspaceId: null, id: "n" };

  test("accepts the three colours and null", () => {
    for (const color of ["green", "orange", "red", null]) {
      expect(setSidebarNoteColorSchema.safeParse({ ...scope, color }).success, String(color)).toBe(true);
    }
  });

  test("rejects an unknown colour, a missing one and extra keys", () => {
    expect(setSidebarNoteColorSchema.safeParse({ ...scope, color: "blue" }).success).toBe(false);
    expect(setSidebarNoteColorSchema.safeParse(scope).success).toBe(false);
    expect(setSidebarNoteColorSchema.safeParse({ ...scope, color: "red", expectedRevision: 1 }).success).toBe(false);
  });
});
