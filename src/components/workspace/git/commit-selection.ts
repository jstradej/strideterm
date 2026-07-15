// Scoped-commit selection → backend payload.
//
// The changes list checkboxes let the user commit only some files. A staged
// rename is stored as delete(previousPath) + add(path); committing just `path`
// would leave the delete side staged and record a COPY instead of a rename. So
// we hand the backend the checked paths and, SEPARATELY, the old names of any
// checked renames (`previousPaths`), which it removes from the temp index.
//
// A COPY (porcelain v2 also fills `previousPath` when `status.renames=copies`)
// must NOT contribute a previousPath: its source has to survive, and removing
// it would turn the copy into a rename+delete. Only a rename status (`R`) — in
// either the staged or the working-tree column — is a real delete side.

export interface ChangedFileLike {
  path?: unknown;
  previousPath?: unknown;
  stagedStatus?: unknown;
  unstagedStatus?: unknown;
}

export function buildCommitSelection(
  files: ChangedFileLike[],
  selectedPaths: Set<string>,
): { paths: string[]; previousPaths: string[] } {
  const paths = [...selectedPaths];
  const previousPaths: string[] = [];
  for (const f of files) {
    const path = f.path;
    const previousPath = f.previousPath;
    if (typeof path !== "string" || typeof previousPath !== "string" || !previousPath) continue;
    if (!selectedPaths.has(path)) continue;
    // Rename (delete side to remove) vs copy (source must stay).
    const isRename = f.stagedStatus === "R" || f.unstagedStatus === "R";
    if (isRename) previousPaths.push(previousPath);
  }
  return { paths, previousPaths };
}
