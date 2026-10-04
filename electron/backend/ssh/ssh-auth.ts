import { resolveAgent } from "./ssh-agent.js";
import type { AuthenticationType } from "ssh2";
import type { SshConnectionSettings } from "../../shared/ssh-connection.js";
import type { CredentialStore } from "../shared/credential-store.js";

interface HostAuth {
  methods?: string[];
  passwordRef?: string;
  keyRef?: string;
  passphraseRef?: string;
  certRef?: string;
  agent?: string | null;
}

interface HostLike {
  auth?: HostAuth;
  advanced?: Record<string, unknown> & { agentForward?: boolean };
}

export interface AuthConfig {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  agent?: string;
  tryKeyboard?: boolean;
  promptPassword?: boolean;
  methodOrder?: AuthenticationType[];
  configuredMethods?: AuthenticationType[];
  unavailableMethods?: AuthenticationType[];
}

/**
 * Build auth candidates for ssh2's negotiated method handler.
 */
export async function buildAuth(
  host: HostLike,
  credentialStore: CredentialStore,
  settings?: Partial<SshConnectionSettings>,
): Promise<AuthConfig> {
  const methods = host.auth?.methods || ["publickey"];
  const methodOrder = methods.filter((method): method is AuthenticationType =>
    ["publickey", "agent", "password", "keyboard-interactive"].includes(method),
  );
  const configuredMethods = [...methodOrder];
  const unavailableMethods: AuthenticationType[] = [];
  if (methods.includes("keyboard-interactive") && !methods.includes("password")) methodOrder.push("password");
  const cfg: AuthConfig = { methodOrder, configuredMethods, unavailableMethods };

  if (host.auth?.certRef) {
    throw new Error(
      "Built-in SSH does not support OpenSSH user certificates. Choose System SSH or WSL to use the certificate from your OpenSSH configuration.",
    );
  }

  for (const method of methods) {
    if (method === "password") {
      if (host.auth?.passwordRef) {
        cfg.password = credentialStore.getSecret(host.auth.passwordRef);
        if (!credentialStore.hasSecret(host.auth.passwordRef)) unavailableMethods.push("password");
      } else {
        cfg.promptPassword = true;
      }
    }

    if (method === "publickey") {
      if (host.auth?.keyRef) {
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
        } else {
          unavailableMethods.push("publickey");
        }
      } else {
        unavailableMethods.push("publickey");
      }
    }

    if (method === "agent") {
      const agentPath = await resolveAgent(
        host.auth?.agent || settings?.defaultAgentMode || "auto",
        settings?.agentPath || undefined,
      );
      if (agentPath) cfg.agent = agentPath;
      else unavailableMethods.push("agent");
    }

    if (method === "keyboard-interactive") {
      cfg.tryKeyboard = true;
      // ssh2's keyboard-interactive support does not include the classic
      // password method. Make it available for servers that disable
      // keyboard-interactive; the handler prompts only if the server asks.
      cfg.promptPassword = true;
    }
  }

  if (host.advanced?.agentForward && !cfg.agent) {
    cfg.agent = await resolveAgent(
      host.auth?.agent || settings?.defaultAgentMode || "auto",
      settings?.agentPath || undefined,
    );
    if (!cfg.agent)
      throw new Error(
        "Agent forwarding is enabled, but no SSH agent is available. Start an agent or turn off agent forwarding.",
      );
  }

  return cfg;
}
