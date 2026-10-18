# Telegram

Connect a Telegram bot to strIDEterm to receive selected notifications and control supported tasks or workspaces from your phone. The app uses an outgoing connection to Telegram, so you do not need to expose a public webhook or open an inbound port.

## Set up a bot

1. In Telegram, open [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the bot token.
2. Send `/start` or another message to the new bot from the chat you want to use.
3. In strIDEterm, open **Settings → Telegram**, select **Add connection**, paste the token, and select **Detect**.
4. Choose the chat from the detected list, enable the connection, and choose which notifications to forward.

Treat the bot token like a password. The connection authorizes the selected chat; messages and button presses from other chats are ignored. Remove or replace the token in Settings if you think it was exposed. You can disable polling without deleting the connection.

## Choose notifications

Each Telegram connection can forward all notifications or only selected types, including completed work, agents waiting or asking for input, pull-request reviews, pipelines, errors, and informational messages. Manage the filters by expanding a connection in **Settings → Telegram**. You can also disable notifications while keeping the bot available for commands.

An **agent waiting** alert means the agent finished a turn and is idle; replying with text sends a message to the Worker. A **question** alert means the agent needs your answer in its terminal, for example to approve a command or respond to a question. Telegram cannot answer that prompt: return to the original terminal. Dismissing the notification does not answer it.

## Use bot commands and buttons

Start with `/menu` to see available actions. The leading slash is optional for commands such as `status`.

| Command             | Action                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `/status`           | Show task agents and their status; select a task for available controls.                          |
| `/workspaces`       | List workspaces in the active profile.                                                            |
| `/task`             | Start a task agent by choosing a workspace, worktree option, branch, and description.             |
| `/prs`              | Browse pull requests from connected GitHub or Azure DevOps accounts and start a review workspace. |
| `/screenshot`       | Request a screenshot of the app or a workspace.                                                   |
| `/tunnel`           | Show the remote-access links available from the desktop.                                          |
| `/tunnel reconnect` | Restart a dropped temporary tunnel and issue a fresh link.                                        |
| `/profile`          | See or choose the profile that a global chat targets.                                             |
| `/help`             | Show the command list.                                                                            |

Task buttons depend on the task's state. You can pause or resume work, edit the task description, or retrieve a task file. Stop and reset are more disruptive and ask you to confirm. A reply to a completed-task notification starts a new task on the same parent workspace using your reply as its description. A reply to a pull-request notification opens its review workspace.

## Choose which profile the chat controls

Each connection can target **All profiles** or a specific profile. With a specific profile, the chat receives alerts from that profile and its commands act only there. A global chat can see alerts across profiles; use `/profile` to pin its commands to one profile. Choose a specific profile when you want clearer separation between projects or users.

Actions that need an app window, such as opening a review workspace or taking a screenshot, may open a window for the selected profile. Commands that only show status or manage tasks do not need a window.

## Replies, screenshots, and remote access

- Reply to an agent-waiting alert to send text to the Worker.
- Reply to a completed-task alert to start a follow-up task.
- Select a pull-request alert to open its review workspace.
- Use task actions to pause, resume, edit a description, or fetch a task file.
- Use `/screenshot` to request an image from the desktop app.
- Use `/tunnel` to open the remote-access page. The desktop must already have remote access enabled. If a temporary tunnel link expires, request a fresh one from the bot.

The **Telegram** section in the Notification Center shows each connection's status and configured notification types. The in-app activity log can help confirm whether a command or action was received and completed.
