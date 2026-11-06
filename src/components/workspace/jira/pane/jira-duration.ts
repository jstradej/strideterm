const SECONDS_PER_UNIT = { h: 3600, m: 60 } as const;
const MAX_WORKLOG_SECONDS = 24 * 3600;

export type JiraDurationResult = { ok: true; seconds: number } | { ok: false; error: string };

const FORMAT_HINT = "Enter a time like 1h 30m, 45m, 2h or 1.5h.";

/** Accepts "1h 30m", "1h30m", "45m", "2h", "1.5h"; returns whole seconds. */
export function parseJiraDuration(input: string): JiraDurationResult {
  const text = input.trim().toLowerCase().replace(/,/g, ".");
  if (!text) return { ok: false, error: "Enter how long you worked. " + FORMAT_HINT };
  let seconds = 0;
  let index = 0;
  let parts = 0;
  const seen = new Set<string>();
  while (index < text.length) {
    while (text[index] === " ") index++;
    const start = index;
    while (index < text.length && ((text[index]! >= "0" && text[index]! <= "9") || text[index] === ".")) index++;
    const amountText = text.slice(start, index);
    while (text[index] === " ") index++;
    const unit = text[index];
    if (!amountText || (unit !== "h" && unit !== "m")) return { ok: false, error: FORMAT_HINT };
    index++;
    if (index < text.length && text[index] !== " " && !(text[index]! >= "0" && text[index]! <= "9"))
      return { ok: false, error: FORMAT_HINT };
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amountText.split(".").length > 2) return { ok: false, error: FORMAT_HINT };
    if (seen.has(unit)) return { ok: false, error: `Use each unit once, like 1h 30m.` };
    seen.add(unit);
    seconds += amount * SECONDS_PER_UNIT[unit];
    parts++;
    while (text[index] === " ") index++;
  }
  const whole = Math.round(seconds);
  if (!parts || whole < 60) return { ok: false, error: "Log at least 1 minute." };
  if (whole > MAX_WORKLOG_SECONDS) return { ok: false, error: "Log up to 24 hours at a time." };
  return { ok: true, seconds: whole };
}
