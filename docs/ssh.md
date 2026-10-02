# SSH

strIDEterm has a first-class SSH client: a terminal tab can connect straight to a remote machine, with a host book, a built-in key manager and host-key verification. SSH sessions live in the same workspaces, splits and notifications as local shells.

---

## User Guide

### The Host Book

**Settings → SSH** (or the host picker in an SSH tab) manages saved hosts. Each entry holds a display name and tags, hostname / port / user, its authentication setup (key, password / MFA, SSH agent — any combination), and advanced options: post-login command, keepalive, agent forwarding, compression and jump hosts. **Test Connection** checks a host without opening a tab.

### Opening an SSH Tab

1. **Saved host** — pick it when creating or editing a tab; reconnects always use the saved configuration.
2. **Ad-hoc** — type host / user / port into the tab editor for a one-off connection.

A running SSH tab behaves like a local terminal tab: splits, resize, shell integration, finish notifications, copy/paste.

### Authentication

strIDEterm tries the methods a host allows, in order, until one succeeds:

- **Public key / certificate** — a key from the key manager. A stored passphrase is used automatically; otherwise you are asked once per session.
- **Password / keyboard-interactive (MFA)** — the server drives the prompts and strIDEterm shows each one inline. Answers are not kept beyond the connect attempt. With no stored password you are asked once, and that answer satisfies both password and keyboard-interactive prompts, so mixed-auth servers do not ask twice.
- **SSH agent** — auto-detects the Windows OpenSSH named pipe on Windows and `$SSH_AUTH_SOCK` on macOS / Linux. A host can pin an agent mode (Pageant, a named pipe, a Unix socket) or a custom path.

### Key Manager

Available for the built-in launch mode:

- **Generate** an ed25519, ECDSA or RSA key, with optional passphrase and comment
- **Import** a private key by pasting it (PEM, OpenSSH, PKCS#8); files such as `~/.ssh/id_ed25519` are never modified
- **Import certificates** and see their principals, validity and key ID
- **Inspect** which hosts use a key before deleting it, with cascade delete for dependents

### Host Key Verification

Trust on first use: the first successful connection records the server's key fingerprint, and every later connection checks it.

When a known host's key changes, a warning shows the new SHA-256 fingerprint (the format `ssh-keygen` prints), the key type and the previously trusted fingerprint. You can cancel, accept the new key for this session only, or replace the stored fingerprint.

### Importing ~/.ssh/config

The SSH settings can import your OpenSSH client config: each non-wildcard `Host` block becomes a host-book entry, with `Hostname`, `Port`, `User` and `IdentityFile` mapped to the matching fields.

### Launch Modes

- **Built-in (default)** — strIDEterm opens the connection itself. Only this mode uses the key manager, the host-key prompts and jump-host chains (a chain of saved hosts).
- **System `ssh`** — runs your OS's `ssh` binary, so your `~/.ssh/config`, keys and agent apply exactly as in a shell, with no import. The key manager is hidden for these hosts.
- **WSL** — on Windows, runs the SSH client inside a chosen WSL distribution, for setups that only exist there.

### Settings

**Settings → SSH** holds the global preferences: default launch mode, SSH agent preference (auto / prefer / off) and custom agent path, **Require encrypted storage** (on by default), and the certificate-expiry warning threshold. Per-host options such as keepalive and post-login commands live in the host's advanced options.

---

## How It Fits Together

**One session contract.** A local PTY and an SSH session implement the same contract — write, resize, stop, data and exit events — and the session manager picks the backend from the tab's launch kind. Everything above it (terminal store, split layout, shell integration, notifications) sees only bytes and lifecycle events, so SSH inherits what local shells already do. The built-in client is built on the `ssh2` library; a jump chain is a sequence of nested clients, each carried over its parent's forwarded channel.

**Works remotely unchanged.** Because SSH uses the same session and transport abstractions, a remote browser or phone session can open an SSH host from the host book. The credentials stay on the machine running strIDEterm.

**What is persisted where.** Host definitions, key and certificate metadata, and trusted host-key fingerprints (keyed by `host:port`) live in the regular state file. Secret material does not — see below. Live clients, pending prompts and open streams are never persisted.

---

## Security Model

- **Private keys and passphrases** are stored in `credentials.json` under the data directory, encrypted with Electron `safeStorage` (DPAPI on Windows, the macOS Keychain, libsecret / kwallet on Linux), never handed to the keychain directly and never in the state file. A passphrase is its own record, so it can be rotated — or not saved at all and asked per connect — without re-importing the key.
- **Without an OS keychain** (e.g. headless Linux without `gnome-keyring` / `kwallet`), saving SSH credentials is refused while **Require encrypted storage** is on, which is the default. Turned off, they fall back to base64 on disk with a logged warning and a warning in Settings → SSH.
- **Host keys** are checked on every connection, and a changed key is always shown to you with the previous fingerprint before anything proceeds.
- **Keyboard-interactive answers** live only for one connect attempt.
- **Agent forwarding** is off by default and must be enabled per host.
- **Private keys never leave the machine**, including when an SSH tab is used from a remote client.
