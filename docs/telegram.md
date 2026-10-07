# Telegram

strIDEterm can forward workspace alerts to a Telegram bot, and let you reply to those alerts to drive the app from your phone — start a task, pause / resume agents, capture screenshots, fetch task files, open a PR review, and so on. It uses Telegram's `getUpdates` long-polling, so the machine only needs outbound HTTPS to `api.telegram.org`: no public webhook, no tunnel.

---

## User Guide

### What it does

When something noteworthy happens — a task agent finishes, an agent is blocked on you, a PR needs your review, a long shell command exits — the app sends the alert as a Telegram message. You can act on it three ways:

- **Tap an inline button** — runs short, low-risk actions immediately; destructive ones (stop, reset) ask for confirmation first.
- **Use Telegram Reply** on a notification — the text is routed to the right workspace.
- **Type a command** — `/menu` is the recommended entry point on mobile because tapping is faster than typing.

### Set up the bot

1. Talk to **[@BotFather](https://t.me/BotFather)** and run `/newbot`. Save the bot token — it is your shared secret with the bot.
2. Send `/start` (or any message) to the new bot so Telegram has a chat to deliver into.
3. Open **Settings → Telegram** and click **Add connection**.
4. Paste the token, click **Detect** to list recent chats, and pick the one that should receive notifications.
5. Enable the connection and choose which alert kinds to forward (everything by default).

The **Telegram** tab of the notification panel shows each connection, its status, how often it polls, which kinds it forwards, and a shortcut to its settings. With no connection it offers **Set up Telegram bot**.

### Forwarding rules

Each connection has its own **Forward filter** (Settings → Telegram, expand the connection). Nothing ticked means everything is forwarded. The kinds:

- `completed` — an agent or shell command finished
- `waiting` — the agent stopped and nobody typed for about a minute (Claude Code `idle_prompt`). It is not asking anything; it is idle
- `question` — the agent is **blocked on you**: a permission prompt, an `AskUserQuestion`, an MCP elicitation, or a background session that needs input. The message shows what is being approved (`Bash: chmod +x deploy.sh`) and offers only Dismiss, because the answer has to be typed in the terminal it came from
- `auto_approved` — strIDEterm answered a Claude Code permission prompt for you ("Approval sent"). Appears only with **Settings → General → Auto-approve permission prompts** enabled
- `subagent_done` — a sub-agent finished within the current turn. Opt-in via **Settings → General → Notify on sub-agent completion**
- `review` — an Azure DevOps or GitHub PR alert
- `pipeline` — a CI pipeline check completed
- `error`, `info` — error-class and neutral notifications

A filter that listed `waiting` before `question` existed was migrated once to `["waiting", "question"]`; you can still choose `waiting` alone afterwards.

### Profile binding

A connection's **Profile** setting decides which profile's alerts reach the chat and which profile its commands act on:

- **All profiles (global, default)** — alerts from every profile, each labelled with its profile name. A command picks its target profile in this order: the chat's pinned profile (`/profile`), the only defined profile, the only profile open in desktop windows (the bot says "Acting on profile X" once), and only then asks you — remembering the answer for the chat until you change it or the app restarts.
- **Specific profile** — strict isolation: only that profile's alerts arrive, and every command from the chat targets that profile.

An action that needs a window (Open PR review, a workspace `/screenshot`) for a profile with no open window opens one and leaves it open. When a profile is open in several windows, the window already showing the target workspace wins, then the most recently focused one. Runtime-only commands (`/status`, `/workspaces`, `/task`, task buttons) never need a window.

### Bot commands

The leading `/` is optional — `status` works as well as `/status`.

| Command             | What it does                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/menu`             | Interactive main menu with inline buttons. `/start` is an alias.                                                                                                                                                             |
| `/status`           | Every task agent and its state; tap a task for actions.                                                                                                                                                                      |
| `/workspaces`       | Workspaces in the active profile, starred ones first.                                                                                                                                                                        |
| `/task`             | Start a new task agent (see below).                                                                                                                                                                                          |
| `/prs`              | Open pull requests across your Azure DevOps / GitHub connections; start a review workspace from chat.                                                                                                                        |
| `/screenshot`       | PNG of the strIDEterm window — the current one or a chosen workspace.                                                                                                                                                        |
| `/tunnel`           | Browser links for the Cloudflare quick tunnel and LAN URLs. Each link carries a one-use ticket that expires after 5 minutes; request `/tunnel` again for a fresh link. Alias `/url`.                                         |
| `/tunnel reconnect` | Restart a dropped quick tunnel (same as the 🔁 button). Alias `/reconnect`. If the app still reports the tunnel as connected, the bot asks before forcing a restart (`/tunnel reconnect force`). A restart issues a new URL. |
| `/profile`          | Show and switch which profile a global chat targets; `/profile clear` unpins.                                                                                                                                                |
| `/help`             | The command list.                                                                                                                                                                                                            |

### Task control from chat

`/status` lists tasks; tap one for its actions (offered by state):

- ⏸ **Pause** / ▶️ **Resume** — reversible, no confirmation.
- ⏹ **Stop** and 🔄 **Reset** (back to idle, round history cleared) — confirmation required.
- 📝 **Edit description** — just edit, edit and resume, or edit and restart.
- 📂 **Get file** — reply with a path relative to the task's `cwd`; choose _Preview_ (images inline, short text as a code block) or _As file_ (raw attachment).
- 📸 **Screenshot** — captures that workspace specifically.

`/task` walks you through: workspace (top-level workspaces of the active profile only) → worktree mode (_New worktree_, _Directly in parent cwd_, _Existing worktree_) → branch name (normalised to a valid Git branch, e.g. `feature/Auth Fix` → `feature/auth-fix`) → description → confirm. It is rate-limited per chat, so a stuck `/task` cannot spawn a pile of workspaces.

### Replies to notifications

- Reply to a PR-review alert → opens the review workspace.
- Reply to an agent-waiting alert with text → sends the text to the worker.
- Reply to a finished-task alert → starts a new task on the same parent workspace with the reply as its description.

### Audit log

Every Telegram-driven side effect — alert sent, command received, button tapped, action dispatched — is recorded in a local audit log next to the Azure DevOps and GitHub logs, kept for 30 days. Use it to confirm a `/task` actually ran or to find out why a notification did not arrive.

---

## Security Model

- **Bot token** — kept in the credential store (`credentials.json`), encrypted by the OS keychain through Electron `safeStorage`, never in the main state file. Without a keychain it falls back to base64 on disk and the log says so.
- **One chat per connection** — every incoming message and button tap is checked against the saved chat ID; anything else is logged and dropped.
- **Get file stays inside the task** — the requested path is resolved against the task's `cwd` and refused if the result leaves it.
- **No replay** — updates are fetched with the next expected offset, so a processed update is never dispatched twice.
- **Stale flows expire** — every multi-step flow (workspace pick, branch input, description) is dropped after 10 minutes, so an old button cannot be reused later.
- **Rate limit** — `/task` can run at most once every 10 seconds per chat.
- **Tunnel reconnect cannot create new exposure** — it only restores a Cloudflare tunnel the desktop user already enabled (remote access on and the tunnel previously started), both re-checked when the action runs. A hijacked chat can restore prior exposure, never turn on new public access. Every attempt is audited.
- **Secrets stay out of logs** — log lines are scrubbed of bot tokens, bearer headers and token query strings, and the audit log stores only the API method name, never the full URL.

## Polling

A connection's poll interval defaults to 5 seconds (`pollSeconds`); with several connections the bot polls at the shortest of their intervals. Each poll is a Telegram long-poll of up to 25 seconds, so the bot reacts within about a second while sending roughly one request per 25 seconds.
