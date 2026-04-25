import { resolveAgent } from "./ssh-agent.js";
import type { CredentialStore } from "../shared/credential-store.js";

interface HostAuth {
  methods?: string[];
  passwordRef?: string;
  keyRef?: string;
  passphraseRef?: string;
  certRef?: string;
  agent?: string;
}

interface HostLike {
  auth?: HostAuth;
}

export interface AuthConfig {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  publicKey?: string;
  agent?: string;
  tryKeyboard?: boolean;
}

/**
 * Build the ssh2 connection auth config from a host record. Multiple methods
 * can be active at once — ssh2 negotiates which the server actually wants:
 *   - password        → cfg.password
 *   - publickey       → cfg.privateKey (+ optional passphrase) [+ cfg.publicKey for cert]
 *   - agent           → cfg.agent (socket path or "pageant")
 *   - keyboard-int.   → cfg.tryKeyboard = true (client-side opts in)
 *
 * Missing credentials for a selected method are simply skipped — we don't
 * block the whole connect, since the user may have overlapping methods like
 * agent + keyboard-interactive.
 */
export async function buildAuth(host: HostLike, credentialStore: CredentialStore): Promise<AuthConfig> {
  const methods = host.auth?.methods || ["publickey"];
  const cfg: AuthConfig = {};

  for (const method of methods) {
    if (method === "password") {
      if (host.auth?.passwordRef) {
        cfg.password = credentialStore.getSecret(host.auth.passwordRef);
      } else {
        // No stored password → fall through to interactive prompt. Older host
        // records (and the now-retired "Password" UI checkbox) could save
        // methods:["password"] with no passwordRef, which previously produced
        // a silent auth failure. Treat that as "prompt me".
        cfg.tryKeyboard = true;
      }
    }

    if (method === "publickey" && host.auth?.keyRef) {
      const priv = credentialStore.getSecret(host.auth.keyRef);
      if (priv) {
        cfg.privateKey = priv;
        // Explicit passphraseRef wins; otherwise fall back to the derived
        // "ssh:passphrase:<keyRef>" ref set at import time. Users don't have
        // to wire this through the host editor — if the key was imported
        // with a passphrase we already know where to find it.
        const passRef = host.auth.passphraseRef || `ssh:passphrase:${host.auth.keyRef}`;
        if (credentialStore.hasSecret(passRef)) {
          const pass = credentialStore.getSecret(passRef);
          if (pass) cfg.passphrase = pass;
        }
        if (host.auth.certRef) {
          const cert = credentialStore.getSecret(host.auth.certRef);
          if (cert) cfg.publicKey = cert;
        }
      }
    }

    if (method === "agent") {
      const agentPath = await resolveAgent(host.auth?.agent || "auto");
      if (agentPath) cfg.agent = agentPath;
    }

    if (method === "keyboard-interactive") {
      cfg.tryKeyboard = true;
    }
  }

  return cfg;
}
