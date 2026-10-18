# SSH Connections

Use SSH terminal tabs to work on remote computers from strIDEterm. Save frequently used connections in the host book, or use **Quick connect** for a one-time session.

## Choose an SSH client

In **Settings → SSH**, choose the default connection method. You can also choose **Use app default** or a specific method for each host. A changed default affects future connections; open sessions keep their current client.

| Method                   | Use it when                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| **Built-in SSH**         | You want strIDEterm to manage connection prompts, host fingerprints, and optional SSH keys.         |
| **SSH on this computer** | You already use the computer's OpenSSH setup, including its config, keys, agent, and `known_hosts`. |
| **SSH in WSL**           | On Windows, you want to use OpenSSH and its files inside a chosen WSL distribution.                 |

System SSH and WSL use their own OpenSSH configuration and agent. Leave **Username** or **Port** empty to let OpenSSH read it from its config; enter a value to override it. On Windows, choose the WSL distribution and, if needed, its Linux user and SSH executable. System SSH has its own optional executable setting.

## Add and manage hosts

Open **Settings → SSH → Manage hosts** to add, edit, duplicate, test, or delete a saved host. A host can have an address or alias, display name, username, port, connection method, tags, authentication choice, and advanced connection options. Hosts are available across profiles on the same computer. strIDEterm will prevent deleting a host that is currently used as a jump host by another saved entry.

You can preview aliases from your OpenSSH config and add selected aliases to the host book. This imports the alias names only; it does not copy `HostName`, `User`, `Port`, `IdentityFile`, or other config rules. OpenSSH reads those settings itself when you connect, so keep using the same OpenSSH environment that owns the config. Wildcard-only config entries are not saved as hosts.

To connect without saving details, choose **New Tab → SSH → Quick connect**. Fill in the host and sign-in details, then select **Connect**; use **Save to host book** if you want to keep it. To open a saved entry, choose **New Tab → SSH → Saved host**. **Test connection** is also available from Manage Hosts, the host editor, and Quick Connect. It uses the current connection details temporarily, does not create a regular workspace tab, and does not run a startup command. For System SSH or WSL, check the terminal output: the client may still be waiting for a prompt even though it has started.

## Authentication and keys

Built-in SSH supports private-key authentication, an SSH agent, an account password, and keyboard-interactive sign-in, including additional verification or MFA prompts. A private-key passphrase unlocks the key; it is separate from your remote account password. Passwords and verification responses are requested when needed rather than saved in a host entry.

In **Settings → SSH → Manage keys**, you can generate Ed25519, ECDSA, or RSA private keys, or import a key from a file or pasted text. You can rename or delete managed keys and copy a key's public half. Built-in SSH uses keys you manage in strIDEterm; it does not automatically scan your computer's `.ssh` folder. System SSH and WSL use keys and agents configured for their respective OpenSSH installations.

For a Built-in SSH host, **Transfer public key…** can add a managed key to the remote account's `authorized_keys` file. It uploads the public key only, preserves existing entries, then checks that the selected key can sign in. You may be asked for the account password for this one-time operation; it is not saved. System SSH and WSL connections use your OpenSSH tools for installing a key.

The key manager can also import OpenSSH certificate metadata alongside a managed private key, so you can identify its expiry and configure a matching OpenSSH connection. Built-in SSH does not authenticate with OpenSSH user certificates. To use a certificate, configure its matching key and certificate in System SSH or WSL.

### Protect saved credentials

**Settings → SSH → Require encrypted storage** is enabled by default. When the computer's secure storage is unavailable, strIDEterm will not save a managed key or passphrase while this option is on. Turning it off may allow credentials to be saved without encryption; leave it enabled unless you understand that risk. This setting applies to keys saved by strIDEterm, not the keys or agents maintained by OpenSSH or WSL.

## Host verification and advanced options

On a first Built-in SSH connection, check the server's host-key fingerprint before trusting it. You can trust it once or save that fingerprint for future connections. If a previously trusted server presents a different fingerprint, strIDEterm asks whether to reject it, trust it once, or replace the saved fingerprint. System SSH and WSL follow their OpenSSH `known_hosts` and host-key settings; those entries are separate from Built-in SSH's records.

The host editor's **Advanced** options include:

- **Tags** to organize and filter the host book.
- **Keepalive** to send periodic traffic and help detect or prevent an idle connection from being dropped.
- **Jump hosts** to connect through another saved SSH host before reaching the target. Select a host already in your host book.
- **Startup command** to run after sign-in. A command saved on an SSH tab takes precedence over the host command; leave it blank to use the host command or open a normal shell.
- **Agent forwarding**, which lets remote programs request authentication through your local SSH agent. Enable it only on hosts you trust: anyone with access to that remote machine could use the forwarded agent while the connection is open.

For Built-in SSH, **Default SSH agent source** in Settings and **Agent source** on an individual host let you choose how strIDEterm reaches an agent. Depending on your computer, the choices include automatic detection, Pageant, the Windows OpenSSH agent pipe, a Unix socket, or no agent. A custom agent path is available for setups that need one. System SSH and WSL ignore these Built-in settings and use their own OpenSSH agent configuration.

## SSH tabs and AI tools

When creating or editing an SSH tab, you can set its own startup command and connection method. The tab command overrides the saved host's startup command for that tab. **Edit tab** changes the tab's title and startup command; **Edit SSH host** changes the connection details. A Quick Connect tab can be saved as a new host from **Edit SSH host**.

You can optionally enable **SSH tools** for a tab that directly launches Claude Code or Codex. This lets that agent list saved Built-in SSH hosts and run a command on a selected host. The option is off by default, takes effect when the terminal starts, and requires restarting the terminal after a change. It is unavailable for manually launched agents, other tab types, WSL, System SSH, and remote sessions.

## Use SSH over remote access

When connected to strIDEterm remotely, SSH sessions still run on the computer hosting the app and use that computer's SSH setup. Remote clients can open SSH sessions to hosts available to them and respond to connection prompts. Managing hosts or keys, transferring a public key, and testing a connection are desktop-only; a remote client cannot retrieve private keys.
