// The last VERIFIED login address this desktop signed in with, remembered on this machine.
//
// WHY. The owner session is transient (see `account-manager.ts`), and the overview this machine reads
// through its installation session carries only the server's MASKED `accountDisplay`. So a restarted
// desktop could not tell its own owner which address they signed in with — and the page that asks
// them to type that address for a fresh link showed them `t••••@example.com` as the only hint. It is
// their own address, typed on this machine; the desktop may remember it.
//
// WHAT IT IS NOT:
//
//   - NOT A CREDENTIAL. It proves nothing and is never used to decide anything. A sign-in still goes
//     to the address a person types, and the owner check still happens at the server.
//   - NOT AUTHORITATIVE. The login address can be changed from another device. Every overview the
//     server answers is compared with it (`matchesAccountDisplay`), and a remembered address the
//     server's mask contradicts is forgotten and the person is TOLD — never silently corrected, never
//     silently kept.
//   - NOT SENT ANYWHERE. It lives in the credential store (encrypted where secure storage exists) and
//     reaches only the desktop renderer through the account state. The account state has no remote
//     route, and logs never carry it.

/** The credential-store ref. Not `mobile:` — this is account sign-in, which works without Mobile. */
export const REMEMBERED_OWNER_EMAIL_REF = "account:owner-email";

export interface RememberedOwnerEmail {
  readonly email: string;
  /** The owner uid it was proved for, so a different account is recognised as one. */
  readonly uid: string;
  readonly savedAt: number;
}

/** Parses what the store holds. `null` for nothing stored, `corrupt` for something unreadable. */
export function parseRememberedOwnerEmail(raw: string | null | undefined): RememberedOwnerEmail | null | "corrupt" {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RememberedOwnerEmail> & { v?: unknown };
    if (
      value?.v !== 1 ||
      typeof value.email !== "string" ||
      !value.email.includes("@") ||
      typeof value.uid !== "string" ||
      value.uid.length === 0 ||
      typeof value.savedAt !== "number"
    ) {
      return "corrupt";
    }
    return { email: value.email, uid: value.uid, savedAt: value.savedAt };
  } catch {
    return "corrupt";
  }
}

export function serializeRememberedOwnerEmail(value: RememberedOwnerEmail): string {
  return JSON.stringify({ v: 1, email: value.email, uid: value.uid, savedAt: value.savedAt });
}

export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The characters a server mask is made of. A RUN of them stands for the hidden part. */
const MASK_RUN = /[•*·…]+/u;

/**
 * Whether a remembered address is consistent with the server's masked `accountDisplay`.
 *
 * The visible characters must match in place and each run of mask characters stands for one or more
 * hidden ones, compared case-insensitively. The mask format is the server's, so this reads it rather
 * than re-deriving it: `t••••@example.com` and `t***@example.com` are both understood.
 *
 * `uncheckable` when there is nothing to compare with — no display at all, or one that is neither an
 * address nor a mask. That is not a disagreement, and the person is not told it is one.
 */
export function matchesAccountDisplay(
  email: string,
  accountDisplay: string | undefined,
): "match" | "mismatch" | "uncheckable" {
  const display = accountDisplay?.trim();
  if (!display) return "uncheckable";
  if (!MASK_RUN.test(display)) {
    if (!display.includes("@")) return "uncheckable";
    return sameEmail(email, display) ? "match" : "mismatch";
  }
  return globMatches(email.trim().toLowerCase(), display.toLowerCase().split(MASK_RUN)) ? "match" : "mismatch";
}

/**
 * Whether `value` is `parts[0]`, one or more characters, `parts[1]`, … `parts[n]`, end to end.
 *
 * A plain scan rather than a RegExp built from the server's text: leftmost placement of each middle
 * part is enough for wildcards, and it needs no escaping and cannot backtrack.
 */
function globMatches(value: string, parts: readonly string[]): boolean {
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (!value.startsWith(first)) return false;
  let cursor = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = value.indexOf(part, cursor + 1);
    if (found < 0) return false;
    cursor = found + part.length;
  }
  return value.length - last.length >= cursor + 1 && value.endsWith(last);
}
