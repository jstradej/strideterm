import { describe, test, expect } from "vitest";
import { parseCertificate } from "./ssh-cert.js";

const SAMPLE_CERT =
  "ssh-ed25519-cert-v01@openssh.com " +
  "AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAICTh+Ju4MDfN6EDRJu7JAT4RxKYs9jgyRWNCYxwXIxKa" +
  "AAAAIIacvjG+IMAsAstjo57RdPD8zHpMvU4pin+ahXSqATjCAAAAAAAAACoAAAABAAAAEGpkb2VAZXhhbXBsZS5jb20AAAA" +
  "QAAAABWFsaWNlAAAAA2JvYgAAAABpVarwAAAAAGs23nAAAAAAAAAAggAAABVwZXJtaXQtWDExLWZvcndhcmRpbmcAAAAAAA" +
  "AAF3Blcm1pdC1hZ2VudC1mb3J3YXJkaW5nAAAAAAAAABZwZXJtaXQtcG9ydC1mb3J3YXJkaW5nAAAAAAAAAApwZXJtaXQtc" +
  "HR5AAAAAAAAAA5wZXJtaXQtdXNlci1yYwAAAAAAAAAAAAAAMwAAAAtzc2gtZWQyNTUxOQAAACBAjddBQgwZfIIURxjBZv2v" +
  "ayqdTyc54bNSUxBNGQwg3gAAAFMAAAALc3NoLWVkMjU1MTkAAABAsakbG4HZsq0BfcWWrDsJZQIkPQxcRPpKDQAfYpKhxDt" +
  "rP9+gXpNxnZraf6z/+nCBr3IvT7xSvo1SKgSY+ZwiBg== test-user";

describe("parseCertificate", () => {
  test("returns {} for null", () => {
    expect(parseCertificate(null)).toEqual({});
  });

  test("returns {} for undefined", () => {
    expect(parseCertificate(undefined)).toEqual({});
  });

  test("returns {} for empty string", () => {
    expect(parseCertificate("")).toEqual({});
  });

  test("returns {} for non-string input", () => {
    expect(parseCertificate(123)).toEqual({});
    expect(parseCertificate({})).toEqual({});
    expect(parseCertificate([])).toEqual({});
  });

  test("returns {} when ssh2 rejects the blob", () => {
    expect(parseCertificate("not-a-real-cert-blob")).toEqual({});
  });

  test("surfaces the cert type for a valid ed25519 certificate", () => {
    const result = parseCertificate(SAMPLE_CERT);
    expect(result.type).toBe("ssh-ed25519-cert-v01@openssh.com");
    expect(Array.isArray(result.principals)).toBe(true);
    expect(Array.isArray(result.extensions)).toBe(true);
    expect(Array.isArray(result.criticalOptions)).toBe(true);
    expect(typeof result.keyIdString).toBe("string");
    expect(typeof result.serial).toBe("string");
    expect(typeof result.signatureKey).toBe("string");
  });

  test("tolerates leading/trailing whitespace around a valid cert", () => {
    const result = parseCertificate(`\n  ${SAMPLE_CERT}  \n`);
    expect(result.type).toBe("ssh-ed25519-cert-v01@openssh.com");
  });
});
