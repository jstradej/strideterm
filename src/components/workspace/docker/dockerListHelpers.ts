/**
 * Helpers shared by the image / volume / network list tabs.
 *
 * `parseDockerSize` is the load-bearing piece: docker prints sizes as strings
 * like "123MB", "1.234GB", "576kB". The CLI uses SI units (1 kB = 1000 bytes)
 * for image sizes; that's good enough for the table's sort order, and exact
 * accuracy doesn't matter — we never compare against the raw byte count.
 */

const UNITS: Record<string, number> = {
  B: 1,
  kB: 1000,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  PB: 1000 ** 5,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

/**
 * Parse a docker-formatted size string into a numeric byte count for sorting.
 * Empty / unparseable input returns 0 so those rows sort to the bottom in
 * descending order without crashing the sort comparator.
 */
export function parseDockerSize(s: string | undefined | null): number {
  if (!s) return 0;
  const trimmed = String(s).trim();
  if (!trimmed) return 0;
  // Split numeric prefix from unit suffix without a regex — bounded scan that
  // can't backtrack, sidestepping eslint's regex-safety heuristic entirely.
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed.charCodeAt(i);
    const isDigit = ch >= 48 && ch <= 57;
    const isDot = ch === 46;
    if (!isDigit && !isDot) break;
    i++;
  }
  if (i === 0) return 0;
  const value = parseFloat(trimmed.slice(0, i));
  if (Number.isNaN(value)) return 0;
  const unit = trimmed.slice(i).trim() || "B";
  // Whitelisted lookup — UNITS is a static literal map; this isn't a real
  // object-injection sink but eslint can't statically prove that.
  // eslint-disable-next-line security/detect-object-injection
  const mul = UNITS[unit] ?? 1;
  return value * mul;
}

/**
 * Build the message body of a bulk-action confirmation dialog. Caps the
 * listed names at MAX so we don't render a 100-row dialog; the rest is
 * collapsed into "…and N more".
 */
export function bulkConfirmMessage(verb: string, names: string[], suffix?: string): string {
  const MAX = 10;
  const head = names.slice(0, MAX);
  const rest = names.length - head.length;
  const lines: string[] = [];
  lines.push(`${verb} ${names.length} item${names.length === 1 ? "" : "s"}?`);
  lines.push("");
  for (const n of head) lines.push(`  • ${n}`);
  if (rest > 0) lines.push(`  …and ${rest} more`);
  if (suffix) {
    lines.push("");
    lines.push(suffix);
  }
  return lines.join("\n");
}

/**
 * Composite row key for the images table.
 *
 * `docker images --format` lists one row per Repository:Tag, so the same
 * underlying image (same SHA ID) can legitimately appear multiple times in
 * the list — once per tag. Using just `ID` as Vue's `:key` causes the keyed
 * diff to reuse DOM nodes across rows after sort toggles, producing visible
 * duplicates and a scrambled order.
 *
 * The composite key is unique per (image, tag) within a single (backend,
 * context) — which is the scope filtered into the table. Bulk operations
 * collapse back to `ID` before invoking `docker image rm` since removing the
 * underlying image also removes its other tags.
 */
export function imageRowKey(img: { ID: string; Repository: string; Tag: string }): string {
  return `${img.ID}|${img.Repository}:${img.Tag}`;
}

/**
 * Pretty-print a PruneResult into a notification body.
 */
export function pruneSummary(deletedNames: string[], reclaimed: string): string {
  const count = deletedNames.length;
  const sizePart = reclaimed && reclaimed !== "0B" ? `, freed ${reclaimed}` : "";
  if (count === 0) return reclaimed ? `Nothing to delete${sizePart}.` : "Nothing to delete.";
  return `Removed ${count} item${count === 1 ? "" : "s"}${sizePart}.`;
}
