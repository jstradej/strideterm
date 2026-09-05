// The last hop of a billing URL: what the desktop is willing to hand to the operating system.
//
// WHAT THIS FILE USED TO SAY, and why that was the finding rather than the fix. It asserted a
// scheme-only check and stated, in a comment the last test PINNED, that "the host allowlist is the
// server's job" and "this side cannot repeat that check: it has no merchant configuration and no way
// to tell a merchant host from any other HTTPS host". Both halves were true of the code and false of
// the design: plan §2 asks for the exact-host allowlist on BOTH boundaries, and a green test proving
// a deviation is worse than no test.
//
// TWO CHECKS IN TWO PLACES, AND THEY ANSWER DIFFERENT QUESTIONS. The server's asks "is the URL I am
// about to hand out a merchant URL", which it can only ask because it holds the merchant
// configuration — `strideterm-mobile`'s `cloud/functions/test/billing-url-allowlist.test.ts` covers
// it, including the suffix, userinfo and path tricks a `startsWith` would let through. The
// DESKTOP's asks "is the URL I am about to hand to the operating system one I was told to expect",
// and that question survives a malformed, truncated or compromised callable response — which is
// exactly the case the server's own check cannot help with.
//
// WHERE THE ALLOWLIST COMES FROM: `billingCheckoutHosts` on the SIGNED control-plane bootstrap
// envelope. Not an environment variable (editable by whatever launched the app) and not a compiled-in
// constant (a merchant host has to be able to move during a recovery without a new release).
//
// TWO SURFACES ARE TESTED HERE. `billing-url.ts` is the behavioural half, exercised directly. The
// `ipc.ts` opener is the scheme-and-parse backstop for every OTHER external URL in the app, and it
// is a closure wired to Electron's `shell` — so the property worth pinning there is structural, and
// it is the one a refactor breaks silently.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkBillingUrl } from "./billing-url.js";

const BACKEND_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IPC_SOURCE = readFileSync(path.join(BACKEND_DIR, "ipc.ts"), "utf8");

const ALLOWLIST = ["checkout.paddle.com", "strideterm.paddle.com"];

describe("the desktop's own billing URL check", () => {
  it("accepts an HTTPS URL whose host is exactly on the signed allowlist", () => {
    expect(checkBillingUrl("https://checkout.paddle.com/pay/abc", ALLOWLIST)).toBeNull();
    expect(checkBillingUrl("https://strideterm.paddle.com/portal/1?x=2#y", ALLOWLIST)).toBeNull();
    // Userinfo is stripped before the comparison, so the host is the host.
    expect(checkBillingUrl("https://user:pw@checkout.paddle.com/pay", ALLOWLIST)).toBeNull();
  });

  it("refuses the suffix, prefix and path tricks a `startsWith` would let through", () => {
    // The whole family, because each one has been somebody's real bug somewhere.
    expect(checkBillingUrl("https://checkout.paddle.com.evil.test/pay", ALLOWLIST)).toBe("host-not-allowed");
    expect(checkBillingUrl("https://evil.test/?next=checkout.paddle.com", ALLOWLIST)).toBe("host-not-allowed");
    expect(checkBillingUrl("https://evil.test/checkout.paddle.com/pay", ALLOWLIST)).toBe("host-not-allowed");
    expect(checkBillingUrl("https://evilcheckout.paddle.com/pay", ALLOWLIST)).toBe("host-not-allowed");
    // And a userinfo that spells the allowed host while the AUTHORITY is somebody else's.
    expect(checkBillingUrl("https://checkout.paddle.com@evil.test/pay", ALLOWLIST)).toBe("host-not-allowed");
  });

  it("requires HTTPS, with no loopback exception", () => {
    // A development fake speaks http on loopback, and it is reached through the FUNCTIONS emulator —
    // so an exception here would be an exception in production too.
    expect(checkBillingUrl("http://checkout.paddle.com/pay", ALLOWLIST)).toBe("not-https");
    expect(checkBillingUrl("http://127.0.0.1:8080/pay", ["127.0.0.1"])).toBe("not-https");
    // And a scheme the OS would hand to a registered protocol handler is refused before anything else.
    expect(checkBillingUrl("vscode://file/etc/passwd", ALLOWLIST)).toBe("not-https");
    expect(checkBillingUrl("file:///etc/passwd", ALLOWLIST)).toBe("not-https");
  });

  it("refuses everything when the allowlist is EMPTY, rather than accepting anything", () => {
    // The opposite of the old behaviour, and the important half. A build that has not been told which
    // merchant it uses must open nothing: the failure mode of refusing is a checkout that does not
    // open, and the failure mode of accepting is a person sent to somebody else's page from inside
    // our app.
    expect(checkBillingUrl("https://checkout.paddle.com/pay", [])).toBe("no-allowlist");
    // And the refusal is DISTINCT from "not on the list": one is a configuration task, the other is
    // worth treating as an incident, and a single boolean makes them indistinguishable.
    expect(checkBillingUrl("https://evil.test/pay", ALLOWLIST)).toBe("host-not-allowed");
  });

  it("refuses something that is not a URL at all", () => {
    expect(checkBillingUrl("not a url", ALLOWLIST)).toBe("not-a-url");
    expect(checkBillingUrl("", ALLOWLIST)).toBe("not-a-url");
  });
});

/** The body of `runtime.setExternalUrlOpener?.(…)`, from the call to its closing `});`. */
function externalUrlOpenerBody(): string {
  const start = IPC_SOURCE.indexOf("runtime.setExternalUrlOpener?.(");
  expect(start).toBeGreaterThan(-1);
  const end = IPC_SOURCE.indexOf("\n  });", start);
  expect(end).toBeGreaterThan(start);
  return IPC_SOURCE.slice(start, end);
}

describe("the external URL opener the account manager is given", () => {
  it("is installed at all, so a checkout never falls back to an unchecked opener", () => {
    // `setExternalUrlOpener` is optional on the runtime. If this registration were dropped, the
    // account manager would have no opener and a checkout would silently do nothing — which reads
    // as a payment failure rather than as a missing wire.
    expect(IPC_SOURCE).toContain("runtime.setExternalUrlOpener?.(");
  });

  it("parses with WHATWG and returns on anything that is not a URL", () => {
    const body = externalUrlOpenerBody();
    expect(body).toContain("new URL(url)");
    // A `catch` that returns, not one that opens the raw string.
    expect(body).toMatch(/catch\s*\{\s*return;/);
  });

  it("requires http: or https: exactly, and refuses everything else before opening", () => {
    const body = externalUrlOpenerBody();
    // Exact protocol equality, not a `^https?://` prefix: `https://x#javascript:alert(1)` parses to
    // an https URL, but `vscode://…` and `file://…` must never reach the OS handler.
    expect(body).toMatch(/parsed\.protocol !== "https:" && parsed\.protocol !== "http:"/);
    const guardAt = body.search(/parsed\.protocol !== "https:"/);
    const openAt = body.indexOf("shell.openExternal");
    expect(guardAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(guardAt);
    // And the URL that is handed over is the PARSED one, so a normalised string is what the OS sees.
    expect(body).toContain("shell.openExternal(parsed.toString())");
  });

  it("is a backstop for every external URL, and NOT the billing check", () => {
    // The one comment worth pinning, and it is the opposite of what it used to say. This opener is
    // shared with "open the docs" and "show this file", so a merchant allowlist here would refuse
    // every one of them. The billing allowlist lives in `billing-url.ts` and is applied by the
    // account manager BEFORE a URL reaches this closure — which is what makes both boundaries real.
    const start = IPC_SOURCE.indexOf("runtime.setExternalUrlOpener?.(");
    const preamble = IPC_SOURCE.slice(Math.max(0, start - 900), start);
    expect(preamble).toMatch(/billing-url\.ts/);
    expect(preamble).toMatch(/exact-host allowlist/i);
  });
});
