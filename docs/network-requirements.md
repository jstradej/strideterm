# Network requirements (for IT / security teams)

What the strIDEterm desktop app connects to, what it listens on, what is encrypted, and how it
behaves behind TLS inspection (EDR / security proxy). Hosts below are the ones found in the code
(`electron/backend/mobile/mobile-firebase-config.ts`, `electron/backend/account/authlink-config.ts`,
`electron/backend/version-checker.ts`, `electron/backend/telegram-manager.ts`, the tunnel manager).

## Outbound connections

| Process     | Host                                      | Port / protocol            | Purpose                             | When                    |
| ----------- | ----------------------------------------- | -------------------------- | ----------------------------------- | ----------------------- |
| strIDEterm  | `identitytoolkit.googleapis.com`          | 443 / HTTPS                | sign-in (Firebase Auth)             | mobile integration on   |
| strIDEterm  | `securetoken.googleapis.com`              | 443 / HTTPS                | token refresh                       | mobile integration on   |
| strIDEterm  | `*.firebasedatabase.app`                  | 443 / HTTPS (SSE)          | pairing, commands, presence         | mobile integration on   |
| strIDEterm  | `*.cloudfunctions.net`                    | 443 / HTTPS                | pairing, account, push              | mobile integration on   |
| strIDEterm  | `auth.strideterm.com`                     | 443 / HTTPS                | email sign-in                       | while signing in        |
| strIDEterm  | `relay.strideterm.com`                    | 443 / WSS                  | terminal and WebView from the phone | managed relay on        |
| strIDEterm  | `api.github.com`                          | 443 / HTTPS                | version check (once per 24 h)       | always                  |
| strIDEterm  | `api.telegram.org`                        | 443 / HTTPS                | Telegram bot                        | only with Telegram on   |
| cloudflared | `api.trycloudflare.com` + Cloudflare edge | 443, 7844 UDP (QUIC) / TCP | quick tunnel                        | only with the tunnel on |

The relay origin is delivered by the control plane with each connector grant; the production value is
`relay.strideterm.com`. Integrations the user configures (GitHub / Azure DevOps pull requests) talk to
the host of that connection. Git, ssh, docker and anything else started by the user in a terminal is
outside the app and not listed here.

## Inbound

- TCP **43123** (configurable), plain HTTP, only while remote access is on.
- **Settings → Remote Access → LAN → "Allow access from other devices on the network"** (default on)
  controls whether it listens on all interfaces. Turned off, the server listens on `127.0.0.1` only,
  which is all the Cloudflare tunnel and the managed relay need — no firewall prompt, no port on the
  network. An explicitly set address (`remoteAccess.host`, `STRIDETERM_REMOTE_HOST`) is still bound as
  given. A remote client cannot change this setting.

## Encryption

- **Firebase channel** (notifications, commands): end-to-end encrypted between the desktop and the
  paired phone (X25519 + AES-256-GCM). Google only sees ciphertext.
- **Managed relay:** encrypted in transit only (TLS to the Cloudflare Worker). The relay can read the
  terminal / WebView traffic while it is in flight.
- **Network access on 43123:** not encrypted.

## TLS inspection

The app trusts the **operating system certificate store** in addition to Node's bundled roots
(merged, never replaced; verification stays on). A corporate root CA only has to be where IT already
deploys it for the browser:

- Windows: _Trusted Root Certification Authorities_;
- macOS: _System_ keychain;
- Linux: `update-ca-certificates` / `update-ca-trust`.

Alternatives: exclude the hosts above from inspection, or point `NODE_EXTRA_CA_CERTS=<path to PEM>`
at the CA. `STRIDETERM_DISABLE_SYSTEM_CA=1` turns the system-store trust off (diagnostics / escape
hatch). The startup log records `tls trust store` with counts and duration only.

If a connection still fails because of an untrusted certificate, Settings → Mobile / Account says the
network is intercepting encrypted connections instead of a generic error.

macOS and Linux: this follows Node's documented `tls.getCACertificates("system")` behaviour and the
CI tests on those platforms; it has **not** been verified by hand on a managed machine there.

`cloudflared` is a Go binary with its own system-store handling. Its quick tunnel
(`*.trycloudflare.com`, UDP/TCP 7844) is a common EDR alert trigger; the managed relay is the
alternative.

## Process names for EDR / firewall rules

- Windows: `strIDEterm.exe` (electron-builder `productName`), installed per user by the NSIS
  installer, or run from the portable build. Verify on the installed build.
- macOS: `strIDEterm.app` (bundle id `com.strideterm.app`) — from the electron-builder config, not
  verified by hand.
- Linux: AppImage / `.deb` named `strIDEterm` — from the electron-builder config, not verified by hand.
- `cloudflared`: started from the path set in Settings, or looked up on `PATH`
  (`STRIDETERM_TUNNEL_BINARIES` can override the candidates). It is never copied to or run from a
  temporary directory.

## Build identity

EDR and firewall exceptions are usually bound to the binary's signer:

- Windows: the release workflow (`.github/workflows/release.yml`) signs with `CSC_LINK` /
  `CSC_KEY_PASSWORD`; check with
  `Get-AuthenticodeSignature "<path>\strIDEterm.exe" | Format-List Status, SignerCertificate`
  and compare the publisher across versions.
- macOS: the current electron-builder config sets `mac.identity: null` — builds are **not** signed or
  notarized, so there is no Team ID to allowlist yet.
- Linux: AppImage / `.deb` artifacts are not signed by the release workflow.

## What to turn off on sensitive machines

Telegram, network access (the checkbox above) and the Cloudflare quick tunnel.

See also the mobile app's own `docs/network-requirements.md` in the `strideterm-mobile` repository for
where the phone connects.
