# SSH

SSH tabs use one of three clients: strIDEterm's Built-in client, the system OpenSSH client, or OpenSSH inside WSL on Windows. Saved hosts, authentication prompts and terminal lifecycle are managed by the runtime on the computer running strIDEterm.

## Choose a connection method

Each host can use **Use app default** or choose a method directly. A host-level choice takes precedence over **Settings → SSH → Default connection method**. Changing the default affects the next connection for hosts that inherit it; open sessions keep running with their current client.

Connection-method lists show Built-in SSH first as the recommended choice; that is a suggestion, not the default. New hosts inherit the app default. A fresh installation uses System SSH unless `STRIDETERM_SSH_DEFAULT_CLIENT` configures another default. Existing hosts that had no saved client are migrated once to Built-in SSH to preserve their previous behavior. Existing explicit choices are kept.

| Method                   | What it uses                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Built-in SSH**         | The `ssh2` client, strIDEterm's saved keys and agent settings, and strIDEterm's host-key records and prompts.             |
| **SSH on this computer** | The system OpenSSH executable, its `ssh_config`, keys, native agent and `known_hosts` on the computer running strIDEterm. |
| **SSH in WSL**           | OpenSSH and its configuration inside the selected WSL distribution. Available on Windows only.                            |

For System SSH and WSL, leave username and port empty to inherit them from OpenSSH configuration. Entering a value overrides that configuration; explicitly entering port 22 is an override. A compatibility migration preserves the old behavior of saved hosts whose port 22 previously meant “use config”.

An existing saved host that already selects public-key authentication with a strIDEterm-managed key keeps using that key in System SSH or WSL. strIDEterm writes it to a temporary file with user-only permissions, passes its path to OpenSSH and removes the file when the session ends or launch fails. New System SSH and WSL hosts use keys and certificates configured in their OpenSSH environment.

System SSH and WSL use separate executables and settings. The System SSH executable path applies on the host operating system; WSL uses the executable inside Linux. The host value is passed as the OpenSSH target, so an alias such as `prod` is resolved by that client's configuration. Blank optional fields are omitted from argv so OpenSSH can apply its normal configuration. The app's agent mode and path settings apply only to Built-in SSH; System SSH and WSL use agents configured in their native OpenSSH environments.

Saving in the host editor adds or updates the host book only. To open a real SSH session, use **New Tab → SSH → Saved host** and choose the entry, or **Quick connect** to connect with details typed in the dialog without saving them (tick **Save to host book** to keep them). A running System SSH or WSL process does not prove that authentication succeeded: it may still be connecting or waiting for a prompt. Check the terminal output for the actual OpenSSH result.

## Tabs and startup commands

An SSH tab can carry its own startup command, for example when a Claude Code tab template is switched to SSH in the New Tab dialog. It runs after sign-in and replaces the host's own startup command for that tab. A tab without one uses the host's startup command, or opens a normal shell.

**Edit tab** changes what belongs to the tab: its title, icon and startup command. **Edit SSH host** changes the connection: address, sign-in, port, jump hosts and the host's own startup command. On a Quick Connect tab, **Edit SSH host** opens the tab's connection as a new host; once it is saved, the tab uses that saved host.

## Test connection

**Test connection** is available from the host editor and Quick Connect. It starts a temporary connection with the current unsaved host and authentication settings. It does not save the host, create a workspace tab, or run the configured initial command. Returning to the editor or Quick Connect keeps its draft available for further edits.

Manage Hosts also has a row-level **Test connection** action. It tests that saved entry in place and reports the result on that row; it does not create or select a workspace or tab. Only one host test runs at a time. Use **New Tab → SSH → Saved host** when you want to open an actual session.

Built-in SSH reports success only after authentication succeeds, then closes the temporary test session. It uses the usual password, MFA, key-passphrase and host-key prompts. Host-key decisions follow the normal trust policy: first connections may record a new key, and choosing permanent trust stores a changed key; trusting once does not replace the saved fingerprint.

System SSH and WSL open a temporary terminal for interactive sign-in. The test asks OpenSSH to run a one-shot verification command instead of the host's configured startup command. It reports success only after the exact generated marker returns and that command exits with code 0. “SSH process running” means the client started and may still be connecting or waiting for a prompt; it does not confirm login. A forced command, unsupported client option, or missing marker fails verification rather than producing a false success. Stop the test to cancel it while pending; it closes automatically after verification succeeds or fails. Closing the test or changing the active profile stops its temporary session; closing the app also cleans up the session. Test terminal output and prompts are sent only to the desktop window that started the test. Connection testing is desktop-only.

The runtime's separate legacy host setup-check operation tests Built-in SSH only. It returns `unsupported` for System SSH and WSL; use **Test connection** to try those clients.

## Saved hosts and OpenSSH configuration

The host book (available in **Settings → SSH**) stores the target or alias, display name, tags, optional username and port, client choice, agent settings, and advanced options such as keepalive, agent forwarding, compression, startup command and jump hosts. A Built-in startup command is sent to the terminal after connection; System SSH and WSL pass it to OpenSSH as a remote command and request a terminal for it, so interactive programs such as `tmux` or `claude` work.

OpenSSH config import adds host-book entries for non-wildcard `Host` aliases. It does not copy or translate `Hostname`, `User`, `Port`, `IdentityFile`, `Include` or `Match` rules into the host entry. The alias remains the connection target, and OpenSSH reads the configuration when the connection starts. The importer is a helper for listing aliases, not a complete config parser; a manually entered alias can still work when the parser cannot list it.

The `known_hosts` import operation is currently a stub and imports no entries. Built-in host fingerprints and OpenSSH's own `known_hosts` are separate stores; strIDEterm does not copy one into the other.

## Authentication and keys

Built-in SSH supports saved private keys, SSH agents, passwords and keyboard-interactive authentication, including combinations preserved on existing hosts. If an imported private key is encrypted and its passphrase was not saved, strIDEterm asks for the **key passphrase** before connecting. This is separate from the remote account password. Password and keyboard-interactive prompts follow the server's authentication flow; multiple MFA rounds are supported, and answers are not saved in the host entry.

The Built-in client uses a bounded 20-second network and server-response deadline. Time spent waiting for an app password, MFA, or host-key prompt does not count against it; the deadline resumes after the user answers.

When Built-in SSH exhausts its configured authentication methods, the error reports which methods were configured, which the client observed being rejected, and which methods the server advertised. It also identifies selected methods whose local key, password or agent was unavailable, and notes when the server accepted one factor but requires another. SSH servers often provide no reason for a rejection, so the message does not claim that a password or key is incorrect when that cannot be determined; check the account's allowed methods and server policy.

The key manager can generate ed25519, ECDSA and RSA keys, or import a private key by choosing a file or pasting its contents. Import validates the key and passphrase and stores public-key metadata for review. Generated or imported private keys and optional saved passphrases are stored in the local credential store. Add the resulting public key to the remote account before using key authentication.

Managed keys can be renamed. Their **Added** date records when the key was imported or generated in strIDEterm, not the key's original creation date. Imported certificate metadata includes its validity dates so an expired certificate can be identified.

For a Built-in SSH host — saved, open in the host editor, or entered in Quick Connect — **Transfer public key…** can install a managed key without opening a shell. Transferring does not save the host. strIDEterm asks for the target account password when needed, uploads only the validated public key through SFTP to the authenticated account's home directory, preserves existing `authorized_keys` entries, and then verifies authentication using only the selected key. The account password is used for this operation only and is not saved. A result is reported as installed only after key-only authentication succeeds; if the upload may have completed but verification fails, the result says so. This action requires Built-in SSH; System SSH and WSL hosts must use their own OpenSSH tools or a manual `authorized_keys` update.

OpenSSH user certificates can be imported and their metadata is retained, but Built-in SSH does not authenticate with an attached certificate. The host editor blocks saving a Built-in connection with a certificate reference. To use a certificate, configure the matching key and certificate in the OpenSSH environment used by System SSH or WSL, then connect with that method.

## Host-key trust

Built-in SSH records a host's fingerprint after its first successful connection and prompts if a previously recorded fingerprint changes. The prompt lets you reject the connection, trust the key once, or replace the saved fingerprint.

System SSH and WSL use OpenSSH's host-key policy and `known_hosts` files for their respective environments. They do not use strIDEterm's Built-in fingerprint prompts or records. Explicit strict or accept-new host policies are passed as OpenSSH options; otherwise the client's configuration applies.

## Settings, storage and profiles

SSH connection settings are saved with application settings. They include the default client, System SSH executable, WSL distribution and executable, Built-in agent mode and path, and the **Require encrypted storage** policy.

Host records, key and certificate metadata, and Built-in host fingerprints live in application state and are shared across profiles. Private keys, saved passphrases and other credential material live separately in `credentials.json` under the app data directory; they are not written to the state file. These are installation-wide settings and credentials, not profile-isolated data.

When encrypted storage is available, the credential store uses Electron `safeStorage` backed by the operating system's secure storage. With **Require encrypted storage** enabled (the default), key or passphrase storage is refused if encryption is unavailable. If encryption is unavailable and you turn this option off, credentials may be stored as base64-encoded plaintext in `credentials.json`; base64 is not encryption, and anyone who can read that file can recover the credentials. The Settings page warns when this fallback is active. A one-time migration turns an older saved `false` value back on, so a previously ineffective opt-out does not silently begin storing new keys in plaintext.

This policy applies to credentials stored by strIDEterm. It does not control keys managed by System SSH or OpenSSH inside WSL; those clients use their own files, agent and OS policies.

## Remote sessions

A remote browser or phone connects through the runtime on the desktop, so SSH connections still use the desktop's OS, OpenSSH configuration, WSL installation and credentials. Remote sessions may list saved-host and key/certificate metadata, open SSH tabs, and answer authentication or host-key prompts for sessions they can access.

Host and credential administration is desktop-only. Remote create, edit, duplicate, delete, key/certificate import or deletion, config preview/import, setup-check and known-hosts import requests return HTTP 403. The remote client cannot retrieve private key material. Session access remains scoped to the caller's allowed profile. The host book and credential store themselves are shared across profiles on the desktop.

## Platform checklist

Use this checklist when verifying a desktop build. Start the full Electron app with the developer's interactive PowerShell flow for `dev.ps1`.

- **Windows — System SSH:** connect using an existing `ssh` alias; confirm blank user and port inherit OpenSSH configuration, an explicit port 22 overrides it, and a missing executable reports an error in the terminal.
- **Windows — WSL:** try both the default and a selected distribution. Confirm SSH configuration and keys are read inside that distribution, the optional Linux user starts the client, and a managed-key temporary file is created and removed inside the WSL filesystem.
- **macOS:** connect with System SSH using an existing OpenSSH config and agent. Confirm no WSL option is offered.
- **Linux:** verify System SSH still works when no desktop keyring is available. With encrypted storage required, app key import/generation should refuse to save; after explicitly disabling the requirement, the Settings warning must explain plaintext fallback.
- **Built-in SSH:** connect with an unencrypted key, an encrypted key with and without a saved passphrase, a password-only server and a server requiring multiple keyboard-interactive prompts. Confirm the private-key passphrase prompt is distinct from server prompts.
- **Test connection:** from Manage Hosts, test a saved entry; confirm only that row shows progress/result, the temporary terminal accepts System SSH/WSL prompts, and stopping leaves the workspace and tab list unchanged. From Host Editor and Quick Connect, test an unsaved draft and return; confirm the draft remains unchanged, no host or tab was saved, and no initial command ran. Retry after a failed test. Open a real saved-host connection through **New Tab → SSH → Saved host**.
- **Electron and remote client:** confirm System SSH/WSL show a running process before authentication completes; test remote connection to an allowed saved host, responding to its prompts, and that host/key management requests are unavailable remotely.

## Implementation notes

The session manager chooses the SSH backend from the host's effective method and preserves the common terminal contract: data, resize, stop and exit. Built-in SSH emits a connection state after its client reports ready. System SSH and WSL report process-running while their PTY exists. Only the exact marker from the test-owned verification command followed by a successful process exit proves the native test connection; arbitrary terminal text is never treated as authentication evidence.

System SSH and WSL inherit configuration from their OpenSSH environment. Explicit host values and supported advanced options are passed as argv without invoking a shell. Agent forwarding is off unless enabled for the host. Jump hosts use OpenSSH `ProxyJump`; Built-in SSH uses its own nested SSH sessions.
