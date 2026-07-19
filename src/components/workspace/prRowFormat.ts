/**
 * Formatting helpers used by PrRow.vue (Azure/GitHub PR rows share the one
 * component, parametrized by a `provider` prop). Each provider's PR row used
 * to carry its own copy of these before the merge — this is the single home
 * for them. (`stripRef` is shared too, but its existing home is
 * azurePipelineFormat.ts — see the import in PrRow.vue.)
 */

/** First 7 chars of a commit SHA, for the compact "HEAD" fact. */
export function shortSha(sha: unknown): string {
  return String(sha || "").slice(0, 7);
}

/** e.g. "3 Jan 2026" — used for the "Created"/"Updated" facts. */
export function formatDate(iso: unknown): string {
  if (!iso) return "";
  const d = new Date(iso as string);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
