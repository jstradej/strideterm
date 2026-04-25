// Shared helpers for surfacing git status across the file manager UI.
// Status keys: "modified" | "staged" | "untracked" | "conflict" | "ignored".

export const STATUS_LABEL = {
  modified: "Modified",
  staged: "Staged",
  untracked: "Untracked",
  conflict: "Conflict",
  ignored: "Ignored",
};

export const STATUS_BADGE = {
  modified: "M",
  staged: "S",
  untracked: "U",
  conflict: "!",
  ignored: "I",
};

// Tailwind-ish accent-aligned colors. Values picked to read on both light
// and dark themes; tweakable via CSS variables in main.css.
export const STATUS_COLOR = {
  modified: "var(--fm-status-modified, #d8a14b)",
  staged: "var(--fm-status-staged, #6cb478)",
  untracked: "var(--fm-status-untracked, #5e9bd6)",
  conflict: "var(--fm-status-conflict, #e26b6b)",
  ignored: "var(--fm-status-ignored, #888)",
};

export const STATUS_TITLE = {
  modified: "Modified — has unstaged changes since HEAD",
  staged: "Staged — changes staged for commit",
  untracked: "Untracked — new file not yet added to git",
  conflict: "Conflict — merge in progress, resolve before committing",
  ignored: "Ignored by .gitignore",
};

export function statusLabel(status) {
  return STATUS_LABEL[status] || "";
}

export function statusBadge(status) {
  return STATUS_BADGE[status] || "";
}

export function statusColor(status) {
  return STATUS_COLOR[status] || "transparent";
}

export function statusTitle(status) {
  return STATUS_TITLE[status] || "";
}
