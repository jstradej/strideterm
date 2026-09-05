import { describe, expect, test } from "vitest";
import { __redactSecretsForTesting as redact } from "./logger.js";

describe("logger secret redaction", () => {
  test("Telegram bot token in URL path is redacted", () => {
    const out = redact("GET https://api.telegram.org/bot1234567890:AAH-9XYZabcdEFGHijklMNOPqrsTUVwx/sendMessage");
    expect(out).not.toContain("AAH-9XYZabcdEFGHijklMNOPqrsTUVwx");
    expect(out).toContain("[REDACTED]");
    // Path structure preserved so the message still reads as a Telegram URL.
    expect(out).toContain("/bot");
    expect(out).toContain("/sendMessage");
  });

  test("Authorization Bearer header is redacted", () => {
    const out = redact('headers: { "authorization": "Bearer abc123def456ghi789jkl012" }');
    expect(out).not.toContain("abc123def456ghi789jkl012");
    expect(out).toContain("[REDACTED]");
  });

  test("bare Bearer prefix in plain text is redacted", () => {
    const out = redact("got 401 with Bearer abc123def456ghi789jkl012mnopqr");
    expect(out).not.toContain("abc123def456ghi789jkl012mnopqr");
  });

  test("token / pat / api_key query strings are redacted", () => {
    expect(redact("http://lan/?token=secretvalue123")).not.toContain("secretvalue123");
    expect(redact("http://lan/?pat=PATTOPSECRET")).not.toContain("PATTOPSECRET");
    expect(redact("http://api/?api_key=SUPER")).not.toContain("SUPER");
    expect(redact("http://api/?api-key=SUPER")).not.toContain("SUPER");
    expect(redact("http://api/?access_token=abc")).not.toContain("=abc");
  });

  test("JSON-style secret fields are redacted", () => {
    const cases = [
      '{"token":"xyz123abc"}',
      '{"pat":"PAT-VALUE"}',
      '{"password":"hunter2"}',
      '{"passphrase":"correct horse battery staple"}',
      '{"secret":"shh"}',
      '{"botToken":"123:ABC"}',
      '{"access_token":"a1b2"}',
      '{"api_key":"k-1"}',
    ];
    for (const c of cases) {
      const out = redact(c);
      // The values are gone but the keys stay so the log structure is readable.
      expect(out).toContain("[REDACTED]");
    }
    expect(redact('{"password":"hunter2"}')).not.toContain("hunter2");
    expect(redact('{"botToken":"123:ABC"}')).not.toContain("123:ABC");
  });

  test("the mobile Firebase REST credentials in a query string are redacted", () => {
    // The RTDB REST API takes the caller's ID token as ?auth=<jwt> and the Auth endpoints take the
    // web API key as ?key=<key>. Undici puts the full request URL in several of its error messages,
    // so a single failed fetch used to drop a live credential into the log (review 2 §"Logy a
    // diagnostika").
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJhYmMifQ.c2lnbmF0dXJl";
    const url = `RTDB GET failed: https://demo-default-rtdb.europe-west1.firebasedatabase.app/v2/pairs.json?auth=${jwt}`;
    const out = redact(url);
    expect(out).not.toContain(jwt);
    expect(out).toContain("[REDACTED]");
    // The path survives, because that is the part that makes the log useful.
    expect(out).toContain("/v2/pairs.json");

    const keyed = redact(
      "signUp failed: https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaLiveWebApiKey",
    );
    expect(keyed).not.toContain("AIzaLiveWebApiKey");
  });

  test("a JWT is redacted by SHAPE, wherever it appears and whatever it is called", () => {
    // Review 2 §"Logy a diagnostika": redaction must not depend on the field name alone, because a
    // value can be a composite URL or a JSON blob whose key we never see. These three carry no
    // recognisable secret-ish key name at all.
    const jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJhdWQiOiJkZW1vIn0.AbCdEfGhIjKlMnOp";
    for (const line of [
      `TypeError: fetch failed (bearerless bare token ${jwt})`,
      `{"headers":{"X-Firebase-AppCheck":"${jwt}"}}`,
      `stream error: unexpected response for ${jwt}`,
    ]) {
      const out = redact(line);
      expect(out).not.toContain(jwt);
      expect(out).toContain("[REDACTED]");
    }
  });

  test("Firebase session fields are redacted by name too, for the JSON that does name them", () => {
    for (const field of ["idToken", "refreshToken", "refresh_token", "id_token", "secretHash"]) {
      const out = redact(`{"${field}":"opaque-value-here"}`);
      expect(out).not.toContain("opaque-value-here");
    }
  });

  test("a passwordless sign-in code is redacted in a bare link", () => {
    // `oobCode` is a bearer credential for somebody's ACCOUNT for as long as Firebase honours it. It
    // arrives in a URL, which is exactly the shape undici puts into a failed-fetch message.
    const line = "sendOobCode failed: https://auth.strideterm.com/c?attempt=abc&oobCode=LIVE-SIGN-IN-CODE&mode=signIn";
    const out = redact(line);
    expect(out).not.toContain("LIVE-SIGN-IN-CODE");
    expect(out).toContain("[REDACTED]");
    // The path survives, because that is the part that makes the log useful.
    expect(out).toContain("/c?attempt=abc");
  });

  test("the code is redacted inside a URL-ENCODED continueUrl too", () => {
    // THE CASE A NAME-ONLY RULE MISSES. What arrives in the mail is Firebase's own action handler
    // with our URL nested inside it, percent-encoded — so the code appears twice, and the second copy
    // is not preceded by a bare `oobCode=` at all.
    const nested =
      "https://demo.firebaseapp.com/__/auth/action?mode=signIn&oobCode=OUTER-CODE-VALUE" +
      "&continueUrl=https%3A%2F%2Fauth.strideterm.com%2Fc%3Fattempt%3Dabc%26oobCode%3DINNER-CODE-VALUE&lang=en";
    const out = redact(`pasted link rejected: ${nested}`);
    expect(out).not.toContain("OUTER-CODE-VALUE");
    expect(out).not.toContain("INNER-CODE-VALUE");
    expect(out).toContain("[REDACTED]");
  });

  test("the claim secret is redacted wherever it appears", () => {
    for (const line of [
      '{"claimSecret":"NsdV0eXaMPLEsecretVALUE"}',
      "POST /claim?claimSecret=NsdV0eXaMPLEsecretVALUE",
      "encoded as claimSecret%3DNsdV0eXaMPLEsecretVALUE&next=1",
      '{"claimSecretHash":"NsdV0eXaMPLEsecretVALUE"}',
    ]) {
      const out = redact(line);
      expect(out, line).not.toContain("NsdV0eXaMPLEsecretVALUE");
      expect(out).toContain("[REDACTED]");
    }
  });

  test("a whole pasted sign-in link is redacted when it is logged as a JSON field", () => {
    // The manual fallback carries the entire link across one IPC hop. Nothing logs that payload — the
    // IPC wrapper carries an opId and no arguments — but the field name is covered anyway, because a
    // redactor that depends on nobody ever adding a log line is not a control.
    const out = redact('{"link":"https://auth.strideterm.com/c?attempt=abc&oobCode=WHOLE-LINK-CODE"}');
    expect(out).not.toContain("WHOLE-LINK-CODE");
  });

  test("non-secret content is left alone", () => {
    const safe = "starting workspace ws-1 with 3 panels and exit code 0";
    expect(redact(safe)).toBe(safe);
    // And the shape rule is a shape rule, not "anything long and base64-ish": a device id, a
    // fingerprint and an ordinary path must survive, or the logs stop being usable.
    const ordinary = "device e2e-mobile-device fingerprint AB12:CD34:EF56:7890 path v2/pairs/desktop-1/events";
    expect(redact(ordinary)).toBe(ordinary);
  });
});
