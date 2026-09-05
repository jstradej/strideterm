# CLAUDE.md

Guidance for Claude Code in this repo. Project-specific notes first, then behavioral guidelines.

## Project

strIDEterm — multi-workspace terminal app with Electron shell, headless runtime, and remote web client. Details (stack, modules, build scripts) live in the codebase — discover them by reading; don't rely on a description here that will rot.

## Project-Specific Things to Remember

### Dev runtime uses a separate home directory

Dev is started with `.\dev.ps1` (interactive PowerShell, not from the Bash tool). It sets `STRIDETERM_DATA_DIR` to `~/.strideterm-dev` and remaps Electron `userData` there. Production uses `~/.strideterm` (also not Electron's default userData path — see `electron/main.ts`).

- **Dev logs, state, credentials, and Electron cache live under `~/.strideterm-dev/`, separate from prod's `~/.strideterm/`.** When debugging a dev-mode issue, read logs from the dev directory.
- Dev and prod don't share state — a workspace/profile/credential present in one is not present in the other.
- The single-instance lock is also isolated, so dev and prod can run side-by-side.

`--data-dir <path>` overrides both. Check `dev.ps1` and `electron/main.ts` if unsure where something landed.

### Never run plain `npm run build` while the user's dev loop is active

The user develops with `.\dev.ps1`, which runs `vite build --watch` with `VITE_BUILD_WATCH=1`. That env var:

- skips `emptyOutDir` so the watcher keeps writing into a live `dist/` that the remote-server serves to open mobile/web sessions
- emits chunks **without content hashes** (`assets/[name].js`) so a rebuild overwrites in place instead of leaving orphan hashed files behind

Running plain `npm run build` from a Claude tool call (no env var, default config) breaks both: it wipes `dist/`, then produces hashed chunks like `DockerPane-XXXX.js`. Any browser page already loaded on the remote client references the previous chunk names and 404s — and because the 404 response carries `text/plain`, Chrome's strict-MIME check fires the noisy "Refused to apply style from … because its MIME type ('text/plain') is not a supported stylesheet" error that buries the real cause.

Rules:

- **For verification, use `npm run typecheck`** — it doesn't touch `dist/`.
- **If a real build is genuinely needed, set the env var explicitly:** `VITE_BUILD_WATCH=1 npx vite build`. This matches what `dev.ps1` does and stays compatible with a live watch.
- **Never run plain `npm run build`** while `dev.ps1` may be open. If unsure whether it's running, ask first or pick the typecheck-only path.

### Cross-platform & multi-agent

Users run on **Windows, macOS, and Linux**, and may drive the app from multiple **AI agents** (Claude Code, Codex, Gemini, etc.). Most functionality is intentionally generic:

- Don't hardcode platform paths, shells, or executables — go through the existing config / platform-detection helpers.
- Don't bake in assumptions about a specific terminal, PTY, or path separator.
- Don't tie behavior to a single agent's conventions; agent integrations should share the generic plumbing.
- When adding a feature, ask: "does this work on all three OSes and for any agent?" If you need platform- or agent-specific code, isolate it behind the existing abstractions.

### Profiles — what is and isn't isolated

Profiles group workspaces inside one installation. They are a UI/organizational construct, **not a security or storage boundary**.

- **Scoped to a profile:** which workspaces are visible/active, profile metadata (name, color), and the workspace→profile assignment via `profileId`.
- **Shared across all profiles in one install:** the persisted state file, credentials store (`credentials.json` under the data dir), and the runtime managers (git/docker/azure/github). Anything else: check the code before assuming — profile is primarily a workspace-grouping concept, not a sandbox.

Switching profiles filters the visible workspace list — it does not swap stores or credentials. For true isolation (different creds, different data), use a separate data dir (dev vs prod, or `--data-dir`) or a different OS user.

### Terminal font size — per-transport settings keys

Two flat settings keys control terminal font size, separated by transport so desktop and remote/mobile clients are independent:

- `terminalFontSizeLocal: number` — font size for Electron desktop windows. Range 8–32 px, default 13. Adjusted via Ctrl/Cmd + scroll wheel, Ctrl/Cmd + 0 (reset to 13), or the Settings dialog.
- `terminalFontSizeRemote: number` — font size for remote/mobile web clients. Range 8–32 px, default 13. Adjusted via pinch gesture or the Settings dialog on the remote client.

**Invariant:** `terminalFontSizeLocal` may only be written by desktop IPC (`settings:update`). Remote HTTP clients (`/api/settings/update`) are blocked from writing it — `sanitizeSettingsFromRemote()` in `remote-server.ts` drops the key. Remote clients may freely write `terminalFontSizeRemote`. This keeps desktop and remote/mobile font preferences isolated even when both are connected simultaneously.

Migration: both keys are backfilled to 13 by `normalizeState()` in `default-state.ts` for any persisted state that predates this feature.

### Auto-approve permission prompts — desktop-only invariant

`notifications.autoApprovePermissions: boolean` (default `false`) arms strIDEterm to answer Claude Code's `PermissionRequest` hook with `allow`, so the agent does not stop at a permission prompt.

One prompt is out of reach and the UI says so: a tool call the Claude sandbox blocks for network access raises no `PermissionRequest` at all — only a `Notification:permission_prompt`, which carries no decision back. Don't let the README or the Settings copy drift back to "every permission prompt".

**Invariant:** the key may only be written by desktop IPC (`settings:update`). Remote HTTP clients (`/api/settings/update`) are blocked — `sanitizeSettingsFromRemote()` in `remote-server.ts` drops it via `REMOTE_BLOCKED_NOTIFICATION_FIELDS`. Same reasoning as `remoteAccess.autoTunnel`, one step worse in kind: it is a quiet, persistent flip whose consequences (every future `Bash` / `Write` the agent proposes, approved unattended) land on the desktop where the remote caller cannot see them. Arming it must be a deliberate act at the machine that executes the result.

Reading the trail IS remote-allowed: `GET /api/approvals/audit-log` (and `/stats`) are read-only, and scoped to the profile the calling session is bound to (a master-token caller with no bound session gets the whole installation — that token already grants every mutation on every profile). The Settings checkbox is disabled on the remote client with a "desktop only" hint — a tickable box whose Save the server silently drops is worse than no box.

DELETING from the trail is desktop-only, and for the same reason arming is. `deleteEntries()` (`base-audit-log-store.ts`) reaches the renderer through `approvals:audit-log:delete` and NOTHING else: `remote-server.ts` registers no counterpart, `transport.ts`'s remote transport leaves `deleteApprovalAuditEntries` undefined, and the Approvals tab renders no delete control when the transport does not provide it. The bypass runs on the desktop and its consequences land there; the record of it is not something a remote caller gets to erase. Two source-shape tests pin this — the parity test's `KNOWN_DESKTOP_ONLY_METHODS` entry and a "no remote route deletes from the trail" check in `remote-server.test.ts`. The store's own rule: an empty `ids` deletes NOTHING (wiping the table takes an explicit `all: true`), and `providerFilters` scope both shapes, so a per-profile clear cannot reach another profile even by naming its row ids. The rows go; a line in `strideterm.log` saying how many and when does not.

The viewer lives in the notification dock, not in Settings — `ApprovalsPanel.vue`, mounted by `NotificationCenter.vue` as the `approvals` tab. Its visibility rule is `armed OR the profile has rows OR the tab is the active one`, and each disjunct is load-bearing: keying it on the checkbox alone would hide the record of everything approved while it WAS on — and `updateSettings()` flips that checkbox to false on its own whenever `agentHook` drops — while the active-tab term stops "Clear all" from pulling the tab out from under the click that emptied it.

Note on the drop mechanism: `notifications` is the first subtree to get PER-FIELD remote blocking (`REMOTE_BLOCKED_NOTIFICATION_FIELDS`) rather than the wholesale top-level drop used for `externalPathOpener`. Dropping the whole subtree would take the quiet-timing and agents-only preferences with it, and those are legitimately tunable from a phone.

**Disarm-on-prerequisite-loss.** `updateSettings()` forces `autoApprovePermissions` to false whenever `notifications.agentHook` is false. Without it a parked `true` survives the hook being turned off, and a remote client — which IS allowed to set `agentHook` — would silently re-arm the bypass. Re-arming must always cost another deliberate desktop-side tick. The checkbox itself is locked against ARMING only: an armed bypass can always be unticked, whatever the hook status says, because at `partial` the `PermissionRequest` entry may still be registered and approving.

Eleven more invariants worth not breaking:

- **The stdout contract is the whole document.** `commitPermissionDecision()` returns `{hookSpecificOutput: {hookEventName, decision}}` — the wrapper is what Claude Code reads. `{hookOutput: …}` is only the internal HTTP envelope between notify-server and `notify.mjs`. The end-to-end test in `claude-hook-config.test.ts` compares the script's real stdout byte for byte; assert on the bytes, not on a parsed inner object.
- **Arbitrate before recording.** `PermissionRequest` is a two-phase handshake: `offerPermissionDecision()` (phase 1) must have NO observable side effect — no audit row, no `approval:recorded`, no Telegram — because `notify.mjs` has not yet counted how many instances offered. Only `commitPermissionDecision()`, sent to the single offerer, records anything.
- **The audit write gates the approval.** `commitPermissionDecision()` in `runtime.ts` writes to `approval-audit-log-store.ts` BEFORE returning the decision, and returns `null` (prompt shown) if the write fails. An unrecorded auto-approval must never happen. The row's `outcome` is `decision-issued`, never "approved" — nothing in the flow observes whether Claude Code acted on it, and the Telegram / Notification Center wording ("Approval sent") follows the same rule.
- **Ownership is proven, not inferred.** Hook routing is by project directory, which proves nothing: a `claude` in a plain terminal in the same repo, a second panel with the same `cwd`, and dev beside prod all reach the same responder. Each PTY gets a token (`sessionOwnershipTokens` → `STRIDETERM_SESSION_TOKEN`) that the hook echoes back in `strideterm_session_token`; `decideAutoApprove` refuses anything else with `unproven-session`. Never weaken this to "the session looks active".
- **One request, one record — and `prompt_id` is not a request.** Offers are keyed by `strideterm_delivery_id`, a uuid `notify.mjs` mints once per hook run and repeats on both phases. It used to be `(claude session_id, prompt_id)`, which reads like the identity of a permission request and is not one: `prompt_id` names the USER PROMPT being processed, so Bash, Write and `AskUserQuestion` inside one turn all shared it and the second request replayed the first one's `allow` — past the never-list, and with no audit row of its own. Claude's `PermissionRequest` input carries nothing that identifies the individual request (no `tool_use_id`), so don't invent one from the payload. A replay is additionally gated on same session + same tool + same input digest, and re-runs every guard first. The COMMIT leg is bound the same way: before anything else it must present the same session, the same `strideterm_delivery_id`, the same `tool_name` and the same input digest as the record it names, or it returns `null`. A request id is a lookup key, not an identity — without that check a commit carrying an `AskUserQuestion` payload was decided on a stored `Bash` record, past the never-list and audited as the Bash call it never was.
- **The commit re-validates; an offer is not a promise.** `commitPermissionDecision()` re-runs `decideAutoApprove` and re-proves the ownership token against the CURRENT state before recording anything. Unticking the box, the turn's `Stop` and `retireSession()` all call `discardPermissionOffers()`. Ten minutes can pass between the two legs — an offer that nobody revoked is not the same thing as an offer that is still valid. **A committed record is no exception:** the idempotent replay sits AFTER both the identity check and the guards, never before them. Returning the stored output first meant a second commit still answered `allow` after the box was unticked, after the turn's `Stop`, or from a caller that could not prove the panel at all. Re-issuing a stored decision the rules would now refuse is the same bypass as issuing it fresh; only the audit row is not written twice.
- **The history is reconciled, not assumed.** `approval:recorded` is a live event and nothing replays it, so `useNotificationCapture.ts` rebuilds the missing Notification Center entries from the audit log. What it keeps per profile is a CHECKPOINT, never a "profile done" flag: this renderer drops every live event whose profile is not the one on screen, and a disconnected remote client is handed nothing it missed, so re-entering a profile and reconnecting BOTH resume from the checkpoint (`backfillCheckpoints`, the `myActiveProfileId` watcher, and `onConnectionState`). A lifetime marker left those gaps open for the life of the renderer while the rows sat in SQLite. The ordinary state push still only retries a profile with no checkpoint at all — reconciliation must not become a query on every payload.
- **The checkpoint is a keyset cursor on the audit row `id`, and it only moves over a gap that was proved closed.** Three rules, one per way the old timestamp watermark lost rows for good:
  - The cursor is `id`, the column the store orders by (`afterId` / `beforeId`, both exclusive, added to `base-audit-log-store.ts` and carried by IPC and `GET /api/approvals/audit-log`). A `to: <oldest timestamp seen>` window is INCLUSIVE, so a page whose rows all share one millisecond came back unchanged and the walk called that "nowhere left to go".
  - An entry whose cursor is `0` is a real checkpoint — a first read that found an empty log. The marker used to be the newest timestamp folded in, so that case recorded the empty string, which is also what "never read" looked like; the resume then took the one-page branch meant for a first read and abandoned everything below it.
  - `BACKFILL_MAX_RESUME_PAGES` bounds ONE BATCH, not the gap. A walk that hits the cap keeps `walkTopId` / `walkBeforeId` and leaves the cursor where it was, and the next batch continues the same walk downwards. Advancing the watermark to the top of an unfinished walk is what made the rest of a long gap unaskable.
- **A back-filled row is inserted where it belongs, not at the head.** The store prepends (`addEvent` in `notifications.ts`), which is right for a live arrival and wrong for a walk that pages DOWNWARDS: a capped walk's second batch carries rows OLDER than its first, so prepending them reversed the thread, pulled `latestAt` back to an old row and — at `MAX_EVENTS_PER_SESSION` (20) and `MAX_SESSIONS` (200) — evicted the newest entries the earlier batch had just restored. Real history loss, not display order. The back-fill therefore passes `historical: true` plus `historyRank` (the audit row `id`, the tiebreak for a burst of approvals sharing one millisecond), and that path places the event by chronology and moves `firstAt`, `latestAt`, the session's position and both caps by the same. The caps then always cut the genuinely oldest tail. Never make this the default: a live event IS the newest thing in its thread, and its own clock is not evidence to the contrary.
- **A replayed row the caps drop is a no-op, and says so.** Placing by chronology means a row can land PAST the end — older than all 20 events the thread keeps, or a whole thread older than all 200 — and the cap then throws it away. It must therefore change nothing the user can see: no state, no labels, no category, no meta, no tier or urgency, no reordering, and `addAlertEvent` answers `inserted: false` for the same reason a duplicate does. Otherwise a row nobody can point at reopened a thread the user had already resolved, and rewrote its labels from an old audit snapshot. `firstAt` is the single deliberate exception — the row still proves when the thread began, which is a lifetime fact and not a claim about its state. The same rule one notch up: the session-level projection (state, labels, category, meta) describes `events[0]`, so only a replayed row that landed at the HEAD of its thread writes it; one that landed below is history, not news. Tier and urgency stay aggregates over the whole thread and are the exception to that half.
- **A failed attempt arms its own retry; the checkpoint alone is not one.** A failure rightly leaves the checkpoint where it was — but the checkpoint is also exactly what makes the ordinary state push skip the profile, so the one lifecycle trigger there was going to be took the gap with it. A reconnect is the sharp case: coming back up successfully does not produce a second `reconnected`. So `catch` calls `scheduleBackfillRetry()`, which sets `backfillRetryProfileIds` — the marker that lets the NEXT state push through the checkpoint gate, consumed by the attempt it lets through so it is not one extra query per payload for ever — and arms one `BACKFILL_RETRY_DELAYS_MS` timer for when no push comes. Bounded on purpose: past the last step the timers stop and only the marker stays, because a permanently broken transport or a locked SQLite file must not become a tight retry loop. An unfinished walk keeps `walkTopId` / `walkBeforeId`, so the retry continues from the same `beforeId` and never restarts at the top.
- **A lifecycle resume that lands mid-attempt is queued, not dropped.** `backfillInFlightProfileIds` stops two triggers issuing one query, but a `resume` is not a duplicate — it is news that a gap MAY have opened since the running attempt took its snapshot. `backfillResumePendingProfileIds` holds it (a capped walk's own continuation too) and the `finally` releases the in-flight marker BEFORE firing it, or the follow-up would drop itself for the same reason. Losing it was permanent: the stale attempt then wrote a checkpoint and the ordinary state push never asks a profile that has one.
- **`AUTO_APPROVE_NEVER_TOOLS`** (`notifications/auto-approve.ts`) holds `AskUserQuestion` and `ExitPlanMode`. A bare `allow` for either answers with nothing — the Claude Code docs require `updatedInput` alongside it. This is correctness, not caution; it is unit-tested, don't relax it.

### The notify-URL registry is shared across data dirs

`~/.claude/settings.json` is global, so exactly ONE installed `notify.mjs` is ever registered — and a registry living under a data dir could therefore never describe the OTHER instance (dev beside prod). The authoritative registry is the shared directory `~/.strideterm-hooks/`, instance-independent by construction. All of it lives in `notify-url-registry.ts`.

- **One file per installation: `instances/<instanceId>.json`.** An instance writes its own file and nothing else that another instance writes. A single shared document could not be written safely — `tmp + rename` prevents a torn file, not a lost update, and dev and prod starting together each read the old content, each appended, and the second rename dropped the first's entry. `notify.mjs` merges the directory.
- `<sharedDir>/notify-urls.json` (an older script's only source) and `<userDataPath>/hooks/notify-urls.json` (this instance's own older script) are still written, and neither is authoritative. The aggregate is REBUILT from the per-instance files on every write, so a racing mirror write heals on the next one.
- **A mirror is a fallback, never a peer.** Both mirrors are bare maps with no lease, so `notify.mjs` merges them ONLY when no leased shard answered. One written while a now-abandoned installation was alive names the same URL its shard did, and merging it beside the shards handed the lease filter straight back what it had just refused. The same read also TOMBSTONES the URLs of every expired shard it saw — shards are enumerated before the mirrors for that reason — which is the per-URL half of the rule: a mirror still routes what only it knows. Both halves are needed, and the ordering is why: once `pruneExpiredShards()` has deleted the shard there is nothing left to tombstone from, and an abandoned data dir's own local mirror is a file no live instance ever rewrites.
- **An expired shard's workspace KEYS survive as empty buckets.** Refusing its URLs is only half the answer, because a missing key falls through to the longest-PREFIX match. Live `C:/repo` beside expired `C:/repo/sub` therefore delivered a hook run in the child straight to the parent workspace's panel — a different panel, which never made the tool call. `resolveUrls()` collects the expired keys alongside the URL tombstones and materialises them as `[]` after the merge, so an exact (or deeper) match answers "nothing" instead of falling upwards. It is written only where nothing live claims the key, so dev and prod sharing one workspace path keep their routing. Neither mirror can supply the key here: a leased shard answered, so both are skipped by construction.
- Entries are `{ url, instanceId, sid }`. `instanceId` is a hash of `userDataPath`. Bare strings are still read (older writers).
- `retireSession()` removes a session's entry when its panel closes, its workspace is deleted, or its PTY exits. A stale URL lets a hook re-create a signal — and offer to answer — for a panel the user already closed.
- `normalizeCwd()` folds case ONLY on win32/darwin, and `notify.mjs#norm` applies exactly the same rule. On Linux `/work/Repo` and `/work/repo` are two different directories.
- **Shards carry a lease.** A shard is `{ updatedAt, urls }`, stamped on every write and re-stamped periodically (`renewLease()`, driven by a timer in `runtime.ts`) so a long-running install with no panel churn never looks dead. `SHARD_LEASE_TTL_MS` is 7 days — deliberately long, because expiring a live instance costs it every hook. Past it the shard is not merged (both `readMerged()` and `notify.mjs`) and `pruneExpiredShards()` deletes it — and rebuilds the shared aggregate in the same operation, since a mirror that still names the swept URL cannot be recognised as stale once the shard is gone; that is the ONE place an instance touches a file it does not own, and it only ever removes. Without it a crash, a deleted dev data dir or an uninstalled portable copy left a file nobody was left to clean up, and every hook kept POSTing at its dead — by then possibly recycled — port. A shard with no `updatedAt` (an earlier build, and both legacy mirrors) is dated by its mtime: not assumed fresh, not assumed dead.
- `STRIDETERM_HOOKS_DIR` relocates the shared registry. It exists so tests (see `vitest.backend.config.ts`) don't write into the developer's real home; nothing in production sets it.

**The registry is a live map; `STRIDETERM_NOTIFY_URL` is a snapshot.** A command hook DOES inherit the environment of the shell it was started from — the ownership token depends on it — but that environment is frozen when the PTY spawns. A notify server that restarts on a new port (the agent-hook checkbox off and on again) cannot reach into a running shell, so `notify.mjs` treats the env URL as a first choice and FALLS BACK to the registry whenever nothing could be delivered over it (refused, timed out, or answered 403 by whoever owns that port now), and `refreshNotifyUrls()` re-registers every live session when the server starts. The order matters both ways: the registry is keyed by project DIRECTORY, so reaching for it first would deliver one panel's events to every other panel sharing the cwd. For the same reason the ownership token is minted for every PTY whether or not the listener is running: a panel spawned with hooks off would otherwise be `unproven-session` forever.

### One-shot state migrations

`settings.appliedMigrations: string[]` records migrations that have already run. `normalizeState()` runs on load AND after every mutation, so a migration written as "add X whenever Y" is not a migration — it is a rule that keeps re-asserting itself and the user can never undo it. That is what happened to the Telegram `forwardKinds` widening (`TELEGRAM_QUESTION_FORWARD_MIGRATION`): `question` was re-added the moment it was unticked. Gate any new migration on a marker id and test the opt-out afterwards, not just the absence of duplicates.

---

# Behavioral Guidelines

Reduce common LLM coding mistakes. Bias toward caution over speed; for trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that _your_ changes orphaned. Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
