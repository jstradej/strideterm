/// <reference types="node" />
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getLogger } from "../logger.js";

const log = getLogger("ssh-keygen");

let keygenAvailable: boolean | null = null;

export interface GeneratedKey {
  privateKey: string;
  publicKey: string;
  source: "ssh-keygen" | "sshpk";
}

export async function detectSshKeygen(): Promise<boolean> {
  if (keygenAvailable !== null) return keygenAvailable;
  keygenAvailable = await new Promise<boolean>((resolve) => {
    execFile("ssh-keygen", ["-?"], { timeout: 3000 }, (err) => {
      // err.code is string|number|null for ExecFileException; exit code 1 means
      // the binary exists but printed usage (normal for ssh-keygen -?).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve(!err || (err as any).code === 1);
    });
  });
  log.info("ssh-keygen runtime", { available: keygenAvailable, platform: process.platform });
  return keygenAvailable;
}

export async function generateKey({
  kind = "ed25519",
  comment = "",
  passphrase = "",
}: { kind?: string; comment?: string; passphrase?: string } = {}): Promise<GeneratedKey> {
  if (await detectSshKeygen()) {
    return generateViaKeygen({ kind, comment, passphrase });
  }
  log.warn("ssh-keygen missing, falling back to sshpk");
  return generateViaSshpk({ kind, comment, passphrase });
}

async function generateViaKeygen({
  kind,
  comment,
  passphrase,
}: {
  kind: string;
  comment: string;
  passphrase: string;
}): Promise<GeneratedKey> {
  const dir = await mkdtemp(path.join(tmpdir(), "strideterm-sshkey-"));
  const file = path.join(dir, "id");
  try {
    await new Promise<void>((resolve, reject) => {
      const args = ["-t", kind, "-f", file, "-N", passphrase, "-C", comment, "-q"];
      const proc = spawn("ssh-keygen", args, { stdio: "ignore" });
      proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ssh-keygen exit ${code}`))));
      proc.on("error", reject);
    });
    const privateKey = await readFile(file, "utf8");
    const publicKey = await readFile(file + ".pub", "utf8");
    return { privateKey, publicKey, source: "ssh-keygen" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function generateViaSshpk({
  kind,
  comment,
  passphrase,
}: {
  kind: string;
  comment: string;
  passphrase: string;
}): Promise<GeneratedKey> {
  const { generateKeyPairSync } = await import("node:crypto");
  const sshpk = await import("sshpk");

  // generateKeyPairSync is heavily overloaded; cast the result to avoid union
  // type narrowing issues while keeping correct runtime behaviour.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pair: any;
  if (kind === "rsa") {
    pair = generateKeyPairSync("rsa", { modulusLength: 4096 });
  } else if (kind === "ec") {
    pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  } else {
    pair = generateKeyPairSync("ed25519");
  }

  const { publicKey: pubRaw, privateKey: privRaw } = pair as {
    publicKey: { export(opts: object): string };
    privateKey: { export(opts: object): string };
  };

  const pubPem = pubRaw.export({ type: "spki", format: "pem" });
  const privKeyType = kind === "rsa" ? "pkcs1" : "pkcs8";
  const privPem = privRaw.export({
    type: privKeyType,
    format: "pem",
    ...(passphrase ? { cipher: "aes-256-cbc", passphrase } : {}),
  });

  const parsedPub = sshpk.parseKey(pubPem as string, "pem");
  parsedPub.comment = comment;

  const parsedPriv = sshpk.parsePrivateKey(privPem as string, "pem", { passphrase: passphrase || undefined });

  return {
    privateKey: parsedPriv.toString("ssh-private"),
    publicKey: parsedPub.toString("ssh"),
    source: "sshpk",
  };
}
