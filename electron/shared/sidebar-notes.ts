import { z } from "zod";

export const SIDEBAR_NOTE_MAX_LENGTH = 65_536;

export const SIDEBAR_NOTE_ID_MAX_LENGTH = 200;
export const SIDEBAR_NOTES_MAX_PER_OWNER = 500;

export const SIDEBAR_NOTE_COLORS = ["green", "orange", "red"] as const;
export type SidebarNoteColor = (typeof SIDEBAR_NOTE_COLORS)[number];

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

export const deleteSidebarNoteSchema = sidebarNotesScopeSchema
  .extend({
    id: noteId,
    expectedRevision: revision.positive(),
  })
  .strict();

export const setSidebarNoteColorSchema = sidebarNotesScopeSchema
  .extend({
    id: noteId,
    color: z.enum(SIDEBAR_NOTE_COLORS).nullable(),
  })
  .strict();

export const saveInstallationNoteSchema = z
  .object({
    text: noteText,
    expectedRevision: revision.nonnegative(),
  })
  .strict();

export const undoInstallationNoteSchema = z.object({ expectedRevision: revision.positive() }).strict();

const popoutId = z.string().min(1).max(SIDEBAR_NOTE_ID_MAX_LENGTH);

export const notePopoutTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("note"), profileId: popoutId, workspaceId: popoutId.nullable(), noteId: popoutId })
    .strict(),
  z.object({ kind: z.literal("installation") }).strict(),
  z.object({ kind: z.literal("host"), hostId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("tab"), profileId: popoutId, viewId: popoutId }).strict(),
]);

export type NotePopoutTarget = z.infer<typeof notePopoutTargetSchema>;

export function notePopoutKey(target: NotePopoutTarget): string {
  switch (target.kind) {
    case "note":
      return JSON.stringify(["note", target.profileId, target.workspaceId, target.noteId]);
    case "installation":
      return JSON.stringify(["installation"]);
    case "host":
      return JSON.stringify(["host", target.hostId]);
    case "tab":
      return JSON.stringify(["tab", target.profileId, target.viewId]);
  }
}

export type SidebarNotesScope = z.infer<typeof sidebarNotesScopeSchema>;
export type SaveSidebarNote = z.infer<typeof saveSidebarNoteSchema>;
export type UndoSidebarNote = z.infer<typeof undoSidebarNoteSchema>;
export type DeleteSidebarNote = z.infer<typeof deleteSidebarNoteSchema>;
export type SetSidebarNoteColor = z.infer<typeof setSidebarNoteColorSchema>;
export type SaveInstallationNote = z.infer<typeof saveInstallationNoteSchema>;
export type UndoInstallationNote = z.infer<typeof undoInstallationNoteSchema>;

export const INSTALLATION_NOTE_ID = "global";
export const INSTALLATION_NOTE_OWNER_ID = "local";

export interface SidebarNote {
  id: string;
  text: string;
  revision: number;
  canUndo: boolean;
  color?: SidebarNoteColor;
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
