/**
 * Shared types for `BranchTreePane.vue` / `BranchTreeNode.vue` and any
 * consumer that builds a tree to pass in (e.g. `GitBranchesTab.vue`).
 *
 * Lives in a plain `.ts` file (rather than re-exported from `.vue`) so
 * the `tsconfig.tests.json` toolchain — which uses plain `tsc` and the
 * default `*.vue` module shim that only exposes the default export — can
 * still import the named type from component test files.
 */

export interface BranchTreeNodeMeta {
  ahead?: number;
  behind?: number;
  upstream?: string;
  merged?: boolean;
  remote?: string;
  lastCommit?: string;
  lastSubject?: string;
  lastAuthor?: string;
  lastRelativeDate?: string;
  lastCommitTimestamp?: number;
  isCurrent?: boolean;
  isDefault?: boolean;
  hasLocal?: boolean;
  count?: number;
  tag?: boolean;
}

export type BranchTreeNodeKind = "section" | "folder" | "branch-local" | "branch-remote" | "tag";

export interface BranchTreeNode {
  key: string;
  kind: BranchTreeNodeKind;
  label: string;
  ref?: string;
  icon?: string;
  isCurrent?: boolean;
  upstream?: string;
  meta?: BranchTreeNodeMeta;
  children?: BranchTreeNode[];
}
