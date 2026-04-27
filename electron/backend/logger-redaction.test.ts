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

  test("non-secret content is left alone", () => {
    const safe = "starting workspace ws-1 with 3 panels and exit code 0";
    expect(redact(safe)).toBe(safe);
  });
});
