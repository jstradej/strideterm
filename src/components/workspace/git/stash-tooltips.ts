// Shared tooltip copy for stash actions. The same actions appear in three
// places — the list-row kebab menu, the expanded list row, and the detail-pane
// toolbar — so the wording lives here once to stay identical and accurate.
// Each line says what actually happens, including whether the stash is kept.
export const STASH_TOOLTIPS = {
  apply: "Add these stashed changes to your working tree and keep the stash in the list (so you can apply it again).",
  pop: "Add these stashed changes to your working tree, then delete the stash from the list (apply + drop).",
  drop: "Delete this stash for good without touching your working tree. This cannot be undone.",
  branch:
    "Create a new branch at the commit this stash was based on and apply the stash there — use this when the stash no longer applies cleanly to the current branch.",
  export: "Save this stash to a .patch file (to share or re-import later). The stash itself stays in the list.",
  copy: "Copy this stash's git reference (e.g. stash@{0}) to the clipboard for use in git commands.",
} as const;

// `stash@{N}` looks like an unfilled placeholder but is git's own reference
// syntax. Explain the stack-position meaning of the number.
export function stashRefTooltip(ref: string): string {
  return `${ref} — git's own name for this stash. The number is its position on the stash stack: 0 is the newest, and it shifts up or down as stashes are added or removed.`;
}
