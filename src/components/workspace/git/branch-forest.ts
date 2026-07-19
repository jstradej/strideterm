// Shared "/"-split branch-forest builder.
//
// Both GitBranchesTab.vue's branch tree and BranchSelectPopover.vue's branch
// picker turn a flat list of ref names into a folder/leaf forest by splitting
// each name on "/" (so "feature/auth" nests under a collapsible "feature"
// folder). This used to be two separate copies of the same algorithm; this
// module is the single pure implementation both now build on. No Vue
// reactivity here — callers own their own reactive wrapping (e.g. a computed
// that re-invokes buildBranchForest when its inputs change).

export interface BranchForestEntry<TPayload> {
  /** "/"-delimited name to split into folders, e.g. "feature/auth". */
  path: string;
  /** Full ref carried through unmodified onto the leaf, e.g. "origin/feature/auth". */
  ref: string;
  payload: TPayload;
}

export interface BranchForestFolder<TPayload> {
  kind: "folder";
  key: string;
  label: string;
  children: BranchForestNode<TPayload>[];
}

export interface BranchForestLeaf<TPayload> {
  kind: "leaf";
  key: string;
  label: string;
  ref: string;
  payload: TPayload;
  children: [];
}

export type BranchForestNode<TPayload> = BranchForestFolder<TPayload> | BranchForestLeaf<TPayload>;

/**
 * Build a folder/leaf forest from a flat list of entries, splitting each
 * entry's `path` on "/". Folders are always sorted alphabetically by label;
 * leaf order within a folder is controlled by `compareLeaves` so callers can
 * pin a "current"/"default" ref to the top, sort by recency, etc.
 */
export function buildBranchForest<TPayload>(
  entries: BranchForestEntry<TPayload>[],
  keyPrefix: string,
  compareLeaves: (a: BranchForestLeaf<TPayload>, b: BranchForestLeaf<TPayload>) => number,
): BranchForestNode<TPayload>[] {
  interface Cursor {
    key: string;
    label: string;
    children: Array<Cursor | BranchForestLeaf<TPayload>>;
    childMap: Map<string, Cursor>;
  }
  function isCursor(node: Cursor | BranchForestLeaf<TPayload>): node is Cursor {
    return "childMap" in node;
  }

  const root: Cursor = { key: keyPrefix, label: "", children: [], childMap: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let cursor: Cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let next = cursor.childMap.get(seg);
      if (!next) {
        const folderPath = parts.slice(0, i + 1).join("/");
        next = { key: `${keyPrefix}:dir:${folderPath}`, label: seg, children: [], childMap: new Map() };
        cursor.childMap.set(seg, next);
        cursor.children.push(next);
      }
      cursor = next;
    }
    const leaf: BranchForestLeaf<TPayload> = {
      kind: "leaf",
      key: `${keyPrefix}:${entry.ref}`,
      label: parts[parts.length - 1] || entry.path,
      ref: entry.ref,
      payload: entry.payload,
      children: [],
    };
    cursor.children.push(leaf);
  }

  function sortAndConvert(node: Cursor): BranchForestNode<TPayload>[] {
    const folders = node.children.filter(isCursor);
    const leaves = node.children.filter((c): c is BranchForestLeaf<TPayload> => !isCursor(c));
    folders.sort((a, b) => a.label.localeCompare(b.label));
    leaves.sort(compareLeaves);
    return [
      ...folders.map((f): BranchForestFolder<TPayload> => ({
        kind: "folder",
        key: f.key,
        label: f.label,
        children: sortAndConvert(f),
      })),
      ...leaves,
    ];
  }

  return sortAndConvert(root);
}
