import { z } from "zod";

export const SIDEBAR_NOTE_MAX_LENGTH = 65_536;

const noteId = z.string().min(1);
const noteText = z.string().max(SIDEBAR_NOTE_MAX_LENGTH);
const revision = z.int();

export const sidebarNotesScopeSchema = z.object({
  profileId: noteId,
  workspaceId: noteId.nullable(),
});

export const saveSidebarNoteSchema = sidebarNotesScopeSchema.extend({
  id: noteId,
  text: noteText,
  expectedRevision: revision.nonnegative(),
});

export const undoSidebarNoteSchema = sidebarNotesScopeSchema.extend({
  id: noteId,
  expectedRevision: revision.positive(),
});

export type SidebarNotesScope = z.infer<typeof sidebarNotesScopeSchema>;
export type SaveSidebarNote = z.infer<typeof saveSidebarNoteSchema>;
export type UndoSidebarNote = z.infer<typeof undoSidebarNoteSchema>;

export interface SidebarNote {
  id: string;
  text: string;
  revision: number;
  canUndo: boolean;
}

export interface SidebarNotes {
  global: SidebarNote[];
  workspace: SidebarNote[];
}
