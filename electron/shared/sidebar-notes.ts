import { z } from "zod";

export const SIDEBAR_NOTE_MAX_LENGTH = 65_536;

export const SIDEBAR_NOTE_ID_MAX_LENGTH = 200;
export const SIDEBAR_NOTES_MAX_PER_OWNER = 500;

const noteId = z.string().min(1).max(SIDEBAR_NOTE_ID_MAX_LENGTH);
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

export const saveInstallationNoteSchema = z
  .object({
    text: noteText,
    expectedRevision: revision.nonnegative(),
  })
  .strict();

export const undoInstallationNoteSchema = z.object({ expectedRevision: revision.positive() }).strict();

export type SidebarNotesScope = z.infer<typeof sidebarNotesScopeSchema>;
export type SaveSidebarNote = z.infer<typeof saveSidebarNoteSchema>;
export type UndoSidebarNote = z.infer<typeof undoSidebarNoteSchema>;
export type SaveInstallationNote = z.infer<typeof saveInstallationNoteSchema>;
export type UndoInstallationNote = z.infer<typeof undoInstallationNoteSchema>;

export const INSTALLATION_NOTE_ID = "global";
export const INSTALLATION_NOTE_OWNER_ID = "local";

export interface SidebarNote {
  id: string;
  text: string;
  revision: number;
  canUndo: boolean;
  /** ISO time the text last changed; absent on notes saved before it was recorded. */
  updatedAt?: string;
}

/** The installation's one note, with the name this installation goes by (the host name `hello` reports). */
export interface InstallationNote {
  note: SidebarNote;
  installationName: string;
}

export interface SidebarNotes {
  global: SidebarNote[];
  workspace: SidebarNote[];
}
