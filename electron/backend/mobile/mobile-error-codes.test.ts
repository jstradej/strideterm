import { describe, expect, it } from "vitest";
import { mobileErrorCode } from "./mobile-error-codes.js";
import { MobileFirebaseCallableError } from "./mobile-firebase-rest.js";

describe("mobileErrorCode", () => {
  it("maps undici's TLS failure to network:tls-untrusted", () => {
    const undiciTlsError = new TypeError("fetch failed", {
      cause: Object.assign(new Error("unable to get local issuer certificate"), {
        code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      }),
    });
    expect(mobileErrorCode(undiciTlsError)).toBe("network:tls-untrusted");
  });

  it("maps a ws-shaped refused connection to network:refused", () => {
    expect(mobileErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("network:refused");
  });

  it("keeps callable codes unchanged", () => {
    expect(mobileErrorCode(new MobileFirebaseCallableError("pairDevice", "permission-denied"))).toBe(
      "callable:pairDevice:permission-denied",
    );
  });

  it("keeps the class name for a non-network error", () => {
    expect(mobileErrorCode(new TypeError("not a function"))).toBe("TypeError");
    expect(mobileErrorCode(new TypeError("fetch failed"))).toBe("TypeError");
    expect(mobileErrorCode("boom")).toBe("non-error:string");
  });
});
