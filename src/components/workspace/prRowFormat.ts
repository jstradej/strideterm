/**
 * Formatting helpers shared by AzurePrRow and GitHubPrRow. Each provider's PR
 * row used to carry its own copy of these — this is the single home for them
 * so both stay in sync. (`stripRef` is shared too, but its existing home is
 * azurePipelineFormat.ts — see the imports in AzurePrRow.vue/GitHubPrRow.vue.)
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
