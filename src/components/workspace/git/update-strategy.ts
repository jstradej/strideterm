/**
 * Shared types for the rebase/merge split button (GitStrategySplitButton.vue),
 * used by both its call sites: the "Update Current Branch" card, which targets
 * the base branch, and the Git toolbar's Pull button, which targets the
 * upstream. They live here rather than in the SFC because `<script setup>`
 * cannot carry ES module exports.
 */

/** Persisted as `settings.git.ui.updateStrategy`. */
export type UpdateStrategy = "rebase" | "merge";

export interface StrategyOption {
  value: UpdateStrategy;
  label: string;
  /** Tooltip — say what it does to history, not just what it is called. */
  title: string;
  testid: string;
}
