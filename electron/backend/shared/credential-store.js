import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

function createDefaultState() {
  return {
    version: 1,
    secrets: {},
  };
}

function encodePlaintext(value) {
  return `plain:${Buffer.from(String(value || ""), "utf8").toString("base64")}`;
}

function decodePlaintext(value) {
  return Buffer.from(String(value || ""), "base64").toString("utf8");
}

function encodeEncrypted(value, safeStorage) {
  return `safe:${safeStorage.encryptString(String(value || "")).toString("base64")}`;
}

function decodeEncrypted(value, safeStorage) {
  return safeStorage.decryptString(Buffer.from(String(value || ""), "base64"));
}

function canEncrypt(safeStorage) {
  return Boolean(
    safeStorage &&
    typeof safeStorage.encryptString === "function" &&
    typeof safeStorage.decryptString === "function" &&
    (typeof safeStorage.isEncryptionAvailable !== "function" || safeStorage.isEncryptionAvailable()),
  );
}

async function loadState(filePath) {
  if (!existsSync(filePath)) {
    return createDefaultState();
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      secrets: typeof parsed?.secrets === "object" && parsed.secrets ? parsed.secrets : {},
    };
  } catch {
    return createDefaultState();
  }
}

export async function createCredentialStore(filePath, { safeStorage = null } = {}) {
  const state = await loadState(filePath);
  let pending = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  }

  function enqueue(operation) {
    const next = pending.then(operation, operation);
    pending = next.catch(() => {});
    return next;
  }

  function encode(value) {
    return canEncrypt(safeStorage) ? encodeEncrypted(value, safeStorage) : encodePlaintext(value);
  }

  function decode(value) {
    const raw = String(value || "");
    if (raw.startsWith("safe:")) {
      if (!canEncrypt(safeStorage)) {
        return "";
      }
      return decodeEncrypted(raw.slice(5), safeStorage);
    }
    if (raw.startsWith("plain:")) {
      return decodePlaintext(raw.slice(6));
    }
    return "";
  }

  await persist();

  return {
    async setSecret(ref, secret) {
      if (!ref) {
        throw new Error("Credential ref is required.");
      }
      return enqueue(async () => {
        state.secrets[ref] = {
          value: encode(secret),
          updatedAt: new Date().toISOString(),
        };
        await persist();
      });
    },
    getSecret(ref) {
      if (!ref || !state.secrets[ref]) {
        return "";
      }
      return decode(state.secrets[ref].value);
    },
    hasSecret(ref) {
      return Boolean(ref && state.secrets[ref]);
    },
    async deleteSecret(ref) {
      if (!ref) {
        return;
      }
      return enqueue(async () => {
        delete state.secrets[ref];
        await persist();
      });
    },
    listRefs() {
      return Object.keys(state.secrets);
    },
  };
}
