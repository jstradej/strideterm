# CLAUDE.md

strIDEterm is a multi-workspace terminal app: an Electron shell, a headless Node runtime, and a remote web/mobile client. The code and its tests are the reference for how things work. Most invariants are explained in comments next to the code that enforces them, so read those before changing it. This file holds only what the code cannot tell you: how the dev loop runs, rules for new code, and decisions whose reason is written nowhere else.

## Dev loop

- The user runs the app with `.\dev.ps1` (Windows, interactive PowerShell) or `./dev.sh` (macOS/Linux). Don't start it from a tool call. Describe what to check and let the user run it.
- Dev data, logs (`strideterm.log`), credentials and `electron-data/` live in `~/.strideterm-dev`; prod uses `~/.strideterm`. When debugging dev, read the logs in the dev directory. Dev and prod share no state and can run side by side. `--data-dir` / `STRIDETERM_DATA_DIR` override the location.
- **Never run plain `npm run build` while the dev loop may be running.** That includes the scripts that call it: `start`, `smoke`, `dist*` and `test:e2e:electron`. It wipes the live `dist/` that the remote server serves and renames the chunks, so open remote and mobile pages break. Verify with `npm run typecheck`. If you really need a frontend build, run `VITE_BUILD_WATCH=1 npx vite build`. If you can't tell whether the loop is running, use typecheck or ask.

## Rules for new code

### Cross-platform and multi-agent

Users run Windows, macOS and Linux, and drive the app from several agent CLIs: Claude Code, Codex, Copilot, OpenCode and Gemini.

- Don't hardcode paths, shells, executables or path separators. Use the existing platform helpers.
- Agent integrations share the generic plumbing. Put anything OS- or agent-specific behind the existing abstractions.
- For every feature, ask: does it work on all three OSes and for any agent?
- On macOS/Linux, program tabs start through the login shell (`viaLoginShell` in `session-manager.ts`). Don't revert this to a direct spawn: when `fix-path.ts` timed out reading the login PATH, every agent tab exited 1 with no message.

### A failed user action must reach the user AND strideterm.log

This applies to every button, menu item, shortcut and dialog submit. When one fails, the user sees why (a toast or a dialog error), and the failure is written to `strideterm.log`.

- Never end a user action in `catch → console.*`, `.catch(() => {})`, or an un-awaited or `void` call. A `void` call also never reaches the `installVueErrorHandler` safety net.
- Swallow errors silently only in background work.
- Use the central logging; don't duplicate it:
  - `handle()` in `ipc.ts` logs every failing IPC handler.
  - The notifications store logs every error toast.
  - Channels registered through `handleIpc` in `main.ts` (window/state, SSH bootstrap, popouts) are **not** logged.
- Dialog submits await `attrs.onSubmit` and close only after it succeeds.
- ESLint's `no-floating-promises` covers only `electron/backend` and `src/stores`, not Vue components.

### Profiles are not a security or storage boundary

Profiles group workspaces inside one installation. All profiles share the state file, the credential store and the runtime managers. Switching profiles filters which workspaces are visible and changes nothing else. Real isolation needs a separate data dir or a separate OS user.

Any lookup by name, cwd or parent must filter by profile first.

There is one exception. The server confines a session minted for a paired phone (one with a `deviceId`) to its profile. That is an application boundary, not an OS one: the phone's terminal is still a shell under the user's account. A paired desktop is not confined this way.

### Security posture changes only at the desktop

Anything that arms a bypass, widens access, or changes isolation or credentials is desktop-only. Every remote path counts as a remote viewer: browser, phone and paired desktop alike. Follow the existing pattern and apply all of it:

- `sanitizeSettingsFromRemote` drops the setting.
- `saveWorkspace` keeps the stored value when a remote viewer saves.
- There is no route for it in `remote-server.ts`.
- The remote transport has no method for it, and the method is listed in `KNOWN_DESKTOP_ONLY_METHODS`.
- The UI control is hidden or disabled on a remote client.

New mobile and peer routes must be classified on purpose; source-shape tests enforce this.

Isolation only narrows: a less-trusted caller may turn it on, never off.

### Secrets

- Secrets live in the credential store. They never go into `strideterm-state.json`, argv, logs, audit `details` or broadcast payloads.
- Agent grants and capabilities travel in environment variables, never in argv.
- A secret ref is derived from the owning id, never taken from a request.
- Add a new external system to the `credential-classifier.ts` allowlist on purpose, never by loosening a prefix. Peer and mobile keys are left out of that allowlist deliberately, so Settings → Credentials cannot remove them.

### Agent consent

- A tool permission, a `PermissionRequest` and auto-approve are never user consent. `AskUserQuestion` and `ExitPlanMode` stay in `AUTO_APPROVE_NEVER_TOOLS`.
- strIDEterm never pre-writes folder trust into a CLI config and never sends Enter on the user's behalf. The one exception is the user's own click on a review's trust notification.
- A network block by Claude's sandbox raises no `PermissionRequest`, so auto-approve cannot answer it. User-facing copy must not claim auto-approve covers "every permission prompt".

### Long actions answer at once

Over the mobile relay, a request is cancelled if its response hasn't started within 30 s. The limit is `RELAY_HTTP_REQUEST_TIMEOUT_MS`, a protocol constant shared with the `strideterm-mobile` repo; don't raise it.

Anything that can run longer must validate the caller synchronously, start the work without awaiting it, and report through the generic `OperationRegistry`. Don't add another one-off mechanism.

### State changes

- `store.mutate()` publishes a new snapshot. An async mutator does not isolate concurrent task-runner writes. In task-runner code:
  - Never keep workspace, task or round references across an `await`.
  - Re-read the state, then re-validate identity, lifecycle generation and expected state before applying a result.
  - A cancellation check stops stale work; it does not make an old reference current.
- `normalizeState()` runs on load AND after every mutation, so:
  - It must never mint values.
  - A migration must be gated on a marker in `settings.appliedMigrations`.
  - Test that the user's opt-out survives afterwards.

### The relay session key never leaves the desktop and the phone

The end-to-end relay keys are agreed over the already-encrypted Firebase channel and are held only in memory (`mobile-relay-e2e-session-store.ts`). They are never persisted or logged. Never add a plaintext fallback. The relay Worker lives in the `strideterm-mobile` repo, where a source-shape test checks that it never decrypts `e2e.*` frames.

## Decisions not written in code

These are the reasons behind behaviour that may look like a bug.

### Review Git

- The checkout's state decides every Git outcome. The role and the workspace origin (a managed worktree or "Work here") never do.
- The source baseline never comes from `lastHeadSha` or `lastSourceCommitId`; those are provider activity cursors.
- The baseline never advances on fetch or polling.
- Push-and-publish never repeats a part that already succeeded.

### Automations

- Same-subject suppression can swallow somebody else's event in the same window. That cost is accepted; don't invent an actor identity to avoid it.
- Global pause is installation-wide, and a profile-confined phone may set it, on purpose. Don't make it profile-local, and don't drop pending work.
- The first prompt goes through `restartSession`, never `ensureSession`, because an existing interactive process is not a new run.
- Terminal tails never go into `strideterm.log` or into broadcasts.
- Automated PR reviews stay one-shot, because nobody is there to answer the trust dialog. A review the user starts is interactive.

### Internal MCP

- MCP elicitation is deliberately unused. `task_prepare` returns a summary, and the host agent asks the user.
- A custom model id is allowed. The CLI's presence is checked; account access is not.
- The global CLI MCP config is never written.
- A path mentioned inside a task source grants nothing.

### Sandbox

- A `sandboxShell` tab gets no agent profile on purpose; otherwise it would hold every agent's sign-in.
- Messaging between Claude sessions does not work inside the sandbox, because `srt`'s seccomp filter blocks unix sockets.
- `package.json` overrides `srt`'s `zod` with the app's zod 4. `srt` imports `zod/v3`, and zod 3.25 fails `npm audit`.
- Sandbox decisions never go through a renderer read-modify-write of the whole workspace with `saveWorkspace`.

### Paired desktops

- **Handshake failure latches `not-paired`.** The device does not retry, because retrying extends the host's lockout and blocks the re-pairing that would fix it.
- **`EPROTO` "wrong version number" is the exception.** It means a plain HTTP server is on the port, for example another strIDEterm's remote access. It is reported as `other-program` and retried, because no peer listener counted it.
- **Re-pairing with a new key revokes the old connections**, because re-pairing is how a leaked key is rotated.
- **Pairing polls every 4 s and tolerates 2 min of network failure.** A 2 s poll used to exhaust the limit of 20 requests a minute while the user typed the code.
- **Restored windows are not gated on the host being online.** A host that is down shows the failure screen instead of losing the window.
- **Host and device must run the same build**, because the local renderer parses the host's payloads. Pairing only warns about a mismatch.
- **Use `isPeerWindow()` for anything that runs on this machine.** It means this window shows a host's data. Examples: popouts, the native folder picker, the Docker shell tab, the font size and the window title.
- **Desktop-class uploads accept any file type**, because the caller already has a terminal on that machine.

## Known limitations and verification status

- Task creation is still synchronous. A first-time worktree on a large repository can exceed the 30 s relay limit.
- `~/.strideterm/paste` on the SSH host, where screenshot paste writes, is never cleaned up.
- An attachment download is assembled in memory as one `Blob`, up to 1 GiB.
- The sandbox was verified end-to-end in two places:
  - On Windows 11 with WSL2: `sandbox-wsl.e2e.test.ts`, run with `STRIDETERM_SANDBOX_E2E=1`.
  - On macOS: `sandbox-native.e2e.test.ts`. Inside Seatbelt, curl cannot verify example.com's certificate chain; the cause is unknown.
- Not verified:
  - a native Linux host
  - WSL NAT vs mirrored networking beyond the probe
  - Copilot and OpenCode MCP placeholders against the real CLIs
  - the real agent CLIs reading the sandbox home
  - a packaged Windows installer

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
