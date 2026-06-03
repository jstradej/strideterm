# Telegram

strIDEterm can forward workspace alerts to a Telegram bot, and let you reply to those alerts to drive the app from your phone — start a task, pause / resume agents, capture screenshots, fetch task files, open a PR review, and so on. Setup takes a minute and uses long-polling, so no public webhook or tunnel is required.

---

## User Guide

### What it does

When something noteworthy happens in strIDEterm — a task agent finishes, an agent is waiting for input, a PR needs your review, a long shell command exits — the app forwards that alert as a Telegram message. The message has inline buttons for the obvious actions (open the PR review, dismiss, start a new task) and supports two-way control:

- **Tap an inline button** — fires the action immediately for short, low-risk operations, or pops a confirmation prompt for destructive ones (stop, reset).
- **Use Telegram Reply** — reply to a notification with free text and the bot routes it to the right workspace as a `custom-message` command.
- **Type a slash command** — `/menu` (or `/start`, which is aliased to `/menu`), `/status`, `/workspaces`, `/task`, `/prs`, `/screenshot`, `/tunnel`, `/help`. `/menu` is the recommended entry point on mobile because tapping is faster than typing.

The whole feature works over Telegram's `getUpdates` long-polling API, so the strIDEterm machine only needs outbound HTTPS to `api.telegram.org`.

### Set up the bot

1. Talk to **[@BotFather](https://t.me/BotFather)** in Telegram and run `/newbot`. Save the bot token it returns — it's your shared secret with the bot.
2. Send `/start` (or any message) to your new bot from your account so Telegram has a chat to deliver into.
3. Open **Settings → Telegram** in strIDEterm and click **Add connection**.
4. Paste the bot token, then click **Detect** to fetch recent chats. Pick the chat where you want notifications to land.
5. Enable the connection and choose which alert kinds to forward (everything by default).

The bot token is stored encrypted via the OS credential store (Windows Credential Manager, macOS Keychain, or libsecret on Linux) — it never sits in the main state JSON. The chat ID is validated on save so only the configured chat can drive actions.

### Side-panel Telegram tab

Open the notification panel and switch to the **Telegram** tab to see, at a glance:

- Each configured connection with its label, chat ID, and `connected` / `missing-token` badge.
- A **poll Ns** chip — how often the bot polls Telegram for new messages.
- A **forwarding** chip — which alert kinds this chat receives (or _all alerts_ when no filter is set).
- A **Configure** button that opens Settings → Telegram in one click.

When no connection is configured the panel shows a short pitch and a primary **Set up Telegram bot** button so you don't have to menu-hunt for the settings dialog.

### Forwarding rules

`forwardKinds` controls what arrives in your chat. Leave it empty to forward everything; otherwise list the kinds you care about, e.g. `["completed", "waiting", "review"]`. Common kinds:

- `completed` — agent or shell command finished
- `waiting` — agent paused waiting for input
- `subagent_done` — a sub-agent (Task tool) finished within the current turn — one ping per subagent, with only a Dismiss button to keep the chat tidy during complex turns
- `review` — Azure DevOps or GitHub PR alert (new comment, your review requested, …)
- `pipeline` — CI pipeline check completed
- `error` — error-class notifications
- `info` — neutral info notifications

Each connection has its own filter, so different chats can subscribe to different alert flavours.

### Profile binding

In a multi-profile install a Telegram connection's **Profile** setting controls which profile's alerts arrive in that chat:

- **All profiles (global, default)** — the connection receives alerts from every profile. The profile name is shown on each Telegram message so you can tell at a glance where the alert came from. This is what you want when you have a single bot for everything.
- **Specific profile** — strict isolation. Only alerts from workspaces in that profile reach the chat, and follow-up commands from this chat always target that profile/context. A profile may be open in several desktop windows at once: window-needing actions pick the window deterministically — a window already showing the target workspace wins, then the most recently focused window of the profile — and `/screenshot` of the "current" window asks you to pick when several windows qualify.

When you click a Telegram action (Open PR review, workspace `/screenshot`, …) for a profile that isn't currently open in any desktop window, strIDEterm spawns a fresh window for that profile, runs the action there, and leaves the window open. Runtime-only commands (`/status`, `/workspaces`, `/task`, task lifecycle buttons) never need a desktop window at all. You don't have to remember which profile lives in which window.

### Bot commands

| Command             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/menu`             | Global interactive main menu with inline buttons (recommended on mobile). Profile-specific actions ask for a profile only when needed.                                                                                                                                                                                                                                                                                                                                 |
| `/status`           | List every task agent and its state. Tap a task for actions.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/workspaces`       | List every workspace in the active profile. Starred workspaces (⭐) appear first, then alphabetical.                                                                                                                                                                                                                                                                                                                                                                   |
| `/task`             | Start a new task agent. Picks workspace → worktree mode → branch → prompt. Starred workspaces are shown first in the picker.                                                                                                                                                                                                                                                                                                                                           |
| `/prs`              | List open pull requests across configured Azure DevOps / GitHub connections and start a review workspace from chat.                                                                                                                                                                                                                                                                                                                                                    |
| `/screenshot`       | Capture a PNG of the strIDEterm window (current or any workspace).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/tunnel`           | Send the strIDEterm remote-access URL to your phone — auto-picks the Cloudflare quick-tunnel URL when connected, otherwise LAN URLs, with the auth token already appended. Aliased as `/url`. When the Cloudflare tunnel has dropped, the message includes a 🔁 **Reconnect tunnel** button.                                                                                                                                                                           |
| `/tunnel reconnect` | Restart a dropped Cloudflare quick tunnel from chat (same as the 🔁 button). Only available when remote access is enabled and the tunnel was previously started from the desktop. Aliased as `/reconnect`. If the app still reports the tunnel as _connected_ (cloudflared can hold a dead edge connection while the process stays alive), the bot asks for confirmation — tap **Force restart** or type `/tunnel reconnect force`. A restart issues a new public URL. |
| `/help`             | Print the command list.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Slash-prefix is optional — both `/status` and `status` work, since mobile keyboards make `/` annoying to type.

In multi-profile setups, `/menu` itself is not bound to a profile. Buttons such as **Status**, **New task**, **Workspaces**, **Pull requests**, **Screenshot**, or **Tunnel URL** use the same profile resolution as their matching slash command: a profile-bound Telegram connection runs directly, a single open profile runs directly, and an unbound chat with multiple open profiles asks you to pick one for that action.

### Task control from chat

The `/status` command shows every task agent with state-coloured icons and inline buttons. Tap a task to get its action menu (offered actions depend on state):

- ⏸ **Pause** / ▶️ **Resume** — for running / paused tasks. No confirmation; reversible.
- ⏹ **Stop** — destructive; requires confirmation.
- 🔄 **Reset** — wipes round history and goes back to IDLE; requires confirmation.
- 📝 **Edit description** — type new instructions; optional follow-up to also resume or restart.
- 📂 **Get file** — reply with a relative path inside the task's `cwd`. The bot offers _Preview_ (chat-friendly format) or _As file_ (raw download attachment).
- 📸 **Screenshot** — captures this workspace specifically (briefly activates it, captures, switches back).

Edit-description has three variants: just edit, edit-and-resume, and edit-and-(reset+start). The "edit-and-resume" variant pauses immediately on tap so the resume after the new description always succeeds, even if the worker was mid-step.

### Starting a new task from chat

`/task` walks you through:

1. **Pick a workspace** — only true top-level workspaces in the active profile (excludes review workspaces, task children, and worktree children).
2. **Pick a worktree mode** — _New worktree_ (recommended), _Directly in parent cwd_, or _Existing worktree_.
3. **(New worktree)** — type a branch name. Mobile autocapitalisation and stray spaces are normalised to a valid Git branch (`česká-větev` → `ceska-vetev`, `feature/Auth Fix` → `feature/auth-fix`).
4. **Type the task description** — what the agent should do.
5. **Confirm** — the bot summarises everything and asks for ✓ Confirm / ✗ Cancel.

The flow is rate-limited per chat so a stuck `/task` cannot spawn a runaway pile of workspaces.

### Replies to notifications

Use Telegram's native **Reply** feature on a forwarded notification:

- Reply to a PR-review alert → opens the review workspace.
- Reply to an agent-waiting alert with text → forwards the text to the worker as a `custom-message` directive.
- Reply to a finished-task alert → starts a new task on the same parent workspace using the reply as the description.

### Screenshots and file transfers

`/screenshot` captures the live BrowserWindow as a PNG and sends it via `sendPhoto` so Telegram inlines a preview and lets you tap-to-save the original. You can capture the currently active workspace, or pick another workspace from the list — the runtime briefly activates it, captures, then switches back.

The **Get file** flow refuses paths that resolve outside the task's `cwd`, prevents `..` traversal, and picks a delivery mode based on size and extension:

- `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.bmp` → `sendPhoto` (inline preview, max 10 MB)
- Text files ≤ 3500 bytes → fenced code block in chat with language tag inferred from extension
- Everything else (including `.svg`, `.ico`, `.avif`, and any binary) → `sendDocument` (raw attachment up to 50 MB)

You can force the document path by tapping **As file** instead of **Preview** in the file-mode prompt.

### Audit log

Every Telegram-driven side-effect (alert sent, command received, button tapped, action dispatched) is recorded in a SQLite audit log alongside the Azure DevOps and GitHub logs. Useful for:

- Confirming a `/task` actually ran
- Investigating why a notification didn't arrive
- Cross-checking Telegram-driven actions against workspace state

Entries are kept for 30 days and include timestamps, chat ID, workspace ID, the operation, the originating method (slash command, button tap, reply), and a summary.

---

## Security Model

- **Bot token** is stored encrypted via Electron's `safeStorage` (which delegates to the OS keychain). When the keychain is unavailable the credential store falls back to base64 plaintext _and emits an explicit warning_ in the logs — anyone with read access to that file would otherwise have every secret. SSH credentials still refuse the plaintext fallback unconditionally.
- **Chat ID allowlist** is enforced on every incoming message _and_ every callback query — only the chat that was saved with the connection can drive actions. Off-chat updates are logged and dropped.
- **Path traversal** for the Get-file flow is blocked: the requested path is resolved against the task `cwd` and the absolute result must still live inside it; otherwise the bot responds with a clear error.
- **Update replay protection** — `getUpdates` is called with the next-expected `offset` so a previously processed update can never be re-dispatched.
- **Pending-state expiry** — every multi-step flow (workspace pick, branch input, description input) carries a `createdAt` and is dropped after `PENDING_TIMEOUT_MS` so a stale callback can't be weaponised.
- **Rate limiting** — `/task` enforces `TASK_COMMAND_COOLDOWN_MS` per chat to stop rapid-fire workspace spam from a hijacked phone.
- **Tunnel reconnect gating** — the 🔁 Reconnect button / `/tunnel reconnect` can only re-establish a Cloudflare tunnel the user already configured on the desktop (remote access enabled **and** auto-tunnel previously on; both re-checked in the runtime at execution time, not just when the button was rendered). A hijacked chat can restore prior exposure but can never turn on brand-new public access. The force-restart variant (for tunnels that still report connected) passes through the same gates. Every reconnect attempt — success or failure — lands in the audit log as a `reconnect-tunnel` write.
- **Token redaction** — the Winston log layer (`electron/backend/logger.ts`) strips secrets from every line before it's written: Telegram bot tokens in `/bot<TOKEN>/` URL paths, `Authorization: Bearer …` headers, and `?token=…` / `?access_token=…` / `?api_key=…` query strings all become `[REDACTED]`. The Telegram audit log only persists the API method path (`/sendMessage`, `/getMe`, …), never the full URL, so an outbound-fetch error message or HTTP 401 response can't double as a credential dump in `~/.strideterm/logs/` or `telegram-audit-log.db`.

---

## Technical Overview

### Components

```
┌────────────────────────┐    long-poll getUpdates   ┌────────────────────┐
│   TelegramManager      │ <───────────────────────> │  api.telegram.org  │
│   (electron/backend)   │    sendMessage / sendPhoto│                    │
└─────────┬──────────────┘                           └────────────────────┘
          │ emits "command" events
          ▼
┌────────────────────────┐
│       runtime.ts       │ → AgentTaskRunner / SessionManager / AzureDevOps
│  (orchestrator)        │   / GitHub / FileManager / …
└─────────┬──────────────┘
          │ broadcasts state:updated (telegram.connections)
          ▼
┌────────────────────────┐
│    Renderer (Vue)      │ → NotificationCenter "Telegram" tab + Settings
└────────────────────────┘
```

`TelegramManager` (`electron/backend/telegram-manager.ts`) is a thin Telegram-bot client built on `getUpdates` long-polling. It:

- Polls Telegram for new messages and callback queries (one HTTP request per poll cycle, per connection).
- Validates the chat ID, parses the update, and emits a typed `TelegramCommandEvent`.
- Handles the inverse direction — `forwardAlert` sends a `sendMessage` (with optional inline keyboard) for every alert raised through the runtime.

The runtime listens on `manager.on("command")` and dispatches each event to the right subsystem (`agentTaskRunner`, `sessionManager`, the workspace store, etc.). The runtime also calls `forwardAlert` whenever it raises a UI notification.

### State and persistence

- **Connections** (`integrations.telegram.connections` in the main state file) — id, label, chat ID, bot token reference, enabled, poll interval, forward filter. Plain JSON, no secrets.
- **Bot tokens** — stored separately in `credentials.json` under refs of the form `cred:tg-<id>`, encrypted via `safeStorage`.
- **Audit log** (`telegram-audit-log.db`, SQLite) — every operation with timing, status, and source.

Runtime-only state — pending requests, polling offsets, in-flight HTTP timers — lives only in memory.

### Polling

Default poll interval is 5 seconds per connection. The actual `getUpdates` call uses Telegram's long-polling timeout of 25 seconds (with a slightly longer 35 s HTTP read timeout to give the server room to respond), so the bot reacts to messages within ~1 second in practice while still using only one outbound request per ~25 seconds. Polling state is per-connection so multiple bots in the same instance don't interfere.

### Inline buttons and callbacks

Telegram caps `callback_data` at 64 bytes. The bot uses compact prefixes:

- `t:<op>:<workspaceId>` — task-action callback (pause, resume, stop, reset, edit, file, screenshot, …)
- `m:<op>` — worktree-mode pick (`m:n` new, `m:d` direct, `m:e` existing list, `m:x:<idx>` chosen)
- `mn:<op>` — main-menu button (`mn:status`, `mn:task`, `mn:prs`, `mn:workspaces`, `mn:screenshot`, `mn:tunnel`, `mn:help`)
- `ss:<op>` — screenshot mode (`ss:c` current, `ss:w` pick workspace)
- `tn:<op>` — tunnel action (`tn:r` reconnect the Cloudflare quick tunnel, `tn:f` force-restart one that still reports connected)
- `fm:<op>` — file delivery mode (`fm:a` auto/preview, `fm:d` document)
- single-letter ops (`c`, `d`, `s`, `o`, `ar`, `x`) — confirm / dismiss / start-task / open-review / auto-review / cancel

This keeps every button under the byte limit even with full-uuid workspace IDs.

### IPC surface

The renderer talks to `TelegramManager` through a small set of validated IPC calls:

- `telegram:verify-connection` — `getMe` + verify the chat is reachable
- `telegram:detect-chats` — list recent chats the bot has heard from (used to fill the chat picker)
- `telegram:save-connection` / `telegram:delete-connection` — CRUD
- `telegram:refresh` — kick the polling loop (used after settings changes)

Every payload goes through the same Zod-schema validation layer the rest of the IPC surface uses.

### Configuration

| Setting                               | Default  | Purpose                                                                                                                 |
| ------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pollSeconds` (per connection)        | `5`      | Interval between `getUpdates` calls.                                                                                    |
| `forwardKinds` (per connection)       | `[]`     | Empty = forward all; otherwise list of alert kinds.                                                                     |
| `TASK_COMMAND_COOLDOWN_MS` (constant) | `10_000` | Minimum gap between two `/task` invocations from a chat.                                                                |
| `PENDING_TIMEOUT_MS` (constant)       | `10 min` | Multi-step flow expiry (workspace pick, branch input, …).                                                               |
| `GETUPDATES_LONG_POLL_SEC` (constant) | `25`     | Telegram long-poll timeout. Paired with a `35 s` HTTP read timeout so the request can outlive the server's poll window. |

Constants live next to `TelegramManager` in the backend; per-connection settings live in the main state file and are editable in **Settings → Telegram**.

### Error handling and retries

Outbound Telegram API calls run inside an Effect-based retry policy keyed on the kind of failure:

- **Network errors** and **5xx** — retried with backoff
- **Auth errors (401/403)** — fail fast with a typed `TelegramAuthError`; the user sees a clear message in the audit log and the connection card flips to `missing-token`
- **Rate-limit (429)** — waits the `retry_after` Telegram returned, then retries
- **Other 4xx** — fails fast (no point retrying a malformed payload)

Errors are translated back to plain `Error.message` at the boundary so existing try/catch callers keep working.

---

## Differences from Azure DevOps / GitHub integrations

| Feature   | Azure / GitHub              | Telegram                                                 |
| --------- | --------------------------- | -------------------------------------------------------- |
| Direction | Outbound HTTP only          | Long-polling (HTTP-pull) plus outbound `sendMessage`     |
| Auth      | PAT / Bearer per request    | Bot token in URL path (Telegram contract)                |
| Trigger   | User clicks in the renderer | Inline button or chat reply, anywhere with Telegram      |
| Audit log | One row per API call        | One row per command / alert / button tap                 |
| Reach     | Same machine as strIDEterm  | Anywhere your Telegram client runs (phone, web, desktop) |
