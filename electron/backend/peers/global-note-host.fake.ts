import type { InstallationNote, SaveInstallationNote, UndoInstallationNote } from "../../shared/sidebar-notes.js";
import { ClientRequestError } from "../shared/client-request-error.js";

/** An in-memory stand-in for the runtime's installation note, with its revision arbitration, for host tests. */
export function createFakeGlobalNoteHost(installationName = "Host PC") {
  let text = "";
  let previous: string | null = null;
  let revision = 0;
  const view = (): InstallationNote => ({
    note: { id: "global", text, revision, canUndo: previous !== null },
    installationName,
  });
  const settle = (expectedRevision: number) => {
    if (expectedRevision !== revision) {
      throw new ClientRequestError("This note has changed. Reload it before trying again.", 409);
    }
  };
  return {
    get: view,
    revision: () => revision,
    save: async (input: SaveInstallationNote): Promise<InstallationNote> => {
      settle(input.expectedRevision);
      if (input.text === text) return view();
      previous = text;
      text = input.text;
      revision += 1;
      return view();
    },
    undo: async (input: UndoInstallationNote): Promise<InstallationNote> => {
      settle(input.expectedRevision);
      if (previous === null) throw new ClientRequestError("There is no previous saved text to undo.", 409);
      text = previous;
      previous = null;
      revision += 1;
      return view();
    },
  };
}
