import { describe, expect, test } from "vitest";
import { isVerifiedSshTestExit, SshTestMarkerCapture } from "./ssh-test-marker.js";

describe("SshTestMarkerCapture", () => {
  const marker = "STRIDETERM_SSH_TEST_0123456789abcdef0123456789abcdef";

  test("recognizes a complete marker line split across output chunks", () => {
    const capture = new SshTestMarkerCapture(marker);
    expect(capture.append(`login banner\r\n${marker.slice(0, 20)}`)).toBe(false);
    expect(capture.append(marker.slice(20))).toBe(false);
    expect(capture.append("\r")).toBe(true);
  });

  test("requires a line ending and rejects a marker followed by a suffix", () => {
    const incomplete = new SshTestMarkerCapture(marker);
    expect(incomplete.append(marker)).toBe(false);
    expect(incomplete.append("-suffix\r\n")).toBe(false);

    const suffixed = new SshTestMarkerCapture(marker);
    expect(suffixed.append(`${marker}-suffix\r\n`)).toBe(false);
  });

  test("finds a complete marker after bounded output truncation", () => {
    const capture = new SshTestMarkerCapture(marker);
    expect(capture.append(`${"x".repeat(700)}\n${marker}\n`)).toBe(true);
  });

  test("requires both the marker and a zero process exit", () => {
    expect(isVerifiedSshTestExit(false, 0)).toBe(false);
    expect(isVerifiedSshTestExit(true, 1)).toBe(false);
    expect(isVerifiedSshTestExit(true, 255)).toBe(false);
    expect(isVerifiedSshTestExit(true, 0)).toBe(true);
  });
});
