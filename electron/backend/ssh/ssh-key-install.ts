import path from "node:path";
import ssh2 from "ssh2";
import type { SFTPWrapper, Stats } from "ssh2";

const { utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
const MAX_AUTHORIZED_KEYS_BYTES = 1024 * 1024;
const SSH_DIRECTORY_MODE = 0o700;
const AUTHORIZED_KEYS_MODE = 0o600;

interface ParsedPublicKeyLine {
  type: string;
  data: string;
  line: string;
}

export interface DerivedPublicKeyLine {
  type: string;
  data: string;
  line: string;
}

export function derivePublicKeyLine(privateKey: string, passphrase?: string): DerivedPublicKeyLine {
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) {
    throw new Error("The selected managed key is invalid or its passphrase is incorrect.");
  }
  const type = parsed.type;
  const data = parsed.getPublicSSH().toString("base64");
  const comment = parsed.comment?.trim();
  return { type, data, line: `${type} ${data}${comment ? ` ${comment}` : ""}` };
}

export interface InstallPublicKeyOptions {
  shouldContinue?: () => boolean;
  onWriteAttempt?: () => void;
  onPublicKeyPresent?: (alreadyInstalled: boolean) => void;
}

export async function installPublicKey(
  sftp: SFTPWrapper,
  publicLine: string,
  { shouldContinue = () => true, onWriteAttempt, onPublicKeyPresent }: InstallPublicKeyOptions = {},
): Promise<{ alreadyInstalled: boolean }> {
  const key = parsePublicKeyLine(publicLine);
  const home = await call<string>((done) => sftp.realpath(".", done));
  if (!home.startsWith("/") || home.includes("\0") || path.posix.normalize(home) !== home) {
    throw new Error("The SSH server returned an invalid home path.");
  }
  const sshDirectory = path.posix.join(home, ".ssh");

  let directoryStats = await statOrMissing(sftp, sshDirectory);
  if (!directoryStats) {
    ensureActive(shouldContinue);
    try {
      await call<void>((done) => sftp.mkdir(sshDirectory, { mode: SSH_DIRECTORY_MODE }, done));
    } catch (error) {
      if (!isExistsError(error)) {
        const racedDirectory = await statOrMissing(sftp, sshDirectory);
        if (!racedDirectory) throw error;
        directoryStats = racedDirectory;
      }
    }
    directoryStats ??= await statOrMissing(sftp, sshDirectory);
  }
  assertRegularDirectory(directoryStats, ".ssh");

  const authorizedKeys = path.posix.join(sshDirectory, "authorized_keys");
  const fileStats = await statOrMissing(sftp, authorizedKeys);
  if (fileStats) assertRegularFile(fileStats, "authorized_keys");
  const current = fileStats ? await readBoundedFile(sftp, authorizedKeys, fileStats) : Buffer.alloc(0);
  if (containsKey(current, key)) {
    onPublicKeyPresent?.(true);
    ensureActive(shouldContinue);
    await call<void>((done) => sftp.chmod(sshDirectory, SSH_DIRECTORY_MODE, done));
    ensureActive(shouldContinue);
    await call<void>((done) => sftp.chmod(authorizedKeys, AUTHORIZED_KEYS_MODE, done));
    return { alreadyInstalled: true };
  }

  ensureActive(shouldContinue);
  await call<void>((done) => sftp.chmod(sshDirectory, SSH_DIRECTORY_MODE, done));
  const keyBytes = Buffer.from(`${key.line}\n`, "utf8");
  const makeAppend = (contents: Buffer): Buffer =>
    Buffer.concat([contents.length > 0 && contents.at(-1) !== 0x0a ? Buffer.from("\n") : Buffer.alloc(0), keyBytes]);
  const append = makeAppend(current);
  if (current.length + append.length > MAX_AUTHORIZED_KEYS_BYTES) {
    throw new Error("The remote authorized_keys file is larger than the 1 MiB safety limit.");
  }

  ensureActive(shouldContinue);
  if (fileStats) {
    const latestStats = await statOrMissing(sftp, authorizedKeys);
    assertRegularFile(latestStats, "authorized_keys");
    const latest = await readBoundedFile(sftp, authorizedKeys, latestStats);
    if (containsKey(latest, key)) {
      onPublicKeyPresent?.(true);
      ensureActive(shouldContinue);
      await call<void>((done) => sftp.chmod(authorizedKeys, AUTHORIZED_KEYS_MODE, done));
      return { alreadyInstalled: true };
    }
    const latestAppend = makeAppend(latest);
    if (latest.length + latestAppend.length > MAX_AUTHORIZED_KEYS_BYTES) {
      throw new Error("The remote authorized_keys file is larger than the 1 MiB safety limit.");
    }
    ensureActive(shouldContinue);
    onWriteAttempt?.();
    await call<void>((done) => sftp.appendFile(authorizedKeys, latestAppend, { mode: AUTHORIZED_KEYS_MODE }, done));
    onPublicKeyPresent?.(false);
  } else {
    ensureActive(shouldContinue);
    onWriteAttempt?.();
    let createFailed = false;
    try {
      await call<void>((done) =>
        sftp.writeFile(authorizedKeys, append, { mode: AUTHORIZED_KEYS_MODE, flag: "wx" }, done),
      );
      onPublicKeyPresent?.(false);
    } catch (error) {
      if (!isExistsError(error)) {
        const racedStats = await statOrMissing(sftp, authorizedKeys);
        if (!racedStats) throw error;
      }
      createFailed = true;
    }
    if (createFailed) {
      const racedStats = await statOrMissing(sftp, authorizedKeys);
      assertRegularFile(racedStats, "authorized_keys");
      const racedContents = await readBoundedFile(sftp, authorizedKeys, racedStats);
      if (containsKey(racedContents, key)) {
        onPublicKeyPresent?.(true);
        ensureActive(shouldContinue);
        await call<void>((done) => sftp.chmod(authorizedKeys, AUTHORIZED_KEYS_MODE, done));
        return { alreadyInstalled: true };
      }
      const racedAppend = makeAppend(racedContents);
      if (racedContents.length + racedAppend.length > MAX_AUTHORIZED_KEYS_BYTES) {
        throw new Error("The remote authorized_keys file is larger than the 1 MiB safety limit.");
      }
      ensureActive(shouldContinue);
      onWriteAttempt?.();
      await call<void>((done) => sftp.appendFile(authorizedKeys, racedAppend, { mode: AUTHORIZED_KEYS_MODE }, done));
      onPublicKeyPresent?.(false);
    }
  }

  ensureActive(shouldContinue);
  const finalStats = await statOrMissing(sftp, authorizedKeys);
  assertRegularFile(finalStats, "authorized_keys");
  ensureActive(shouldContinue);
  await call<void>((done) => sftp.chmod(authorizedKeys, AUTHORIZED_KEYS_MODE, done));
  return { alreadyInstalled: false };
}

function parsePublicKeyLine(publicLine: string): ParsedPublicKeyLine {
  if (/[\u0000\r\n]/.test(publicLine)) throw new Error("The selected public key must be exactly one line.");
  const fields = publicLine.trim().split(/\s+/);
  if (fields.length < 2) throw new Error("The selected public key line is invalid.");
  const parsed = utils.parseKey(`${fields[0]} ${fields[1]}`);
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.isPrivateKey()) {
    throw new Error("The selected public key line is invalid.");
  }
  const type = parsed.type;
  const data = parsed.getPublicSSH().toString("base64");
  const comment = fields.slice(2).join(" ");
  return { type, data, line: `${type} ${data}${comment ? ` ${comment}` : ""}` };
}

function containsKey(contents: Buffer, key: ParsedPublicKeyLine): boolean {
  return contents
    .toString("utf8")
    .split("\n")
    .some((line) => {
      const fields = tokenizeAuthorizedKeyLine(line);
      if (fields.length < 2) return false;
      const first = fields.at(0);
      const second = fields.at(1);
      const keyIndex = first && isKeyType(first) ? 0 : second && isKeyType(second) ? 1 : -1;
      return keyIndex >= 0 && fields.at(keyIndex) === key.type && fields.at(keyIndex + 1) === key.data;
    });
}

function tokenizeAuthorizedKeyLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return [];
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      token += char;
      escaped = false;
    } else if (quoted && char === "\\") {
      token += char;
      escaped = true;
    } else if (char === '"') {
      token += char;
      quoted = !quoted;
    } else if (/\s/.test(char) && !quoted) {
      if (token) tokens.push(token);
      token = "";
    } else {
      token += char;
    }
  }
  if (quoted || escaped) return [];
  if (token) tokens.push(token);
  return tokens;
}

function isKeyType(value: string): boolean {
  return /^(?:ssh-|ecdsa-sha2-|sk-)/.test(value);
}

async function statOrMissing(sftp: SFTPWrapper, remotePath: string): Promise<Stats | undefined> {
  try {
    return await call<Stats>((done) => sftp.lstat(remotePath, done));
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

async function readBoundedFile(sftp: SFTPWrapper, remotePath: string, stats: Stats): Promise<Buffer> {
  if (stats.size > MAX_AUTHORIZED_KEYS_BYTES) {
    throw new Error("The remote authorized_keys file is larger than the 1 MiB safety limit.");
  }
  const handle = await call<Buffer>((done) => sftp.open(remotePath, OPEN_MODE.READ, done));
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= MAX_AUTHORIZED_KEYS_BYTES) {
      const length = Math.min(32 * 1024, MAX_AUTHORIZED_KEYS_BYTES + 1 - total);
      const buffer = Buffer.alloc(length);
      const result = await new Promise<{ bytesRead: number }>((resolve, reject) => {
        sftp.read(handle, buffer, 0, length, total, (error, bytesRead) => {
          if (error) {
            const code = (error as Error & { code?: string | number }).code;
            if (code === STATUS_CODE.EOF || /end of file|eof/i.test(error.message)) resolve({ bytesRead: 0 });
            else reject(error);
          } else resolve({ bytesRead });
        });
      });
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      total += result.bytesRead;
      if (total > MAX_AUTHORIZED_KEYS_BYTES) {
        throw new Error("The remote authorized_keys file is larger than the 1 MiB safety limit.");
      }
    }
  } finally {
    await call<void>((done) => sftp.close(handle, done));
  }
  return Buffer.concat(chunks, total);
}

function assertRegularDirectory(stats: Stats | undefined, label: string): asserts stats is Stats {
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Remote ${label} is not a regular directory; refusing to follow it.`);
  }
}

function assertRegularFile(stats: Stats | undefined, label: string): asserts stats is Stats {
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Remote ${label} is not a regular file; refusing to overwrite or follow it.`);
  }
}

function ensureActive(shouldContinue: () => boolean): void {
  if (!shouldContinue()) throw new Error("Public-key transfer was cancelled.");
}

function isMissingFileError(error: unknown): boolean {
  const value = error as { code?: string | number; message?: string };
  return value?.code === 2 || value?.code === "ENOENT" || /no such file or directory/i.test(value?.message || "");
}

function isExistsError(error: unknown): boolean {
  const value = error as { code?: string | number; message?: string };
  return value?.code === 11 || value?.code === "EEXIST" || /already exists/i.test(value?.message || "");
}

function call<T>(start: (_callback: (_error: Error | null | undefined, _value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    start((_error, _value) => (_error ? reject(_error) : resolve(_value)));
  });
}
