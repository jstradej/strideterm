import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createCredentialStore, refusesPlaintextStorage } from "./credential-store.js";
import { REMOTE_ACCESS_TOKEN_REF } from "./connection-secret.js";

const tempPaths: string[] = [];

async function createTempPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-credentials-"));
  tempPaths.push(directory);
  return path.join(directory, "credentials.json");
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((targetPath) => fs.rm(targetPath, { recursive: true, force: true })));
});

describe("credential store", () => {
  test("stores plaintext secrets when safe storage is unavailable", async () => {
    const store = await createCredentialStore(await createTempPath());

    await store.setSecret("cred-1", "super-secret");

    expect(store.getSecret("cred-1")).toBe("super-secret");
    expect(store.hasSecret("cred-1")).toBe(true);
  });

  test("uses safe storage when encryption is available", async () => {
    const safeStorage = {
      isEncryptionAvailable() {
        return true;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      encryptString(value: any) {
        return Buffer.from(`encrypted:${value}`, "utf8");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decryptString(value: any) {
        return Buffer.from(value)
          .toString("utf8")
          .replace(/^encrypted:/, "");
      },
    };
    const filePath = await createTempPath();
    const store = await createCredentialStore(filePath, { safeStorage });

    await store.setSecret("cred-1", "token-123");

    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).toContain("safe:");
    expect(raw).not.toContain("token-123");
    expect(store.getSecret("cred-1")).toBe("token-123");
  });

  test("deletes stored refs", async () => {
    const store = await createCredentialStore(await createTempPath());

    await store.setSecret("cred-1", "token-123");
    await store.deleteSecret("cred-1");

    expect(store.getSecret("cred-1")).toBe("");
    expect(store.listRefs()).toEqual([]);
  });
});

describe("Mobile integration keys never fall back to plaintext (E2E 3.11)", () => {
  const encrypting = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
  };

  test.each([
    "mobile:desktop-device-private-key",
    "mobile:firebase-refresh-token",
    "mobile:relay-installation-private-key",
  ])("%s is refused without secure storage, and nothing is written", async (ref) => {
    const filePath = await createTempPath();
    const store = await createCredentialStore(filePath);
    await expect(store.setSecret(ref, "KEY-MATERIAL")).rejects.toThrow(/Secure storage is not available/);
    expect(store.hasSecret(ref)).toBe(false);
    expect(await fs.readFile(filePath, "utf8")).not.toContain(Buffer.from("KEY-MATERIAL").toString("base64"));
  });

  test("an explicit forcePlaintext does not unlock it", async () => {
    const store = await createCredentialStore(await createTempPath());
    await expect(
      store.setSecret("mobile:desktop-device-private-key", "KEY-MATERIAL", { forcePlaintext: true }),
    ).rejects.toThrow(/Secure storage is not available/);
  });

  test("the same refs are stored encrypted when secure storage is available", async () => {
    const filePath = await createTempPath();
    const store = await createCredentialStore(filePath, { safeStorage: encrypting });
    await store.setSecret("mobile:desktop-device-private-key", "KEY-MATERIAL");
    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).toContain("safe:");
    expect(raw).not.toContain("KEY-MATERIAL");
    expect(store.getSecret("mobile:desktop-device-private-key")).toBe("KEY-MATERIAL");
  });

  test("the non-secret markers account sign-in writes still work on a machine with no keyring", async () => {
    const store = await createCredentialStore(await createTempPath());
    for (const ref of ["mobile:desktop-device-id", "mobile:account-binding", "mobile:relay-registration-configured"]) {
      await store.setSecret(ref, "marker");
      expect(store.getSecret(ref)).toBe("marker");
    }
  });

  test("a mobile key an earlier build left as plaintext is re-encrypted as soon as encryption is available", async () => {
    const filePath = await createTempPath();
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        secrets: {
          "mobile:desktop-device-private-key": {
            value: `plain:${Buffer.from("OLD-PLAINTEXT-KEY").toString("base64")}`,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          "cred-1": { value: `plain:${Buffer.from("pat").toString("base64")}`, updatedAt: "2026-01-01T00:00:00.000Z" },
        },
      }),
    );
    const store = await createCredentialStore(filePath, { safeStorage: encrypting });
    expect(store.getSecret("mobile:desktop-device-private-key")).toBe("OLD-PLAINTEXT-KEY");
    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).not.toContain(Buffer.from("OLD-PLAINTEXT-KEY").toString("base64"));
    // Only the mobile secret is touched; an ordinary credential keeps its own rules.
    expect(raw).toContain(Buffer.from("pat").toString("base64"));
  });
});

describe("remote-access master token", () => {
  test("is not a ref that refuses plaintext storage", () => {
    expect(REMOTE_ACCESS_TOKEN_REF).toBe("remote:access-token");
    expect(refusesPlaintextStorage(REMOTE_ACCESS_TOKEN_REF)).toBe(false);
  });

  test("falls back to a plain: value without secure storage and reads back", async () => {
    const filePath = await createTempPath();
    const store = await createCredentialStore(filePath);
    await store.setSecret(REMOTE_ACCESS_TOKEN_REF, "master-token");
    expect(store.getSecret(REMOTE_ACCESS_TOKEN_REF)).toBe("master-token");
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(raw.secrets[REMOTE_ACCESS_TOKEN_REF].value).toMatch(/^plain:/);
  });
});
