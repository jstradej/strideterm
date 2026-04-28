# Security Policy

Thanks for taking the time to report a security issue. strIDEterm handles credentials (SSH private keys, GitHub / Azure DevOps PATs, Telegram bot tokens) and runs interactive AI-agent sessions, so security reports are taken seriously.

## Reporting a vulnerability

**Preferred:** open a private report through GitHub Security Advisories — go to the [Security tab](https://github.com/jstradej/strideterm/security) and click **Report a vulnerability**. This keeps the report private until a fix is released.

**Backup:** email <strideterm@stradej.cz> with `[security]` in the subject. Do not open a public GitHub issue for unfixed vulnerabilities.

A useful report includes:

- A clear description of the issue and the impact you believe it has
- Steps to reproduce (commands, sample input, attacker capabilities required)
- The strIDEterm version (Settings → About) and host OS
- Whether the issue is exploitable in default configuration or requires non-standard settings
- Optional: a suggested fix or mitigation

This is a small project with a single maintainer, so I can't promise an SLA, but I aim to acknowledge reports within a few days and follow up with a timeline once the issue is reproduced.

## Supported versions

Only the **latest tagged release** on the [Releases page](https://github.com/jstradej/strideterm/releases) receives security fixes. Older versions are not patched — please update before reporting an issue against an older build.

## Scope

**In scope** (please report):

- Bypass of IPC payload validation (`electron/backend/ipc-schemas.ts`)
- Credential exfiltration from `~/.strideterm/credentials.json` without prior local-machine access
- Path-traversal in any user-supplied path (workspace `cwd`, file manager, Telegram Get-file flow, plugin script paths)
- Token leakage in logs (`~/.strideterm/logs/`) or audit databases
- RCE triggered by remote terminal output (e.g. malicious escape sequences delivered through SSH or a process the user attached to)
- XSS / template injection in the Vue renderer
- Renderer escape (bypass of `contextIsolation` / `nodeIntegration: false`)
- TOFU bypass in the SSH host-key verification flow
- Bypass of the Telegram chat-ID allowlist or replay of `getUpdates` updates
- Vulnerabilities in the remote HTTP/WS server (`electron/backend/remote-server.ts`)

**Out of scope** (these are documented trust assumptions):

- **Plugin code is not sandboxed.** Plugins under `~/.strideterm/plugins/` run in the same Node.js process as the backend with full filesystem access — see [docs/plugin-development.md](docs/plugin-development.md). Treat plugin authors as trusted.
- **Custom user CLI commands** (Worker / Judge agent commands, post-login SSH commands, panel commands) execute with the user's privileges. The user explicitly configures them.
- **Local-machine attacks.** A local attacker who can read `~/.strideterm/` files or the user's keychain is already past the trust boundary. The OS keychain protection of `safeStorage` is the boundary, not file-permission obscurity.
- **Third-party CLIs we integrate with** (Claude Code, Codex, Gemini, Copilot, OpenCode, `git`, Docker, `lazygit`, `ssh`). Report those upstream.
- **Denial-of-service from a malicious user against their own instance** (e.g. typing a runaway command in your own terminal). The terminal is not a sandbox.
- Issues only reachable when the user has explicitly bypassed a documented protection (e.g. accepting a TOFU host-key mismatch warning, choosing to save credentials when the OS keychain is unavailable, granting agent forwarding to an untrusted host).

If you're unsure whether something is in scope, report it — borderline cases are easier to triage with the report in hand.

## Disclosure

I aim for coordinated disclosure: once a fix is published in a release, a corresponding GitHub Security Advisory is filed (with credit if you'd like). Standard practice is up to **90 days** from initial report to public disclosure, but the exact timing depends on severity and complexity. If you need to disclose sooner for safety reasons, please say so in your report.

## What's already in place

For context — this informs what's likely to be a duplicate vs. a novel issue:

- **Automated:** Dependabot version-bump PRs, Dependabot security alerts, secret scanning + push protection, CodeQL, weekly `npm audit` (high-severity blocking), package signature verification, `eslint-plugin-security` on every PR.
- **Architectural:** `contextIsolation: true` and `nodeIntegration: false` for all renderer windows, Zod-validated IPC payloads, Electron `safeStorage`-encrypted credentials, TOFU host-key verification, chat-ID allowlist on every Telegram update, path containment for plugin entry points and Get-file requests.

Thanks again for helping keep strIDEterm secure.
