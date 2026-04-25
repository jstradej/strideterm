/// <reference types="node" />
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { APP_CONFIG } from "../../../config/app-config.js";

interface SecretEntry {
  value: string;
  updatedAt: string;
}

interface CredentialState {
  version: number;
  secrets: Record<string, SecretEntry>;
}

interface SafeStorage {
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isEncryptionAvailable?(): boolean;
}

interface SetSecretOptions {
  forcePlaintext?: boolean;
}

export interface CredentialStore {
  setSecret(ref: string, secret: string, opts?: SetSecretOptions): Promise<void>;
  getSecret(ref: string): string;
  hasSecret(ref: string): boolean;
  deleteSecret(ref: string): Promise<void>;
  listRefs(): string[];
}

function createDefaultState(): CredentialState {
  return {
    version: 1,
    secrets: {},
  };
}

function encodePlaintext(value: string): string {
  return `plain:${Buffer.from(String(value || ""), "utf8").toString("base64")}`;
}

function decodePlaintext(value: string): string {
  return Buffer.from(String(value || ""), "base64").toString("utf8");
}

function encodeEncrypted(value: string, safeStorage: SafeStorage): string {
  return `safe:${safeStorage.encryptString(String(value || "")).toString("base64")}`;
}

function decodeEncrypted(value: string, safeStorage: SafeStorage): string {
  return safeStorage.decryptString(Buffer.from(String(value || ""), "base64"));
}

function canEncrypt(safeStorage: SafeStorage | null): safeStorage is SafeStorage {
  return Boolean(
    safeStorage &&
    typeof safeStorage.encryptString === "function" &&
    typeof safeStorage.decryptString === "function" &&
    (typeof safeStorage.isEncryptionAvailable !== "function" || safeStorage.isEncryptionAvailable()),
  );
}

async function loadState(filePath: string): Promise<CredentialState> {
  if (!existsSync(filePath)) {
    return createDefaultState();
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { secrets?: unknown };
    return {
      version: 1,
      secrets:
        typeof parsed?.secrets === "object" && parsed.secrets
          ? (parsed.secrets as Record<string, SecretEntry>)
          : {},
    };
  } catch {
    return createDefaultState();
  }
}

export async function createCredentialStore(
  filePath: string,
  { safeStorage = null }: { safeStorage?: SafeStorage | null } = {},
): Promise<CredentialStore> {
  const state = await loadState(filePath);
  let pending: Promise<unknown> = Promise.resolve(undefined);

  async function persist(): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  }

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const next = pending.then(operation, operation);
    pending = next.catch(() => {});
    return next as Promise<void>;
  }

  function encode(value: string): string {
    return canEncrypt(safeStorage) ? encodeEncrypted(value, safeStorage) : encodePlaintext(value);
  }

  function decode(value: string): string {
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
    async setSecret(ref: string, secret: string, opts: SetSecretOptions = {}): Promise<void> {
      if (!ref) {
        throw new Error("Credential ref is required.");
      }
      if (
        !canEncrypt(safeStorage) &&
        (ref.startsWith("ssh:key:") || ref.startsWith("ssh:passphrase:") || ref.startsWith("ssh:password:"))
      ) {
        const requireEncrypted = typeof APP_CONFIG !== "undefined" ? APP_CONFIG.ssh.requireEncryptedStorage : true;
        if (requireEncrypted && !opts.forcePlaintext) {
          throw new Error("Secure storage is not available. Refusing to store SSH credentials in plaintext.");
        }
      }
      return enqueue(async () => {
        state.secrets[ref] = {
          value: encode(secret),
          updatedAt: new Date().toISOString(),
        };
        await persist();
      });
    },
    getSecret(ref: string): string {
      if (!ref || !state.secrets[ref]) {
        return "";
      }
      return decode(state.secrets[ref].value);
    },
    hasSecret(ref: string): boolean {
      return Boolean(ref && state.secrets[ref]);
    },
    async deleteSecret(ref: string): Promise<void> {
      if (!ref) {
        return;
      }
      return enqueue(async () => {
        delete state.secrets[ref];
        await persist();
      });
    },
    listRefs(): string[] {
      return Object.keys(state.secrets);
    },
  };
}
