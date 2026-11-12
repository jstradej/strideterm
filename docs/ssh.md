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

## Transfer files over SSH

For a Built-in SSH tab, choose **Browse files (SFTP)** in the tab's context menu to open a file browser for that host in a tab of its own. You can browse folders, create a folder, rename and delete items, and copy a path. System SSH and WSL tabs are not supported.

- **Upload:** choose **Upload files…** or **Upload folder…**, or drag files from your computer (or from the Files tab) onto the list. The items go into the folder you are viewing.
- **Download:** select items and choose **Download…**, then pick a folder on your computer.
- **Existing items:** if a target already exists, strIDEterm asks whether to overwrite it or skip the existing items.
- **Symbolic links:** links are not transferred. A link inside a folder is skipped; the result shows how many items were skipped, and hovering it lists them. A link you select directly is refused.
- **Progress:** each transfer shows its progress, speed and estimated time left, and can be cancelled. A transfer keeps running if you switch tabs, and its result also appears in the Notification Center.

If the SSH tab is connected, the file browser needs no extra sign-in. Otherwise it connects on its own and asks for any password or host-key confirmation.

Dropping a file onto an SSH terminal does not upload it; it types the file's path, as in any terminal.

### Paste a screenshot into an SSH tab

When you paste an image into a Built-in SSH tab (Ctrl/Cmd+V or right-click), strIDEterm uploads it to `~/.strideterm/paste` on the server and types that path into the terminal, so a tool running there, such as Claude Code, can open it. On a slow connection a short "Uploading screenshot…" message appears until the path is typed. If the upload fails, nothing is typed and a message says why.

This works in the desktop app while the tab is connected, and follows the **Clipboard image paste** setting in Settings → General. Uploaded images stay on the server until you delete them. System SSH and WSL tabs type the path of the image on your computer, as other terminals do.

### From a remote browser or a phone

The file browser also works over remote access, with these differences:

- Sign-in and host-key questions appear on the device you are using.
- **Upload:** drag files from the Files tab onto the list. Files stored on the remote device itself cannot be uploaded.
- **Download:** files are saved on the computer running strIDEterm, into a workspace folder you choose, not onto the remote device.
- **Phone:** a paired phone can browse the host's files, but uploading and downloading are not available.

## SSH tabs and AI tools

When creating or editing an SSH tab, you can set its own startup command and connection method. The tab command overrides the saved host's startup command for that tab. **Edit tab** changes the tab's title and startup command; **Edit SSH host** changes the connection details. A Quick Connect tab can be saved as a new host from **Edit SSH host**.

**Remote directory** sets the folder on the server where the tab starts, for example `~/projects/app`. After sign-in the tab changes to it and runs the startup command there; if the folder does not exist, the terminal shows the error and the command does not run. It needs a Unix-like shell on the server (Linux or macOS). SSH tabs to saved hosts can also be added directly in the workspace dialog with **🔐 SSH…**.

**Reconnect with password** in an SSH tab's context menu connects once with the account password instead of a key or agent, for example to a Mac with FileVault right after a restart. The host's saved sign-in does not change.

You can optionally enable **SSH tools** for a tab that directly launches Claude Code or Codex. This lets that agent list saved Built-in SSH hosts, run a command on a selected host, and list, upload and download files on it. The option is off by default, takes effect when the terminal starts, and requires restarting the terminal after a change. It is unavailable for manually launched agents, other tab types, WSL, System SSH, and remote sessions.

An agent is never asked for a password or a host-key confirmation: it can only use a host that already signs in on its own, with saved credentials and a trusted host key. It transfers files only between the host and its own workspace's folders, never into a `.git` folder, and replaces an existing file only when it asks to overwrite.

To enable it for every such tab of a workspace at once, tick **Allow SSH tools for agents** in the workspace settings, next to **Allow internal MCP for agents**. Tabs that do not directly launch Claude Code or Codex are simply skipped. It is off by default, can only be changed from the desktop app, and is never available to task workspaces.

## Use SSH over remote access

When connected to strIDEterm remotely, SSH sessions still run on the computer hosting the app and use that computer's SSH setup. Remote clients can open SSH sessions to hosts available to them and respond to connection prompts. Managing hosts or keys, transferring a public key, and testing a connection are desktop-only; a remote client cannot retrieve private keys.
