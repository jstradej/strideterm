import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getLogger } from "../logger.js";

const log = getLogger("ssh-keygen");

let keygenAvailable = null;

export async function detectSshKeygen() {
  if (keygenAvailable !== null) return keygenAvailable;
  keygenAvailable = await new Promise((resolve) => {
    execFile("ssh-keygen", ["-?"], { timeout: 3000 }, (err) => {
      resolve(!err || err.code === 1);
    });
  });
  log.info("ssh-keygen runtime", { available: keygenAvailable, platform: process.platform });
  return keygenAvailable;
}

export async function generateKey({ kind = "ed25519", comment = "", passphrase = "" }) {
  if (await detectSshKeygen()) {
    return generateViaKeygen({ kind, comment, passphrase });
  }
  log.warn("ssh-keygen missing, falling back to sshpk");
  return generateViaSshpk({ kind, comment, passphrase });
}

async function generateViaKeygen({ kind, comment, passphrase }) {
  const dir = await mkdtemp(path.join(tmpdir(), "strideterm-sshkey-"));
  const file = path.join(dir, "id");
  try {
    await new Promise((resolve, reject) => {
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

async function generateViaSshpk({ kind, comment, passphrase }) {
  const { generateKeyPairSync } = await import("node:crypto");
  const sshpk = await import("sshpk");

  const opts =
    kind === "ed25519"
      ? { type: "ed25519" }
      : kind === "rsa"
        ? { type: "rsa", modulusLength: 4096 }
        : { type: "ec", namedCurve: "prime256v1" };

  const { publicKey: pubRaw, privateKey: privRaw } = generateKeyPairSync(
    opts.type === "ed25519" ? "ed25519" : opts.type,
    opts.type === "rsa"
      ? { modulusLength: opts.modulusLength }
      : opts.type === "ec"
        ? { namedCurve: opts.namedCurve }
        : undefined,
  );

  const pubPem = pubRaw.export({ type: "spki", format: "pem" });
  const privPem = privRaw.export({
    type: opts.type === "rsa" ? "pkcs1" : "pkcs8",
    format: "pem",
    ...(passphrase ? { cipher: "aes-256-cbc", passphrase } : {}),
  });

  const parsedPub = sshpk.parseKey(pubPem, "pem");
  parsedPub.comment = comment;

  const parsedPriv = sshpk.parsePrivateKey(privPem, "pem", { passphrase });

  return {
    privateKey: parsedPriv.toString("ssh-private"),
    publicKey: parsedPub.toString("ssh"),
    source: "sshpk",
  };
}
