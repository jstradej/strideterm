import net from "node:net";
import { existsSync } from "node:fs";

const WINDOWS_OPENSSH_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

function hasWindowsOpenSshAgent() {
  return new Promise((resolve) => {
    const sock = net.connect(WINDOWS_OPENSSH_PIPE);
    let resolved = false;
    const once = (value) => {
      if (resolved) return;
      resolved = true;
      try {
        sock.destroy();
      } catch {
        // already destroyed
      }
      resolve(value);
    };
    sock.once("connect", () => once(true));
    sock.once("error", () => once(false));
    // Some environments never fire either event promptly (AppContainer, etc.) —
    // fall through to "no agent" after a short wait rather than hanging.
    setTimeout(() => once(false), 250);
  });
}

/**
 * Resolve the SSH agent reference expected by ssh2's `agent` option.
 * Returns either a socket path / pipe string, the literal "pageant" switch,
 * or undefined when no agent is available.
 */
export async function resolveAgent(mode) {
  if (mode === "off") return undefined;

  if (process.platform === "win32") {
    if (mode === "pageant") return "pageant";
    if (mode === "pipe") return WINDOWS_OPENSSH_PIPE;
    if (mode === "auto" || !mode) {
      if (await hasWindowsOpenSshAgent()) return WINDOWS_OPENSSH_PIPE;
      // Don't silently fall through to Pageant — we can't tell from Node whether
      // Pageant is actually running, and feeding "pageant" to ssh2 when it isn't
      // just produces an opaque auth failure. Let the caller's pre-flight check
      // surface a clear "no agent reachable" warning instead. Users who know
      // they run Pageant can still pick mode="pageant" explicitly.
      return undefined;
    }
    return undefined;
  }

  // POSIX
  if (mode === "socket" || mode === "auto" || !mode) {
    if (process.env.SSH_AUTH_SOCK && existsSync(process.env.SSH_AUTH_SOCK)) {
      return process.env.SSH_AUTH_SOCK;
    }
  }

  return undefined;
}
