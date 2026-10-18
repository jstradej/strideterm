import { describe, expect, it } from "vitest";
import { userFacingMessage } from "./error-message.js";

describe("userFacingMessage", () => {
  it("uses process output and nested causes from structured failures", () => {
    expect(
      userFacingMessage({
        error: { cause: { stderr: "fatal: repository is locked\n" } },
      }),
    ).toBe("fatal: repository is locked");
  });

  it("uses the fallback for empty process output", () => {
    expect(userFacingMessage({ stderr: "", stdout: "  " }, "Operation failed")).toBe("Operation failed");
  });

  it("strips Electron's IPC wrapper while retaining the underlying reason", () => {
    expect(
      userFacingMessage(new Error("Error invoking remote method 'git:fetch': Error: fatal: repository is locked")),
    ).toBe("fatal: repository is locked");
  });
});
