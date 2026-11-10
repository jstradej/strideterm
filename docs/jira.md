# Jira

strIDEterm brings Jira issues into a Jira inbox workspace. Search and filter issues, open boards, comment and change status, then start development on an issue. Starting development creates a branch workspace that has the issue's details and, optionally, an AI agent already working on it.

## Connect Jira

Open **Settings → Jira**, or select **open Jira inbox** at the bottom of the workspace sidebar and add a connection there. Choose the connection type that matches your site:

- **Jira Cloud · API token**: enter your Jira site URL (for example `https://your-site.atlassian.net`), the email of your Atlassian account and an API token. Select **Create an API token** to open the Atlassian page where you create one. The token acts as the account that created it, with that account's Jira permissions, so a technical account works too. It is stored only on this computer. Classic tokens work against the site directly. A scoped token goes through Atlassian's API gateway and needs at least the `read:jira-user` scope, plus read and write scopes for the actions you use.
- **Jira Data Center · Personal access token**: enter the Jira web URL, the API URL and a personal access token.
- **API gateway (APIM)**: for a Jira site behind your organization's API gateway. Enter the gateway base URL, the subscription header and key, and a client certificate if your administrator requires one.

Set **Account purpose** for every connection type:

- **Personal account** acts as you.
- **Technical account** is a shared service account. Because issues assigned to a shared account are not yours, pick your own Jira user under **Who are you in Jira?** so **My issues** shows your work. Changes in Jira are still made by the connected account.

The setup can also limit searches and boards to the projects you work in. Jira needs the operating system's credential store (Keychain, Credential Manager or a Linux keyring) for its secrets. Without it a connection cannot be saved or tested and changes in Jira are refused. A connection belongs to the profile it was created in. Connections can be added, changed and removed only in the desktop app. In the Jira inbox, **Connection settings** opens the settings of the selected connection: test it, check your Jira user for **My issues**, manage its saved queries or disconnect it. **Edit** has two tabs. **General** holds the name, **Search only these projects**, the **Starting query (JQL)** that runs when you open the connection, and **Link issue keys to this connection**, which only decides where keys like `ABC-123` in other text open and does not filter searches. **Connection** holds the URL and credentials; a secret left blank keeps the saved one.

## Find issues

The **Inbox** tab has **Issues**, **Board** and **Settings** views.

- **Issues**: type an issue key or words to search. When you have several connections, **All connections** searches by text only; JQL and boards need one connection selected. Use **Advanced JQL…** to run your own JQL, save it as a query or open a Jira filter by its ID.
- **Views**: this menu opens **My issues**, recent searches, your Jira favorites and saved queries. Open any of them as its own tab; the tab keeps its filters.
- **Board**: pick a Jira board to see its columns by status. Switch between **Sprint**, **Backlog** and **All issues**, and choose how far back **Completed issues** go. **Board filters** holds the board's quick filters, **My issues** and a search over any Jira user. A saved view has **Filter by issue status**, and the **My issues** view has **Issue scope** to show open issues only or all of them.

The workspace header also has a Jira search: type an issue key to open it, or words to see the newest matches. Next to it, two counters show your open issues in **To Do** and **In Progress** (the same issues as **My issues**, so your Jira user must be set). Click a counter to list them; the list says how old the numbers are and has **Refresh**.

Select an issue to open its detail with description, comments, attachments, status and linked work.

## Work on an issue

From the issue detail you can:

- **Comment**: you see a preview before it is posted.
- **Change status**: choose one of the transitions Jira allows.
- **Assign to me**, assign someone else or **Unassign**.
- **Add attachment**, **Add link…** or **Log work…**. Logging work needs a personal account.
- **Link workspace…**: connect an existing workspace to the issue.
- **Copy key**, **Copy link** or **Open in Jira ↗** for anything strIDEterm cannot do.

Every change is shown for you to confirm before it is sent to Jira. If the network fails and strIDEterm cannot tell whether Jira applied a change, it does not let you send it again until it has checked with Jira. Use **Reconcile write status** to check; this prevents duplicate comments or transitions.

When a comment is posted with a technical account, strIDEterm can add a line such as "On behalf of Jane Doe" so readers know who wrote it. It is on by default for technical accounts. Turn it off or edit the text under **Settings → Jira → Comment attribution for technical accounts**. Comments from a personal account are posted exactly as written.

## Start development

Select **Start development** on an issue. You need an Azure DevOps or GitHub connection in the same profile as the Jira connection for the repository.

1. Pick the connection, repository and base branch. Azure DevOps also needs a **Project**. The new branch name is suggested from the issue key and summary; change it freely.
2. Choose an **Agent**, optionally a **Model** and **Effort**, or **No agent** to only prepare the branch (the button then reads **Create branch**).
3. Choose how the agent starts:
   - **Analyze first** (default): the agent studies the issue and the code, asks about anything unclear and writes a specification. It changes no code until you tell it to.
   - **Implement**: the agent plans briefly and starts the change.

   Both instructions are editable before you start.

strIDEterm creates a branch workspace and copies the issue, its comments and attachments into `.strideterm/jira/<KEY>/`. That folder is excluded from Git. Attachments are copied up to 10 MB each and 50 MB per issue; larger ones are listed as not downloaded. The selected agent then starts and is told to read the issue files. The dialog shows each step until the workspace is ready. You can close it while setup runs; the Notification Center tells you when the workspace is ready or if it failed.

In the sidebar, a workspace linked to Jira shows the issue key (the status appears on hover); select it to open the issue. When you open the pull request from that workspace, the Review page names it after the issue. After the pull request exists, the Review page offers to post a comment with the pull request link and to change the issue's status. You confirm both first.

**New branch…** in an issue's menu starts another branch for the same issue. The issue's **Development** section lists the branch workspaces linked to it.

## Work with AI agents

To let agents read Jira, open the workspace settings and enable **Allow Jira MCP for agents**. It works with Claude Code, Codex, GitHub Copilot and OpenCode, not Gemini CLI. It applies to new agent sessions; restart open agent tabs after changing it. It can be changed only in the desktop app.

Agents can then search issues, read issues, comments, attachments, boards and sprints, and propose comments. They cannot post comments or change issues. Proposed comments wait in the Jira inbox for you to preview and post or delete.

Attachments an agent downloads are kept per workspace and removed with it. When the folder reaches its limit, the oldest files are deleted to make room. Change the limit in **Settings → Jira → Agent attachment folder** (**Max files**, **Max size (MB)**; 50 files and 50 MB by default, desktop app only).

Task workspaces have the same option: enable it when creating the task and its Worker and Judge get these tools too. See the [Agent Task Runner guide](agent-task-runner.md).

## Background updates and notifications

Saved queries can be checked for changes in the background. Choose the saved queries in the connection's saved query list, turn on **Check for updates in the background** for each one, and set **Default poll interval (seconds)** in the connection's settings (15 minutes to 1 hour). Opening the Jira inbox, focusing the Jira search or coming back to the window checks them sooner. When an issue is added to a checked query, changes or leaves it, an entry with a link to the issue appears in the Notification Center.

Nothing else is refreshed on a timer. The inbox loads saved data first and refreshes it when you open it, switch to a view, come back to the window after a few minutes, or press **Refresh**; the line above the list says how old the data is.

## Remote and mobile access

From a remote browser or a paired phone you can browse issues and boards in an existing Jira inbox of the profile that session belongs to, comment, change status, assign and log work (each change is previewed and confirmed first, as on the desktop), and use **Start development**. It needs a Jira connection and an Azure DevOps or GitHub connection in that profile, and the setup continues on the desktop after you close the dialog. A phone cannot create the Jira inbox: if the profile has none, create it on the desktop first. Adding connections, attachments (upload and save), linking workspaces and enabling Jira tools for agents are available only in the desktop app.
