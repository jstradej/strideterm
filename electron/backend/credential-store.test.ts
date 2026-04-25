import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createCredentialStore } from "./credential-store.js";

const tempPaths = [];

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
      encryptString(value) {
        return Buffer.from(`encrypted:${value}`, "utf8");
      },
      decryptString(value) {
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
