# How strIDEterm works

strIDEterm brings terminal workspaces and project tools together in a desktop app. Your desktop keeps
the workspaces and runs their terminals; Git, Docker, pull-request review, plugins and AI-agent tools
are available alongside them.

## Desktop and connected devices

The desktop is the main app and owns the running work. You can connect a browser over your local
network or a public address to view and control the same workspaces. The browser is a window into the
desktop, not a separate copy of your projects.

A second computer running strIDEterm can attach the profiles of the first over the local network and show them in its own windows; see [Attaching profiles of another computer](attach-profiles.md).

The optional [mobile companion app](https://strideterm.com/mobile/) connects through a managed relay.
Relay sessions are end-to-end encrypted between the phone and desktop. Other remote connection
methods do not have this end-to-end encryption.

Profiles help organize workspaces and windows within one installation; they are not separate security
boundaries.
