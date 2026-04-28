# SSH

strIDEterm has a first-class SSH client: open a terminal tab that connects straight to a remote machine, with a host book, built-in key manager, and proper host-key verification. You can run SSH sessions inside the same workspaces, splits, and notifications as your local shells.

---

## User Guide

### The Host Book

Open **Settings → SSH** (or the host picker from an SSH tab) to manage saved hosts. Each entry stores:

- Display name and optional tags for searching
- Hostname, port, and username
- Authentication setup (key, password / MFA, SSH agent — any combination)
- Advanced options: post-login command, keepalive, agent forwarding, compression, jump hosts
- Last-connected timestamp

The dialog supports add, edit, delete, and a **Test Connection** button that validates the host configuration without opening a tab.

### Opening an SSH Tab

You have two ways to start an SSH session:

1. **Saved host** — pick a host from the host book when creating or editing a tab. Reconnects always use the same saved configuration.
2. **Ad-hoc** — type host / user / port directly into the tab editor for one-off connections that don't need to be saved.

Once the tab is running, it behaves exactly like a local terminal tab: splits, resize, shell integration, finish notifications, copy/paste, and so on.

### Authentication

A host can advertise multiple auth methods; strIDEterm tries them in order until one succeeds:

- **Public key / certificate** — pick a key from the key manager; passphrases are handled transparently if stored, otherwise you're prompted once per session.
- **Password / keyboard-interactive (MFA)** — the server drives the prompts. strIDEterm opens an inline dialog for each challenge; nothing is cached beyond the connect attempt.
- **SSH Agent** — auto-detects the Windows OpenSSH named pipe on Windows, and `$SSH_AUTH_SOCK` on macOS / Linux. You can also pin a specific agent mode (e.g. Pageant, a named pipe, or a Unix socket) or a custom path per host.

If only interactive auth is configured and no password is stored, you're asked once up front and the same answer satisfies both legacy `password` and keyboard-interactive prompts — so mixed-auth servers don't double-prompt.

### Key Manager

The **Key Manager** dialog (available for the built-in SSH mode) lets you:

- **Generate** a new key — ed25519, ECDSA, or RSA, with an optional passphrase and comment
- **Import** an existing private key by pasting it in any common format (PEM, OpenSSH, PKCS#8)
- **Import certificates** and see their principals, validity window, and key ID parsed out
- **Inspect** which hosts reference a key before deleting it, with cascade-delete for dependents

Private key material is stored in `~/.strideterm/credentials.json`, encrypted via Electron's `safeStorage` (which is backed by DPAPI on Windows, the macOS Keychain, and libsecret/kwallet on Linux). Passphrases are stored under a separate record so you can rotate one without touching the other. Files on disk (e.g. `~/.ssh/id_ed25519`) are never modified by the import. If the OS keychain isn't available, see the **Settings** option below to refuse plaintext fallback rather than store credentials unprotected.

### Host Key Verification

strIDEterm uses a TOFU ("trust on first use") model: the first successful connection records the server's public-key fingerprint, and every later connection checks that it hasn't changed.

When a host's key **does** change from what was recorded, strIDEterm shows a warning dialog with:

- The server's new fingerprint (SHA-256, the same format `ssh-keygen` prints)
- The key type (ed25519, RSA, …)
- The previously trusted fingerprint, highlighted so you can spot the change

You can cancel the connection, accept the new key for this session only, or replace the stored fingerprint and trust it from now on.

### Importing ~/.ssh/config

From the SSH settings you can import your existing OpenSSH client config. strIDEterm reads the standard config file, creates host book entries for the non-wildcard `Host` blocks, and maps `Hostname`, `Port`, `User`, and `IdentityFile` onto the equivalent fields.

### Launch Modes

Each host chooses how it actually connects:

- **Built-in (default)** — strIDEterm opens the SSH connection itself. This is the mode that uses the internal key manager, TOFU prompts, and jump chains.
- **System `ssh`** — strIDEterm shells out to your OS's `ssh` binary. Your `~/.ssh/config`, keys, and agent are used exactly as they would be from a shell, with no import step. The key manager is hidden for these hosts.
- **WSL** — on Windows, runs the SSH client inside a chosen WSL distribution. Useful when the remote end expects Unix line endings, forwarded agents, or tooling that only exists in your WSL environment.

Jump hosts (bastions) are supported as a chain of saved hosts in the built-in mode.

### Settings

**Settings → SSH** collects global preferences:

- Default launch mode for new hosts
- SSH agent preference (auto / prefer / off) and an optional custom agent path
- Whether to refuse saving credentials if the OS keychain isn't available
- Certificate expiry warning threshold

Per-host knobs like keepalive timing and post-login commands live in the host's advanced options, not in global settings.

---

## Technical Overview

Under the hood, SSH is treated as a different kind of session rather than a bolt-on. A tab's `launch.kind` can be `ssh`, alongside the usual shell/agent kinds, and the backend routes accordingly.

### Session Model

Local PTYs and SSH sessions implement the same session contract — write, resize, stop, plus event streams for data and exit. The session manager routes to the right backend based on the tab's launch kind, but everything above it (terminal store, split layout, shell-integration hooks, finish-notification heuristics) just sees a stream of bytes and lifecycle events. That means the feature inherits everything workspaces already do: profiles, split layouts, OSC 133 command boundaries, and per-session notifications.

The built-in client is layered on top of the `ssh2` Node library, with a thin session abstraction that owns the client lifecycle, shell request, stream multiplexing, keepalive, and cleanup. Jump chains are modelled as a sequence of nested clients, each using its parent's forwarded channel as a transport.

### Persistence and State

Host definitions, key metadata, certificate metadata, and trusted host-key fingerprints live in the regular workspace state file, so they're backed up and synced along with everything else. Runtime-only state — active SSH clients, pending auth prompts, open streams — is never persisted.

Sensitive material is stored separately from that state file:

- Private key bytes are written to `~/.strideterm/credentials.json` under an opaque key ID, encrypted via Electron's `safeStorage` (DPAPI / macOS Keychain / libsecret-kwallet under the hood).
- Passphrases are stored as their own credential records, so rotating one doesn't require re-importing the key.
- Host-key fingerprints are kept in a TOFU-style map keyed by `host:port`.

### Security Model

- Private keys don't leave the device. They are encrypted with Electron's `safeStorage` master key (which is itself protected by the OS keychain) and stored in `credentials.json` rather than handed to the keychain directly.
- Passphrases are held separately; users can opt not to save them at all and be prompted per connect.
- Host-key verification is explicit on first connect (when policy requires) and always on mismatch, with the previously trusted fingerprint surfaced in the UI.
- Keyboard-interactive answers are scoped to a single connect attempt.
- Agent forwarding is off by default and requires explicit per-host opt-in.
- If `safeStorage` is unavailable (e.g. headless Linux without `gnome-keyring`/`kwallet`), the credential store falls back to base64-on-disk and emits a logged warning. The **Settings → SSH** option _Refuse to save credentials without OS keychain_ turns that fallback into a hard refusal.

### IPC Surface

The renderer talks to the backend through a small set of validated IPC calls that cover: host-book CRUD and test, key/certificate CRUD and generation, `~/.ssh/config` preview and import, auth-prompt answers, and host-key accept/reject decisions. Every payload goes through the same Zod-schema validation layer used for the rest of the app.

### Transport-Agnostic

Because SSH plugs into the same session and transport abstractions as local shells, the feature works in both the Electron UI and the remote HTTP/WS client unchanged. A remote browser session can connect to an SSH host configured in the host book, using credentials that live only on the machine running strIDEterm.
