import { z } from "zod";
import { INSTALLATION_NOTE_ID, INSTALLATION_NOTE_OWNER_ID, saveSidebarNoteSchema } from "../shared/sidebar-notes.js";
import type { SidebarNote } from "../shared/sidebar-notes.js";
import type { Profile, SidebarNoteRecord, WorkspaceState } from "../shared/types/state.js";

const recordSchema = saveSidebarNoteSchema.pick({ id: true, text: true }).extend({
  owner: z.enum(["profile", "workspace", "installation"]),
  ownerId: z.string().min(1),
  revision: z.int().positive(),
  previousText: saveSidebarNoteSchema.shape.text.optional(),
  // A bad timestamp loses only the timestamp, never the note.
  updatedAt: z.iso.datetime({ offset: true }).optional().catch(undefined),
});

export function normalizeSidebarNotes(
  value: unknown,
  profiles: Profile[],
  workspaces: WorkspaceState[],
): SidebarNoteRecord[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const profileIds = new Set(profiles.map(({ id }) => id));
  const workspaceIds = new Set(workspaces.map(({ id }) => id));
  const seen = new Set<string>();
  const notes: SidebarNoteRecord[] = [];
  for (const entry of value) {
    const parsed = recordSchema.safeParse(entry);
    if (!parsed.success) continue;
    const note = parsed.data;
    if (note.owner === "installation") {
      if (note.ownerId !== INSTALLATION_NOTE_OWNER_ID || note.id !== INSTALLATION_NOTE_ID) continue;
    } else if (!(note.owner === "profile" ? profileIds : workspaceIds).has(note.ownerId)) continue;
    const key = JSON.stringify([note.owner, note.ownerId, note.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const { updatedAt, ...rest } = note;
    notes.push(updatedAt ? { ...rest, updatedAt } : rest);
  }
  return notes;
}

export function toSidebarNote(note: SidebarNoteRecord): SidebarNote {
  return {
    id: note.id,
    text: note.text,
    revision: note.revision,
    canUndo: note.previousText !== undefined,
    ...(note.updatedAt ? { updatedAt: note.updatedAt } : {}),
  };
}
