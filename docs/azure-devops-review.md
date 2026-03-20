# Azure DevOps Pull Request Review

This document describes the Azure DevOps integration in strIDEterm: what it does, how it is wired into the app, how users are expected to work with it, and what remains intentionally outside the current scope.

## Goals

The integration is designed around one central promise:

`Turn a pull request inbox into a local review workspace where AI agents can help you review code.`

The current implementation focuses on:

- Azure DevOps connections without Azure CLI
- PAT-based authentication for REST and Git operations
- a prioritized pull request inbox
- managed local review checkouts
- AI agent integration via MCP (Model Context Protocol)
- local draft management with human-controlled publishing
- review actions directly from the app

It does not try to replicate the full Azure DevOps web UI.

## User Workflow

### 1. Open the Azure DevOps Workspace

strIDEterm creates an `Azure DevOps` workspace automatically. It is the home for:

- connection management
- pull request inbox sections
- refresh and attention state

If no connections exist yet, the workspace shows an onboarding empty state with an `Add Azure connection` action.

### 2. Add a Connection

Each connection stores:

- label
- organization URL
- login or UPN
- PAT (must have `Code: Read` scope minimum; `Code: Read & Write` for push)
- review checkout root (where git worktrees are created)
- optional project filters
- optional repository filters
- polling interval

PAT values are stored separately from the main state file. The main state file keeps only a `tokenRef`.

### 3. Review the Inbox

The inbox is split into:

- `Needs My Review`
- `My Pull Requests`
- `Needs Attention`
- connection status cards

Each pull request card includes:

- PR number and title
- project and repository
- source and target branches
- author
- role (`reviewer` or `author`)
- attention reason when applicable
- check/pipeline status (failed count, pending count)
- actions to open the review workspace, attach to an existing workspace, open the PR in the browser, or mark it as seen

### 4. Open a Review Workspace

Opening a pull request creates or reuses a file-backed workspace. The process:

1. Fetch PR details from Azure DevOps API (threads, iterations, checks)
2. Get the repository `remoteUrl` from the PR metadata
3. Create or reuse a cache repository clone (`git clone --no-checkout`)
4. Fetch the source and target branches
5. Create a git worktree for the PR at `{reviewRoot}/reviews/{connectionId}/pr-{prId}/`

For reviewer workflows, strIDEterm uses:

- a cached repository clone under the configured review root
- a managed Git worktree for the specific PR

For author workflows, strIDEterm tries to match an existing local workspace by:

- Git remote URL
- current branch

If a suitable workspace is found, the PR can be attached to that workspace instead of creating a duplicate checkout.

On workspace open, auto-refresh fetches the latest PR data (threads, checks, files). If checks are still missing, a second request triggers full detail loading.

### 5. Work Inside the Review Workspace

A review workspace behaves like a normal strIDEterm workspace with terminal tabs, a Git tab, and a dedicated Review pane.

The Review pane has five tabs:

#### Summary
- PR metadata (number, title, author, branches, merge status)
- Reviewer votes with vote buttons (Approve, Approve with suggestions, Wait, Reject)
- Check/pipeline status with failure details
- Changed file count

#### Files
- Directory tree of changed files with change type indicators (M/A/D)
- Diff preview panel with syntax highlighting
- Supports both PR diff (remote vs target) and worktree diff (local changes)

#### Comments
- All Azure DevOps review threads with inline code context and diff snippets
- Local comments created by users or agents
- Inline draft replies with author badge (e.g., "by claude")
- Draft management inline: edit, queue, delete, publish
- Stable `#N` numbering matching MCP tool indices
- Filter bar: All / Active / Has draft / Mine
- Prev/Next navigation buttons
- Actions: Reply, Reply & resolve, Resolve, Reactivate, Edit draft, Queue draft, Delete draft

#### Conflicts
- Merge status from Azure DevOps (succeeded, failure, queued, etc.)
- Conflict detection with file tree and diff preview
- Split view with clickable files

#### Agent
- Ready-to-use agent prompt templates (copy to clipboard)
- Editable prompts stored in SQLite
- MCP tools reference and environment info

### 6. Work with AI Agents

The review workspace integrates with AI agents (Claude Code, Codex) through MCP:

1. Open a terminal tab in the review workspace (Claude Code or Codex)
2. The agent automatically gets MCP tools for the review bridge
3. Use an agent prompt from the Agent tab, or give the agent custom instructions
4. The agent reads comments via `list_review_comments` and `get_review_comment`
5. The agent writes draft replies via `save_review_draft`
6. Drafts appear instantly in the Comments tab (live sync via signal file)
7. Review, edit, or delete drafts in the UI
8. When satisfied, queue drafts and publish to Azure DevOps

Agents cannot publish directly to Azure DevOps. All publishing goes through the user-controlled queue.

## Review Bridge

The review bridge is a local SQLite-backed system that connects Azure DevOps threads with AI agents through MCP.

### MCP Tools

The bridge exposes five tools via MCP (stdio transport):

| Tool | Purpose |
|------|---------|
| `list_review_comments` | List all comment threads with status, priority, and draft previews |
| `get_review_comment` | Get full thread detail by `#N` index (replies, file context, code snippet) |
| `create_review_comment` | Create a new review comment with an auto-created draft |
| `save_review_draft` | Save or replace a local draft reply for a comment |
| `queue_review_draft` | Queue a draft for publishing to Azure DevOps |

Additionally:
- **Resource** `review://brief` — current PR review brief in markdown
- **Prompt** `process-review-comments` — step-by-step review workflow guide

### Comment Model

Two types of comments:

| Type | Source | Description |
|------|--------|-------------|
| `answer-question` | Imported from Azure DevOps | A remote thread that needs a reply |
| `local-comment` | Created locally by user or agent | A local-only observation or follow-up |

Comment status lifecycle:
```
ready-for-agent → agent-working → draft-ready → ready-to-sync → synced
                                                                  ↓
                                                               conflict (on failure)
```

Each comment has a stable `display_index` (assigned on creation, never changes). This index is used in the UI (`#1`, `#2`, ...) and in MCP tools for cross-referencing.

### Draft Workflow

1. Agent or human creates a draft via `save_review_draft` or the Edit dialog
2. Draft stays local with status `draft`
3. User reviews the draft in Comments tab or Drafts & Sync tab
4. User queues the draft (status → `ready-to-sync`, added to `sync_queue`)
5. User clicks "Publish queued drafts" → drafts are posted to Azure DevOps via REST API
6. On success: status → `synced`. On failure: status → `failed` with error message and retry option.

### Live Sync

When an MCP agent writes to the SQLite database, the UI updates automatically:

1. The store writes a `.bridge-signal` file after every mutation
2. The runtime watches this file with `fs.watch()` for instant notification (~150ms)
3. As a reliable fallback, `PRAGMA data_version` is polled every 3 seconds
4. On change, `broadcastState()` pushes the new state to the renderer
5. Vue reactivity updates the renderer automatically (Pinia store → computed → components)

### Agent Prompts

Seven built-in prompt templates are stored in SQLite and editable in the Agent tab:

- Full code review
- Quick summary
- Write a review comment
- Process review comments
- Security & correctness scan
- Suggest improvements
- Create a local comment

Each prompt references the correct MCP tool names so agents know which tools to call.

### Export Files

The bridge exports context files for agent consumption:

- `agent-brief.json` / `agent-brief.md` — full PR context with comments and drafts
- `threads.md` — remote thread content
- `drafts.md` — all draft responses with statuses
- `sync-status.md` — queue status

## Architecture

### Backend

Core files:

| File | Responsibility |
|------|----------------|
| `azure-devops-manager.js` | Inbox orchestration, worktree management, polling |
| `azure-devops-api.js` | Azure DevOps REST API calls |
| `azure-devops-pr-summary.js` | PR summary formatting and card data |
| `azure-devops-utils.js` | Shared utilities (URL normalization, key helpers) |
| `review-bridge-store.js` | SQLite database for comments, drafts, sync queue, prompts |
| `review-bridge-mcp.js` | MCP server with tool/resource/prompt definitions |
| `review-bridge-mcp-stdio.js` | Stdio entry point for MCP subprocess |
| `review-bridge-agent-launch.js` | Agent launch configuration (Claude, Codex) |
| `review-bridge-format.js` | Markdown/JSON export formatting |
| `review-bridge-cli.js` | CLI for testing and automation |
| `credential-store.js` | Encrypted PAT storage |
| `azure-review-store.js` | PR tracking state (seen timestamps, workspace mapping) |
| `runtime.js` | Orchestration, IPC handlers, broadcast, polling |
| `ipc.js` | Electron IPC channel registration |
| `remote-server.js` | WebSocket/HTTP remote access server |

### SQLite Schema (review-bridge-store)

| Table | Purpose |
|-------|---------|
| `pull_requests` | PR metadata from Azure DevOps |
| `review_threads` | Comment threads from Azure |
| `thread_comments` | Individual replies within threads |
| `review_comments` | Mapped comments (remote threads + local) with `display_index` |
| `draft_responses` | Local draft replies (not yet published) |
| `sync_queue` | Queue of drafts pending publishing |
| `agent_notes` | Agent working notes |
| `agent_prompts` | Editable prompt templates |

### Renderer (Vue 3)

Core files:

| File | Responsibility |
|------|----------------|
| `src/components/workspace/AzureInboxPane.vue` | PR inbox with tabs (assigned/created/all), connection management |
| `src/components/workspace/AzureReviewPane.vue` | Review pane orchestrator (toolbar, tabs, files, conflicts) |
| `src/components/workspace/azure/ReviewSummaryTab.vue` | PR overview, reviewers, vote buttons |
| `src/components/workspace/azure/ReviewCommentsTab.vue` | Comment threads, drafts, filtering, sorting, bulk actions |
| `src/components/workspace/azure/ReviewAgentTab.vue` | Agent prompts, MCP server command |
| `src/components/workspace/azure/AzurePrRow.vue` | Individual PR card in inbox |
| `src/composables/useReviewComments.js` | Comment filtering, sorting, thread/draft map building |
| `src/stores/app-api-actions.js` | Azure/review bridge API action wrappers |
| `src/stores/git-ui.js` | Per-workspace review UI state (active tab, filters, selected diff) |

### Communication Flow

```
Azure DevOps REST API
    ↓
AzureDevOpsManager (fetch threads, comments, checks)
    ↓
ReviewBridgeStore (import into SQLite)
    ↓ (exports)
MCP Agent (Claude/Codex reads via MCP tools, writes drafts)
    ↓ (signal file)
Runtime (detects change, broadcastState)
    ↓ (IPC / WebSocket)
Renderer (re-renders with scroll preservation)
    ↓ (user action: publish)
Runtime → AzureDevOpsManager → Azure DevOps REST API
```

## Authentication and Security

### PAT Storage

PAT values are not stored in `strideterm-state.json`.

Instead:

- connection metadata is stored in the main state
- secrets are stored in `credentials.json`
- on Electron builds, `safeStorage` is used when available

If secure encryption is unavailable, the fallback store still keeps secrets separate from the main state file.

### Git Authentication

Git clone, fetch, and push commands do not write PAT values into remote URLs or `.git/config`.

The integration authenticates Git commands with:

- `git -c http.extraheader=AUTHORIZATION: Basic ...`

This keeps remotes clean and avoids leaking tokens into repository configuration.

### Agent Isolation

MCP agents cannot publish comments directly to Azure DevOps. All drafts must pass through the human-controlled queue. Agents only interact with the local SQLite database via MCP tools.

## Persisted Data

### Main State

The app state stores:

- Azure DevOps integration settings
- connection metadata (with `tokenRef`, not the PAT itself)
- review workspaces and their review metadata
- profile associations

### Review Bridge (SQLite)

The review bridge database stores:

- imported PR threads and comments
- local comments created by users or agents
- draft responses with status lifecycle
- sync queue with attempt tracking
- agent prompt templates
- stable display indices for comment numbering

### Review Cache

The Azure review store keeps runtime-adjacent metadata:

- tracked pull request state
- last seen timestamps
- last known review workspace mapping
- per-connection sync status

## Attention Model

The current attention model raises inbox attention for:

- new comments from other users
- source branch updates after the last seen activity
- reviewer vote changes
- merge or policy status changes
- check/pipeline failures

Opening a review workspace or marking the PR as seen clears the current attention snapshot.

## Profile Support

The integration supports multiple profiles:

- Each workspace has a `profileId` field (default: `"default"`)
- PR-to-workspace mapping is scoped to the active profile
- Review workspaces are created in the active profile

## Current Scope

The current implementation includes:

- connection verification and PAT-based auth
- polling-based inbox refresh with attention model
- full PR detail (metadata, threads, checks, iterations, changed files)
- five-tab review UI (Summary, Files, Comments, Conflicts, Agent)
- comment filtering and navigation
- general comments and replies to existing threads
- reviewer vote display and changes
- local review checkout creation (cache repo + git worktree)
- fetch, rebase, and push actions
- MCP-based AI agent integration (Claude Code, Codex)
- local draft management with queue-based publishing
- live MCP-to-UI sync (signal file + data version polling)
- stable comment numbering across sessions
- editable agent prompt templates
- auto-refresh on workspace open
- local comment creation and deletion

## Explicitly Out of Scope

The current implementation does not yet cover:

- inline thread creation on exact file and line anchors
- full policy API visualization beyond the merge status signal
- webhook-first synchronization (currently polling-only)
- Azure Entra or device-flow authentication
- full PR completion or merge orchestration

## Testing

The codebase includes automated coverage for:

- Azure manager logic (`azure-devops-manager.test.js`)
- credential persistence
- review store persistence (`review-bridge-store.test.js`)
- MCP tool handlers (`review-bridge-mcp.test.js`)
- agent launch configuration (`review-bridge-agent-launch.test.js`)
- runtime wiring (`runtime.test.js`)
- selector behavior for Azure and review virtual tabs
- render state change detection (`runtime-bindings.test.js`)

Automated tests do not replace live verification against a real Azure DevOps organization. Before release, run an end-to-end check with:

- a real organization URL and PAT
- at least one reviewer workflow and one author workflow
- comment, reply, vote, fetch, rebase, and push actions
- MCP agent draft creation and publishing flow
- draft edit, queue, delete, and sync operations
