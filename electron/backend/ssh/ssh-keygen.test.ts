import { describe, expect, test, vi } from "vitest";

// Force detectSshKeygen() to resolve false (binary unavailable) so generateKey()
// always exercises the sshpk fallback path (generateViaSshpk). execFile is what
// detectSshKeygen calls; simulate an ENOENT-style failure, i.e. the binary isn't
// on PATH. spawn is stubbed too (generateViaKeygen's mechanism) — it must never
// be invoked once the fallback is selected.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: object, callback: (err: NodeJS.ErrnoException | null) => void) => {
      const err = new Error("spawn ssh-keygen ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      callback(err);
    },
  ),
  spawn: vi.fn(() => {
    throw new Error("spawn() should not be called when falling back to sshpk");
  }),
}));

vi.mock("../logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import * as sshpk from "sshpk";
import { generateKey } from "./ssh-keygen.js";

describe("generateKey sshpk fallback (ssh-keygen binary unavailable)", () => {
  test("ed25519 produces an ed25519 key", async () => {
    const result = await generateKey({ kind: "ed25519" });
    expect(result.source).toBe("sshpk");
    const pub = sshpk.parseKey(result.publicKey, "ssh");
    expect(pub.type).toBe("ed25519");
  });

  test("rsa produces an rsa key", async () => {
    const result = await generateKey({ kind: "rsa" });
    expect(result.source).toBe("sshpk");
    const pub = sshpk.parseKey(result.publicKey, "ssh");
    expect(pub.type).toBe("rsa");
  });

  test("ecdsa produces an actual ecdsa (P-256) key — regression test for the 'ec' vs 'ecdsa' branch bug", async () => {
    const result = await generateKey({ kind: "ecdsa" });
    expect(result.source).toBe("sshpk");
    const pub = sshpk.parseKey(result.publicKey, "ssh");
    expect(pub.type).toBe("ecdsa");
    expect(pub.curve).toBe("nistp256");
  });

  test("dsa throws an explicit error instead of silently generating a different key type", async () => {
    await expect(generateKey({ kind: "dsa" })).rejects.toThrow(
      "dsa requires the ssh-keygen binary — no pure-JS fallback is implemented",
    );
  });
});
