import { errorCauseCode, JiraRequestError } from "./jira-request-error.js";

/** Where a request was when it failed: only `read` can have reached Jira. */
export type JiraRequestStage = "acquire" | "auth" | "connect" | "read";

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME"]);
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "ENETDOWN"]);
const PRE_SEND_CODES = new Set([
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT",
  "UND_ERR_SOCKET_CONNECT",
]);
const HANDSHAKE_CERT_CODE =
  /^(?:CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|HOSTNAME_MISMATCH|ERR_TLS_CERT_ALTNAME_INVALID$)/;
const PRE_SEND_SYSCALLS = new Set(["connect", "getaddrinfo"]);

/**
 * True only when the failure is provably from before the request bytes were written: name resolution, connect, or a
 * certificate refusal during the handshake. Codes such as EHOSTUNREACH or EPROTO can also come from a socket that had
 * already sent the request, so they are not enough on their own.
 */
export function provablyBeforeSend(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const { code, syscall } = current as { code?: unknown; syscall?: unknown };
    if (typeof code === "string" && (DNS_CODES.has(code) || PRE_SEND_CODES.has(code) || HANDSHAKE_CERT_CODE.test(code)))
      return true;
    if (typeof syscall === "string" && PRE_SEND_SYSCALLS.has(syscall)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
const TLS_CODE =
  /^(?:CERT_|ERR_TLS_|ERR_SSL_|ERR_OSSL_SSL|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|EPROTO$)/;

function messageChain(error: unknown): string {
  const parts: string[] = [];
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error) parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ").toLowerCase();
}

/**
 * The PFX/P12 failures people actually meet. OpenSSL's own wording is what tells a wrong password from a file this
 * build can no longer read, so it is matched here and only the OpenSSL CODE is carried on, never the message.
 */
export function describePfxFailure(error: unknown): JiraRequestError | undefined {
  const text = messageChain(error);
  const causeCode = errorCauseCode(error);
  let message: string | undefined;
  if (/mac verify (?:failure|error)|bad decrypt|invalid password|incorrect password/.test(text))
    message =
      "The client certificate password is wrong. Edit this connection and enter the password of the PFX/P12 file again.";
  else if (
    causeCode === "ERR_OSSL_EVP_UNSUPPORTED" ||
    /digital envelope routines|unsupported.*(?:pkcs12|pfx)/.test(text)
  )
    message =
      "The client certificate uses an old encryption algorithm (such as RC2 or 3DES) that this app cannot read. Re-export the PFX/P12 with AES encryption and choose it again.";
  else if (causeCode === "ENOENT" || causeCode === "EACCES" || causeCode === "EPERM" || causeCode === "EISDIR")
    message = `The client certificate file could not be read (${causeCode}). Edit this connection and choose its PFX/P12 file again.`;
  else if (/asn1|wrong tag|not enough data|pkcs12|pfx|too long/.test(text) && /cert|pfx|pkcs|asn1/.test(text))
    message = "The client certificate file is not a valid PFX/P12 file. Edit this connection and choose it again.";
  if (!message) return undefined;
  return new JiraRequestError("certificate-invalid", message, undefined, undefined, { cause: error, notSent: true });
}

/**
 * Turns anything a request can throw into a JiraRequestError that keeps its cause, carries a specific code and says
 * whether the request ever left this machine. Messages never include the cause's text (it can hold URLs and JQL).
 */
export function toJiraRequestError(
  error: unknown,
  stage: JiraRequestStage,
  genericMessage = "Jira request failed or exceeded its time limit.",
): JiraRequestError {
  if (error instanceof JiraRequestError) {
    if (stage !== "read" && error.statusCode === undefined) error.notSent = true;
    return error;
  }
  const causeCode = errorCauseCode(error);
  const text = messageChain(error);
  if (stage === "connect" || stage === "read") {
    const pfx = describePfxFailure(error);
    if (pfx) return pfx;
  }
  const notSent = stage !== "read" || provablyBeforeSend(error);
  if (causeCode && DNS_CODES.has(causeCode))
    return new JiraRequestError(
      "host-unreachable",
      `The Jira host name could not be resolved (${causeCode}). Check the Jira URL, your network and your VPN.`,
      undefined,
      undefined,
      { cause: error, notSent },
    );
  if (causeCode && UNREACHABLE_CODES.has(causeCode))
    return new JiraRequestError(
      "host-unreachable",
      `Jira could not be reached (${causeCode}). Check the Jira URL, your network and your VPN.`,
      undefined,
      undefined,
      { cause: error, notSent },
    );
  if (causeCode && TLS_CODE.test(causeCode))
    return new JiraRequestError(
      "tls-error",
      `The secure connection to Jira failed (${causeCode}). Check the server certificate and any client certificate.`,
      undefined,
      undefined,
      { cause: error, notSent },
    );
  const timedOut = /deadline exceeded|aborted|timeout|timed out/.test(text) || causeCode === "ABORT_ERR";
  if (timedOut && stage !== "read")
    return new JiraRequestError(
      "network",
      "Jira request exceeded its time limit before it was sent.",
      undefined,
      undefined,
      {
        cause: error,
        notSent: true,
      },
    );
  return new JiraRequestError("network", genericMessage, undefined, undefined, { cause: error, notSent });
}
