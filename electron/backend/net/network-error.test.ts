import { describe, expect, it } from "vitest";
import { classifyNetworkError, type NetworkFailureKind } from "./network-error.js";

const CASES: Array<[string, NetworkFailureKind]> = [
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls-untrusted"],
  ["UNABLE_TO_GET_ISSUER_CERT", "tls-untrusted"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "tls-untrusted"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls-untrusted"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls-untrusted"],
  ["CERT_UNTRUSTED", "tls-untrusted"],
  ["CERT_HAS_EXPIRED", "tls-other"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "tls-other"],
  ["CERT_NOT_YET_VALID", "tls-other"],
  ["ERR_TLS_HANDSHAKE_TIMEOUT", "tls-other"],
  ["ERR_SSL_WRONG_VERSION_NUMBER", "tls-other"],
  ["ENOTFOUND", "dns"],
  ["EAI_AGAIN", "dns"],
  ["ECONNREFUSED", "refused"],
  ["ETIMEDOUT", "timeout"],
  ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
  ["ECONNRESET", "reset"],
  ["EPIPE", "reset"],
  ["UND_ERR_SOCKET", "reset"],
];

const withCode = (code: string) => Object.assign(new Error(), { code });

describe("classifyNetworkError", () => {
  describe.each(CASES)("%s", (code, kind) => {
    it("ws shape (code on the error)", () => {
      expect(classifyNetworkError(withCode(code))).toBe(kind);
    });
    it("undici shape (TypeError with cause)", () => {
      expect(classifyNetworkError(new TypeError("fetch failed", { cause: withCode(code) }))).toBe(kind);
    });
    it("double-wrapped cause.cause", () => {
      const inner = new Error("wrapper", { cause: withCode(code) });
      expect(classifyNetworkError(new TypeError("fetch failed", { cause: inner }))).toBe(kind);
    });
  });

  it("an AbortError from our own timeout is a timeout", () => {
    expect(classifyNetworkError(new DOMException("aborted", "AbortError"))).toBe("timeout");
  });

  it("returns null for non-network values", () => {
    expect(classifyNetworkError(new Error("x"))).toBeNull();
    expect(classifyNetworkError("string")).toBeNull();
    expect(classifyNetworkError(undefined)).toBeNull();
    expect(classifyNetworkError(withCode("ENOENT"))).toBeNull();
  });

  it("bounds the depth on a cyclic cause", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(classifyNetworkError(a)).toBeNull();
  });

  it("does not look deeper than 4 causes", () => {
    let err: unknown = withCode("ECONNREFUSED");
    for (let i = 0; i < 5; i++) err = new Error("wrap", { cause: err });
    expect(classifyNetworkError(err)).toBeNull();
    let shallow: unknown = withCode("ECONNREFUSED");
    for (let i = 0; i < 4; i++) shallow = new Error("wrap", { cause: shallow });
    expect(classifyNetworkError(shallow)).toBe("refused");
  });
});
