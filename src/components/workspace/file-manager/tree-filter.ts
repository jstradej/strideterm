export interface FilterableTreeNode {
  entry: { name: string; kind: string; relativePath: string };
  children: FilterableTreeNode[] | null;
}

export interface TreeFilterContext {
  filter: string;
  editorLayout: boolean;
  treeNodes: Map<string, FilterableTreeNode>;
}

export function normalizeTreeFilter(text: string): string {
  return text.trim().toLowerCase();
}

export function treeNameMatches(node: FilterableTreeNode, filter: string): boolean {
  return !!filter && node.entry.name.toLowerCase().includes(filter);
}

export function loadedTreeChildren(
  node: FilterableTreeNode,
  treeNodes: Map<string, FilterableTreeNode>,
): FilterableTreeNode[] {
  return treeNodes.get(node.entry.relativePath)?.children || node.children || [];
}

function isShownKind(node: FilterableTreeNode, editorLayout: boolean): boolean {
  return editorLayout || node.entry.kind === "directory";
}

// A folder that does not match by name stays only while something already loaded below it does —
// the tree is lazy, so the contents of a folder never expanded are unknown and not searched.
function keepsMatch(node: FilterableTreeNode, context: TreeFilterContext): boolean {
  if (treeNameMatches(node, context.filter)) return true;
  if (node.entry.kind !== "directory") return false;
  return loadedTreeChildren(node, context.treeNodes).some(
    (child) => isShownKind(child, context.editorLayout) && keepsMatch(child, context),
  );
}

// Inside a folder whose name matches everything is shown, so expanding `dist` lists its contents.
export function visibleTreeChildren<T extends FilterableTreeNode>(
  children: T[],
  context: TreeFilterContext,
  insideMatch: boolean,
): T[] {
  const shown = children.filter((child) => isShownKind(child, context.editorLayout));
  if (!context.filter || insideMatch) return shown;
  return shown.filter((child) => keepsMatch(child, context));
}
