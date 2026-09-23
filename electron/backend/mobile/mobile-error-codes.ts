/**
 * One fixed, structured reason code per failure on the mobile control-plane path (review 2
 * §"Logy a diagnostika": "používat strukturované reason codes, nikoli raw remote response").
 *
 * WHY THIS EXISTS. Every log site in this directory used to emit `err: (err as Error)?.message`.
 * That string is not ours. For a callable failure it is whatever the Cloud Function's `HttpsError`
 * said; for an RTDB rejection it was the serialised response body; and for a transport failure it
 * is undici's own text, which in several cases embeds the full request URL — and the RTDB REST API
 * carries the caller's Firebase ID token as `?auth=<jwt>`. The logger redacts secrets on emission
 * (logger.ts's TOKEN_PATTERNS, including a JWT-shaped rule added for exactly this), but a redactor
 * is a backstop, not a reason to keep feeding it remote-controlled text: whatever a redactor has
 * not thought of, it does not catch.
 *
 * WHAT IS LOST, STATED PLAINLY. A message often carries detail a code does not, and this drops it.
 * That is the trade the review asks for, and it is affordable here because the diagnostic surface
 * this path actually needs is elsewhere and is richer: `mobile-audit-log-store.ts` records a fixed
 * reason code per rejected envelope, `MobileManager.getConnectionHealth()` surfaces the last
 * transport error to the UI, and the codes below already distinguish the cases an operator acts on
 * differently — a rules rejection, an over-quota write, an unconfigured install, a callable that
 * refused, and a network failure. For anything outside those, the error's own class name is kept,
 * which is what separates an `AbortError` from a `TypeError` without quoting anyone.
 */
import { MobileFirebaseNotConfiguredError } from "./mobile-firebase-config.js";
import {
  MobileFirebaseAuthRejectedError,
  MobileFirebaseCallableError,
  MobileFirebasePermissionDeniedError,
} from "./mobile-firebase-rest.js";
import { MobileQuotaExceededError } from "./mobile-firebase-transport.js";
import { classifyNetworkError } from "../net/network-error.js";

/**
 * A fixed code for `err`, safe to log.
 *
 * Every branch returns a value assembled from OUR OWN constants and, at most, a callable name and
 * status that this codebase defines — never from a response body, a URL, or an error message.
 */
export function mobileErrorCode(err: unknown): string {
  if (err instanceof MobileFirebaseCallableError) {
    // `functionName` is one of the nine names in cloud/functions/src/index.ts and `status` is a
    // gRPC status code (`permission-denied`, `resource-exhausted`, …) — both are enumerable values,
    // not free text. The callable's own `message` is deliberately not included even though ours are
    // fixed strings today: a future function, or a Firebase-generated error, need not be.
    return `callable:${err.functionName}:${err.status}`;
  }
  if (err instanceof MobileFirebasePermissionDeniedError) return "permission-denied";
  // `reason` is matched against REFRESH_TOKEN_REJECTIONS, so it is one of our own constants.
  if (err instanceof MobileFirebaseAuthRejectedError) return `auth-rejected:${err.reason}`;
  if (err instanceof MobileQuotaExceededError) return "quota-exceeded";
  if (err instanceof MobileFirebaseNotConfiguredError) return "not-configured";
  // A transport failure (undici's `TypeError: fetch failed` with the code in `cause`, or a `ws`
  // error with `code` on it) gets a fixed kind the UI can explain — TLS inspection above all —
  // instead of the bare class name. Unclassified errors keep the class name below.
  const net = classifyNetworkError(err);
  if (net) return `network:${net}`;
  if (err instanceof Error) {
    // `name` for a built-in is a class name (`TypeError`, `AbortError`, `SyntaxError`); for a
    // custom error it is whatever the constructor set, which in this codebase is always a literal.
    // Bounded anyway, because `name` is writable and an object crossing a package boundary could
    // carry an arbitrary one.
    return err.name ? err.name.slice(0, 64) : "error";
  }
  // A thrown non-Error. The type name, never the value: a thrown string is remote content as often
  // as not.
  return `non-error:${typeof err}`;
}
