# Attaching profiles of another computer

**Attaching profiles** lets one computer running strIDEterm show the profiles of another computer running strIDEterm, in its own windows. You work on the other computer's workspaces from this one: the terminals, agents, Git and files stay on the other computer, and you see and type into them live.

Use it when you keep your projects on one machine (a desktop, a workstation, a Mac mini) and sit at another (a laptop). You can also move files and notes between the two.

The computer that owns the profiles is the **host**. The computer that shows them is the **device**. Any combination of Windows, macOS and Linux works, and a computer can be a host for some and a device for others.

## Before you start

- Both computers must be on the same network and be able to reach each other.
- Both must run the **same strIDEterm version**. Pairing works with different versions and warns you, but a host on another version cannot be opened: its profiles show **Different version** and **Activate** and **New Window** stay disabled until you update the older one.
- Both computers need secure credential storage (the system keychain or equivalent). Without it the host cannot turn attaching on, and the device cannot start pairing; both say so. The pairing keys are never saved unencrypted.

## Set up the host

1. On the host, open **Remote Access** and select the **Desktops** tab.
2. Turn on **Let other strIDEterm desktops attach profiles of this one**. It is off by default and independent of browser sharing and the mobile relay, so it works while they are off.
3. Keep the default **Port** or enter another and select **Apply**. If the port is taken, the panel says so; choose a different one.

When the host is listening, the tab shows **Listening on port …** and the addresses of this computer with the port. Select one to copy it. This is what you type on the other computer.

## Attach from the other computer

1. On the device, open **Profiles** and select **Connect from network…**.
2. Enter the host's address (an IP address or a host name) and the port, then select **Connect**.
3. The device shows an 8-digit code. Only the device shows it.
4. On the host, under **Remote Access → Desktops → Pairing requests**, find the request from this device, type the code and select **Approve**.
5. The device shows that the host is attached, and its profiles appear in **Profiles** under a **Network** group.

A wrong code ends that request: the host says the code did not match, the device says the request was rejected, and nothing is paired. Select **Try again** on the device to start a new request. **Reject** on the host refuses a request outright. A request that nobody answers expires after 10 minutes.

## Work with an attached profile

In **Profiles**, every attached host lists its profiles with two actions:

- **Activate** switches the window you are in to that profile. Switching to a profile of the same host keeps the window; switching from a local profile or another host restarts the window.
- **New Window** opens the profile in a new window.

An attached window is marked: its title names the host, its profile bar shows the host's name, and the host's group in **Profiles** shows **This window**. To go back, open **Profiles** in that window and select **Activate** on one of this computer's own profiles; the window restarts as a local window.

Everything runs on the host. Terminals, agents, Git, Docker, files and the workspace folders are the host's, and they keep running when you close the attached window. Both computers can show the same terminal at the same time and see the same output live.

When you create a workspace in an attached window, the folder you choose is on the host. The folder picker browses the host's folders and says **Choose a folder on** the host's name. The same picker is used for the pull request worktree folder of Azure DevOps and GitHub connections.

Several windows can show different profiles, or the same profile, of one host. Your terminal font size is this computer's own setting; the host's is not changed.

## Move files

Open the **Attachments** tab in the notification dock. It lists the attachments of the active workspace, which live in that workspace's folder on the host. It also lists files a phone uploaded.

- **Add file**, drag and drop, or paste adds files to the workspace.
- **Save to this computer** (in the menu of an attachment) downloads a copy here.
- In a terminal of an attached window, paste an image or drop a file: the file is added to the workspace's attachments on the host and its path on the host is typed into the terminal, where the agent there can read it.

Limits for files added from a computer: up to 1 GiB per file, 100 attachments and 4 GiB in total per workspace, and 4 transfers at a time. Any file type is accepted. Files uploaded from a phone keep the phone's stricter limits (25 MiB per file and 128 MiB per day per workspace) and file-type checks.

Attachments are not available in container workspaces or in SSH workspaces and terminals.

In a local window, the **Attachments** tab also lists the recent attachments of each attached desktop (the last 14 days, all its profiles), under that desktop's name. **Copy here** copies one into the workspace the tab shows, **Copy to** (in its menu) into another workspace of the profile, and the eye button copies it and opens it. The copy runs in the background, shows its progress, and ends with a notification that has a **Copy path** action. A file that is already in the workspace is marked **Copied**.

## Notes

The notes in an attached window are the host's notes for that profile and workspace. A change made on either computer appears on the other within moments. If you and someone at the host change the same note at once, the second save is refused with "This note has changed". Select **Review latest** to see the saved text, then **Use latest** or **Save my draft**. Your unsaved text is not overwritten by an update.

The **Global** section holds one note for the whole installation, shared by every profile. In an attached window it is the host's global note. In a local window, **Global** also shows the note of each attached desktop under that desktop's name, and you can edit it there; an attached desktop that is offline or no longer paired shows a status line instead. A desktop that is connected to this one, but that you have not attached from here, is listed without its note: you see it once you attach it too. Nothing is synced: each note stays on its own computer.

## When the other computer is not reachable

Each host in **Profiles** shows a state:

| State                               | Meaning and what to do                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Online**                          | Ready.                                                                                                                                           |
| **Offline**                         | The host is off, asleep or unreachable. Make sure strIDEterm runs there and **Desktops** is on, then select **Reconnect**.                       |
| **Needs pairing**                   | The host no longer accepts this computer, for example because it was removed there. Select **Disconnect**, then **Connect from network…** again. |
| **Different version**               | The two computers run different versions. Update the older one.                                                                                  |
| **Another strIDEterm answers here** | The address now belongs to a different installation. Select **Edit address**, or pair again.                                                     |
| **Checking…**                       | The first check is still running.                                                                                                                |

**Reconnect** checks the host again, also after it refused this computer. **Edit address** changes the address or port, for example after the host got a new IP address. **Rename** changes the name this computer shows for the host (and **Rename** in Remote Access → Desktops does the same for a paired device); the name is kept only on this computer and the other desktop is not told.

An attached window that loses its host shows a banner while it retries by itself. When retrying cannot help (**Needs pairing**, another installation, another version) or the connection was closed, the window shows a screen with the reason and three choices: **Reconnect**, **Switch to a local profile** and **Close window**. After a restart of your computer, its attached windows open again; if the host is not there, they show this screen.

## If the other desktop cannot be reached

When **Connect from network…** or **Reconnect** says the address did not answer, the other desktop's firewall usually blocks incoming connections, or the two computers are not on the same network. Allow the port shown in Remote Access → Desktops (default 43124) on the other desktop:

- **Windows:** when Windows asks whether strIDEterm may communicate on networks, allow **Private networks**. If that was dismissed: Windows Security → Firewall & network protection → Allow an app through firewall → Change settings → tick strIDEterm for Private. The network must be Private: Settings → Network & internet → your Wi-Fi or Ethernet connection → Network profile type → Private. Or in PowerShell as administrator:

  ```powershell
  New-NetFirewallRule -DisplayName "strIDEterm desktops" -Direction Inbound -Protocol TCP -LocalPort 43124 -Action Allow -Profile Private
  ```

- **macOS:** System Settings → Network → Firewall → Options… → strIDEterm → Allow incoming connections.
- **Linux:** with ufw, `sudo ufw allow 43124/tcp`. With firewalld, `sudo firewall-cmd --permanent --add-port=43124/tcp && sudo firewall-cmd --reload`.

On a Mac that starts the connection, also check System Settings → Privacy & Security → Local Network: strIDEterm must be allowed to reach devices on the local network.

"Nothing is listening" means the other desktop is not hosting on that port: turn on **Desktops** there and check the port. "Another program answers" means something else uses that port: choose a different one in Remote Access → Desktops. If a pairing waits for you to type the code, take your time: it keeps trying for ten minutes.

## Remove an attachment

- **Disconnect** (on the device, in **Profiles**) removes the host from this computer and closes its windows here. Nothing is deleted on the host, and the host still lists this computer under **Paired desktops** until you remove it there.
- **Remove** (on the host, under **Remote Access → Desktops → Paired desktops**) ends that computer's access at once, including open windows. The device shows **Needs pairing**. Nothing is deleted on the device or the host except the pairing.

To stop all attaching, turn off **Let other strIDEterm desktops attach profiles of this one**.

## What an attached window cannot do

An attached window has the same limits as a browser connected to the host:

- Settings that only the host can change stay on the host: the isolation and agent-tool switches of a workspace and their defaults, automatic approval of permission prompts, SSH hosts and keys, stored credentials, the external editor and terminal path links, and the paired-desktop settings. They are hidden or disabled in an attached window.
- It cannot change the host's remote-access token, start or stop its tunnels, create, rename or delete its profiles, or set up its agent notification hooks.
- Pop-out windows for diffs and files, opening a terminal path in an editor or the file manager, opening an attachment with the default app and **Copy into clipboard** for attachments, and the Docker container shell tab are not offered.
- The **Browser** tab loads pages on this computer, so `localhost` there means this computer, not the host. To reach a service on the host, use the host's address.
- Hosting is set up from a local window of the host. An attached window can still attach more hosts.

## Security

- The connection is encrypted, and its key comes from the pairing. Nothing secret is sent while pairing: the code is shown on one computer and typed on the other, never sent over the network.
- Anyone on the network can send a pairing request, but a request does nothing until someone at the host types the matching code. A wrong code ends it.
- A pairing lasts until you remove it on the host. A removed computer is cut off at once.
- Attaching is off by default and separate from browser sharing and the mobile relay.
- A paired computer sees and can work in **all** profiles of the host. Profiles organize workspaces; they are not a security boundary, so pair only computers you own or fully trust.
- Turn the host switch off, or choose another network, when you do not want the host to accept connections.
