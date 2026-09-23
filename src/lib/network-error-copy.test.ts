import { describe, expect, it } from "vitest";
import { describeNetworkErrorCode, NETWORK_TLS_UNTRUSTED_COPY } from "./network-error-copy.js";

describe("describeNetworkErrorCode", () => {
  it("maps every network kind to a text", () => {
    expect(describeNetworkErrorCode("network:tls-untrusted")).toBe(NETWORK_TLS_UNTRUSTED_COPY);
    expect(describeNetworkErrorCode("network:tls-other")).toMatch(/system clock/);
    for (const kind of ["dns", "refused", "timeout", "reset"]) {
      expect(describeNetworkErrorCode(`network:${kind}`)).toMatch(/No internet connection/);
    }
  });

  it("returns null for anything else", () => {
    expect(describeNetworkErrorCode("TypeError")).toBeNull();
    expect(describeNetworkErrorCode("network:other")).toBeNull();
    expect(describeNetworkErrorCode("")).toBeNull();
    expect(describeNetworkErrorCode(null)).toBeNull();
  });

  it("names no OS or security product", () => {
    const all = ["tls-untrusted", "tls-other", "dns"].map((k) => describeNetworkErrorCode(`network:${k}`)).join(" ");
    expect(all).not.toMatch(/Windows|macOS|Linux|ESET|Defender|Zscaler|Netskope/);
  });
});
