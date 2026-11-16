# Working in isolation

**Work in isolation** runs the AI agents of a workspace in an isolated environment. The agent works on your project as usual, while the rest of your computer stays out of its reach.

## What it is for

Use it when you let an agent work on its own, for example with permission prompts turned off, or when you work on code you do not fully trust. An isolated agent:

- sees only the workspace folder, not your home folder or other drives,
- can write only to the workspace and its own working folders,
- cannot change Git hooks, editor settings or your agent configuration,
- reaches the network only through strIDEterm, which asks you before it lets the agent go anywhere new,
- never gets tokens or passwords for other services; strIDEterm signs in to private package registries for it.

## Turn it on

1. Open the workspace settings and tick **Work in isolation**.
2. strIDEterm checks what your computer needs and shows the result. If something is missing, **Install missing parts** installs it; where it needs your password, it shows the commands to run yourself.
3. Save. New agent tabs start isolated and show an **isolated** label. A tab that was already running shows **restart to isolate** until you restart it.

To isolate every new workspace, turn on **Settings → General → Agent isolation**.

### Tasks

A task created in an isolated workspace is isolated too. In a workspace that is not, tick **Run in isolation** when you create the task.

### Shell tabs

A shell tab in an isolated workspace can run isolated as well: tick **Run this shell isolated** in the tab's settings. Use it for builds and scripts; start agents in their own agent tabs.

## When the agent wants to reach the network

When an isolated agent tries to connect somewhere new, strIDEterm shows a notification and adds an entry to the **Notification Center**. It says which tab asked and where it wants to go. Choose:

- **Allow for this workspace** – allowed now and in the future,
- **Allow this time** – allowed for this session only,
- **Deny** – refused.

If you do not answer in time, the connection is refused. The entry stays in the Notification Center, so you can still allow the destination for the workspace later. Allowed destinations are listed in the workspace settings, where you can remove them.

## Private package registries

In **Settings → Registries** connect a private Maven, npm, pip or Gradle registry. Isolated builds then download from it without the token ever reaching the agent. Use a read-only token.

## Windows, macOS and Linux

|                  | Windows                                                        | macOS                 | Linux                                      |
| ---------------- | -------------------------------------------------------------- | --------------------- | ------------------------------------------ |
| Where agents run | Inside WSL2                                                    | On your Mac           | On your computer                           |
| What it needs    | WSL2 with a Linux distribution, Node.js 22.12+ in it           | Node.js 22.12+        | Node.js 22.12+, bubblewrap, socat, ripgrep |
| Agent CLIs       | Installed inside WSL (the settings show which ones were found) | Your installed agents | Your installed agents                      |
| Agent sign-in    | Your Windows sign-in is used, no second login                  | Your existing sign-in | Your existing sign-in                      |
| Project tools    | Linux build tools inside WSL                                   | Your usual tools      | Your usual tools                           |

**Windows tips**

- If WSL is missing or the distribution runs as WSL1, the settings show how to install or convert it.
- A workspace on a Windows drive (`C:`) is slower in WSL. **Choose a folder inside WSL…** in the workspace settings switches the workspace to a folder in your Linux home; your files are not moved.
- To update an agent, update it inside WSL from a normal terminal, then press **Check again** in the workspace settings.
