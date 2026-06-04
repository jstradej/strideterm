/// <reference types="node" />
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { APP_CONFIG } from "../../../config/app-config.js";
import { getLogger } from "../logger.js";
import { renameWithRetries, writeFileDurable } from "./fs-durable.js";

const log = getLogger("credential-store");

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
  /**
   * Reports whether the OS keychain (Electron `safeStorage`) is available
   * for actual encryption. When false, secrets are persisted as base64
   * plaintext on disk (with a warning logged once per process). The
   * renderer surfaces this in the Settings UI so the operator sees the
   * downgrade rather than discovering it after a credentials.json leak.
   *
   * On Linux: false typically means libsecret/gnome-keyring is missing.
   * On macOS/Windows: false typically means Electron is running headless
   * without a desktop session attached.
   */
  isEncryptionAvailable(): boolean;
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
        typeof parsed?.secrets === "object" && parsed.secrets ? (parsed.secrets as Record<string, SecretEntry>) : {},
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
  let warnedAboutPlaintext = false;

  async function atomicWrite(): Promise<void> {
    const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    // mode 0o600 (set by writeFileDurable): credentials.json contains user
    // secrets (PATs, OAuth tokens, SSH key passphrases). Without an explicit
    // mode the default umask leaves it world-readable on shared Linux/macOS
    // hosts. Windows ignores `mode`, so this is safe everywhere. The durable
    // write (fsync) + rename retry match the state store: a crash mid-write
    // or a Windows AV/indexer holding the file must not truncate secrets.
    await writeFileDurable(tmpPath, JSON.stringify(state, null, 2));
    await renameWithRetries(tmpPath, filePath);
    // Belt-and-suspenders: rename preserves the source mode but if the file
    // already existed the kernel may keep the previous mode bits. chmod
    // explicitly so a permissive ancestor file can't lock us into 0644.
    await fs.chmod(filePath, 0o600).catch(() => {});
  }

  async function persist(): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Ensure the file exists before locking (proper-lockfile requires target to exist)
    if (!existsSync(filePath)) {
      await atomicWrite();
      return;
    }
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(filePath, {
        retries: { retries: 10, minTimeout: 100, maxTimeout: 500 },
        stale: 10000,
        realpath: false,
      });
      await atomicWrite();
    } catch (error) {
      // fail-soft: still write if lock acquisition fails
      log.warn("credential file lock failed, writing without lock", { err: (error as Error).message });
      await atomicWrite();
    } finally {
      await release?.().catch(() => {});
    }
  }

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const next = pending.then(operation, operation);
    pending = next.catch(() => {});
    return next as Promise<void>;
  }

  function encode(value: string): string {
    if (canEncrypt(safeStorage)) {
      return encodeEncrypted(value, safeStorage);
    }
    // Falling back to base64-on-disk is *not* encryption — anyone who can
    // read the credentials file gets every secret. We allow it (the store
    // would otherwise be useless on systems without OS keychain support)
    // but the operator must know about it. Emit a one-shot warning per
    // process so they cannot miss the downgrade in their logs.
    if (!warnedAboutPlaintext) {
      warnedAboutPlaintext = true;
      log.warn(
        "secure storage unavailable — credentials are being stored as base64 plaintext on disk. " +
          "Anyone with read access to the credentials file can recover the secrets. " +
          "On Linux this usually means installing libsecret/gnome-keyring; on macOS/Windows " +
          "it means launching strideterm with the desktop session loaded.",
      );
    }
    return encodePlaintext(value);
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
    isEncryptionAvailable(): boolean {
      return canEncrypt(safeStorage);
    },
  };
}
