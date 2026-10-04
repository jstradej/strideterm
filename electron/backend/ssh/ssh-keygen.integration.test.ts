import { describe, expect, test } from "vitest";
import ssh2 from "ssh2";
import { detectSshKeygen, generateKey } from "./ssh-keygen.js";

const { utils } = ssh2;

const keygenAvailable = await detectSshKeygen();

describe.skipIf(!keygenAvailable)("generateKey with the native ssh-keygen", () => {
  test.each(["ed25519", "ecdsa", "rsa"] as const)("generates a compatible encrypted %s key", async (kind) => {
    const passphrase = "test passphrase";
    const generated = await generateKey({ kind, passphrase });

    expect(generated.source).toBe("ssh-keygen");
    expect(utils.parseKey(generated.privateKey)).toBeInstanceOf(Error);

    const privateKey = utils.parseKey(generated.privateKey, passphrase);
    const publicKey = utils.parseKey(generated.publicKey);
    expect(privateKey).not.toBeInstanceOf(Error);
    expect(publicKey).not.toBeInstanceOf(Error);
    if (privateKey instanceof Error || publicKey instanceof Error) return;
    expect(privateKey.getPublicSSH()).toEqual(publicKey.getPublicSSH());
  });
});
